import {
  AUDIO_PRESETS,
  SCREEN_AUDIO_CONSTRAINTS,
  type AudioPresetId,
  type ContentMode,
  type VideoPreset,
} from "./config";

/* ---------------------------------------------------------------------------
   Captura de midia. Todo o segredo de "parecer Parsec" comeca aqui:
   pedir os constraints certos ANTES do encoder existir.
--------------------------------------------------------------------------- */

export class MediaError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "MediaError";
  }
}

function describe(err: unknown): string {
  const e = err as DOMException;
  switch (e?.name) {
    case "NotAllowedError":
      return "Permissao negada. Libere microfone/tela pro app.";
    case "NotFoundError":
      return "Nenhum dispositivo encontrado.";
    case "NotReadableError":
      return "Dispositivo ocupado por outro programa.";
    case "OverconstrainedError":
      return "O dispositivo nao suporta a qualidade pedida.";
    case "AbortError":
      return "Captura cancelada.";
    default:
      return e?.message || "Falha desconhecida na captura.";
  }
}

/* ------------------------------ MICROFONE -------------------------------- */

export async function captureMic(
  presetId: AudioPresetId,
  deviceId?: string
): Promise<MediaStream> {
  const preset = AUDIO_PRESETS[presetId];
  const audio: MediaTrackConstraints = {
    ...preset.constraints,
    ...(deviceId && deviceId !== "default" ? { deviceId: { exact: deviceId } } : {}),
    // Flags legadas do Chromium: ainda respeitadas pelo WebView2 e desligam
    // o resto do pipeline de DSP (highpass, typing detection, ducking).
    ...({
      googEchoCancellation: preset.constraints.echoCancellation,
      googAutoGainControl: preset.constraints.autoGainControl,
      googNoiseSuppression: preset.constraints.noiseSuppression,
      googHighpassFilter: preset.constraints.noiseSuppression,
      googTypingNoiseDetection: false,
      googAudioMirroring: false,
    } as Record<string, unknown>),
  };

  try {
    return await navigator.mediaDevices.getUserMedia({ audio, video: false });
  } catch (err) {
    // Fallback: alguma flag exotica pode ter derrubado. Tenta o basico.
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch {
      throw new MediaError(describe(err), err);
    }
  }
}

/* ----------------------------- TELA / JOGO ------------------------------- */

export interface ScreenCaptureResult {
  stream: MediaStream;
  video: MediaStreamTrack;
  audio: MediaStreamTrack | null;
}

export async function captureScreen(
  preset: VideoPreset,
  mode: ContentMode
): Promise<ScreenCaptureResult> {
  const constraints: DisplayMediaStreamOptions = {
    video: {
      // `ideal` e nao `exact`: se o monitor for 1440p, a fonte entrega nativo e
      // o encoder faz o downscale na GPU. `exact` faria a captura falhar.
      frameRate: { ideal: preset.fps, max: preset.fps },
      width: { ideal: preset.width, max: preset.width },
      height: { ideal: preset.height, max: preset.height },
      ...({
        displaySurface: "monitor",
        cursor: "always",
        resizeMode: "crop-and-scale",
      } as Record<string, unknown>),
    },
    audio: SCREEN_AUDIO_CONSTRAINTS,
    ...({
      systemAudio: "include",
      surfaceSwitching: "include",
      selfBrowserSurface: "exclude",
      monitorTypeSurfaces: "include",
      preferCurrentTab: false,
    } as Record<string, unknown>),
  };

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(constraints);
  } catch (err) {
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch {
      throw new MediaError(describe(err), err);
    }
  }

  const video = stream.getVideoTracks()[0];
  const audio = stream.getAudioTracks()[0] ?? null;

  if (video) {
    // contentHint e o interruptor mais importante do encoder:
    //  "motion" => prioriza framerate, aceita perder nitidez (jogo)
    //  "detail" => prioriza nitidez do texto, aceita perder fps (leitura)
    video.contentHint = mode === "jogo" ? "motion" : "detail";
    // Reforca framerate no proprio track (alguns drivers ignoram no getDisplayMedia)
    void video.applyConstraints({
      frameRate: { ideal: preset.fps, max: preset.fps },
    }).catch(() => {});
  }
  if (audio) audio.contentHint = "music";

  return { stream, video, audio };
}

/* ------------------------------- WEBCAM ----------------------------------- */

export interface WebcamCaptureResult {
  stream: MediaStream;
  video: MediaStreamTrack;
}

export async function captureWebcam(deviceId?: string): Promise<WebcamCaptureResult> {
  const video: MediaTrackConstraints = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
    ...(deviceId && deviceId !== "default" ? { deviceId: { exact: deviceId } } : {}),
  };

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    const track = stream.getVideoTracks()[0];
    track.contentHint = "motion";
    return { stream, video: track };
  } catch (err) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      return { stream, video: stream.getVideoTracks()[0] };
    } catch {
      throw new MediaError(describe(err), err);
    }
  }
}

/* --------------------------- DISPOSITIVOS -------------------------------- */

export interface DeviceList {
  mics: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
}

export async function listDevices(): Promise<DeviceList> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return {
      mics: all.filter((d) => d.kind === "audioinput"),
      speakers: all.filter((d) => d.kind === "audiooutput"),
      cameras: all.filter((d) => d.kind === "videoinput"),
    };
  } catch {
    return { mics: [], speakers: [], cameras: [] };
  }
}

/* ------------------------- DETECCAO DE FALA ------------------------------ */

let sharedCtx: AudioContext | null = null;
let unlockArmado = false;

/**
 * Destrava o AudioContext no PRIMEIRO clique em qualquer lugar do app.
 *
 * `--autoplay-policy=no-user-gesture-required` (webview.rs) libera o
 * autoplay de <audio>/<video>, mas NAO cobre AudioContext.resume() — sao
 * duas politicas separadas no Chromium. O audio remoto passou a depender
 * de AudioContext puro (GainNode, para o volume ir alem de 100%), e o
 * clique que entra no canal de voz acontece varios `await`s antes do
 * efeito que cria o contexto — tempo suficiente pra a "ativacao do
 * usuario" expirar e o resume() ficar suspenso pra sempre, em silencio,
 * sem erro nenhum. Um listener no documento inteiro garante que QUALQUER
 * clique — silenciar, abrir configuracoes, o que for — destrava.
 */
function armarDestravamento(ctx: AudioContext) {
  if (unlockArmado || typeof document === "undefined") return;
  unlockArmado = true;

  const destravar = () => {
    if (ctx.state === "suspended") void ctx.resume();
    if (ctx.state === "running") {
      document.removeEventListener("click", destravar, true);
      document.removeEventListener("keydown", destravar, true);
    }
  };
  document.addEventListener("click", destravar, true);
  document.addEventListener("keydown", destravar, true);
}

export function audioContext(): AudioContext {
  if (!sharedCtx || sharedCtx.state === "closed") {
    sharedCtx = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
    unlockArmado = false;
  }
  if (sharedCtx.state === "suspended") {
    void sharedCtx.resume();
    armarDestravamento(sharedCtx);
  }
  return sharedCtx;
}

/**
 * VAD barato: um AnalyserNode + polling a 12 Hz.
 * Nao usa AudioWorklet de proposito — worklet roda no audio thread a 128
 * samples por callback (375 wakeups/s) e isso aparece no perfil de CPU.
 */
export function createVoiceDetector(
  stream: MediaStream,
  onChange: (speaking: boolean, level: number) => void,
  { threshold = 0.018, holdMs = 260 } = {}
): () => void {
  const ctx = audioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.4;
  source.connect(analyser);

  const buf = new Float32Array(analyser.fftSize);
  let speaking = false;
  let lastLoud = 0;

  const timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    const now = performance.now();

    if (rms > threshold) lastLoud = now;
    const next = now - lastLoud < holdMs;
    if (next !== speaking) {
      speaking = next;
      onChange(speaking, rms);
    }
  }, 80);

  return () => {
    window.clearInterval(timer);
    try {
      source.disconnect();
      analyser.disconnect();
    } catch {
      /* noop */
    }
  };
}

export function stopStream(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((t) => t.stop());
}
