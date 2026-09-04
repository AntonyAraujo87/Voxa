import { audioContext } from "./media";
import { FilaPCM } from "./filaPcm";
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

/**
 * Codigo do worklet. O AudioWorklet roda num escopo isolado que nao aceita
 * `import`, entao a classe da fila entra aqui pelo `toString()` — mesma fonte
 * que os testes usam, em vez de uma copia que envelhece sozinha.
 */
const WORKLET = `
${FilaPCM.toString()}

class ProcessadorPCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fila = new FilaPCM();
    this.port.onmessage = (e) => this.fila.push(new Float32Array(e.data));
  }
  process(_inputs, outputs) {
    const saida = outputs[0];
    this.fila.pull(saida[0], saida[1] ?? saida[0]);
    return true;
  }
}
registerProcessor("fila-pcm", ProcessadorPCM);
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
