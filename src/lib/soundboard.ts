import { audioContext } from "./media";

/* ---------------------------------------------------------------------------
   Soundboard: efeitos curtos, sintetizados no WebAudio — mesmo motivo dos
   avisos de entrada/saida em sounds.ts (nao acrescenta byte ao instalador,
   sem licenciamento de clipe de terceiro pra se preocupar).

   Cada efeito toca em QUALQUER lista de destinos que o chamador passar —
   normalmente dois ao mesmo tempo: o bus de saida local (audioOutput.ts,
   pra quem apertou tambem ouvir) e o bus de mixagem do microfone
   (localMedia.ts, pra ir junto da voz pros outros peers).
--------------------------------------------------------------------------- */

export interface SoundboardClip {
  id: string;
  label: string;
  emoji: string;
}

export const SOUNDBOARD_CLIPS: SoundboardClip[] = [
  { id: "airhorn", label: "Buzina", emoji: "📯" },
  { id: "applause", label: "Aplausos", emoji: "👏" },
  { id: "victory", label: "Vitoria", emoji: "🏆" },
  { id: "fail", label: "Perdeu", emoji: "💀" },
  { id: "alarm", label: "Alarme", emoji: "🚨" },
  { id: "boo", label: "Vaia", emoji: "📢" },
];

type Destino = AudioNode;

function tom(
  ctx: AudioContext,
  destinos: Destino[],
  freq: number,
  inicio: number,
  duracao: number,
  volume: number,
  tipo: OscillatorType = "sine"
) {
  const osc = ctx.createOscillator();
  const ganho = ctx.createGain();
  osc.type = tipo;
  osc.frequency.value = freq;

  const t = ctx.currentTime + inicio;
  ganho.gain.setValueAtTime(0, t);
  ganho.gain.linearRampToValueAtTime(volume, t + 0.01);
  ganho.gain.exponentialRampToValueAtTime(0.0001, t + duracao);

  osc.connect(ganho);
  for (const d of destinos) ganho.connect(d);
  osc.start(t);
  osc.stop(t + duracao + 0.02);
}

/** Rajada de ruido branco com envelope — base de aplausos/estatica. */
function ruido(ctx: AudioContext, destinos: Destino[], inicio: number, duracao: number, volume: number) {
  const tamanho = Math.max(1, Math.floor(ctx.sampleRate * duracao));
  const buffer = ctx.createBuffer(1, tamanho, ctx.sampleRate);
  const dados = buffer.getChannelData(0);
  for (let i = 0; i < tamanho; i++) dados[i] = Math.random() * 2 - 1;

  const fonte = ctx.createBufferSource();
  fonte.buffer = buffer;
  const ganho = ctx.createGain();

  const t = ctx.currentTime + inicio;
  ganho.gain.setValueAtTime(0, t);
  ganho.gain.linearRampToValueAtTime(volume, t + 0.01);
  ganho.gain.exponentialRampToValueAtTime(0.0001, t + duracao);

  fonte.connect(ganho);
  for (const d of destinos) ganho.connect(d);
  fonte.start(t);
}

const RECEITAS: Record<string, (ctx: AudioContext, destinos: Destino[]) => void> = {
  airhorn: (ctx, d) => {
    tom(ctx, d, 370, 0, 0.5, 0.22, "sawtooth");
    tom(ctx, d, 370, 0.55, 0.5, 0.22, "sawtooth");
  },
  applause: (ctx, d) => {
    for (let i = 0; i < 14; i++) ruido(ctx, d, i * 0.028, 0.16, 0.09);
  },
  victory: (ctx, d) => {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
      tom(ctx, d, f, i * 0.1, 0.3, 0.16, "triangle")
    );
  },
  fail: (ctx, d) => {
    tom(ctx, d, 220, 0, 0.25, 0.18, "sawtooth");
    tom(ctx, d, 180, 0.2, 0.35, 0.18, "sawtooth");
    tom(ctx, d, 140, 0.45, 0.55, 0.18, "sawtooth");
  },
  alarm: (ctx, d) => {
    for (let i = 0; i < 4; i++) tom(ctx, d, 880, i * 0.22, 0.18, 0.2, "square");
  },
  boo: (ctx, d) => {
    tom(ctx, d, 150, 0, 0.8, 0.2, "sawtooth");
    tom(ctx, d, 143, 0.1, 0.8, 0.15, "sawtooth");
  },
};

/** Toca o efeito em todos os destinos passados. Ignora id desconhecido. */
export function tocarEfeito(id: string, destinos: Destino[]) {
  const receita = RECEITAS[id];
  if (!receita || destinos.length === 0) return;
  receita(audioContext(), destinos);
}
