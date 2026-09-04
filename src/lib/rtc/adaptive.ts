import type { PeerStats } from "./types";

/* ---------------------------------------------------------------------------
   Adaptacao automatica de qualidade.

   O congestion control do WebRTC ja ajusta bitrate sozinho, mas ele nao sabe
   que o PC esta sem CPU para encodar, nem que o usuario prefere perder nitidez
   a perder fluidez. Este controlador observa as metricas reais e reduz a carga
   em degraus, sempre preservando o framerate primeiro — que e o que faz um
   jogo parecer jogavel do outro lado.

   Sobe rapido quando o problema aparece (3 amostras ruins) e desce devagar
   quando melhora (15 amostras boas), para nao ficar oscilando de resolucao a
   cada pico de perda.
--------------------------------------------------------------------------- */

export interface DegradeStep {
  /** divisor da resolucao enviada: 1 = nativo, 2 = metade da largura/altura */
  scaleDownBy: number;
  /** teto de quadros por segundo */
  fpsCap: number;
  label: string;
}

/**
 * Degraus escolhidos para derrubar pixels antes de derrubar quadros: 60 fps
 * so cede no ultimo degrau, quando ja nao ha o que cortar em resolucao.
 */
export const DEGRADE_STEPS: DegradeStep[] = [
  { scaleDownBy: 1, fpsCap: Infinity, label: "nativo" },
  { scaleDownBy: 1.5, fpsCap: Infinity, label: "resolucao -33%" },
  { scaleDownBy: 2, fpsCap: 45, label: "metade da resolucao" },
  { scaleDownBy: 3, fpsCap: 30, label: "modo sobrevivencia" },
];

const AMOSTRAS_PARA_PIORAR = 3;
const AMOSTRAS_PARA_MELHORAR = 15;
const PERDA_RUIM_PCT = 5;
const PERDA_BOA_PCT = 1;

/**
 * Degrau em que uma transmissao COMECA, conforme quanta gente vai receber.
 *
 * Numa malha full mesh nao existe um encode reaproveitado: a mesma imagem e
 * codificada uma vez para CADA espectador. Com 5 pessoas assistindo sao 5
 * encodes simultaneos, e ai o gargalo vira CPU — o bitrate ja e dividido por
 * espectador (`budgetPerPeer`), a CPU nao e.
 *
 * A adaptacao reativa sozinha chega tarde nesse caso: sao 4s de aquecimento
 * mais 3 amostras ruins antes do primeiro degrau, e nesse intervalo quem
 * esta transmitindo sente o proprio jogo travar — que e justamente o momento
 * em que a pessoa desiste e desliga.
 *
 * Isto NAO e um teto: e so o ponto de partida. Se as metricas ficarem boas o
 * bastante por tempo suficiente, `evaluate` continua livre para descer
 * abaixo do piso — a maquina provou que aguenta, entao ela pode.
 */
function pisoPorEspectadores(n: number): number {
  if (n >= 5) return 2;
  if (n >= 3) return 1;
  return 0;
}

export interface AdaptiveDecision {
  step: DegradeStep;
  changed: boolean;
  reason: string;
}

/**
 * Encoder novo leva um instante pra estabilizar: os primeiros segundos de
 * uma transmissao costumam reportar 0 fps ou "limitado por CPU" so porque o
 * primeiro keyframe ainda esta sendo gerado, nao porque a maquina nao
 * aguenta. Sem essa folga, toda transmissao comecava direto no pior degrau
 * — a mesma leitura transitoria que o start-bitrate do SDP ja existe pra
 * evitar do lado do bitrate, faltava do lado da resolucao/fps.
 */
const AQUECIMENTO_MS = 4000;

export class AdaptiveQuality {
  private level = 0;
  private ruins = 0;
  private boas = 0;
  private iniciadoEm = 0;
  private espectadores = 0;

  get current(): DegradeStep {
    return DEGRADE_STEPS[this.level];
  }

  reset() {
    this.level = pisoPorEspectadores(this.espectadores);
    this.ruins = 0;
    this.boas = 0;
    this.iniciadoEm = Date.now();
  }

  /**
   * Quantas pessoas vao receber esta transmissao. Chamado quando alguem
   * entra ou sai do canal.
   *
   * So sobe o degrau, nunca desce: quem saiu nao devolve qualidade na hora —
   * isso e trabalho do `evaluate`, que decide olhando metrica de verdade em
   * vez de palpite. Sem essa assimetria, alguem entrando e saindo em
   * sequencia ficaria empurrando a resolucao pra cima e pra baixo.
   */
  setViewers(n: number): AdaptiveDecision {
    const antes = this.espectadores;
    this.espectadores = n;
    if (n <= antes) return { step: this.current, changed: false, reason: "" };

    const piso = pisoPorEspectadores(n);
    if (piso <= this.level) return { step: this.current, changed: false, reason: "" };

    this.level = piso;
    this.ruins = 0;
    this.boas = 0;
    return { step: this.current, changed: true, reason: `${n} pessoas recebendo` };
  }

  /**
   * Avalia uma rodada de metricas (uma por par) e decide se muda de degrau.
   * Usa o PIOR par: numa malha, quem esta com a conexao ruim dita o limite,
   * porque a mesma imagem e codificada uma vez para cada espectador.
   */
  evaluate(stats: Iterable<PeerStats>): AdaptiveDecision {
    if (Date.now() - this.iniciadoEm < AQUECIMENTO_MS) {
      return { step: this.current, changed: false, reason: "aquecendo" };
    }

    let pior = { limitation: "none", loss: 0 };
    let algum = false;

    for (const s of stats) {
      algum = true;
      if (s.lossPct > pior.loss) pior.loss = s.lossPct;
      if (s.limitation === "cpu" || s.limitation === "bandwidth") pior.limitation = s.limitation;
    }

    if (!algum) return { step: this.current, changed: false, reason: "sem pares" };

    const ruim = pior.limitation !== "none" || pior.loss > PERDA_RUIM_PCT;
    const boa = pior.limitation === "none" && pior.loss < PERDA_BOA_PCT;

    if (ruim) {
      this.boas = 0;
      this.ruins++;
    } else if (boa) {
      this.ruins = 0;
      this.boas++;
    } else {
      // Zona morta: nem ruim o bastante para piorar, nem boa o bastante para
      // recuperar. Segura o degrau atual em vez de oscilar.
      this.ruins = 0;
      this.boas = 0;
    }

    if (this.ruins >= AMOSTRAS_PARA_PIORAR && this.level < DEGRADE_STEPS.length - 1) {
      this.level++;
      this.ruins = 0;
      const motivo =
        pior.limitation === "cpu"
          ? "CPU nao acompanha a codificacao"
          : pior.limitation === "bandwidth"
            ? "banda insuficiente"
            : `perda de ${pior.loss.toFixed(1)}%`;
      return { step: this.current, changed: true, reason: motivo };
    }

    if (this.boas >= AMOSTRAS_PARA_MELHORAR && this.level > 0) {
      this.level--;
      this.boas = 0;
      return { step: this.current, changed: true, reason: "conexao estavel" };
    }

    return { step: this.current, changed: false, reason: "" };
  }
}
