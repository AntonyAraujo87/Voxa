import { audioContext } from "./media";

/* ---------------------------------------------------------------------------
   Avisos sonoros de entrada, saida e microfone.

   Sintetizados no WebAudio em vez de arquivos: nao acrescentam um byte ao
   instalador, nao passam por decodificacao e tocam com latencia de um frame.
   Sao dois tons curtos — subindo para entrar, descendo para sair — que e o
   vocabulario que todo mundo ja reconhece.
--------------------------------------------------------------------------- */

let habilitado = true;
export function setSoundsEnabled(on: boolean) {
  habilitado = on;
}

/** Nota unica com envelope suave; sem o fade, o corte estala no alto-falante. */
function nota(freq: number, inicio: number, duracao: number, volume: number) {
  const ctx = audioContext();
  const osc = ctx.createOscillator();
  const ganho = ctx.createGain();

  osc.type = "sine";
  osc.frequency.value = freq;

  const t = ctx.currentTime + inicio;
  ganho.gain.setValueAtTime(0, t);
  ganho.gain.linearRampToValueAtTime(volume, t + 0.012);
  ganho.gain.exponentialRampToValueAtTime(0.0001, t + duracao);

  osc.connect(ganho);
  ganho.connect(ctx.destination);
  osc.start(t);
  osc.stop(t + duracao + 0.02);

  // O oscilador some sozinho quando termina, mas o ganho continua ligado ao
  // destino — e o que esta ligado ao destino nao e coletado. Sem soltar aqui,
  // cada aviso (e eles tocam a cada pessoa que entra ou sai) deixava um node
  // pendurado no grafo pelo resto da sessao.
  osc.onended = () => {
    try {
      osc.disconnect();
      ganho.disconnect();
    } catch {
      /* contexto ja fechou */
    }
  };
}

function tocar(sequencia: [freq: number, atraso: number, dur: number][], volume = 0.06) {
  if (!habilitado) return;
  try {
    for (const [freq, atraso, dur] of sequencia) nota(freq, atraso, dur, volume);
  } catch {
    // AudioContext bloqueado ou fechado: som e cosmetico, nunca derruba nada.
  }
}

/** Alguem entrou no canal: duas notas subindo. */
export const playJoin = () =>
  tocar([
    [523.25, 0, 0.12],
    [783.99, 0.09, 0.16],
  ]);

/** Alguem saiu: as mesmas duas notas, descendo. */
export const playLeave = () =>
  tocar([
    [659.25, 0, 0.12],
    [415.3, 0.09, 0.18],
  ]);

/** Proprio microfone fechou. */
export const playMute = () => tocar([[392.0, 0, 0.09]], 0.05);

/** Proprio microfone abriu. */
export const playUnmute = () => tocar([[587.33, 0, 0.09]], 0.05);

/**
 * Alguem citou voce no chat: tres notas subindo, mais alto que os avisos de
 * entrada e saida.
 *
 * Deliberadamente distinto: entrada/saida acontecem o tempo todo e viram
 * ruido de fundo que o ouvido aprende a ignorar. Uma mencao e a unica coisa
 * no app que pede acao de quem esta jogando, entao precisa soar diferente
 * das outras — senao chega junto com o resto e passa batido.
 */
export const playMention = () =>
  tocar(
    [
      [659.25, 0, 0.1],
      [830.61, 0.08, 0.1],
      [987.77, 0.16, 0.2],
    ],
    0.075
  );
