import { loadRnnoise, RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";

/* ---------------------------------------------------------------------------
   Supressao de ruido de verdade (RNNoise, rede neural pequena treinada pra
   separar voz de ruido de fundo) — diferente do `noiseSuppression` nativo do
   getUserMedia, que e um filtro generico e bem mais fraco contra teclado,
   ventoinha, eco de sala.

   Roda num AudioWorklet (thread de audio dedicada, sem competir com o thread
   principal) e entra no grafo de localMedia.ts ENTRE a fonte do microfone e
   o ganho de mudo — antes de ir pro bus de mixagem que alimenta o peer.

   Opcional de proposito: e mais CPU por segundo de audio, e em microfones ja
   bons pode remover nuance da voz. Quem nao quer, desliga.
--------------------------------------------------------------------------- */

let wasmBinaryPromise: Promise<ArrayBuffer> | null = null;
let workletModulePromise: Promise<void> | null = null;

function carregarBinario(): Promise<ArrayBuffer> {
  if (!wasmBinaryPromise) {
    wasmBinaryPromise = loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl });
  }
  return wasmBinaryPromise;
}

function registrarWorklet(ctx: AudioContext): Promise<void> {
  if (!workletModulePromise) {
    workletModulePromise = ctx.audioWorklet.addModule(rnnoiseWorkletUrl);
  }
  return workletModulePromise;
}

/**
 * Cria o node de supressao, ou `null` se o navegador/runtime nao suportar
 * (AudioWorklet indisponivel, wasm bloqueado, etc) — nunca lanca: quem chama
 * so precisa decidir se conecta o node ou segue sem ele.
 */
export async function criarSupressorDeRuido(ctx: AudioContext): Promise<RnnoiseWorkletNode | null> {
  try {
    const [binario] = await Promise.all([carregarBinario(), registrarWorklet(ctx)]);
    return new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: binario });
  } catch (err) {
    console.warn("[rnnoise] indisponivel, seguindo sem supressao:", err);
    // Reseta o cache: uma falha de rede no primeiro carregamento nao deveria
    // grudar como falha permanente pelo resto da sessao.
    wasmBinaryPromise = null;
    workletModulePromise = null;
    return null;
  }
}
