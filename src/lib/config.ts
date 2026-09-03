/* ---------------------------------------------------------------------------
   Configuracao global — sem custo de servidor.
   STUN publico do Google faz o NAT traversal; se os dois lados estiverem atras
   de NAT simetrico a conexao cai (seria preciso TURN, que custa banda).
--------------------------------------------------------------------------- */

export const SIGNALING_URL: string =
  (import.meta.env.VITE_SIGNALING_URL as string) || "http://localhost:3001";

const STUN: RTCIceServer = {
  urls: [
    "stun:stun.l.google.com:19302",
    "stun:stun1.l.google.com:19302",
    "stun:stun2.l.google.com:19302",
    "stun:stun3.l.google.com:19302",
    "stun:stun4.l.google.com:19302",
  ],
};

/**
 * TURN opcional, vindo do .env.
 *
 * Por que importa fora da LAN: STUN so descobre teu IP publico. Se os DOIS
 * lados estiverem atras de NAT simetrico ou CGNAT (padrao de varias operadoras
 * brasileiras), nenhum par de candidatos casa e a conexao nunca fecha. TURN e
 * um relay: funciona sempre, mas todo o video passa por ele — por isso nao
 * existe TURN gratuito ilimitado, e por isso ele fica desligado por padrao.
 *
 * VITE_TURN_URLS aceita varias separadas por virgula.
 */
function turnServers(): RTCIceServer[] {
  const raw = (import.meta.env.VITE_TURN_URLS as string | undefined)?.trim();
  if (!raw) return [];
  return [
    {
      urls: raw.split(",").map((u) => u.trim()).filter(Boolean),
      username: (import.meta.env.VITE_TURN_USERNAME as string) || undefined,
      credential: (import.meta.env.VITE_TURN_CREDENTIAL as string) || undefined,
    },
  ];
}

export const ICE_SERVERS: RTCIceServer[] = [STUN, ...turnServers()];

export const hasTurn = turnServers().length > 0;

/** "relay" forca todo o trafego pelo TURN — util so pra testar o relay. */
const icePolicy = ((import.meta.env.VITE_ICE_POLICY as string) || "all") as RTCIceTransportPolicy;

export const PC_CONFIG: RTCConfiguration = {
  iceServers: ICE_SERVERS,
  iceTransportPolicy: hasTurn ? icePolicy : "all",
  // max-bundle + rtcp-mux => 1 unico par de portas UDP pra tudo.
  // Menos candidatos ICE = handshake mais rapido = menos CPU.
  bundlePolicy: "max-bundle",
  rtcpMuxPolicy: "require",
  iceCandidatePoolSize: 4,
};

/* ------------------------------- VIDEO ---------------------------------- */

export type VideoPresetId = "lan" | "alta" | "equilibrada" | "economica";

export interface VideoPreset {
  id: VideoPresetId;
  label: string;
  hint: string;
  width: number;
  height: number;
  fps: number;
  /** bits/s */
  maxBitrate: number;
  startBitrate: number;
  minBitrate: number;
}

export const VIDEO_PRESETS: Record<VideoPresetId, VideoPreset> = {
  lan: {
    id: "lan",
    label: "LAN / Fibra",
    hint: "1080p60 · ate 40 Mbps",
    width: 1920,
    height: 1080,
    fps: 60,
    maxBitrate: 40_000_000,
    startBitrate: 20_000_000,
    minBitrate: 6_000_000,
  },
  alta: {
    id: "alta",
    label: "Alta",
    hint: "1080p60 · ate 15 Mbps",
    width: 1920,
    height: 1080,
    fps: 60,
    maxBitrate: 15_000_000,
    startBitrate: 8_000_000,
    minBitrate: 2_500_000,
  },
  equilibrada: {
    id: "equilibrada",
    label: "Equilibrada",
    hint: "900p60 · ate 8 Mbps",
    width: 1600,
    height: 900,
    fps: 60,
    maxBitrate: 8_000_000,
    startBitrate: 4_000_000,
    minBitrate: 1_500_000,
  },
  economica: {
    id: "economica",
    label: "Economica",
    hint: "720p30 · ate 3 Mbps",
    width: 1280,
    height: 720,
    fps: 30,
    maxBitrate: 3_000_000,
    startBitrate: 1_500_000,
    minBitrate: 600_000,
  },
};

/**
 * Ordem de preferencia de codec.
 * H264 primeiro: no Windows o WebView2 usa MediaFoundation (NVENC/QuickSync/AMF),
 * ou seja encode/decode 100% na GPU — CPU perto de zero, latencia menor.
 * AV1 so ganha em banda baixa e ainda custa CPU em maquinas sem AV1 no silicio.
 */
export type CodecId = "H264" | "AV1" | "VP9" | "VP8";
export const CODEC_ORDER: Record<string, CodecId[]> = {
  hardware: ["H264", "VP9", "VP8", "AV1"],
  eficiencia: ["AV1", "VP9", "H264", "VP8"],
  compatibilidade: ["VP8", "H264", "VP9", "AV1"],
};
export type CodecStrategy = keyof typeof CODEC_ORDER;

/**
 * "motion"  => o encoder sacrifica nitidez pra segurar o framerate (jogo).
 * "detail"  => segura nitidez do texto e derruba fps (apresentacao/codigo).
 */
export type ContentMode = "jogo" | "leitura";

/* ------------------------------- AUDIO ---------------------------------- */

export type AudioPresetId = "voz" | "estudio";

export interface AudioPreset {
  id: AudioPresetId;
  label: string;
  hint: string;
  constraints: MediaTrackConstraints;
  /** bits/s do opus */
  bitrate: number;
  stereo: boolean;
}

export const AUDIO_PRESETS: Record<AudioPresetId, AudioPreset> = {
  voz: {
    id: "voz",
    label: "Voz",
    hint: "DSP ligado · 48 kbps mono",
    bitrate: 48_000,
    stereo: false,
    constraints: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: 48000,
      sampleSize: 16,
    },
  },
  estudio: {
    id: "estudio",
    label: "Estudio",
    hint: "DSP desligado · 256 kbps stereo",
    bitrate: 256_000,
    stereo: true,
    constraints: {
      // Todo o processamento desligado: sem AEC/NS/AGC o audio nao passa pelo
      // pipeline de DSP => menos ~5ms de latencia e zero "bombeamento" quando
      // o jogo estoura. Use com fone, senao causa eco.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
      sampleRate: 48000,
      sampleSize: 16,
    },
  },
};

/** Audio que vem junto com a tela compartilhada (som do jogo). Nunca com DSP. */
export const SCREEN_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 2,
  sampleRate: 48000,
};
export const SCREEN_AUDIO_BITRATE = 192_000;

/* ------------------------------ CANAIS ---------------------------------- */

export interface Channel {
  id: string;
  name: string;
  kind: "text" | "voice";
  topic?: string;
}

/** Fallback usado quando o Supabase nao esta configurado. */
export const DEFAULT_CHANNELS: Channel[] = [
  { id: "geral", name: "geral", kind: "text", topic: "Papo geral da tropa" },
  { id: "links", name: "links", kind: "text", topic: "Cola aqui o que achar" },
  { id: "clipes", name: "clipes", kind: "text", topic: "Jogadas e bugs engracados" },
  { id: "lounge", name: "Lounge", kind: "voice" },
  { id: "sala-de-jogo", name: "Sala de Jogo", kind: "voice" },
  { id: "afk", name: "AFK", kind: "voice" },
];

export const USER_COLORS = [
  "#5865F2", "#23A55A", "#F0B232", "#F23F43",
  "#A855F7", "#EB459E", "#00A8FC", "#FF7A00",
];
