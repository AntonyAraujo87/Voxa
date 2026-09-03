import { AUDIO_PRESETS, VIDEO_PRESETS, type Channel } from "./config";
import { LocalMedia } from "./localMedia";
import { listDevices } from "./media";
import { Mesh, type TuningState } from "./rtc";
import {
  Signaling,
  pingSignaling,
  type ChatMessage,
  type PeerUser,
  type RosterEntry,
} from "./signaling";
import { useApp } from "../store/store";
import { clearPeerMedia, setLocalScreen, setPeerStream } from "../store/mediaStore";
import { loadChannels, loadMessages, saveMessage, supabaseEnabled, upsertUser } from "./supabase";
import { loadPrefs, primePrefsCache, savePrefs } from "./prefs";
import { setOutputDevice, setOutputMode as aplicarModoSaida } from "./audioOutput";
import {
  checkForUpdate,
  flashTaskbar,
  focusWindow,
  isDesktop,
  listenEvent,
  rebindHotkey as rebindHotkeyNative,
  setPushToTalkNative,
  type HotkeyStatus,
  type RebindCombo,
} from "./desktop";
import { playJoin, playLeave, playMute, playUnmute, setSoundsEnabled } from "./sounds";

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

  private started = false;
  private mutedBeforeDeafen = false;
  private pendingUpdate: (() => Promise<void>) | null = null;
  /** trava contra duplo clique / atalho repetido durante o await da captura */
  private sharePending = false;
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
    });
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

    const { muted, deafened, sharing } = app.getState();
    this.signaling.setState({ muted, deafened, sharing });
    app.getState().toast("ok", "Reconectado ao canal");
  }

  /* -------------------------------- boot -------------------------------- */

  /** Le as preferencias salvas antes de qualquer render. */
  hydrate() {
    const prefs = loadPrefs();
    primePrefsCache(prefs);
    app.setState({
      tuning: prefs.tuning,
      micDeviceId: prefs.micDeviceId,
      outputDeviceId: prefs.outputDeviceId,
      outputMode: prefs.outputMode,
      volumes: prefs.volumes,
      streamVolumes: prefs.streamVolumes,
      membersOpen: prefs.membersOpen,
      showStats: prefs.showStats,
      pushToTalk: prefs.pushToTalk,
      muted: prefs.pushToTalk, // em push-to-talk o padrao e mudo ate apertar
      sounds: prefs.sounds,
    });
    setSoundsEnabled(prefs.sounds);
    void this.mesh.setTuning(prefs.tuning);
    aplicarModoSaida(prefs.outputMode === "nivelado");
    if (prefs.outputDeviceId && prefs.outputDeviceId !== "default") {
      void setOutputDevice(prefs.outputDeviceId);
    }
    return prefs;
  }

  async start(name: string, color: string, token: string): Promise<{ ok: boolean; error?: string }> {
    if (this.started) return { ok: true };

    const prefs = loadPrefs();

    // id estavel entre sessoes: volume por pessoa e autoria no Supabase
    // continuam apontando pra mesma identidade depois de reiniciar.
    const user: PeerUser = { id: prefs.userId, name, color };
    app.setState({ me: user });

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
    const { mics, speakers } = await listDevices();
    app.setState({ mics, speakers });
  }

  /* -------------------------------- texto ------------------------------- */

  async openTextChannel(id: string) {
    app.setState({ activeText: id });
    app.getState().clearUnread(id);
    if (app.getState().messages[id]) return;
    const history = await loadMessages(id);
    app.getState().setMessages(id, history);
  }

  sendChat(content: string) {
    const s = app.getState();
    const text = content.trim();
    if (!text || !s.me) return;

    // O servidor tambem limita, mas ali a mensagem excedente e descartada em
    // silencio. Barrando aqui, quem digitou entende o que aconteceu.
    if (!this.chatAllowance()) {
      s.toast("info", "Devagar com o chat — aguarde alguns segundos.");
      return;
    }

    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      channelId: s.activeText,
      content: text,
      authorId: s.me.id,
      authorName: s.me.name,
      authorColor: s.me.color,
      createdAt: new Date().toISOString(),
    };

    s.pushMessage(msg); // eco otimista: aparece antes de sair da maquina
    this.signaling.sendChat({ id: msg.id, channelId: msg.channelId, content: msg.content });
    void saveMessage(msg);
  }

  typing() {
    this.signaling.typing(app.getState().activeText);
  }

  /** canais que ja chegaram ao inicio do historico — evita consultas inuteis */
  private historicoCompleto = new Set<string>();
  private carregandoHistorico = false;

  /**
   * Carrega a pagina anterior do historico quando o usuario rola ao topo.
   * @returns quantas mensagens novas entraram
   */
  async loadOlderMessages(channelId: string): Promise<number> {
    if (this.carregandoHistorico || this.historicoCompleto.has(channelId)) return 0;

    const atuais = app.getState().messages[channelId] ?? [];
    if (atuais.length === 0) return 0;

    this.carregandoHistorico = true;
    try {
      const anteriores = await loadMessages(channelId, 40, atuais[0].createdAt);
      // Nada mais atras: marca o canal para nao consultar de novo a cada
      // rolagem ate o topo.
      if (anteriores.length === 0) {
        this.historicoCompleto.add(channelId);
        return 0;
      }
      app.getState().prependMessages(channelId, anteriores);
      return anteriores.length;
    } finally {
      this.carregandoHistorico = false;
    }
  }

  /** Mesma janela usada pelo servidor: 8 mensagens a cada 5 segundos. */
  private chatTimestamps: number[] = [];

  private chatAllowance(): boolean {
    const agora = Date.now();
    this.chatTimestamps = this.chatTimestamps.filter((t) => agora - t < 5000);
    if (this.chatTimestamps.length >= 8) return false;
    this.chatTimestamps.push(agora);
    return true;
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
    } catch (err) {
      semMicrofone = true;
      s.toast("info", `Entrando so para ouvir — ${(err as Error).message}`);
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
    this.stopShare();
    this.mesh.clear();
    for (const r of app.getState().roster) clearPeerMedia(r.id);
    this.signaling.leaveVoice();
    app.setState({
      activeVoice: null,
      focusPeer: null,
      watchingLive: false,
      stats: {},
      connState: {},
    });
    if (!keepMic) this.closeMic();
  }

  private async openMic() {
    const { tuning, micDeviceId, muted } = app.getState();
    const track = await this.media.openMic(tuning.audio, micDeviceId);
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

  /* ------------------------------ tela / jogo --------------------------- */

  async startShare() {
    const s = app.getState();
    // A captura e assincrona: sem esta trava, dois cliques rapidos (ou o
    // atalho global repetido) abririam duas capturas e vazariam um stream.
    if (s.sharing || this.sharePending) return;
    if (!s.activeVoice) {
      s.toast("info", "Entre num canal de voz antes de compartilhar.");
      return;
    }

    this.sharePending = true;
    try {
      const { stream, video, audio } = await this.media.openScreen(s.tuning.video, s.tuning.content);
      setLocalScreen(stream);
      await this.mesh.setScreen(video, audio);

      app.setState({ sharing: true, focusPeer: s.selfSocketId });
      this.signaling.setState({ sharing: true });

      const preset = VIDEO_PRESETS[s.tuning.video];
      s.toast("ok", `Compartilhando ${preset.width}x${preset.height} @ ${preset.fps}fps`);
    } catch (err) {
      this.media.closeScreen();
      setLocalScreen(null);
      s.toast("error", (err as Error).message);
    } finally {
      this.sharePending = false;
    }
  }

  stopShare() {
    if (!this.media.isSharing) return;
    void this.mesh.setScreen(null, null);
    this.media.closeScreen();
    setLocalScreen(null);

    const selfId = app.getState().selfSocketId;
    app.setState((s) => ({
      sharing: false,
      focusPeer: s.focusPeer === selfId ? null : s.focusPeer,
    }));
    this.signaling.setState({ sharing: false });
  }

  /**
   * Abre o seletor de fonte antes de compartilhar — como todo mundo espera,
   * ao estilo Discord. No navegador (dev/teste) nao precisa de seletor
   * proprio: getDisplayMedia() ja mostra o seletor nativo do Chrome sozinho.
   * No app empacotado, o WebView2 nao tem esse seletor embutido — por isso
   * existe o SharePicker, que escolhe ANTES de chamar getDisplayMedia().
   */
  async toggleShare() {
    if (app.getState().sharing) {
      this.stopShare();
      return;
    }
    if (!isDesktop) {
      await this.startShare();
      return;
    }
    // O atalho global pode disparar com a janela escondida na bandeja; o
    // seletor precisa estar visivel para poder escolher.
    await focusWindow();
    app.setState({ showSharePicker: true });
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
    this.leaveVoice();
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
