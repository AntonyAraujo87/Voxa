import { audioContext } from "./media";
import { isDesktop } from "./desktop";

/* ---------------------------------------------------------------------------
   Audio do sistema (WASAPI loopback) virando um MediaStreamTrack.

   O `getDisplayMedia` do WebView2 entrega o audio da janela escolhida — quando
   entrega. Com jogo em tela cheia o normal e vir nada, e quem assiste ve a
   imagem em silencio. O Rust captura o que a placa esta tocando (sysaudio.rs)
   e manda blocos de f32 intercalado por um Channel do Tauri, em bytes crus.

   Aqui esses blocos entram num AudioWorklet e saem como track de midia, que a
   malha WebRTC envia igual a qualquer outro.

   O buffer no worklet e o coracao disto: IPC nao entrega com a regularidade de
   um relogio de audio. Sem folga, cada atraso vira clique; com folga demais, o
   som atrasa em relacao a imagem. O worklet segura ~60 ms e descarta o excesso
   quando passa de 400 ms — atrasar meio segundo e pior que perder um pedaco.
--------------------------------------------------------------------------- */

const WORKLET = `
class FilaPCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blocos = [];
    this.amostrasNaFila = 0;
    this.pronto = false;
    // 128 quadros por chamada, 48k => ~2,7 ms. 60 ms de folga antes de comecar.
    this.minimoParaIniciar = 48000 * 0.06;
    this.maximo = 48000 * 0.4;
    this.port.onmessage = (e) => {
      const bloco = new Float32Array(e.data);
      this.blocos.push(bloco);
      this.amostrasNaFila += bloco.length / 2;
      // Atrasou demais (a janela ficou escondida, o IPC engasgou): joga fora o
      // passado e volta a tocar perto do agora.
      while (this.amostrasNaFila > this.maximo && this.blocos.length > 1) {
        this.amostrasNaFila -= this.blocos.shift().length / 2;
      }
    };
  }

  process(_inputs, outputs) {
    const saida = outputs[0];
    const esq = saida[0];
    const dir = saida[1] ?? saida[0];

    if (!this.pronto) {
      if (this.amostrasNaFila < this.minimoParaIniciar) return true;
      this.pronto = true;
    }

    for (let i = 0; i < esq.length; i++) {
      const bloco = this.blocos[0];
      if (!bloco || bloco.__pos >= bloco.length) {
        if (bloco) this.blocos.shift();
        if (this.blocos.length === 0) {
          // Fila secou: silencio ate juntar folga de novo, senao entra em
          // ciclo de estalos.
          esq[i] = 0;
          dir[i] = 0;
          this.pronto = false;
          continue;
        }
      }
      const atual = this.blocos[0];
      if (atual.__pos === undefined) atual.__pos = 0;
      esq[i] = atual[atual.__pos] ?? 0;
      dir[i] = atual[atual.__pos + 1] ?? 0;
      atual.__pos += 2;
      this.amostrasNaFila--;
      if (atual.__pos >= atual.length) this.blocos.shift();
    }
    return true;
  }
}
registerProcessor("fila-pcm", FilaPCM);
`;

let workletCarregado = false;
let node: AudioWorkletNode | null = null;
let destino: MediaStreamAudioDestinationNode | null = null;
let pararNativo: (() => void) | null = null;

/**
 * Liga a captura e devolve o track pronto pra malha.
 * `null` quando nao ha suporte (fora do app instalado, ou nao-Windows).
 */
export async function iniciarAudioDoSistema(): Promise<MediaStreamTrack | null> {
  if (!isDesktop) return null;
  if (node && destino) return destino.stream.getAudioTracks()[0] ?? null;

  const ctx = audioContext();

  if (!workletCarregado) {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
      workletCarregado = true;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const { Channel, invoke } = await import("@tauri-apps/api/core");
  const canal = new Channel<ArrayBuffer>();

  node = new AudioWorkletNode(ctx, "fila-pcm", { outputChannelCount: [2] });
  destino = ctx.createMediaStreamDestination();
  node.connect(destino);

  canal.onmessage = (bloco) => node?.port.postMessage(bloco, [bloco]);

  try {
    await invoke("start_system_audio", { canal });
  } catch (err) {
    pararAudioDoSistema();
    throw err;
  }

  pararNativo = () => void invoke("stop_system_audio").catch(() => {});
  return destino.stream.getAudioTracks()[0] ?? null;
}

export function pararAudioDoSistema() {
  pararNativo?.();
  pararNativo = null;
  try {
    node?.disconnect();
    destino?.disconnect();
  } catch {
    /* grafo ja desfeito */
  }
  node = null;
  destino = null;
}
