import { audioContext } from "./media";
import { registrarErro } from "./diagnostico";

/* ---------------------------------------------------------------------------
   Bus de saida compartilhado. Todo audio remoto (voz + som de transmissao,
   de todo mundo) converge aqui antes de tocar.

   Existe porque escolher DISPOSITIVO de saida so e possivel via
   HTMLMediaElement.setSinkId() — AudioContext nao tem selecao de dispositivo
   na versao do WebView2 que roda hoje. A solucao: cada peer continua com seu
   proprio GainNode (volume individual), mas em vez de ir direto pro
   ctx.destination, todos convergem numa unica soma, que alimenta UM <audio>
   escondido — e e nesse elemento que .setSinkId() escolhe o fone/caixa.

   O modo "Nivelado" insere um DynamicsCompressorNode nesse ponto de soma:
   sobe quem fala baixo, segura quem fala alto, sem exigir teto de volume por
   pessoa. E opcional porque compressao muda o timbre — quem prefere a
   dinamica original desliga.
--------------------------------------------------------------------------- */

let bus: GainNode | null = null;
let compressor: DynamicsCompressorNode | null = null;
let destino: MediaStreamAudioDestinationNode | null = null;
let elemento: HTMLAudioElement | null = null;
let nivelado = false;

function garantirGrafo() {
  const ctx = audioContext();
  if (bus && destino && elemento) return;

  bus = ctx.createGain();
  destino = ctx.createMediaStreamDestination();
  bus.connect(destino);

  elemento = new Audio();
  elemento.autoplay = true;
  elemento.srcObject = destino.stream;

  // No DOM de proposito. Um `new Audio()` solto reproduz na maioria dos
  // casos, mas e o unico caminho por onde TODO o audio remoto sai — nao vale
  // depender de um detalhe de implementacao do navegador.
  elemento.style.display = "none";
  document.body.appendChild(elemento);

  tocar();
}

/**
 * Tenta dar play e, se o navegador recusar, tenta de novo ao primeiro toque
 * da pessoa.
 *
 * Isto ja falhou calado uma vez e custou caro: o `catch` vazio dizia que "o
 * destravamento global em audioContext() cobre isso", e nao cobria — aquele
 * destravamento so chama `ctx.resume()`, que acorda o PROCESSADOR de audio,
 * nao este elemento. Com o play recusado, o grafo processava normalmente e o
 * som simplesmente nunca chegava na caixa: chamada muda, com o video
 * funcionando do lado (porque o <video> e outro elemento, montado pelo
 * React). O sintoma relatado foi "a imagem aparece, so fica sem som".
 */
function tocar() {
  const alvo = elemento;
  if (!alvo) return;

  alvo
    .play()
    .then(() => {
      document.removeEventListener("click", tocar, true);
      document.removeEventListener("keydown", tocar, true);
    })
    .catch((err) => {
      registrarErro("audio:saida", err);
      // `true` para pegar o evento na captura: um clique em botao que chama
      // stopPropagation ainda destrava o audio.
      document.addEventListener("click", tocar, true);
      document.addEventListener("keydown", tocar, true);
    });
}

/** O audio remoto esta realmente saindo? Usado pelo diagnostico. */
export function saidaTocando(): boolean {
  return !!elemento && !elemento.paused;
}

/**
 * Estado do caminho de saida, para o diagnostico.
 *
 * "tocando" sozinho nao bastou: o elemento pode estar rodando e ainda assim
 * ninguem ouvir — se o processador de audio esta suspenso, se o volume geral
 * esta zerado, ou se o som sai por um dispositivo que a pessoa nao usa.
 */
export function estadoSaida() {
  const ctx = audioContext();
  return {
    contexto: ctx.state,
    tocando: saidaTocando(),
    volumeGeral: bus ? Number(bus.gain.value.toFixed(2)) : null,
    dispositivo:
      (elemento as (HTMLAudioElement & { sinkId?: string }) | null)?.sinkId || "padrao do sistema",
    modo: nivelado ? "nivelado" : "natural",
  };
}

/** Ponto de entrada de cada peer: conecte o GainNode individual aqui, nao no destination. */
export function entradaDoBus(): GainNode {
  garantirGrafo();
  return bus!;
}

export function setOutputMode(leveled: boolean) {
  garantirGrafo();
  if (leveled === nivelado) return;
  nivelado = leveled;

  bus!.disconnect();
  compressor?.disconnect();

  if (leveled) {
    const ctx = audioContext();
    compressor = ctx.createDynamicsCompressor();
    // Ajuste conservador: nivela sem achatar a fala — soa proximo do que
    // qualquer headset com AGC de hardware ja faz.
    compressor.threshold.value = -28;
    compressor.knee.value = 24;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.006;
    compressor.release.value = 0.2;
    bus!.connect(compressor);
    compressor.connect(destino!);
  } else {
    compressor = null;
    bus!.connect(destino!);
  }
}

export interface OutputSupport {
  setSinkId: boolean;
}

export const outputSupport: OutputSupport = {
  setSinkId:
    typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype,
};

/** Troca o fone/caixa de saida. Sem suporte no runtime, ignora em silencio. */
export async function setOutputDevice(deviceId: string): Promise<boolean> {
  garantirGrafo();
  if (!outputSupport.setSinkId) return false;
  try {
    await (elemento as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(
      deviceId || ""
    );
    return true;
  } catch {
    return false;
  }
}
