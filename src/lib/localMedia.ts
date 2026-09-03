import { VIDEO_PRESETS, type AudioPresetId, type ContentMode, type VideoPresetId } from "./config";
import { audioContext, captureMic, captureScreen, createVoiceDetector, stopStream } from "./media";

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

  // O track que de fato vai pro RTCPeerConnection nao e o track cru do
  // dispositivo: passa por um bus WebAudio (fonte -> ganho -> destino) pra
  // que o soundboard possa se misturar na voz antes de sair pro peer. O
  // ganho tambem substitui `track.enabled` como mecanismo de mudo — assim
  // um efeito do soundboard ainda toca pros outros mesmo com o microfone
  // silenciado, em vez de ser cortado junto.
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micGain: GainNode | null = null;
  private mixDestino: MediaStreamAudioDestinationNode | null = null;
  private micEnabled = true;

  constructor(private hooks: LocalMediaHooks) {}

  get hasMic() {
    return this.micStream !== null;
  }

  get screen(): MediaStream | null {
    return this.screenStream;
  }

  get isSharing() {
    return this.screenStream !== null;
  }

  /** Ponto de mixagem pro soundboard se conectar — null com o mic fechado. */
  get mixInput(): AudioNode | null {
    return this.mixDestino;
  }

  /* ------------------------------ microfone ----------------------------- */

  /** Idempotente: chamar com o microfone ja aberto devolve o track existente. */
  async openMic(preset: AudioPresetId, deviceId: string): Promise<MediaStreamTrack | null> {
    if (this.micStream) return this.mixDestino?.stream.getAudioTracks()[0] ?? null;

    const stream = await captureMic(preset, deviceId);
    this.micStream = stream;
    this.stopVad = createVoiceDetector(stream, (speaking) => this.hooks.onSpeaking(speaking));

    const ctx = audioContext();
    this.micSource = ctx.createMediaStreamSource(stream);
    this.micGain = ctx.createGain();
    this.micGain.gain.value = this.micEnabled ? 1 : 0;
    this.mixDestino = ctx.createMediaStreamDestination();
    this.micSource.connect(this.micGain);
    this.micGain.connect(this.mixDestino);

    return this.mixDestino.stream.getAudioTracks()[0];
  }

  closeMic() {
    this.stopVad?.();
    this.stopVad = null;
    try {
      this.micSource?.disconnect();
      this.micGain?.disconnect();
    } catch {
      /* grafo ja desfeito — nada a fazer */
    }
    this.micSource = null;
    this.micGain = null;
    this.mixDestino = null;
    stopStream(this.micStream);
    this.micStream = null;
  }

  /**
   * Silenciar zerando o ganho (em vez de desligar o track) mantem o fluxo RTP
   * vivo — nao renegocia nada, o unmute e instantaneo — e ainda deixa o
   * soundboard passar: o track final enviado ao peer continua `enabled`,
   * so a perna do MIC dentro da mixagem que emudece.
   */
  setMicEnabled(enabled: boolean) {
    this.micEnabled = enabled;
    if (this.micGain) this.micGain.gain.value = enabled ? 1 : 0;
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
