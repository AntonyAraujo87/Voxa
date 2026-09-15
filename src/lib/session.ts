import { AUDIO_PRESETS, type Channel } from "./config";
import { LocalMedia } from "./localMedia";
import { watchResume } from "./resumeWatch";
import { audioContext, listDevices } from "./media";
import { Mesh, type TuningState } from "./rtc";
import { Signaling, pingSignaling, type PeerUser, type RosterEntry } from "./signaling";
import { Chat } from "./chat";
import { registrarErro } from "./diagnostico";
import { Transmissao } from "./transmissao";
import { useApp } from "../store/store";
import { clearPeerMedia, setPeerStream } from "../store/mediaStore";
import { loadChannels, observarHistorico, setGuildToken, supabaseEnabled, upsertUser } from "./supabase";
import { currentPrefs, loadPrefs, primePrefsCache, savePrefs } from "./prefs";
import { entradaDoBus, setOutputDevice, setOutputMode as aplicarModoSaida } from "./audioOutput";
import { tocarEfeito, pararEfeitos } from "./soundboard";
import { pararAudioDoSistema } from "./sysaudio";
import {
  emitEvent,
  flashTaskbar,
  listenEvent,
  setOverlayMovable,
  setOverlayWindowEnabled,
  setPushToTalkNative,
  type HotkeyStatus,
  type RebindCombo,
} from "./desktop";
import { SessionUpdates } from "./sessionUpdates";
import { initSessionHotkeys, rebindSessionHotkey } from "./sessionHotkeys";
import { playJoin, playLeave, playMention, playMute, playUnmute, setSoundsEnabled } from "./sounds";

const app = useApp;

/* ---------------------------------------------------------------------------
   Orquestrador: liga signaling, malha P2P, midia local e store.

   Vive fora do React de proposito — nada aqui causa render por si so; a UI so
   reage as fatias do zustand que realmente mudaram. As tres camadas abaixo
   dele (Signaling, Mesh, LocalMedia) nao se conhecem: toda a coordenacao
   acontece neste arquivo.
--------------------------------------------------------------------------- */

class Session {
  private signaling: Signaling;
  private mesh: Mesh;
  private media: LocalMedia;
  private chat: Chat;
  private video: Transmissao;

  private started = false;
  private mutedBeforeDeafen = false;
  private updates = new SessionUpdates();
  /** serializa entradas em canal: dois cliques rapidos criavam duas malhas */
  private voiceGeneration = 0;
  private hydrated = false;
  private destroyed = false;
  private nativeDisposers: (() => void)[] = [];

  private listenNative<T>(event: string, handler: (value: T) => void) {
    void listenEvent<T>(event, handler).then(off => { if (this.destroyed) off(); else this.nativeDisposers.push(off); });
  }

  constructor() {
    this.signaling = new Signaling({
      onStatus: (status) => app.setState({ status }),
      onReconnected: ({ selfId, roster }) => void this.onReconnected(selfId, roster),
      onRoster: (roster) => app.setState({ roster }),
      onPeerState: (p) => { app.getState().patchPeerState(p.id, p.state); if (typeof p.state.watching === "boolean") this.mesh.setViewing(p.id, p.state.watching); },
      onSignal: ({ from, data, channelId }) => {
        // Sinal atrasado de quem ficou para tras depois que saimos do canal
        // criaria um peer fantasma: conexao viva, sem tile, sem ninguem para
        // fecha-la. Fora de canal, nao ha negociacao legitima possivel.
        const state = app.getState();
        if (!state.activeVoice || from === state.selfSocketId || (channelId ? channelId !== state.activeVoice : !state.roster.some(peer => peer.id === from && peer.voice === state.activeVoice))) return;
        void this.mesh.handleSignal(from, data);
      },
      onChat: (msg) => {
        const s = app.getState();
        if (!s.channels.some(channel => channel.id === msg.channelId && channel.kind === "text")) return;
        // O chat nao oferece edicao. Um evento repetido nao pode substituir
        // conteudo existente, mesmo se outro socket copiar id e autor.
        // O ACK do proprio envio e tratado separadamente por Chat.dispatch.
        if (s.messages[msg.channelId]?.some(message => message.id === msg.id)) return;
        s.pushMessage(msg);

        // Escondido na bandeja durante o jogo, o badge de nao lidas nao ajuda:
        // ninguem esta olhando a janela. O piscar da barra de tarefas e o
        // unico aviso que atravessa o jogo em tela cheia.
        if (document.hidden && msg.authorId !== s.me?.id) void flashTaskbar();

        // Mencao e a unica coisa no chat que pede acao de quem esta jogando.
        // Avisa mesmo com a janela aberta em outro canal — o badge sozinho
        // so seria visto por quem ja estivesse olhando pra barra lateral.
        // `pushMessage` acima ja decidiu se conta como mencao; reusar o
        // estado evita a lista de nomes divergir entre os dois lugares.
        const depois = app.getState();
        if (
          (depois.mentions[msg.channelId] ?? 0) > (s.mentions[msg.channelId] ?? 0)
        ) {
          playMention();
          if (!document.hidden) void flashTaskbar();
        }
      },
      onTyping: ({ channelId, name }) =>
        app.setState((s) => ({ typing: { ...Object.fromEntries(Object.entries(s.typing).filter(([,at]) => Date.now() - at < 5000).slice(-100)), [name + channelId]: Date.now() } })),

      onPeerJoined: ({ id, channelId, state }) => {
        // Quem ja estava na sala apenas espera a oferta do recem-chegado.
        if (id === app.getState().selfSocketId || app.getState().activeVoice !== channelId) return;
        this.mesh.addPeer(id, false, state.watching ?? true);
        playJoin();
      },

      onPeerLeft: ({ id, channelId }) => {
        const estavaNoCanal = app.getState().activeVoice === channelId;
        this.mesh.removePeer(id);
        app.setState(current => { const connState={...current.connState}, stats={...current.stats}, speaking={...current.speaking}; delete connState[id]; delete stats[id]; delete speaking[id]; return {connState,stats,speaking}; });
        clearPeerMedia(id);
        if (app.getState().focusPeer === id) app.setState({ focusPeer: null });
        if (estavaNoCanal) playLeave();
      },
    });

    this.mesh = new Mesh({
      selfId: () => app.getState().selfSocketId,
      send: (to, data) => this.signaling.signal(to, data),
      onTrack: (peerId, kind, stream) => setPeerStream(peerId, kind, stream),
      onConnectionState: (peerId, state) =>
        app.setState((s) => ({ connState: { ...s.connState, [peerId]: state } })),
      needsSpeaking: () => app.getState().overlayEnabled,
      onStats: (map) => app.setState({ stats: Object.fromEntries(map) }),
      onSpeaking: (peerId, speaking) =>
        app.setState((s) => ({ speaking: { ...s.speaking, [peerId]: speaking } })),
      // Ia so para o console do WebView2, que ninguem abre. Erro de anexar
      // trilha entra aqui — e foi exatamente o que ficou invisivel.
      onError: (peerId, err) => registrarErro(`rtc:${peerId.slice(0, 6)}`, err),
      onQuality: (label, reason) =>
        app.getState().toast("info", `Qualidade ajustada: ${label} (${reason})`),
    });

    this.media = new LocalMedia({
      onSpeaking: (speaking) => {
        const selfId = app.getState().selfSocketId;
        app.setState((s) => ({ speaking: { ...s.speaking, [selfId]: speaking } }));
        this.signaling.setState({ speaking });
      },
      onScreenEnded: () => this.stopShare(),
      onWebcamEnded: () => this.stopWebcam(),
      onMicEnded: () => {
        this.mesh.setMic(null);
        app.setState({ micReady: false, semMicrofone: true });
        if (app.getState().activeVoice) this.aguardarMicrofoneLivre();
      },
    });

    this.chat = new Chat(this.signaling);
    this.video = new Transmissao(this.media, this.mesh, this.signaling);
    this.nativeDisposers.push(app.subscribe((state, previous) => {
      if (state.watchingLive !== previous.watchingLive) this.signaling.setState({ watching: state.watchingLive });
    }));
  }

  /**
   * Volta de uma queda do signaling (servidor dormindo, rede oscilando,
   * redeploy). A identidade mudou e o servidor nos considera fora do canal:
   * refazemos a malha do zero em vez de tentar remendar conexoes que apontam
   * para um id que nao existe mais.
   */
  private async onReconnected(selfId: string, roster: RosterEntry[]) {
    const generation = ++this.voiceGeneration;
    const canal = app.getState().activeVoice;
    app.setState({ selfSocketId: selfId, roster, stats: {}, connState: {} });

    if (!canal) return;

    this.mesh.clear();
    for (const r of roster) clearPeerMedia(r.id);

    try { await this.openMic(); } catch { app.setState({ semMicrofone: true }); this.aguardarMicrofoneLivre(); }
    if (generation !== this.voiceGeneration) return;
    let peers: { id: string; state?: import("./signaling").PeerState }[];
    try { ({ peers } = await this.signaling.joinVoice(canal)); }
    catch (error) { if (generation === this.voiceGeneration) { this.leaveVoice(); app.getState().toast("error", String(error)); } return; }
    if (generation !== this.voiceGeneration || app.getState().activeVoice !== canal) return;
    for (const peer of peers) if (peer.id !== app.getState().selfSocketId) this.mesh.addPeer(peer.id, true, peer.state?.watching ?? true);

    // `sharingKind` junto de `sharing`: o servidor recria o estado do zero na
    // reconexao (o socket tem id novo), entao o que nao for reenviado volta no
    // padrao. Sem ele, quem estava transmitindo reaparecia para os outros como
    // "ao vivo" generico, e a camera virava icone de monitor no tile.
    const { muted, deafened, sharing, sharingKind } = app.getState();
    this.signaling.setState({ muted, deafened, sharing, sharingKind, watching: app.getState().watchingLive });
    app.getState().toast("ok", "Reconectado ao canal");
  }

  /* -------------------------------- boot -------------------------------- */

  /** Le as preferencias salvas antes de qualquer render. */
  hydrate() {
    if (this.hydrated) return currentPrefs();
    this.hydrated = true;
    this.nativeDisposers.push(watchResume(async () => {
      if (!this.started || this.destroyed) return;
      const generation = this.voiceGeneration;
      this.setTalking(false);
      await this.signaling.recoverNetwork();
      if (this.destroyed || generation !== this.voiceGeneration) return;
      if (app.getState().activeVoice) {
        this.mesh.recoverNetwork();
        // Drivers e permissoes podem deixar estas promises pendentes. Isso
        // nao deve bloquear ICE nem a proxima troca de rede. openMic ja
        // serializa pedidos e invalida a captura quando saimos do canal.
        void Promise.resolve().then(() => audioContext().resume())
          .catch(err => registrarErro("audio", err));
        if (app.getState().semMicrofone) void this.tentarMicrofoneDeNovo();
      }
      void this.refreshDevices().catch(err => registrarErro("dispositivos", err));
    }));
    const prefs = loadPrefs();
    primePrefsCache(prefs);
    observarHistorico((estado) => app.setState({ historico: estado }));
    let deviceTimer = 0;
    const devicesChanged = () => { window.clearTimeout(deviceTimer); deviceTimer = window.setTimeout(() => void this.refreshDevices(), 300); };
    navigator.mediaDevices?.addEventListener("devicechange", devicesChanged);
    this.nativeDisposers.push(() => { window.clearTimeout(deviceTimer); navigator.mediaDevices?.removeEventListener("devicechange", devicesChanged); });
    app.setState({
      tuning: prefs.tuning,
      micDeviceId: prefs.micDeviceId,
      noiseSuppression: prefs.noiseSuppression,
      systemAudio: prefs.systemAudio,
      systemAudioMode: prefs.systemAudioMode,
      camDeviceId: prefs.camDeviceId,
      outputDeviceId: prefs.outputDeviceId,
      outputMode: prefs.outputMode,
      volumes: prefs.volumes,
      streamVolumes: prefs.streamVolumes,
      membersOpen: prefs.membersOpen,
      showStats: prefs.showStats,
      pushToTalk: prefs.pushToTalk,
      muted: prefs.pushToTalk, // em push-to-talk o padrao e mudo ate apertar
      sounds: prefs.sounds,
      overlayEnabled: prefs.overlayEnabled,
    });
    setSoundsEnabled(prefs.sounds);
    void this.mesh.setTuning(prefs.tuning);
    aplicarModoSaida(prefs.outputMode === "nivelado");
    if (prefs.outputDeviceId && prefs.outputDeviceId !== "default") {
      void setOutputDevice(prefs.outputDeviceId).then(ok => { if (!ok) { app.setState({ outputDeviceId: "default" }); app.getState().toast("info", "Saida salva indisponivel; usando o dispositivo padrao."); } });
    }
    if (prefs.overlayEnabled) void setOverlayWindowEnabled(true, prefs.overlayPos);

    // A janela do overlay e quem sabe onde ela mesma parou depois do
    // arrasto; ela avisa aqui, porque as preferencias moram nesta janela.
    this.listenNative<{ x: number; y: number } | null>("overlay:posicionado", (pos) => {
      app.setState({ overlayMoving: false });
      if (pos) savePrefs({ overlayPos: pos });
    });

    // `startOverlayMove` liga o overlay se estiver desligado, e o
    // "overlay:posicionar" sairia antes da janela nova terminar de montar —
    // ela abriria capturando clique sem mostrar o que fazer. Quando ela
    // avisa que esta pronta, o estado e reenviado.
    this.listenNative("overlay:pronto", () => {
      if (app.getState().overlayMoving) void emitEvent("overlay:posicionar", true);
    });

    return prefs;
  }

  async start(name: string, color: string, token: string): Promise<{ ok: boolean; error?: string }> {
    if (this.started) return { ok: true };

    const prefs = currentPrefs();

    // id estavel entre sessoes: volume por pessoa e autoria no Supabase
    // continuam apontando pra mesma identidade depois de reiniciar.
    const user: PeerUser = { id: prefs.userId, name, color };
    app.setState({ me: user });

    // Antes de QUALQUER consulta ao banco: a mesma senha que abre o servidor
    // de sinalizacao e o que prova ao Supabase que este anonimo foi convidado.
    // `upsertUser` logo abaixo ja e a primeira chamada que abre o cliente.
    setGuildToken(token);

    if (supabaseEnabled) {
      const stored = await upsertUser(name, color);
      if (stored) { user.id = stored.id; savePrefs({ userId: stored.id }); app.setState({ me: { ...user }, supabaseUserId: stored.id }); }
    }

    const channels: Channel[] = await loadChannels();
    const firstText = channels.find((c) => c.kind === "text")?.id ?? "geral";
    app.setState({ channels, activeText: firstText });

    try {
      const { selfId, roster } = await this.signaling.connect(user, token);
      app.setState({ selfSocketId: selfId, roster });
    } catch (err) {
      // Nao marca como iniciado: o usuario corrige a senha e tenta de novo
      // sem precisar fechar o app.
      const motivo = (err as Error).message || "Nao foi possivel conectar";

      // "senha errada" e "servidor fora do ar" pareciam a mesma coisa para
      // quem usa. Uma consulta ao /health separa os dois casos e diz o que
      // fazer, em vez de deixar a pessoa insistindo na senha certa contra um
      // servidor que nem respondia.
      if (!/senha/i.test(motivo)) {
        const noAr = await pingSignaling();
        return {
          ok: false,
          error: noAr
            ? motivo
            : "Servidor inacessivel. Verifique sua internet — ou aguarde 1 minuto, ele pode estar acordando.",
        };
      }
      return { ok: false, error: motivo };
    }

    this.started = true;
    savePrefs({ name, color, token });
    void this.openTextChannel(firstText);
    void this.refreshDevices();
    return { ok: true };
  }

  async refreshDevices() {
    const { mics, speakers, cameras } = await listDevices();
    app.setState({ mics, speakers, cameras });
  }

  /* -------------------------------- texto ------------------------------- */

  // A regra de chat mora em chat.ts — ela nao depende de midia nenhuma. Estes
  // metodos ficam como fachada porque a UI ja chama `session.sendChat(...)`
  // em varios lugares; mudar isso seria churn sem ganho.

  openTextChannel(id: string) {
    return this.chat.openChannel(id);
  }

  retryChat(message: import("./signaling").ChatMessage) { this.chat.retry(message); }

  sendChat(content: string) {
    return this.chat.send(content);
  }

  sendAttachment(file: File, caption = "") {
    return this.chat.sendAttachment(file, caption);
  }

  typing() {
    this.chat.typing();
  }

  loadOlderMessages(channelId: string) {
    return this.chat.loadOlder(channelId);
  }

  /* --------------------------------- voz -------------------------------- */

  async joinVoice(channelId: string) {
    if (app.getState().activeVoice === channelId) return;
    this.leaveVoice();
    const generation = this.voiceGeneration;
    app.setState({ activeVoice: channelId, watchingLive: false });
    try { await this.doJoinVoice(channelId, generation); }
    catch (error) {
      if (generation !== this.voiceGeneration) return;
      this.leaveVoice();
      registrarErro("voz:entrada", error);
      app.getState().toast("error", (error as Error).message);
    }
  }

  private async doJoinVoice(channelId: string, generation: number) {
    const s = app.getState();
    const cancelled = () => generation !== this.voiceGeneration;
    // Microfone indisponivel nao pode barrar a entrada. Quem nao tem mic,
    // negou a permissao ou esta com o dispositivo ocupado por outro programa
    // ainda quer ouvir os outros — e antes disso o canal simplesmente nao
    // abria, com um toast vermelho e nenhuma explicacao do que fazer.
    let semMicrofone = false;
    try {
      await this.openMic();
      if (cancelled()) return;
      app.setState({ semMicrofone: false });
    } catch (err) {
      if (cancelled()) return;
      semMicrofone = true;
      app.setState({ semMicrofone: true });
      // Vai para o diagnostico, e nao so para um toast que some em segundos:
      // sem microfone a pessoa fica no canal achando que fala normalmente,
      // e ninguem a ouve. O sintoma reportado e sempre "ninguem me escuta",
      // nunca "meu microfone falhou" — porque nada na tela dizia isso.
      registrarErro("microfone", err);
      s.toast("error", `Entrando so para ouvir — ${(err as Error).message}`);
      this.aguardarMicrofoneLivre();
    }

    // Marca o canal ANTES do ack: se alguem entrar nesse intervalo, o
    // onPeerJoined ja reconhece o canal e nao descarta o peer.
    // watchingLive comeca sempre fechado: entrar num canal novo nao deve abrir
    // a grade de video sozinho, so quando alguem estiver transmitindo E o
    // usuario clicar em "assistir" (ou for ele mesmo quem comecar a transmitir).
    app.setState({ activeVoice: channelId, watchingLive: false });
    if (cancelled()) return;
    const { peers } = await this.signaling.joinVoice(channelId);
    if (cancelled()) return;

    // Nos chegamos por ultimo => nos ofertamos pra todo mundo que ja estava.
    for (const peer of peers) if (peer.id !== app.getState().selfSocketId) this.mesh.addPeer(peer.id, true, peer.state?.watching ?? true);

    // Sem microfone o estado precisa sair como mudo, senao os outros veem um
    // icone de microfone aberto que nunca vai produzir som.
    if (semMicrofone) app.setState({ muted: true });
    this.signaling.setState({ muted: app.getState().muted, watching: app.getState().watchingLive });
  }

  leaveVoice({ keepMic = false } = {}) {
    this.voiceGeneration++;
    pararEfeitos();
    this.pararEsperaDoMicrofone();
    this.stopShare();
    this.mesh.clear();
    for (const r of app.getState().roster) clearPeerMedia(r.id);
    this.signaling.leaveVoice();
    app.setState((s) => ({
      activeVoice: null,
      semMicrofone: false,
      showSharePicker: false,
      focusPeer: null,
      watchingLive: false,
      stats: {},
      connState: {},
      // Sair do canal com a tecla de falar ainda pressionada (o keyup se perde
      // quando a janela deixa de ter foco) deixava `talking` preso em true. No
      // canal seguinte o microfone abria sozinho, sem ninguem segurar nada.
      talking: false,
      muted: s.pushToTalk ? true : s.muted,
    }));
    if (!keepMic) this.closeMic();
  }

  private async openMic() {
    const generation = this.voiceGeneration;
    const { tuning, micDeviceId, noiseSuppression } = app.getState();
    const track = await this.media.openMic(tuning.audio, micDeviceId, noiseSuppression);
    if (generation !== this.voiceGeneration) return;
    if (!track) {
      // Nunca sair daqui em silencio: sem trilha ninguem te ouve, e sem
      // marcar o estado o app continuaria mostrando "microfone ativo".
      app.setState({ semMicrofone: true, micReady: false });
      registrarErro("microfone", "abriu sem trilha de audio");
      throw new Error("O microfone abriu sem enviar audio.");
    }

    this.applyMicState();
    this.mesh.setMic(track);
    app.setState({ micReady: true });
    return true;
  }

  private closeMic() {
    this.media.closeMic();
    this.mesh.setMic(null);
    app.setState({ micReady: false });
  }

  private applyMicState() {
    const s = app.getState();
    const muted = s.deafened || (s.pushToTalk ? !s.talking : s.muted);
    app.setState({ muted });
    this.media.setMicEnabled(!!s.activeVoice && !muted);
    this.signaling.setState({ muted, deafened: s.deafened });
  }

  toggleMute() {
    const s = app.getState();
    if (s.pushToTalk) { s.toast("info", "Segure a tecla de falar; desative push-to-talk para usar o microfone aberto."); return; }
    const muted = !s.muted;
    app.setState({ muted, deafened: muted ? s.deafened : false });
    this.applyMicState();
    if (muted) playMute(); else playUnmute();
  }

  setSounds(on: boolean) {
    app.setState({ sounds: on });
    savePrefs({ sounds: on });
    setSoundsEnabled(on);
    if (on) playUnmute();
  }

  toggleDeafen() {
    const deafened = !app.getState().deafened;
    // Ensurdecer forca mute; desensurdecer devolve o microfone ao estado que
    // ele tinha antes — igual ao Discord.
    if (deafened) this.mutedBeforeDeafen = app.getState().muted;
    const muted = deafened ? true : this.mutedBeforeDeafen;

    app.setState({ deafened, muted });
    this.applyMicState();
  }

  /**
   * Toca um efeito do soundboard pro canal de voz — junto do bus de saida
   * local (quem apertou tambem ouve) e da mixagem de entrada do microfone
   * (vai pros outros peers). Sem canal de voz ou sem microfone aberto o
   * efeito nao teria como chegar em ninguem, entao nem tenta.
   */
  playSoundboard(id: string) {
    const s = app.getState();
    if (!s.activeVoice) return;
    const destinos = [entradaDoBus(), this.media.mixInput].filter((d): d is AudioNode => d !== null);
    tocarEfeito(id, destinos);
  }

  async setMicDevice(deviceId: string) {
    app.setState({ micDeviceId: deviceId });
    savePrefs({ micDeviceId: deviceId });
    if (!this.media.hasMic) return;
    this.closeMic();
    await this.reopenMic();
  }

  async setOutputDeviceId(deviceId: string) {
    const ok = await setOutputDevice(deviceId);
    if (!ok) {
      app.getState().toast("error", "Nao foi possivel trocar o dispositivo de saida.");
      return;
    }
    app.setState({ outputDeviceId: deviceId });
    savePrefs({ outputDeviceId: deviceId });
  }

  setOutputMode(mode: "natural" | "nivelado") {
    aplicarModoSaida(mode === "nivelado");
    app.setState({ outputMode: mode });
    savePrefs({ outputMode: mode });
  }

  /**
   * Liga/desliga o RNNoise. Precisa reabrir o microfone pra valer — o node
   * so entra no grafo dentro de `openMic`, nao da pra inserir/remover no meio
   * de uma captura ja em andamento sem reconstruir a cadeia inteira.
   */
  async setNoiseSuppression(on: boolean) {
    app.setState({ noiseSuppression: on });
    savePrefs({ noiseSuppression: on });
    if (!this.media.hasMic) return;
    this.closeMic();
    await this.reopenMic();
  }

  private async reopenMic() {
    try { await this.openMic(); }
    catch (error) {
      registrarErro("microfone:troca", error);
      if (!app.getState().activeVoice) return;
      app.setState({ semMicrofone: true });
      app.getState().toast("error", "Nao foi possivel abrir o microfone selecionado. Tentaremos novamente.");
      this.aguardarMicrofoneLivre();
    }
  }

  /** Troca a fonte do audio da transmissao. Vale no proximo compartilhamento:
   *  trocar no meio exigiria renegociar o track com todos os pares. */
  setSystemAudio(on: boolean) {
    app.setState({ systemAudio: on });
    savePrefs({ systemAudio: on });
  }

  setSystemAudioMode(mode: "system" | "application" | "exclude-voxa") {
    app.setState({ systemAudioMode: mode });
    savePrefs({ systemAudioMode: mode });
  }

  /** Cria/fecha a janela flutuante (overlay.rs). Sem efeito fora do app
   *  instalado — no navegador (dev/teste) so fica marcado no estado. */
  async setOverlayEnabled(on: boolean) {
    // Desligar cancela o modo posicionar junto: a janela deixa de existir,
    // e um estado de "posicionando" preso deixaria o botao das Configuracoes
    // mentindo sobre o que esta acontecendo.
    app.setState({ overlayEnabled: on, overlayMoving: on ? app.getState().overlayMoving : false });
    savePrefs({ overlayEnabled: on });
    await setOverlayWindowEnabled(on, currentPrefs().overlayPos);
  }

  /** Modo posicionar: destrava o clique do overlay pra ele poder ser
   *  arrastado. Liga o overlay antes se estiver desligado — pedir pra
   *  posicionar uma janela que nao existe nao faria nada e pareceria bug. */
  async startOverlayMove() {
    if (!app.getState().overlayEnabled) await this.setOverlayEnabled(true);
    app.setState({ overlayMoving: true });
    await setOverlayMovable(true);
    await emitEvent("overlay:posicionar", true);
  }

  /**
   * Nova tentativa de abrir o microfone sem sair do canal.
   *
   * O caso comum e outro programa ter segurado o dispositivo (Discord,
   * Parsec, OBS): a pessoa fecha o outro programa e quer voltar a falar sem
   * ter que sair e entrar de novo.
   */
  async tentarMicrofoneDeNovo() {
    if (!app.getState().activeVoice) return;
    try {
      if (!await this.openMic()) return;
      this.pararEsperaDoMicrofone();
      app.setState({ semMicrofone: false });
      this.avisarMicrofoneRecuperado();
    } catch (err) {
      registrarErro("microfone", err);
      app.getState().toast("error", `Continua indisponivel — ${(err as Error).message}`);
    }
  }

  /**
   * Fica tentando o microfone de fundo enquanto ele estiver indisponivel.
   *
   * O caso comum nao e "nao tenho microfone", e sim outro programa segurando
   * o dispositivo — Discord, Parsec, OBS. Quando ele solta, nao ha motivo
   * para a pessoa continuar muda ate reparar no aviso e clicar: o app volta
   * sozinho e avisa que ja da para falar.
   *
   * Silencioso de proposito enquanto falha: quem esta sem microfone de
   * verdade nao pode receber um toast de erro a cada 15 segundos.
   */
  private esperaMicrofone: number | null = null;

  private aguardarMicrofoneLivre() {
    if (this.esperaMicrofone !== null) return;
    this.esperaMicrofone = window.setInterval(() => {
      if (!app.getState().activeVoice || !app.getState().semMicrofone) {
        this.pararEsperaDoMicrofone();
        return;
      }
      void this.openMic()
        .then((opened) => {
          if (!opened || !app.getState().activeVoice) return;
          this.pararEsperaDoMicrofone();
          app.setState({ semMicrofone: false });
          this.avisarMicrofoneRecuperado();
        })
        .catch(() => {
          /* segue ocupado: tenta de novo no proximo ciclo */
        });
    }, 15_000);
  }

  private avisarMicrofoneRecuperado() {
    const { muted, pushToTalk, deafened } = app.getState();
    const detalhe = deafened ? "desative ensurdecido para falar" : pushToTalk ? "segure a tecla para falar" : muted ? "ative o microfone para falar" : "pronto para enviar sua voz";
    app.getState().toast("ok", `Microfone recuperado — ${detalhe}.`);
  }

  private pararEsperaDoMicrofone() {
    if (this.esperaMicrofone === null) return;
    window.clearInterval(this.esperaMicrofone);
    this.esperaMicrofone = null;
  }

  /* ---------------------------- push-to-talk ---------------------------- */

  async setPushToTalk(enabled: boolean) {
    try {
      await setPushToTalkNative(enabled);
      app.setState({ pushToTalk: enabled, muted: enabled || app.getState().deafened, talking: false });
      savePrefs({ pushToTalk: enabled });
      this.applyMicState();
    } catch (error) {
      registrarErro("atalho:ptt", error);
      app.getState().toast("error", "Nao foi possivel registrar a tecla de falar. Escolha outra tecla.");
    }
  }

  /** Chamado na descida e na subida da tecla de push-to-talk. */
  setTalking(active: boolean) {
    const s = app.getState();
    if (!s.pushToTalk || s.talking === active) return;

    const muted = !active || s.deafened;
    app.setState({ talking: active, muted });
    this.applyMicState();
  }

  /* ------------------------- atalhos e atualizacao ---------------------- */

  rebindHotkey(action: "mute" | "deafen" | "share" | "talk", combo: RebindCombo): Promise<HotkeyStatus> {
    return rebindSessionHotkey(action, combo);
  }

  initHotkeys() { return initSessionHotkeys(this); }
  checkUpdate(options = {}) { return this.updates.check(options); }
  installUpdate() { return this.updates.install(); }

  /* --------------------------- tela / jogo / camera ---------------------- */
  /* Regra e implementacao em `lib/transmissao.ts`: tela e camera dividem o
     mesmo canal de video, e a limpeza de estado das duas e a mesma. Aqui
     ficam so os nomes que a UI e os atalhos globais ja chamam. */

  startShare() {
    return this.video.iniciarTela();
  }
  stopShare() {
    this.video.pararTela();
  }
  toggleShare() {
    return this.video.alternarTela();
  }
  startWebcam() {
    return this.video.iniciarCamera();
  }
  stopWebcam() {
    this.video.pararCamera();
  }
  toggleWebcam() {
    this.video.alternarCamera();
  }
  setCamDevice(deviceId: string) {
    return this.video.trocarCamera(deviceId);
  }

  /* ------------------------------- qualidade ---------------------------- */

  async setTuning(patch: Partial<TuningState>) {
    const next = { ...app.getState().tuning, ...patch };
    app.setState({ tuning: next });
    savePrefs({ tuning: next });
    await this.mesh.setTuning(patch);

    // Trocar o preset de audio muda os constraints da captura: precisa
    // reabrir o microfone para o DSP entrar ou sair do caminho.
    if (patch.audio && this.media.hasMic) {
      this.closeMic();
      await this.openMic();
      app.getState().toast("info", `Audio: ${AUDIO_PRESETS[next.audio].label}`);
    }

    if (patch.video || patch.content) {
      await this.media.applyScreenSettings(next.video, next.content);
    }
  }

  /* -------------------------------- ciclo ------------------------------- */

  /** so para depuracao no console */
  /** Fotografia do envio, usada pelo diagnostico. */
  estadoEnvio() {
    return { temMic: this.mesh.temMic, pares: this.mesh.estadoEnvio() };
  }

  debugSenders() {
    return this.mesh.debugSenders();
  }

  cloneMicrophoneForTest() { return this.media.cloneMicrophoneForTest(); }

  destroy() {
    this.destroyed = true;
    this.updates.destroy();
    this.pararEsperaDoMicrofone();
    this.leaveVoice();
    // `leaveVoice` ja passa por `stopShare`, mas se a captura de tela nunca
    // chegou a abrir (erro no meio) a thread do WASAPI podia continuar viva
    // sozinha do lado do Rust, sem ninguem consumindo.
    pararAudioDoSistema();
    for (const off of this.nativeDisposers) off();
    this.nativeDisposers = [];
    this.mesh.destroy();
    this.media.destroy();
    this.signaling.destroy();
  }
}

export const session = new Session();

// Gancho de depuracao: so existe em dev, some do bundle de producao.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__voxa = {
    session,
    store: app,
    senders: () => session.debugSenders(),
  };
}

// Este vale TAMBEM em producao: e o que o diagnostico le para dizer onde a
// trilha de microfone parou. Nao expoe nada sensivel — so contadores e
// bandeiras booleanas do proprio envio.
(window as unknown as Record<string, unknown>).__voxaEnvio = () => session.estadoEnvio();
