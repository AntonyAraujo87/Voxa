import { AUDIO_PRESETS, VIDEO_PRESETS, type Channel } from "./config";
import { captureMic, captureScreen, createVoiceDetector, listDevices, stopStream } from "./media";
import { Mesh, type TuningState } from "./rtc";
import { Signaling, type ChatMessage, type PeerUser } from "./signaling";
import * as store from "../store/store";
import {
  clearPeerMedia,
  setLocalScreen,
  setPeerStream,
} from "../store/mediaStore";
import { loadChannels, loadMessages, saveMessage, supabaseEnabled, upsertUser } from "./supabase";
import { loadPrefs, primePrefsCache, savePrefs } from "./prefs";
import { checkForUpdate, listenEvent, setPushToTalkNative } from "./desktop";

const app = store.useApp;

/* ---------------------------------------------------------------------------
   Orquestrador. Une signaling + mesh + captura + store.
   Vive fora do React de proposito: nada aqui causa render por si so; a UI so
   reage as fatias do zustand que realmente mudaram.
--------------------------------------------------------------------------- */

class Session {
  private signaling: Signaling;
  private mesh: Mesh;
  private micStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private stopVad: (() => void) | null = null;
  private started = false;

  constructor() {
    this.signaling = new Signaling({
      onStatus: (status) => app.setState({ status }),
      onRoster: (roster) => app.setState({ roster }),
      onPeerState: (p) => app.getState().patchPeerState(p.id, p.state),
      onSignal: ({ from, data }) => void this.mesh.handleSignal(from, data),
      onChat: (msg) => {
        app.getState().pushMessage(msg);
      },
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
      onError: (peerId, err) => {
        console.error("[rtc]", peerId, err);
      },
    });
  }

  /* ------------------------------- BOOT ---------------------------------- */

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

    // Supabase e opcional: se der ruim, o app segue em modo efemero.
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

  /* ------------------------------- TEXTO --------------------------------- */

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
    void saveMessage(msg, s.supabaseUserId);
  }

  typing() {
    this.signaling.typing(app.getState().activeText);
  }

  /* -------------------------------- VOZ ---------------------------------- */

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
    if (this.micStream) return;
    const { tuning, micDeviceId } = app.getState();
    const stream = await captureMic(tuning.audio, micDeviceId);
    this.micStream = stream;

    const track = stream.getAudioTracks()[0];
    track.enabled = !app.getState().muted;
    await this.mesh.setMic(track);

    this.stopVad = createVoiceDetector(stream, (speaking) => {
      const selfId = app.getState().selfSocketId;
      app.setState((s) => ({ speaking: { ...s.speaking, [selfId]: speaking } }));
      this.signaling.setState({ speaking });
    });

    app.setState({ micReady: true });
  }

  private closeMic() {
    this.stopVad?.();
    this.stopVad = null;
    void this.mesh.setMic(null);
    stopStream(this.micStream);
    this.micStream = null;
    app.setState({ micReady: false });
  }

  toggleMute() {
    const muted = !app.getState().muted;
    app.setState({ muted });
    const track = this.micStream?.getAudioTracks()[0];
    // enabled=false continua enviando pacotes de silencio: nao renegocia nada,
    // o unmute e instantaneo e o outro lado nao ve a conexao piscar.
    if (track) track.enabled = !muted;
    this.signaling.setState({ muted });
  }

  private mutedBeforeDeafen = false;

  toggleDeafen() {
    const deafened = !app.getState().deafened;
    // Ensurdecer forca mute; desensurdecer devolve o microfone ao estado que
    // ele tinha antes — igual ao Discord.
    if (deafened) this.mutedBeforeDeafen = app.getState().muted;
    const muted = deafened ? true : this.mutedBeforeDeafen;

    app.setState({ deafened, muted });
    const track = this.micStream?.getAudioTracks()[0];
    if (track) track.enabled = !muted;
    this.signaling.setState({ deafened, muted });
  }

  async setMicDevice(deviceId: string) {
    app.setState({ micDeviceId: deviceId });
    savePrefs({ micDeviceId: deviceId });
    if (!this.micStream) return;
    this.closeMic();
    await this.openMic();
  }

  /* --------------------------- PUSH-TO-TALK ------------------------------- */

  async setPushToTalk(enabled: boolean) {
    app.setState({ pushToTalk: enabled, muted: enabled, talking: false });
    savePrefs({ pushToTalk: enabled });
    const track = this.micStream?.getAudioTracks()[0];
    if (track) track.enabled = !enabled;
    this.signaling.setState({ muted: enabled });
    await setPushToTalkNative(enabled);
  }

  /** Chamado na descida e na subida da tecla de push-to-talk. */
  setTalking(active: boolean) {
    const s = app.getState();
    if (!s.pushToTalk || s.talking === active) return;
    const muted = !active || s.deafened;
    app.setState({ talking: active, muted });
    const track = this.micStream?.getAudioTracks()[0];
    if (track) track.enabled = !muted;
    this.signaling.setState({ muted });
  }

  /* ------------------------- ATALHOS E UPDATE ------------------------------ */

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
    if (update) {
      app.getState().toast("info", `Versao ${update.version} disponivel`);
    } else if (!silent) {
      app.getState().toast("ok", "Voce ja esta na ultima versao");
    }
  }

  private pendingUpdate: (() => Promise<void>) | null = null;

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

  /* ---------------------------- TELA / JOGO ------------------------------- */

  async startShare() {
    const s = app.getState();
    if (s.sharing) return;
    if (!s.activeVoice) {
      s.toast("info", "Entre num canal de voz antes de compartilhar.");
      return;
    }

    try {
      const preset = VIDEO_PRESETS[s.tuning.video];
      const { stream, video, audio } = await captureScreen(preset, s.tuning.content);
      this.screenStream = stream;
      setLocalScreen(stream);

      await this.mesh.setScreen(video, audio);

      // Parar pelo botao nativo do Windows tambem tem que refletir na UI.
      video.onended = () => this.stopShare();

      app.setState({ sharing: true, focusPeer: s.selfSocketId });
      this.signaling.setState({ sharing: true });
      s.toast("ok", `Compartilhando ${preset.width}x${preset.height} @ ${preset.fps}fps`);
    } catch (err) {
      s.toast("error", (err as Error).message);
    }
  }

  stopShare() {
    if (!this.screenStream) return;
    void this.mesh.setScreen(null, null);
    stopStream(this.screenStream);
    this.screenStream = null;
    setLocalScreen(null);
    const selfId = app.getState().selfSocketId;
    app.setState((s) => ({ sharing: false, focusPeer: s.focusPeer === selfId ? null : s.focusPeer }));
    this.signaling.setState({ sharing: false });
  }

  async toggleShare() {
    if (app.getState().sharing) this.stopShare();
    else await this.startShare();
  }

  /* ----------------------------- QUALIDADE -------------------------------- */

  async setTuning(patch: Partial<TuningState>) {
    const next = { ...app.getState().tuning, ...patch };
    app.setState({ tuning: next });
    savePrefs({ tuning: next });
    await this.mesh.setTuning(patch);

    // Trocar o preset de audio muda os constraints da captura: precisa
    // reabrir o microfone pra o DSP entrar/sair do caminho.
    if (patch.audio && this.micStream) {
      this.closeMic();
      await this.openMic();
      app.getState().toast("info", `Audio: ${AUDIO_PRESETS[next.audio].label}`);
    }

    // Resolucao/fps mudam a captura da tela: reaplica no track vivo.
    if ((patch.video || patch.content) && this.screenStream) {
      const preset = VIDEO_PRESETS[next.video];
      const track = this.screenStream.getVideoTracks()[0];
      if (track) {
        track.contentHint = next.content === "jogo" ? "motion" : "detail";
        try {
          await track.applyConstraints({
            frameRate: { ideal: preset.fps, max: preset.fps },
            width: { ideal: preset.width, max: preset.width },
            height: { ideal: preset.height, max: preset.height },
          });
        } catch {
          /* a fonte nao aceita; o encoder ainda respeita maxBitrate/maxFramerate */
        }
      }
    }
  }

  /** so pra depuracao no console */
  debugSenders() {
    return this.mesh.debugSenders();
  }

  destroy() {
    this.leaveVoice();
    this.mesh.destroy();
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
