import { AUDIO_PRESETS, CODEC_ORDER, SCREEN_AUDIO_BITRATE, VIDEO_PRESETS } from "../config";
import { tuneSdp } from "../sdp";
import type { TuningState } from "./types";

/* ---------------------------------------------------------------------------
   Tudo que traduz "preset escolhido pelo usuario" em parametros reais de
   encoder. Isolado aqui porque e a parte que mais muda quando se persegue
   qualidade — e a que nao deve estar misturada com ciclo de vida de conexao.
--------------------------------------------------------------------------- */

const AUX_CODEC = /(rtx|red|ulpfec|flexfec)/i;

/**
 * Reordena a lista de codecs do transceiver conforme a estrategia escolhida.
 *
 * rtx/red/fec vao para o fim mas NAO podem sumir: sem rtx nao ha retransmissao,
 * e qualquer perda de pacote vira macroblock congelado na tela.
 */
export function applyCodecPreferences(tx: RTCRtpTransceiver, strategy: TuningState["codec"]) {
  const caps = RTCRtpReceiver.getCapabilities("video");
  if (!caps || typeof tx.setCodecPreferences !== "function") return;

  const order = CODEC_ORDER[strategy];
  const rank = (mime: string) => {
    const name = mime.split("/")[1]?.toUpperCase() ?? "";
    const i = order.findIndex((c) => c === name);
    return i === -1 ? order.length + 1 : i;
  };

  const sorted = [...caps.codecs].sort((a, b) => {
    const ax = AUX_CODEC.test(a.mimeType) ? 1 : 0;
    const bx = AUX_CODEC.test(b.mimeType) ? 1 : 0;
    if (ax !== bx) return ax - bx;
    return rank(a.mimeType) - rank(b.mimeType);
  });

  try {
    tx.setCodecPreferences(sorted);
  } catch {
    /* codec recusado pelo runtime: segue com a ordem padrao */
  }
}

/**
 * Numa malha, a MESMA tela e codificada e enviada uma vez por espectador.
 * 15 Mbps para 3 pessoas seriam 45 Mbps de upload, que quase ninguem tem.
 * O teto por conexao e dividido pelo numero de pares, respeitando o piso do
 * preset — abaixo dele a imagem vira sopa e e melhor baixar a resolucao.
 */
export function budgetPerPeer(tuning: TuningState, viewers: number): number {
  const preset = VIDEO_PRESETS[tuning.video];
  return Math.max(preset.minBitrate, Math.round(preset.maxBitrate / Math.max(1, viewers)));
}

export interface EncodingTargets {
  maxBitrate: number;
  maxFramerate: number;
  /** 1 = resolucao nativa; >1 reduz a resolucao enviada */
  scaleDownBy: number;
}

/** Aplica teto de bitrate, framerate e preferencia de degradacao no sender. */
export async function applyVideoEncoding(
  sender: RTCRtpSender,
  tuning: TuningState,
  targets: EncodingTargets
) {
  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];

  const enc = params.encodings[0] as RTCRtpEncodingParameters & Record<string, unknown>;
  enc.maxBitrate = targets.maxBitrate;
  enc.maxFramerate = targets.maxFramerate;
  enc.scaleResolutionDownBy = targets.scaleDownBy;
  enc.priority = "high";
  enc.networkPriority = "high";

  // O interruptor central do "modo jogo": quando a rede aperta, o encoder
  // escolhe entre derrubar RESOLUCAO ou FRAMERATE. Parsec segura o framerate.
  (params as unknown as Record<string, unknown>).degradationPreference =
    tuning.content === "jogo" ? "maintain-framerate" : "maintain-resolution";

  try {
    await sender.setParameters(params);
  } catch {
    /* estados transitorios de negociacao rejeitam; a proxima passada aplica */
  }
}

export async function applyAudioEncoding(
  micSender: RTCRtpSender,
  screenAudioSender: RTCRtpSender,
  tuning: TuningState
) {
  try {
    const mic = micSender.getParameters();
    if (mic.encodings?.length) {
      mic.encodings[0].maxBitrate = AUDIO_PRESETS[tuning.audio].bitrate;
      (mic.encodings[0] as unknown as Record<string, unknown>).networkPriority = "high";
      await micSender.setParameters(mic);
    }

    const screen = screenAudioSender.getParameters();
    if (screen.encodings?.length) {
      screen.encodings[0].maxBitrate = SCREEN_AUDIO_BITRATE;
      await screenAudioSender.setParameters(screen);
    }
  } catch {
    /* idem */
  }
}

/**
 * Injeta no SDP o que a API publica nao expoe: bitrate INICIAL e MINIMO do
 * video, e os parametros de opus. Sem o start-bitrate o encoder abre em
 * ~300 kbps e leva 10-20s de rampa ate 1080p60 ficar nitido.
 */
export function tuneSessionDescription(sdp: string, tuning: TuningState): string {
  const v = VIDEO_PRESETS[tuning.video];
  const a = AUDIO_PRESETS[tuning.audio];

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
