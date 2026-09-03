import { AUDIO_PRESETS, VIDEO_PRESETS, type Channel } from "./config";
import { LocalMedia } from "./localMedia";
import { listDevices } from "./media";
import { Mesh, type TuningState } from "./rtc";
import { Signaling, type ChatMessage, type PeerUser } from "./signaling";
import { useApp } from "../store/store";
import { clearPeerMedia, setLocalScreen, setPeerStream } from "../store/mediaStore";
import { loadChannels, loadMessages, saveMessage, supabaseEnabled, upsertUser } from "./supabase";
import { loadPrefs, primePrefsCache, savePrefs } from "./prefs";
import { checkForUpdate, listenEvent, setPushToTalkNative } from "./desktop";

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

  constructor() {
    this.signaling = new Signaling({
      onStatus: (status) => app.setState({ status }),
      onRoster: (roster) => app.setState({ roster }),
      onPeerState: (p) => app.getState().patchPeerState(p.id, p.state),
      onSignal: ({ from, data }) => void this.mesh.handleSignal(from, data),
      onChat: (msg) => app.getState().pushMessage(msg),
      onTyping: ({ channelId, name }) =>
        app.setState((s) => ({ typing: { ...s.typing, [name + channelId]: Date.now() } })),

      onPeerJoined: ({ id, channelId }) => {
        // Quem ja estava na sala apenas espera a oferta do recem-chegado.
        if (app.getState().activeVoice !== channelId) return;
        this.mesh.addPeer(id, false);
      },

      onPeerLeft: ({ id }) => {
        this.mesh.removePeer(id);
        clearPeerMedia(id);
        if (app.getState().focusPeer === id) app.setState({ focusPeer: null });
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

  /* -------------------------------- boot -------------------------------- */

  /** Le as preferencias salvas antes de qualquer render. */
  hydrate() {
    const prefs = loadPrefs();
    primePrefsCache(prefs);
    app.setState({
      tuning: prefs.tuning,
      micDeviceId: prefs.micDeviceId,
      volumes: prefs.volumes,
      membersOpen: prefs.membersOpen,
      showStats: prefs.showStats,
      pushToTalk: prefs.pushToTalk,
      muted: prefs.pushToTalk, // em push-to-talk o padrao e mudo ate apertar
    });
    void this.mesh.setTuning(prefs.tuning);
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
      return { ok: false, error: (err as Error).message || "Nao foi possivel conectar" };
    }

    this.started = true;
    savePrefs({ name, color, token });
    await this.openTextChannel(firstText);
    void this.refreshDevices();
    return { ok: true };
  }

  async refreshDevices() {
    const { mics } = await listDevices();
    app.setState({ mics });
  }

  /* -------------------------------- texto ------------------------------- */

  async openTextChannel(id: string) {
    app.setState({ activeText: id });
    if (app.getState().messages[id]) return;
    const history = await loadMessages(id);
    app.getState().setMessages(id, history);
  }

  sendChat(content: string) {
    const s = app.getState();
    const text = content.trim();
    if (!text || !s.me) return;

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

  /* --------------------------------- voz -------------------------------- */

  async joinVoice(channelId: string) {
    const s = app.getState();
    if (s.activeVoice === channelId) return;
    if (s.activeVoice) this.leaveVoice({ keepMic: true });

    try {
      await this.openMic();
    } catch (err) {
      s.toast("error", (err as Error).message);
      return;
    }

    // Marca o canal ANTES do ack: se alguem entrar nesse intervalo, o
    // onPeerJoined ja reconhece o canal e nao descarta o peer.
    app.setState({ activeVoice: channelId });
    const { peers } = await this.signaling.joinVoice(channelId);

    // Nos chegamos por ultimo => nos ofertamos pra todo mundo que ja estava.
    for (const peer of peers) this.mesh.addPeer(peer.id, true);
    this.signaling.setState({ muted: app.getState().muted });
  }

  leaveVoice({ keepMic = false } = {}) {
    this.stopShare();
    this.mesh.clear();
    for (const r of app.getState().roster) clearPeerMedia(r.id);
    this.signaling.leaveVoice();
    app.setState({ activeVoice: null, focusPeer: null, stats: {}, connState: {} });
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

  /** Atalhos globais vindos do Rust: funcionam com o app em segundo plano. */
  async initHotkeys() {
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

  async toggleShare() {
    if (app.getState().sharing) this.stopShare();
    else await this.startShare();
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
