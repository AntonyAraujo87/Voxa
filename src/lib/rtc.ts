import {
  AUDIO_PRESETS,
  CODEC_ORDER,
  PC_CONFIG,
  SCREEN_AUDIO_BITRATE,
  VIDEO_PRESETS,
  type AudioPresetId,
  type CodecStrategy,
  type ContentMode,
  type VideoPresetId,
} from "./config";
import { tuneSdp } from "./sdp";
import type { SignalPayload } from "./signaling";

/* ---------------------------------------------------------------------------
   Malha P2P (full mesh). Cada participante abre 1 RTCPeerConnection com cada
   outro. Zero servidor de midia => zero custo, latencia minima (1 hop).
   Custo: o upload cresce linear com o numero de espectadores. Ate ~5 pessoas
   numa sala com 1 tela compartilhada, mesh e a escolha certa.

   Cada conexao tem SEMPRE 3 m-lines, criadas na mesma ordem nos dois lados:
     0: audio  -> microfone
     1: video  -> tela
     2: audio  -> som do sistema/jogo
   Ordem fixa = SDP simetrico = renegociacao previsivel, e da pra rotear o
   ontrack pelo transceiver, sem depender de ids de stream.
--------------------------------------------------------------------------- */

export type TrackKind = "mic" | "screen" | "screenAudio";

export interface PeerStats {
  outKbps: number;
  inKbps: number;
  fps: number;
  width: number;
  height: number;
  rttMs: number;
  jitterMs: number;
  lossPct: number;
  availableOutKbps: number;
  codec: string;
  encoder: string;
  decoder: string;
  limitation: string;
  connection: RTCPeerConnectionState;
  /** como a midia esta trafegando: direto entre os dois ou por um relay TURN */
  path: "direto" | "relay" | "-";
}

const EMPTY_STATS: PeerStats = {
  outKbps: 0,
  inKbps: 0,
  fps: 0,
  width: 0,
  height: 0,
  rttMs: 0,
  jitterMs: 0,
  lossPct: 0,
  availableOutKbps: 0,
  codec: "-",
  encoder: "-",
  decoder: "-",
  limitation: "none",
  connection: "new",
  path: "-",
};

export interface MeshOptions {
  selfId: () => string;
  send: (to: string, data: SignalPayload) => void;
  onTrack: (peerId: string, kind: TrackKind, stream: MediaStream | null) => void;
  onConnectionState: (peerId: string, state: RTCPeerConnectionState) => void;
  onStats: (stats: Map<string, PeerStats>) => void;
  onSpeaking: (peerId: string, speaking: boolean) => void;
  onError: (peerId: string, err: unknown) => void;
}

export interface TuningState {
  video: VideoPresetId;
  audio: AudioPresetId;
  codec: CodecStrategy;
  content: ContentMode;
}

interface Sample {
  bytes: number;
  ts: number;
  packets: number;
  lost: number;
}

class Peer {
  pc: RTCPeerConnection;
  micTx!: RTCRtpTransceiver;
  videoTx!: RTCRtpTransceiver;
  screenAudioTx!: RTCRtpTransceiver;

  // --- perfect negotiation ---
  makingOffer = false;
  ignoreOffer = false;
  settingRemoteAnswer = false;

  /** transceivers ja mapeados (criados por nos ou vindos da oferta remota) */
  ready = false;

  lastOut: Sample = { bytes: 0, ts: 0, packets: 0, lost: 0 };
  lastIn: Sample = { bytes: 0, ts: 0, packets: 0, lost: 0 };
  stats: PeerStats = { ...EMPTY_STATS };
  speaking = false;

  constructor(
    readonly id: string,
    readonly polite: boolean
  ) {
    this.pc = new RTCPeerConnection(PC_CONFIG);
  }
}

export class Mesh {
  private peers = new Map<string, Peer>();
  private micTrack: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  private screenAudioTrack: MediaStreamTrack | null = null;
  private statsTimer = 0;
  private speakTimer = 0;

  tuning: TuningState = { video: "alta", audio: "voz", codec: "hardware", content: "jogo" };

  constructor(private opts: MeshOptions) {
    this.statsTimer = window.setInterval(() => void this.collectStats(), 1000);
    this.speakTimer = window.setInterval(() => this.detectSpeaking(), 150);
  }

  /* ----------------------------- CICLO DE VIDA --------------------------- */

  addPeer(id: string, initiator: boolean): Peer {
    const existing = this.peers.get(id);
    if (existing) return existing;

    // "Polite" resolve colisao de oferta sem handshake extra: o educado desfaz
    // a propria oferta, o grosseiro ignora a do outro. Criterio deterministico
    // e igual dos dois lados: comparacao lexicografica dos ids.
    const polite = this.opts.selfId() > id;
    const peer = new Peer(id, polite);
    this.peers.set(id, peer);

    peer.pc.onicecandidate = ({ candidate }) => {
      this.opts.send(id, { candidate: candidate ? candidate.toJSON() : null });
    };

    const negotiate = async () => {
      try {
        peer.makingOffer = true;
        const offer = await peer.pc.createOffer();
        offer.sdp = this.tuneSdpFor(offer.sdp!);
        await peer.pc.setLocalDescription(offer);
        this.opts.send(id, { description: peer.pc.localDescription!.toJSON() });
      } catch (err) {
        this.opts.onError(id, err);
      } finally {
        peer.makingOffer = false;
      }
    };

    peer.pc.onnegotiationneeded = () => void negotiate();

    peer.pc.ontrack = (ev) => {
      // Roteamento por POSICAO da m-line, nao por identidade do transceiver:
      // quando somos o lado que responde, os transceivers nascem dentro do
      // setRemoteDescription e o ontrack dispara antes de mapearmos as refs.
      const index = peer.pc.getTransceivers().indexOf(ev.transceiver);
      const kind: TrackKind = index === 1 ? "screen" : index === 2 ? "screenAudio" : "mic";

      this.opts.onTrack(id, kind, new MediaStream([ev.track]));

      // replaceTrack(null) do outro lado chega aqui como mute/unmute — e assim
      // que detectamos "parou de compartilhar" sem renegociar nada.
      ev.track.onmute = () => this.opts.onTrack(id, kind, null);
      ev.track.onunmute = () => this.opts.onTrack(id, kind, new MediaStream([ev.track]));
      ev.track.onended = () => this.opts.onTrack(id, kind, null);
    };

    peer.pc.onconnectionstatechange = () => {
      const state = peer.pc.connectionState;
      peer.stats.connection = state;
      this.opts.onConnectionState(id, state);
      if (state === "connected") void this.applyEncoding(peer);
      if (state === "failed") {
        try {
          peer.pc.restartIce();
        } catch {
          /* noop */
        }
      }
    };

    // Quem chega na sala e quem oferta. O lado que recebe nao cria transceiver
    // nenhum ate a oferta chegar — assim nao existe glare e a m-line sai
    // identica dos dois lados.
    if (initiator) {
      peer.micTx = peer.pc.addTransceiver("audio", { direction: "sendrecv" });
      peer.videoTx = peer.pc.addTransceiver("video", { direction: "sendrecv" });
      peer.screenAudioTx = peer.pc.addTransceiver("audio", { direction: "sendrecv" });
      peer.ready = true;
      this.applyCodecPreferences(peer);
      this.attachLocalTracks(peer);
      queueMicrotask(() => void negotiate());
    }

    this.rebalance();
    return peer;
  }

  /** Mapeia os transceivers criados pela oferta remota (lado que responde). */
  private adoptTransceivers(peer: Peer) {
    if (peer.ready) return;
    const txs = peer.pc.getTransceivers();
    if (txs.length < 3) return;
    peer.micTx = txs[0];
    peer.videoTx = txs[1];
    peer.screenAudioTx = txs[2];
    // Nascem "recvonly" (nao tinham track na criacao). Sem isso, o answer diria
    // que nao mandamos nada e nosso microfone nunca sairia daqui.
    for (const tx of [peer.micTx, peer.videoTx, peer.screenAudioTx]) {
      try {
        tx.direction = "sendrecv";
      } catch {
        /* noop */
      }
    }
    peer.ready = true;
    this.applyCodecPreferences(peer);
    this.attachLocalTracks(peer);
  }

  private attachLocalTracks(peer: Peer) {
    if (!peer.ready) return;
    if (this.micTrack) void peer.micTx.sender.replaceTrack(this.micTrack);
    if (this.screenTrack) void peer.videoTx.sender.replaceTrack(this.screenTrack);
    if (this.screenAudioTrack) void peer.screenAudioTx.sender.replaceTrack(this.screenAudioTrack);
  }

  removePeer(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onnegotiationneeded = null;
    peer.pc.onconnectionstatechange = null;
    try {
      peer.pc.close();
    } catch {
      /* noop */
    }
    this.peers.delete(id);
    this.opts.onTrack(id, "mic", null);
    this.opts.onTrack(id, "screen", null);
    this.opts.onTrack(id, "screenAudio", null);
    this.rebalance();
  }

  /** Redistribui o teto de upload depois que alguem entra ou sai. */
  private rebalance() {
    for (const peer of this.peers.values()) void this.applyEncoding(peer);
  }

  clear() {
    for (const id of [...this.peers.keys()]) this.removePeer(id);
  }

  destroy() {
    window.clearInterval(this.statsTimer);
    window.clearInterval(this.speakTimer);
    this.clear();
  }

  /* ------------------------------ SIGNALING ------------------------------ */

  async handleSignal(from: string, data: SignalPayload) {
    const peer = this.peers.get(from) ?? this.addPeer(from, false);

    try {
      if ("description" in data && data.description) {
        const desc = data.description;
        const readyForOffer =
          !peer.makingOffer && (peer.pc.signalingState === "stable" || peer.settingRemoteAnswer);
        const collision = desc.type === "offer" && !readyForOffer;

        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;

        peer.settingRemoteAnswer = desc.type === "answer";
        await peer.pc.setRemoteDescription(desc);
        peer.settingRemoteAnswer = false;

        if (desc.type === "offer") {
          this.adoptTransceivers(peer);
          const answer = await peer.pc.createAnswer();
          answer.sdp = this.tuneSdpFor(answer.sdp!);
          await peer.pc.setLocalDescription(answer);
          this.opts.send(from, { description: peer.pc.localDescription!.toJSON() });
          void this.applyEncoding(peer);
        }
      } else if ("candidate" in data) {
        try {
          await peer.pc.addIceCandidate(data.candidate ?? undefined);
        } catch (err) {
          if (!peer.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      this.opts.onError(from, err);
    }
  }

  /* -------------------------- TRACKS LOCAIS ------------------------------ */

  async setMic(track: MediaStreamTrack | null) {
    this.micTrack = track;
    await Promise.all(
      [...this.peers.values()]
        .filter((p) => p.ready)
        .map((p) => p.micTx.sender.replaceTrack(track))
    );
  }

  async setScreen(video: MediaStreamTrack | null, audio: MediaStreamTrack | null) {
    this.screenTrack = video;
    this.screenAudioTrack = audio;
    await Promise.all(
      [...this.peers.values()].filter((p) => p.ready).map(async (p) => {
        await p.videoTx.sender.replaceTrack(video);
        await p.screenAudioTx.sender.replaceTrack(audio);
        await this.applyEncoding(p);
      })
    );
  }

  /* --------------------------- QUALIDADE --------------------------------- */

  async setTuning(next: Partial<TuningState>) {
    const before = this.tuning;
    this.tuning = { ...before, ...next };

    if (next.content && this.screenTrack) {
      this.screenTrack.contentHint = this.tuning.content === "jogo" ? "motion" : "detail";
    }
    if (next.codec && next.codec !== before.codec) {
      for (const peer of this.peers.values()) this.applyCodecPreferences(peer);
    }

    await Promise.all([...this.peers.values()].map((p) => this.applyEncoding(p)));
  }

  private applyCodecPreferences(peer: Peer) {
    if (!peer.ready) return;
    const caps = RTCRtpReceiver.getCapabilities("video");
    if (!caps || typeof peer.videoTx.setCodecPreferences !== "function") return;
    const order = CODEC_ORDER[this.tuning.codec];

    const rank = (mime: string) => {
      const name = mime.split("/")[1]?.toUpperCase() ?? "";
      const i = order.findIndex((c) => c === name);
      return i === -1 ? order.length + 1 : i;
    };

    // rtx/red/fec ficam no fim, mas NAO podem sumir: sem rtx nao ha
    // retransmissao e qualquer perda vira macroblock congelado na tela.
    const isAux = (m: string) => /(rtx|red|ulpfec|flexfec)/i.test(m);
    const sorted = [...caps.codecs].sort((a, b) => {
      const ax = isAux(a.mimeType) ? 1 : 0;
      const bx = isAux(b.mimeType) ? 1 : 0;
      if (ax !== bx) return ax - bx;
      return rank(a.mimeType) - rank(b.mimeType);
    });

    try {
      peer.videoTx.setCodecPreferences(sorted);
    } catch {
      /* codec recusado, segue o baile */
    }
  }

  /** maxBitrate / maxFramerate / degradationPreference no sender. */
  /**
   * Numa malha, a MESMA tela e codificada e enviada uma vez por espectador.
   * 15 Mbps para 3 pessoas = 45 Mbps de upload, que quase ninguem tem. Entao o
   * teto por conexao e dividido pelo numero de peers, respeitando o piso do
   * preset (abaixo dele a imagem vira sopa e e melhor baixar a resolucao).
   */
  private budgetPerPeer(): number {
    const preset = VIDEO_PRESETS[this.tuning.video];
    const viewers = Math.max(1, this.peers.size);
    return Math.max(preset.minBitrate, Math.round(preset.maxBitrate / viewers));
  }

  private async applyEncoding(peer: Peer) {
    if (!peer.ready) return;
    const preset = VIDEO_PRESETS[this.tuning.video];
    const sender = peer.videoTx.sender;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    const enc = params.encodings[0] as RTCRtpEncodingParameters & Record<string, unknown>;
    enc.maxBitrate = this.budgetPerPeer();
    enc.maxFramerate = preset.fps;
    enc.scaleResolutionDownBy = 1;
    enc.priority = "high";
    enc.networkPriority = "high";
    // O interruptor central do "modo jogo": quando a rede aperta, o encoder
    // escolhe entre derrubar RESOLUCAO ou FRAMERATE. Parsec segura o framerate.
    (params as unknown as Record<string, unknown>).degradationPreference =
      this.tuning.content === "jogo" ? "maintain-framerate" : "maintain-resolution";

    try {
      await sender.setParameters(params);
    } catch {
      /* alguns estados de negociacao rejeitam; a proxima passada pega */
    }

    try {
      const aParams = peer.micTx.sender.getParameters();
      if (aParams.encodings?.length) {
        aParams.encodings[0].maxBitrate = AUDIO_PRESETS[this.tuning.audio].bitrate;
        (aParams.encodings[0] as unknown as Record<string, unknown>).networkPriority = "high";
        await peer.micTx.sender.setParameters(aParams);
      }
      const sParams = peer.screenAudioTx.sender.getParameters();
      if (sParams.encodings?.length) {
        sParams.encodings[0].maxBitrate = SCREEN_AUDIO_BITRATE;
        await peer.screenAudioTx.sender.setParameters(sParams);
      }
    } catch {
      /* noop */
    }
  }

  private tuneSdpFor(sdp: string): string {
    const v = VIDEO_PRESETS[this.tuning.video];
    const a = AUDIO_PRESETS[this.tuning.audio];
    return tuneSdp(sdp, {
      video: {
        startKbps: Math.round(v.startBitrate / 1000),
        minKbps: Math.round(v.minBitrate / 1000),
        maxKbps: Math.round(v.maxBitrate / 1000),
      },
      micAudio: {
        stereo: a.stereo,
        bitrate: a.bitrate,
        dtx: a.id === "voz",
        ptimeMs: a.id === "voz" ? 20 : 10,
      },
      screenAudio: {
        stereo: true,
        bitrate: SCREEN_AUDIO_BITRATE,
        dtx: false,
        ptimeMs: 10,
      },
    });
  }

  /* ------------------------------ METRICAS ------------------------------- */

  private async collectStats() {
    if (this.peers.size === 0) return;
    const out = new Map<string, PeerStats>();

    await Promise.all(
      [...this.peers.values()].map(async (peer) => {
        try {
          const report = await peer.pc.getStats();
          const s: PeerStats = { ...peer.stats, connection: peer.pc.connectionState };
          const codecs = new Map<string, string>();
          const candidates = new Map<string, string>();

          report.forEach((r: Record<string, unknown>) => {
            if (r.type === "codec") {
              codecs.set(r.id as string, String(r.mimeType ?? "").split("/")[1] ?? "-");
            }
            if (r.type === "local-candidate" || r.type === "remote-candidate") {
              candidates.set(r.id as string, String(r.candidateType ?? ""));
            }
          });

          report.forEach((r: Record<string, unknown>) => {
            if (r.type === "outbound-rtp" && r.kind === "video") {
              const ts = r.timestamp as number;
              const bytes = (r.bytesSent as number) ?? 0;
              if (peer.lastOut.ts && ts > peer.lastOut.ts) {
                s.outKbps = Math.round(((bytes - peer.lastOut.bytes) * 8) / (ts - peer.lastOut.ts));
              }
              peer.lastOut = { bytes, ts, packets: 0, lost: 0 };
              s.fps = Math.round((r.framesPerSecond as number) ?? 0);
              s.encoder = String(r.encoderImplementation ?? "-");
              s.limitation = String(r.qualityLimitationReason ?? "none");
              if (r.codecId) s.codec = codecs.get(r.codecId as string) ?? s.codec;
            }

            if (r.type === "inbound-rtp" && r.kind === "video") {
              const ts = r.timestamp as number;
              const bytes = (r.bytesReceived as number) ?? 0;
              const packets = (r.packetsReceived as number) ?? 0;
              const lost = (r.packetsLost as number) ?? 0;
              if (peer.lastIn.ts && ts > peer.lastIn.ts) {
                s.inKbps = Math.round(((bytes - peer.lastIn.bytes) * 8) / (ts - peer.lastIn.ts));
                const dp = packets - peer.lastIn.packets;
                const dl = lost - peer.lastIn.lost;
                s.lossPct = dp + dl > 0 ? Math.max(0, (dl / (dp + dl)) * 100) : 0;
              }
              peer.lastIn = { bytes, ts, packets, lost };
              s.fps = Math.round((r.framesPerSecond as number) ?? s.fps);
              s.width = (r.frameWidth as number) ?? s.width;
              s.height = (r.frameHeight as number) ?? s.height;
              s.jitterMs = Math.round(((r.jitter as number) ?? 0) * 1000);
              s.decoder = String(r.decoderImplementation ?? "-");
              if (r.codecId) s.codec = codecs.get(r.codecId as string) ?? s.codec;
            }

            if (r.type === "candidate-pair" && (r.nominated || r.state === "succeeded")) {
              const rtt = (r.currentRoundTripTime as number) ?? 0;
              if (rtt) s.rttMs = Math.round(rtt * 1000);
              const avail = (r.availableOutgoingBitrate as number) ?? 0;
              if (avail) s.availableOutKbps = Math.round(avail / 1000);

              // "relay" = passando por TURN (custa banda de quem paga o TURN).
              const local = candidates.get(r.localCandidateId as string) ?? "";
              const remote = candidates.get(r.remoteCandidateId as string) ?? "";
              if (local || remote) {
                s.path = local === "relay" || remote === "relay" ? "relay" : "direto";
              }
            }
          });

          peer.stats = s;
          out.set(peer.id, s);
        } catch {
          /* peer morreu no meio da coleta */
        }
      })
    );

    this.opts.onStats(out);
  }

  /**
   * Fala dos remotos via getSynchronizationSources(): o proprio RTP carrega o
   * nivel de audio (RFC 6464). Nao precisa de WebAudio, custo perto de zero.
   */
  private detectSpeaking() {
    for (const peer of this.peers.values()) {
      if (!peer.ready) continue;
      const receiver = peer.micTx.receiver as RTCRtpReceiver & {
        getSynchronizationSources?: () => { audioLevel?: number }[];
      };
      const sources = receiver.getSynchronizationSources?.();

      let level = 0;
      if (sources?.length) level = Math.max(...sources.map((s) => s.audioLevel ?? 0));
      const speaking = level > 0.012;
      if (speaking !== peer.speaking) {
        peer.speaking = speaking;
        this.opts.onSpeaking(peer.id, speaking);
      }
    }
  }

  get size() {
    return this.peers.size;
  }

  /** Snapshot pra depuracao: teto de bitrate realmente aplicado em cada sender. */
  debugSenders() {
    return [...this.peers.values()].map((p) => ({
      id: p.id,
      ready: p.ready,
      connection: p.pc.connectionState,
      encodings: p.ready ? p.videoTx.sender.getParameters().encodings : [],
      degradation: p.ready
        ? (p.videoTx.sender.getParameters() as unknown as Record<string, unknown>)
            .degradationPreference
        : null,
    }));
  }
}
