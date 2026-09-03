import { PC_CONFIG } from "../config";
import type { SignalPayload } from "../signaling";
import { readStats, newSamples, type StatsSamples } from "./stats";
import {
  applyAudioEncoding,
  applyCodecPreferences,
  applyVideoEncoding,
  tuneSessionDescription,
  type EncodingTargets,
} from "./tuning";
import {
  EMPTY_STATS,
  type LocalTracks,
  type PeerCallbacks,
  type PeerStats,
  type TrackKind,
  type TuningState,
} from "./types";

/* ---------------------------------------------------------------------------
   Uma conexao com UM outro participante.

   Responsabilidades: negociacao (perfect negotiation), ciclo de vida dos
   transceivers, aplicacao dos parametros de encoder e leitura de metricas.
   Nao conhece a sala, nao conhece os outros pares — quem coordena e o Mesh.
--------------------------------------------------------------------------- */

export class Peer {
  readonly pc: RTCPeerConnection;

  private micTx?: RTCRtpTransceiver;
  private videoTx?: RTCRtpTransceiver;
  private screenAudioTx?: RTCRtpTransceiver;

  // --- perfect negotiation ---
  private makingOffer = false;
  private ignoreOffer = false;
  private settingRemoteAnswer = false;

  /** transceivers ja mapeados (criados por nos ou vindos da oferta remota) */
  private ready = false;

  private samples: StatsSamples = newSamples();
  stats: PeerStats = { ...EMPTY_STATS };
  speaking = false;

  constructor(
    readonly id: string,
    /** o educado desfaz a propria oferta numa colisao; o grosseiro ignora a do outro */
    private readonly polite: boolean,
    private readonly tuning: () => TuningState,
    private readonly cb: PeerCallbacks
  ) {
    this.pc = new RTCPeerConnection(PC_CONFIG);
    this.wire();
  }

  get isReady() {
    return this.ready;
  }

  /* --------------------------- ciclo de vida ---------------------------- */

  private wire() {
    this.pc.onicecandidate = ({ candidate }) => {
      this.cb.send(this.id, { candidate: candidate ? candidate.toJSON() : null });
    };

    this.pc.onnegotiationneeded = () => void this.negotiate();

    this.pc.ontrack = (ev) => {
      // Roteamento por POSICAO da m-line, nao por identidade do transceiver:
      // quando somos o lado que responde, os transceivers nascem dentro do
      // setRemoteDescription e o ontrack dispara antes de mapearmos as refs.
      const index = this.pc.getTransceivers().indexOf(ev.transceiver);
      const kind: TrackKind = index === 1 ? "screen" : index === 2 ? "screenAudio" : "mic";

      this.cb.onTrack(this.id, kind, new MediaStream([ev.track]));

      // replaceTrack(null) do outro lado chega aqui como mute/unmute — e assim
      // que detectamos "parou de compartilhar" sem renegociar nada.
      ev.track.onmute = () => this.cb.onTrack(this.id, kind, null);
      ev.track.onunmute = () => this.cb.onTrack(this.id, kind, new MediaStream([ev.track]));
      ev.track.onended = () => this.cb.onTrack(this.id, kind, null);
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      this.stats.connection = state;
      this.cb.onConnectionState(this.id, state);
    };
  }

  /**
   * Quem chega na sala oferta primeiro. Criamos os tres transceivers na ordem
   * canonica; o outro lado apenas responde, o que elimina glare por construcao.
   */
  initiate(tracks: LocalTracks, targets: EncodingTargets) {
    if (this.ready) return;
    this.micTx = this.pc.addTransceiver("audio", { direction: "sendrecv" });
    this.videoTx = this.pc.addTransceiver("video", { direction: "sendrecv" });
    this.screenAudioTx = this.pc.addTransceiver("audio", { direction: "sendrecv" });
    this.ready = true;

    applyCodecPreferences(this.videoTx, this.tuning().codec);
    this.attachTracks(tracks);
    void this.applyEncoding(targets);
    queueMicrotask(() => void this.negotiate());
  }

  /** Mapeia os transceivers que a oferta remota criou (lado que responde). */
  private adopt(tracks: LocalTracks) {
    if (this.ready) return;
    const txs = this.pc.getTransceivers();
    if (txs.length < 3) return;

    [this.micTx, this.videoTx, this.screenAudioTx] = txs;

    // Nascem "recvonly" por nao terem track na criacao. Sem corrigir, o answer
    // diria que nao enviamos nada e nosso microfone nunca sairia daqui.
    for (const tx of [this.micTx, this.videoTx, this.screenAudioTx]) {
      try {
        tx.direction = "sendrecv";
      } catch {
        /* alguns estados recusam a troca; o track ainda vai pelo replaceTrack */
      }
    }

    this.ready = true;
    applyCodecPreferences(this.videoTx, this.tuning().codec);
    this.attachTracks(tracks);
  }

  attachTracks(tracks: LocalTracks) {
    if (!this.ready) return;
    void this.micTx?.sender.replaceTrack(tracks.mic);
    void this.videoTx?.sender.replaceTrack(tracks.screen);
    void this.screenAudioTx?.sender.replaceTrack(tracks.screenAudio);
  }

  close() {
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onnegotiationneeded = null;
    this.pc.onconnectionstatechange = null;
    try {
      this.pc.close();
    } catch {
      /* ja fechada */
    }
  }

  /* ---------------------------- negociacao ------------------------------ */

  private async negotiate() {
    try {
      this.makingOffer = true;
      const offer = await this.pc.createOffer();
      offer.sdp = tuneSessionDescription(offer.sdp!, this.tuning());
      await this.pc.setLocalDescription(offer);
      this.cb.send(this.id, { description: this.pc.localDescription!.toJSON() });
    } catch (err) {
      this.cb.onError(this.id, err);
    } finally {
      this.makingOffer = false;
    }
  }

  async handleSignal(data: SignalPayload, tracks: LocalTracks, targets: EncodingTargets) {
    try {
      if ("description" in data && data.description) {
        const desc = data.description;
        const readyForOffer =
          !this.makingOffer &&
          (this.pc.signalingState === "stable" || this.settingRemoteAnswer);
        const collision = desc.type === "offer" && !readyForOffer;

        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;

        this.settingRemoteAnswer = desc.type === "answer";
        await this.pc.setRemoteDescription(desc);
        this.settingRemoteAnswer = false;

        if (desc.type === "offer") {
          this.adopt(tracks);
          const answer = await this.pc.createAnswer();
          answer.sdp = tuneSessionDescription(answer.sdp!, this.tuning());
          await this.pc.setLocalDescription(answer);
          this.cb.send(this.id, { description: this.pc.localDescription!.toJSON() });
          void this.applyEncoding(targets);
        }
      } else if ("candidate" in data) {
        try {
          await this.pc.addIceCandidate(data.candidate ?? undefined);
        } catch (err) {
          // Candidato orfao de uma oferta que ignoramos nao e erro real.
          if (!this.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      this.cb.onError(this.id, err);
    }
  }

  /* ------------------------------ qualidade ----------------------------- */

  async applyEncoding(targets: EncodingTargets) {
    if (!this.ready || !this.videoTx || !this.micTx || !this.screenAudioTx) return;
    await applyVideoEncoding(this.videoTx.sender, this.tuning(), targets);
    await applyAudioEncoding(this.micTx.sender, this.screenAudioTx.sender, this.tuning());
  }

  refreshCodecPreferences() {
    if (this.ready && this.videoTx) applyCodecPreferences(this.videoTx, this.tuning().codec);
  }

  /* ------------------------------ metricas ------------------------------ */

  async collectStats(): Promise<PeerStats> {
    const report = await this.pc.getStats();
    this.stats = readStats(report, this.samples, {
      ...this.stats,
      connection: this.pc.connectionState,
    });
    return this.stats;
  }

  /**
   * Nivel de audio do par via `getSynchronizationSources()`: o proprio RTP
   * carrega o volume (RFC 6464), entao nao precisa de WebAudio. Custo ~zero.
   */
  audioLevel(): number {
    const receiver = this.micTx?.receiver as
      | (RTCRtpReceiver & { getSynchronizationSources?: () => { audioLevel?: number }[] })
      | undefined;
    const sources = receiver?.getSynchronizationSources?.();
    if (!sources?.length) return 0;
    return Math.max(...sources.map((s) => s.audioLevel ?? 0));
  }

  /** Snapshot para depuracao no console (`__voxa.senders()`). */
  debugInfo() {
    return {
      id: this.id,
      ready: this.ready,
      connection: this.pc.connectionState,
      ice: this.pc.iceConnectionState,
      encodings: this.videoTx?.sender.getParameters().encodings ?? [],
      degradation: this.videoTx
        ? (this.videoTx.sender.getParameters() as unknown as Record<string, unknown>)
            .degradationPreference
        : null,
    };
  }
}
