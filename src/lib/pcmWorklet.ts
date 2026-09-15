import { FilaPCM } from "./filaPcm";

declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

// Asset independente: o bundler inclui a fila e preserva suas referências.
class ProcessadorPCM extends AudioWorkletProcessor {
  private fila = new FilaPCM();
  private quadros = 0;
  private comSom = 0;
  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<ArrayBuffer>) => this.fila.push(new Float32Array(e.data));
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const [esq, dir] = outputs[0];
    this.fila.pull(esq, dir ?? esq);
    this.quadros += esq.length;
    for (const sample of esq) if (Math.abs(sample) > 0.00001) this.comSom++;
    if (this.quadros >= 48000) {
      this.port.postMessage({ quadros: this.quadros, comSom: this.comSom, fila: this.fila.disponivel });
      this.quadros = this.comSom = 0;
    }
    return true;
  }
}
registerProcessor("fila-pcm", ProcessadorPCM);
