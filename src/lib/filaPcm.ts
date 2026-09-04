/* ---------------------------------------------------------------------------
   Fila de PCM entre o IPC e a placa de som.

   Vive fora do sysaudio.ts porque precisa ser as duas coisas ao mesmo tempo:
   o codigo que roda DENTRO do AudioWorklet (que nao aceita import — o texto
   e injetado via toString) e uma classe comum que da pra testar em Node.
   Sem isso, a unica forma de validar seria ouvir e torcer.

   O problema que ela resolve: o IPC entrega blocos quando consegue, e o
   AudioWorklet pede exatamente 128 quadros a cada ~2,7 ms, sem tolerancia.
   Sem folga, todo atraso do IPC vira um clique audivel; com folga demais, o
   som atrasa em relacao a imagem.
--------------------------------------------------------------------------- */

export class FilaPCM {
  private blocos: Float32Array[] = [];
  private posicao = 0;
  private quadros = 0;
  private tocando = false;
  /** quadros acumulados antes de comecar a tocar (~60 ms a 48 kHz) */
  private minimo: number;
  /** teto: acima disso o passado e descartado (~400 ms) */
  private maximo: number;

  // Campos explicitos, sem "parameter properties": elas geram codigo, e tanto
  // o `node --test` (que remove tipos sem compilar) quanto o `toString()` que
  // vira worklet precisam desta classe sendo JavaScript puro por baixo.
  constructor(minimo = 2880, maximo = 19200) {
    this.minimo = minimo;
    this.maximo = maximo;
  }

  /** quadros disponiveis — util para teste e diagnostico */
  get disponivel() {
    return this.quadros;
  }

  push(bloco: Float32Array) {
    if (bloco.length === 0) return;
    this.blocos.push(bloco);
    this.quadros += bloco.length / 2;

    // Atrasou demais (janela escondida, IPC engasgado): joga fora o passado e
    // volta a tocar perto do agora. Meio segundo de atraso em relacao a imagem
    // incomoda mais do que perder um pedaco.
    while (this.quadros > this.maximo && this.blocos.length > 1) {
      const fora = this.blocos.shift()!;
      // Desconta so o que ainda restava do bloco descartado.
      this.quadros -= (fora.length - (this.blocos.length === 0 ? this.posicao : 0)) / 2;
      if (this.blocos.length === 0) this.posicao = 0;
    }
  }

  /** Preenche um bloco de saida. Silencio quando nao ha folga suficiente. */
  pull(esq: Float32Array, dir: Float32Array) {
    if (!this.tocando) {
      if (this.quadros < this.minimo) {
        esq.fill(0);
        dir.fill(0);
        return;
      }
      this.tocando = true;
    }

    for (let i = 0; i < esq.length; i++) {
      const atual = this.blocos[0];
      if (!atual) {
        // Fila secou: silencio ate juntar folga de novo, senao entra num ciclo
        // de estalos tocando fragmentos soltos.
        esq[i] = 0;
        dir[i] = 0;
        this.tocando = false;
        continue;
      }

      esq[i] = atual[this.posicao] ?? 0;
      dir[i] = atual[this.posicao + 1] ?? 0;
      this.posicao += 2;
      this.quadros--;

      if (this.posicao >= atual.length) {
        this.blocos.shift();
        this.posicao = 0;
      }
    }
  }
}
