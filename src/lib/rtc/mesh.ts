import { VIDEO_PRESETS } from "../config";
import type { SignalPayload } from "../signaling";
import { Peer } from "./peer";
import { budgetPerPeer, type EncodingTargets } from "./tuning";
import { NO_TRACKS, type LocalTracks, type MeshOptions, type PeerStats, type TuningState } from "./types";

/* ---------------------------------------------------------------------------
   Malha P2P (full mesh): cada participante abre uma conexao com cada outro.
   Zero servidor de midia, latencia de um salto so. O custo e o upload, que
   cresce com o numero de espectadores — dai o orcamento dividido por par.

   O Mesh coordena: quem entra, quem sai, quais tracks estao no ar e quando
   reaplicar qualidade. A conexao em si e responsabilidade do Peer.
--------------------------------------------------------------------------- */

const STATS_INTERVAL_MS = 1000;
const SPEAKING_INTERVAL_MS = 150;
const SPEAKING_THRESHOLD = 0.012;

export class Mesh {
  private peers = new Map<string, Peer>();
  private tracks: LocalTracks = { ...NO_TRACKS };
  private timers: number[] = [];

  tuning: TuningState = { video: "alta", audio: "voz", codec: "hardware", content: "jogo" };

  constructor(private opts: MeshOptions) {
    this.timers.push(
      window.setInterval(() => void this.collectStats(), STATS_INTERVAL_MS),
      window.setInterval(() => this.detectSpeaking(), SPEAKING_INTERVAL_MS)
    );
  }

  get size() {
    return this.peers.size;
  }

  /* ---------------------------- participantes --------------------------- */

  addPeer(id: string, initiator: boolean): Peer {
    const existing = this.peers.get(id);
    if (existing) return existing;

    // Criterio deterministico e igual dos dois lados, para que exatamente um
    // seja o "educado" numa colisao de ofertas.
    const polite = this.opts.selfId() > id;
    const peer = new Peer(id, polite, () => this.tuning, this.opts);
    this.peers.set(id, peer);

    if (initiator) peer.initiate(this.tracks, this.targets());
    this.rebalance();
    return peer;
  }

  removePeer(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;

    peer.close();
    this.peers.delete(id);

    this.opts.onTrack(id, "mic", null);
    this.opts.onTrack(id, "screen", null);
    this.opts.onTrack(id, "screenAudio", null);
    this.rebalance();
  }

  clear() {
    for (const id of [...this.peers.keys()]) this.removePeer(id);
  }

  destroy() {
    for (const t of this.timers) window.clearInterval(t);
    this.timers = [];
    this.clear();
  }

  /* ------------------------------ signaling ----------------------------- */

  async handleSignal(from: string, data: SignalPayload) {
    const peer = this.peers.get(from) ?? this.addPeer(from, false);
    await peer.handleSignal(data, this.tracks, this.targets());
  }

  /* ---------------------------- tracks locais --------------------------- */

  setMic(track: MediaStreamTrack | null) {
    this.tracks = { ...this.tracks, mic: track };
    for (const peer of this.peers.values()) peer.attachTracks(this.tracks);
  }

  async setScreen(video: MediaStreamTrack | null, audio: MediaStreamTrack | null) {
    this.tracks = { ...this.tracks, screen: video, screenAudio: audio };
    for (const peer of this.peers.values()) peer.attachTracks(this.tracks);
    await this.applyToAll();
  }

  /* ------------------------------ qualidade ----------------------------- */

  async setTuning(patch: Partial<TuningState>) {
    const before = this.tuning;
    this.tuning = { ...before, ...patch };

    if (patch.content && this.tracks.screen) {
      this.tracks.screen.contentHint = this.tuning.content === "jogo" ? "motion" : "detail";
    }
    if (patch.codec && patch.codec !== before.codec) {
      for (const peer of this.peers.values()) peer.refreshCodecPreferences();
    }
    await this.applyToAll();
  }

  private targets(): EncodingTargets {
    return {
      maxBitrate: budgetPerPeer(this.tuning, this.peers.size),
      maxFramerate: VIDEO_PRESETS[this.tuning.video].fps,
      scaleDownBy: 1,
    };
  }

  /** Redistribui o teto de upload — chamado quando alguem entra ou sai. */
  private rebalance() {
    void this.applyToAll();
  }

  private async applyToAll() {
    const targets = this.targets();
    await Promise.all([...this.peers.values()].map((p) => p.applyEncoding(targets)));
  }

  /* ------------------------------- metricas ----------------------------- */

  private async collectStats() {
    if (this.peers.size === 0) return;

    const out = new Map<string, PeerStats>();
    await Promise.all(
      [...this.peers.values()].map(async (peer) => {
        try {
          out.set(peer.id, await peer.collectStats());
        } catch {
          /* par removido no meio da coleta */
        }
      })
    );

    this.opts.onStats(out);
  }

  private detectSpeaking() {
    for (const peer of this.peers.values()) {
      const speaking = peer.audioLevel() > SPEAKING_THRESHOLD;
      if (speaking !== peer.speaking) {
        peer.speaking = speaking;
        this.opts.onSpeaking(peer.id, speaking);
      }
    }
  }

  debugSenders() {
    return [...this.peers.values()].map((p) => p.debugInfo());
  }
}
