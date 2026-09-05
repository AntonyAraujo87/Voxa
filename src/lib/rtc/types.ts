import type { AudioPresetId, CodecStrategy, ContentMode, VideoPresetId } from "../config";
import type { SignalPayload } from "../signaling";

/* ---------------------------------------------------------------------------
   Contratos da camada P2P. Ficam isolados para que `peer`, `mesh`, `stats` e
   `tuning` dependam de tipos, nao uns dos outros.
--------------------------------------------------------------------------- */

/**
 * Cada conexao carrega sempre estes tres fluxos, criados na MESMA ordem nos
 * dois lados. Ordem fixa deixa o SDP simetrico e permite rotear o `ontrack`
 * pela posicao da m-line, sem depender de ids de stream.
 */
export type TrackKind = "mic" | "screen" | "screenAudio";

export interface LocalTracks {
  mic: MediaStreamTrack | null;
  screen: MediaStreamTrack | null;
  screenAudio: MediaStreamTrack | null;
}

export const NO_TRACKS: LocalTracks = { mic: null, screen: null, screenAudio: null };

export interface PeerStats {
  outKbps: number;
  inKbps: number;
  /** Total de bytes de AUDIO trafegados nesta conexao, acumulado.
   *  Enviado = 0 significa que o microfone nao esta chegando na conexao;
   *  recebido = 0, que o audio do outro nunca chegou aqui. Sao as duas
   *  perguntas que "nao estou ouvindo ninguem" faz, e nada respondia. */
  audioOutBytes: number;
  audioInBytes: number;
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
  /** por que o encoder esta segurando qualidade: none | cpu | bandwidth | other */
  limitation: string;
  connection: RTCPeerConnectionState;
  /** como a midia trafega: direto entre os pares ou por um relay TURN */
  path: "direto" | "relay" | "-";
}

export const EMPTY_STATS: PeerStats = {
  outKbps: 0,
  inKbps: 0,
  audioOutBytes: 0,
  audioInBytes: 0,
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

export interface TuningState {
  video: VideoPresetId;
  audio: AudioPresetId;
  codec: CodecStrategy;
  content: ContentMode;
}

/** Amostra anterior de bytes/pacotes, para derivar taxa por segundo. */
export interface Sample {
  bytes: number;
  ts: number;
  packets: number;
  lost: number;
}

export const EMPTY_SAMPLE: Sample = { bytes: 0, ts: 0, packets: 0, lost: 0 };

export interface PeerCallbacks {
  send: (to: string, data: SignalPayload) => void;
  onTrack: (peerId: string, kind: TrackKind, stream: MediaStream | null) => void;
  onConnectionState: (peerId: string, state: RTCPeerConnectionState) => void;
  onError: (peerId: string, err: unknown) => void;
}

export interface MeshOptions extends PeerCallbacks {
  selfId: () => string;
  onStats: (stats: Map<string, PeerStats>) => void;
  onSpeaking: (peerId: string, speaking: boolean) => void;
  /** avisa quando a qualidade foi reduzida ou recuperada automaticamente */
  onQuality?: (label: string, reason: string) => void;
}
