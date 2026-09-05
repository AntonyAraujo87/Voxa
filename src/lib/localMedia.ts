import type { RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import { VIDEO_PRESETS, type AudioPresetId, type ContentMode, type VideoPresetId } from "./config";
import {
  audioContext,
  captureMic,
  captureScreen,
  captureWebcam,
  createVoiceDetector,
  stopStream,
} from "./media";
import { criarSupressorDeRuido } from "./noiseSuppression";

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
  /** dispositivo de camera sumiu (desconectado, outro programa tomou) */
  onWebcamEnded: () => void;
}

export interface ScreenHandles {
  stream: MediaStream;
  video: MediaStreamTrack;
  audio: MediaStreamTrack | null;
}

export class LocalMedia {
  private micStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private webcamStream: MediaStream | null = null;
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
  // Opcional, entra ENTRE a fonte e o ganho quando ligado — ver noiseSuppression.ts.
  private rnnoiseNode: RnnoiseWorkletNode | null = null;

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

  get isWebcamOn() {
    return this.webcamStream !== null;
  }

  /** Ponto de mixagem pro soundboard se conectar — null com o mic fechado. */
  get mixInput(): AudioNode | null {
    return this.mixDestino;
  }

  /* ------------------------------ microfone ----------------------------- */

  /**
   * Idempotente: chamar com o microfone ja aberto devolve o track existente
   * (o pedido de trocar `noiseSuppression` nesse caso e ignorado — quem
   * chama precisa fechar e reabrir pra isso valer, mesmo padrao de trocar
   * preset de audio ou dispositivo).
   */
  async openMic(
    preset: AudioPresetId,
    deviceId: string,
    noiseSuppression = false
  ): Promise<MediaStreamTrack | null> {
    // Ja aberto: devolve a trilha existente. Mas se o grafo interno ficou
    // sem ela (o destino de mistura sumiu, ou nunca chegou a ser montado),
    // NAO devolve null — fecha e monta de novo. Devolver null aqui era o
    // caminho silencioso do bug: quem chamou saia sem anexar nada, sem
    // excecao nenhuma, e o app seguia dizendo "microfone ativo" enquanto
    // nao mandava um byte de voz para ninguem.
    if (this.micStream) {
      const existente = this.mixDestino?.stream.getAudioTracks()[0];
      if (existente && existente.readyState === "live") return existente;
      this.closeMic();
    }

    const stream = await captureMic(preset, deviceId);
    this.micStream = stream;
    this.stopVad = createVoiceDetector(stream, (speaking) => this.hooks.onSpeaking(speaking));

    const ctx = audioContext();
    this.micSource = ctx.createMediaStreamSource(stream);
    this.micGain = ctx.createGain();
    this.micGain.gain.value = this.micEnabled ? 1 : 0;
    this.mixDestino = ctx.createMediaStreamDestination();

    // Entra ANTES do ganho: assim mudar/ensurdecer nao interfere no estado
    // interno do supressor, e o soundboard (que se mistura depois do ganho,
    // em session.ts) nunca passa por ele — nao faz sentido "filtrar ruido"
    // de um efeito sintetico.
    let entrada: AudioNode = this.micSource;
    if (noiseSuppression) {
      // So bloqueia entrada em voz na primeira vez da sessao (carrega e
      // cacheia o wasm); reaberturas seguintes reusam o cache e nao esperam.
      const node = await criarSupressorDeRuido(ctx);
      // Quem chamou pode ter saido do canal (closeMic) enquanto o wasm
      // carregava — sem essa checagem, o node conectaria num grafo que ja
      // nao existe mais.
      if (this.micStream !== stream) {
        node?.destroy();
        return null;
      }
      if (node) {
        this.micSource.connect(node);
        entrada = node;
        this.rnnoiseNode = node;
      }
    }
    entrada.connect(this.micGain);
    this.micGain.connect(this.mixDestino);

    return this.mixDestino.stream.getAudioTracks()[0];
  }

  closeMic() {
    this.stopVad?.();
    this.stopVad = null;
    try {
      this.micSource?.disconnect();
      this.rnnoiseNode?.disconnect();
      this.rnnoiseNode?.destroy();
      this.micGain?.disconnect();
    } catch {
      /* grafo ja desfeito — nada a fazer */
    }
    this.micSource = null;
    this.rnnoiseNode = null;
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

  /* ------------------------------- webcam -------------------------------- */

  /**
   * Camera e tela sao mutuamente exclusivas por escolho — as duas iriam pro
   * mesmo transceiver de video da malha (mesh.setScreen), entao quem chama
   * (session.ts) precisa garantir que so uma esteja aberta por vez.
   */
  async openWebcam(deviceId: string): Promise<MediaStreamTrack | null> {
    if (this.webcamStream) return this.webcamStream.getVideoTracks()[0] ?? null;

    const { stream, video } = await captureWebcam(deviceId);
    this.webcamStream = stream;
    video.onended = () => this.hooks.onWebcamEnded();
    return video;
  }

  closeWebcam() {
    stopStream(this.webcamStream);
    this.webcamStream = null;
  }

  destroy() {
    this.closeMic();
    this.closeScreen();
    this.closeWebcam();
  }
}
