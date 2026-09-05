import { AUDIO_PRESETS, type Channel } from "./config";
import { LocalMedia } from "./localMedia";
import { listDevices } from "./media";
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
import { tocarEfeito } from "./soundboard";
import { pararAudioDoSistema } from "./sysaudio";
import {
  checkForUpdate,
  emitEvent,
  flashTaskbar,
  listenEvent,
  rebindHotkey as rebindHotkeyNative,
  setOverlayMovable,
  setOverlayWindowEnabled,
  setPushToTalkNative,
  type HotkeyStatus,
  type RebindCombo,
} from "./desktop";
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
  private pendingUpdate: (() => Promise<void>) | null = null;
  /** serializa entradas em canal: dois cliques rapidos criavam duas malhas */
  private joinPending: Promise<void> | null = null;

  constructor() {
    this.signaling = new Signaling({
      onStatus: (status) => app.setState({ status }),
      onReconnected: ({ selfId, roster }) => void this.onReconnected(selfId, roster),
      onRoster: (roster) => app.setState({ roster }),
      onPeerState: (p) => app.getState().patchPeerState(p.id, p.state),
      onSignal: ({ from, data }) => {
        // Sinal atrasado de quem ficou para tras depois que saimos do canal
        // criaria um peer fantasma: conexao viva, sem tile, sem ninguem para
        // fecha-la. Fora de canal, nao ha negociacao legitima possivel.
        if (!app.getState().activeVoice) return;
        void this.mesh.handleSignal(from, data);
      },
      onChat: (msg) => {
        const s = app.getState();
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
        app.setState((s) => ({ typing: { ...s.typing, [name + channelId]: Date.now() } })),

      onPeerJoined: ({ id, channelId }) => {
        // Quem ja estava na sala apenas espera a oferta do recem-chegado.
        if (app.getState().activeVoice !== channelId) return;
        this.mesh.addPeer(id, false);
        playJoin();
      },

      onPeerLeft: ({ id, channelId }) => {
        const estavaNoCanal = app.getState().activeVoice === channelId;
        this.mesh.removePeer(id);
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
      onStats: (map) => app.setState({ stats: Object.fromEntries(map) }),
      onSpeaking: (peerId, speaking) =>
        app.setState((s) => ({ speaking: { ...s.speaking, [peerId]: speaking } })),
      onError: (peerId, err) => console.error("[rtc]", peerId, err),
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
    });

    this.chat = new Chat(this.signaling);
    this.video = new Transmissao(this.media, this.mesh, this.signaling);
  }

  /**
   * Volta de uma queda do signaling (servidor dormindo, rede oscilando,
   * redeploy). A identidade mudou e o servidor nos considera fora do canal:
   * refazemos a malha do zero em vez de tentar remendar conexoes que apontam
   * para um id que nao existe mais.
   */
  private async onReconnected(selfId: string, roster: RosterEntry[]) {
    const canal = app.getState().activeVoice;
    app.setState({ selfSocketId: selfId, roster, stats: {}, connState: {} });

    if (!canal) return;

    this.mesh.clear();
    for (const r of roster) clearPeerMedia(r.id);

    const { peers } = await this.signaling.joinVoice(canal);
    for (const peer of peers) this.mesh.addPeer(peer.id, true);

    // `sharingKind` junto de `sharing`: o servidor recria o estado do zero na
    // reconexao (o socket tem id novo), entao o que nao for reenviado volta no
    // padrao. Sem ele, quem estava transmitindo reaparecia para os outros como
    // "ao vivo" generico, e a camera virava icone de monitor no tile.
    const { muted, deafened, sharing, sharingKind } = app.getState();
    this.signaling.setState({ muted, deafened, sharing, sharingKind });
    app.getState().toast("ok", "Reconectado ao canal");
  }

  /* -------------------------------- boot -------------------------------- */

  /** Le as preferencias salvas antes de qualquer render. */
  hydrate() {
    const prefs = loadPrefs();
    primePrefsCache(prefs);
    observarHistorico((estado) => app.setState({ historico: estado }));
    app.setState({
      tuning: prefs.tuning,
      micDeviceId: prefs.micDeviceId,
      noiseSuppression: prefs.noiseSuppression,
      systemAudio: prefs.systemAudio,
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
      void setOutputDevice(prefs.outputDeviceId);
    }
    if (prefs.overlayEnabled) void setOverlayWindowEnabled(true, prefs.overlayPos);

    // A janela do overlay e quem sabe onde ela mesma parou depois do
    // arrasto; ela avisa aqui, porque as preferencias moram nesta janela.
    void listenEvent<{ x: number; y: number } | null>("overlay:posicionado", (pos) => {
      app.setState({ overlayMoving: false });
      if (pos) savePrefs({ overlayPos: pos });
    });

    // `startOverlayMove` liga o overlay se estiver desligado, e o
    // "overlay:posicionar" sairia antes da janela nova terminar de montar —
    // ela abriria capturando clique sem mostrar o que fazer. Quando ela
    // avisa que esta pronta, o estado e reenviado.
    void listenEvent("overlay:pronto", () => {
      if (app.getState().overlayMoving) void emitEvent("overlay:posicionar", true);
    });

    return prefs;
  }

  async start(name: string, color: string, token: string): Promise<{ ok: boolean; error?: string }> {
    if (this.started) return { ok: true };

    const prefs = loadPrefs();

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
      if (stored) app.setState({ supabaseUserId: stored.id });
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
    await this.openTextChannel(firstText);
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

  sendChat(content: string) {
    this.chat.send(content);
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
    // `openMic` e o ack do servidor sao assincronos. Sem serializar, clicar em
    // dois canais em sequencia rapida dispara duas entradas: a segunda comeca
    // antes de a primeira registrar o canal, e sobram peers da sala errada.
    const anterior = this.joinPending ?? Promise.resolve();
    this.joinPending = anterior.then(() => this.doJoinVoice(channelId)).catch(() => {});
    return this.joinPending;
  }

  private async doJoinVoice(channelId: string) {
    const s = app.getState();
    if (s.activeVoice === channelId) return;
    if (s.activeVoice) this.leaveVoice({ keepMic: true });

    // Microfone indisponivel nao pode barrar a entrada. Quem nao tem mic,
    // negou a permissao ou esta com o dispositivo ocupado por outro programa
    // ainda quer ouvir os outros — e antes disso o canal simplesmente nao
    // abria, com um toast vermelho e nenhuma explicacao do que fazer.
    let semMicrofone = false;
    try {
      await this.openMic();
      app.setState({ semMicrofone: false });
    } catch (err) {
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
    const { peers } = await this.signaling.joinVoice(channelId);

    // Nos chegamos por ultimo => nos ofertamos pra todo mundo que ja estava.
    for (const peer of peers) this.mesh.addPeer(peer.id, true);

    // Sem microfone o estado precisa sair como mudo, senao os outros veem um
    // icone de microfone aberto que nunca vai produzir som.
    if (semMicrofone) app.setState({ muted: true });
    this.signaling.setState({ muted: app.getState().muted });
  }

  leaveVoice({ keepMic = false } = {}) {
    this.pararEsperaDoMicrofone();
    this.stopShare();
    this.mesh.clear();
    for (const r of app.getState().roster) clearPeerMedia(r.id);
    this.signaling.leaveVoice();
    app.setState((s) => ({
      activeVoice: null,
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
    const { tuning, micDeviceId, muted, noiseSuppression } = app.getState();
    const track = await this.media.openMic(tuning.audio, micDeviceId, noiseSuppression);
    if (!track) return;

    this.media.setMicEnabled(!muted);
    this.mesh.setMic(track);
    app.setState({ micReady: true });
  }

  private closeMic() {
    this.media.closeMic();
    this.mesh.setMic(null);
    app.setState({ micReady: false });
  }

  toggleMute() {
    const muted = !app.getState().muted;
    app.setState({ muted });
    this.media.setMicEnabled(!muted);
    this.signaling.setState({ muted });
    // Confirmacao audivel importa mais aqui do que em qualquer outro botao:
    // o atalho global funciona com o jogo em tela cheia, sem a UI a vista.
    if (muted) playMute();
    else playUnmute();
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
    this.media.setMicEnabled(!muted);
    this.signaling.setState({ deafened, muted });
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
    await this.openMic();
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
    await this.openMic();
  }

  /** Troca a fonte do audio da transmissao. Vale no proximo compartilhamento:
   *  trocar no meio exigiria renegociar o track com todos os pares. */
  setSystemAudio(on: boolean) {
    app.setState({ systemAudio: on });
    savePrefs({ systemAudio: on });
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
    try {
      await this.openMic();
      this.pararEsperaDoMicrofone();
      app.setState({ semMicrofone: false });
      app.getState().toast("ok", "Microfone ativo — ja te ouvem.");
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
        .then(() => {
          this.pararEsperaDoMicrofone();
          app.setState({ semMicrofone: false });
          app.getState().toast("ok", "Microfone liberado — ja te ouvem.");
        })
        .catch(() => {
          /* segue ocupado: tenta de novo no proximo ciclo */
        });
    }, 15_000);
  }

  private pararEsperaDoMicrofone() {
    if (this.esperaMicrofone === null) return;
    window.clearInterval(this.esperaMicrofone);
    this.esperaMicrofone = null;
  }

  /* ---------------------------- push-to-talk ---------------------------- */

  async setPushToTalk(enabled: boolean) {
    app.setState({ pushToTalk: enabled, muted: enabled, talking: false });
    savePrefs({ pushToTalk: enabled });
    this.media.setMicEnabled(!enabled);
    this.signaling.setState({ muted: enabled });
    await setPushToTalkNative(enabled);
  }

  /** Chamado na descida e na subida da tecla de push-to-talk. */
  setTalking(active: boolean) {
    const s = app.getState();
    if (!s.pushToTalk || s.talking === active) return;

    const muted = !active || s.deafened;
    app.setState({ talking: active, muted });
    this.media.setMicEnabled(!muted);
    this.signaling.setState({ muted });
  }

  /* ------------------------- atalhos e atualizacao ---------------------- */

  /**
   * Troca a tecla de uma acao e persiste — reaplicada a cada boot em
   * `reaplicarHotkeysSalvos`, ja que o Rust sempre sobe com os padroes de
   * fabrica primeiro. Rejeita (throw) com o motivo quando a Rust nao aceita
   * a combinacao, pra UI mostrar o erro certo.
   */
  async rebindHotkey(
    action: "mute" | "deafen" | "share" | "talk",
    combo: RebindCombo
  ): Promise<HotkeyStatus> {
    const status = await rebindHotkeyNative(action, combo);
    const hotkeys = { ...loadPrefs().hotkeys, [action]: combo.code ? combo : null };
    savePrefs({ hotkeys });
    return status;
  }

  /** Reaplica no boot as combinacoes que o usuario trocou — o Rust so sabe
   *  dos padroes de fabrica, quem lembra do resto e o localStorage. */
  private async reaplicarHotkeysSalvos() {
    const salvos = loadPrefs().hotkeys;
    for (const action of ["mute", "deafen", "share", "talk"] as const) {
      const combo = salvos[action];
      if (combo === undefined) continue; // nunca mexeu: fica no padrao do Rust
      try {
        await rebindHotkeyNative(
          action,
          combo ?? { code: null, ctrl: false, shift: false, alt: false, label: null }
        );
      } catch (err) {
        app
          .getState()
          .toast("info", `Atalho de ${action} nao pode ser restaurado: ${(err as Error).message}`);
      }
    }
  }

  /** Atalhos globais vindos do Rust: funcionam com o app em segundo plano. */
  async initHotkeys() {
    await this.reaplicarHotkeysSalvos();
    return listenEvent<{ action: string; pressed: boolean }>("hotkey", (e) => {
      switch (e.action) {
        case "mute":
          if (!app.getState().pushToTalk) this.toggleMute();
          break;
        case "deafen":
          this.toggleDeafen();
          break;
        case "share":
          void this.toggleShare();
          break;
        case "talk":
          this.setTalking(e.pressed);
          break;
      }
    });
  }

  async checkUpdate({ silent = true } = {}) {
    app.setState({ updateBusy: true });
    const update = await checkForUpdate();
    app.setState({ updateBusy: false, updateVersion: update?.version ?? null });
    this.pendingUpdate = update?.install ?? null;

    if (update) app.getState().toast("info", `Versao ${update.version} disponivel`);
    else if (!silent) app.getState().toast("ok", "Voce ja esta na ultima versao");
  }

  async installUpdate() {
    if (!this.pendingUpdate) return;
    app.setState({ updateBusy: true });
    app.getState().toast("info", "Baixando atualizacao...");
    try {
      await this.pendingUpdate();
    } catch (err) {
      app.setState({ updateBusy: false });
      app.getState().toast("error", `Falha ao atualizar: ${(err as Error).message}`);
    }
  }

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
  debugSenders() {
    return this.mesh.debugSenders();
  }

  destroy() {
    this.pararEsperaDoMicrofone();
    this.leaveVoice();
    // `leaveVoice` ja passa por `stopShare`, mas se a captura de tela nunca
    // chegou a abrir (erro no meio) a thread do WASAPI podia continuar viva
    // sozinha do lado do Rust, sem ninguem consumindo.
    pararAudioDoSistema();
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
