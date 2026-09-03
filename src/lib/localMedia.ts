import { VIDEO_PRESETS, type AudioPresetId, type ContentMode, type VideoPresetId } from "./config";
import { captureMic, captureScreen, createVoiceDetector, stopStream } from "./media";

/* ---------------------------------------------------------------------------
   Dono dos streams locais: microfone e captura de tela.

   Existe para que a Session nao precise saber nada sobre AudioContext, tracks
   ou constraints — ela pede "abra o microfone" e recebe um track pronto para
   entrar na malha. Nenhum estado de UI mora aqui.
--------------------------------------------------------------------------- */

export interface LocalMediaHooks {
  /** deteccao de voz local, ja com histerese aplicada */
  onSpeaking: (speaking: boolean) => void;
  /** usuario parou o compartilhamento pela barra nativa do sistema */
  onScreenEnded: () => void;
}

export interface ScreenHandles {
  stream: MediaStream;
  video: MediaStreamTrack;
  audio: MediaStreamTrack | null;
}

export class LocalMedia {
  private micStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private stopVad: (() => void) | null = null;

  constructor(private hooks: LocalMediaHooks) {}

  get micTrack(): MediaStreamTrack | null {
    return this.micStream?.getAudioTracks()[0] ?? null;
  }

  get hasMic() {
    return this.micStream !== null;
  }

  get screen(): MediaStream | null {
    return this.screenStream;
  }

  get isSharing() {
    return this.screenStream !== null;
  }

  /* ------------------------------ microfone ----------------------------- */

  /** Idempotente: chamar com o microfone ja aberto devolve o track existente. */
  async openMic(preset: AudioPresetId, deviceId: string): Promise<MediaStreamTrack | null> {
    if (this.micStream) return this.micTrack;

    const stream = await captureMic(preset, deviceId);
    this.micStream = stream;
    this.stopVad = createVoiceDetector(stream, (speaking) => this.hooks.onSpeaking(speaking));
    return this.micTrack;
  }

  closeMic() {
    this.stopVad?.();
    this.stopVad = null;
    stopStream(this.micStream);
    this.micStream = null;
  }

  /**
   * Silenciar desligando o track (em vez de removê-lo) mantem o fluxo RTP vivo:
   * nao renegocia nada, o unmute e instantaneo e o outro lado nao ve a conexao
   * piscar.
   */
  setMicEnabled(enabled: boolean) {
    const track = this.micTrack;
    if (track) track.enabled = enabled;
  }

  /* -------------------------------- tela -------------------------------- */

  async openScreen(presetId: VideoPresetId, mode: ContentMode): Promise<ScreenHandles> {
    const handles = await captureScreen(VIDEO_PRESETS[presetId], mode);
    this.screenStream = handles.stream;
    handles.video.onended = () => this.hooks.onScreenEnded();
    return handles;
  }

  closeScreen() {
    stopStream(this.screenStream);
    this.screenStream = null;
  }

  /** Reaplica resolucao, fps e dica de conteudo num compartilhamento em curso. */
  async applyScreenSettings(presetId: VideoPresetId, mode: ContentMode) {
    const track = this.screenStream?.getVideoTracks()[0];
    if (!track) return;

    const preset = VIDEO_PRESETS[presetId];
    track.contentHint = mode === "jogo" ? "motion" : "detail";
    try {
      await track.applyConstraints({
        frameRate: { ideal: preset.fps, max: preset.fps },
        width: { ideal: preset.width, max: preset.width },
        height: { ideal: preset.height, max: preset.height },
      });
    } catch {
      // A fonte pode recusar; o encoder ainda respeita maxBitrate/maxFramerate.
    }
  }

  destroy() {
    this.closeMic();
    this.closeScreen();
  }
}
