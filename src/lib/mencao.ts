/* ---------------------------------------------------------------------------
   Mencoes (@fulano) no chat.

   Modulo puro de proposito: nao importa React, store nem nada de rede. A
   regra de "isto e uma mencao" e cheia de casos de canto que sao invisiveis
   quando dao errado — um nome que e prefixo de outro, alguem chamado "Ana
   Paula" com espaco, um e-mail no meio da frase — e todos eles sao
   testaveis sem navegador.

   Nao existe lista fechada de nomes validos: o nome e escolhido por cada
   pessoa e pode conter espaco, acento e emoji. Por isso o casamento e feito
   contra o roster do canal, e nao contra um padrao tipo `@\w+` — senao
   "@Ana Paula" viraria mencao a uma "Ana" que talvez nem exista.
--------------------------------------------------------------------------- */

/** Mencao a todo mundo. Escrito em minusculas: a comparacao e case-insensitive. */
export const MENCAO_TODOS = "todos";

export type Parte =
  | { tipo: "texto"; texto: string }
  | { tipo: "mencao"; texto: string; alvo: string };

/** `@` so vale no comeco ou depois de algo que nao seja letra/numero — assim
 *  um e-mail (`fulano@dominio`) nao vira mencao ao "dominio". */
function inicioValido(texto: string, i: number): boolean {
  if (i === 0) return true;
  const anterior = texto[i - 1];
  return !/[\p{L}\p{N}]/u.test(anterior);
}

/**
 * Quebra o texto em partes, marcando as mencoes reconhecidas.
 *
 * Os nomes sao testados do MAIS LONGO para o mais curto. Sem isso, num canal
 * com "Ana" e "Ana Paula", escrever "@Ana Paula" casaria "Ana" e deixaria
 * " Paula" como texto solto — a mencao iria para a pessoa errada.
 */
export function partirPorMencao(texto: string, nomes: readonly string[]): Parte[] {
  const alvos = [...nomes, MENCAO_TODOS].sort((a, b) => b.length - a.length);
  const partes: Parte[] = [];
  let buffer = "";
  let i = 0;

  const despejar = () => {
    if (buffer) partes.push({ tipo: "texto", texto: buffer });
    buffer = "";
  };

  while (i < texto.length) {
    if (texto[i] !== "@" || !inicioValido(texto, i)) {
      buffer += texto[i];
      i++;
      continue;
    }

    const resto = texto.slice(i + 1).toLowerCase();
    const achado = alvos.find((n) => n && resto.startsWith(n.toLowerCase()));

    if (!achado) {
      buffer += texto[i];
      i++;
      continue;
    }

    despejar();
    partes.push({
      tipo: "mencao",
      texto: "@" + texto.slice(i + 1, i + 1 + achado.length),
      alvo: achado,
    });
    i += 1 + achado.length;
  }

  despejar();
  return partes;
}

/**
 * A mensagem chama ESTA pessoa?
 *
 * `@todos` conta. O proprio nome so e considerado se estiver no roster
 * passado — quem checa e quem tem essa lista.
 */
export function mencionaVoce(texto: string, meuNome: string, nomes: readonly string[]): boolean {
  if (!meuNome) return false;
  const alvo = meuNome.toLowerCase();
  return partirPorMencao(texto, nomes).some(
    (p) => p.tipo === "mencao" && (p.alvo.toLowerCase() === alvo || p.alvo === MENCAO_TODOS)
  );
}

/**
 * Estado do autocomplete: o que a pessoa digitou depois do ultimo `@` que
 * ainda esta "aberto" (sem espaco duplo nem quebra de linha depois).
 *
 * Devolve `null` quando nao ha `@` valido antes do cursor — a UI usa isso
 * pra decidir se mostra a lista.
 */
export function trechoDeMencao(texto: string, cursor: number): { inicio: number; termo: string } | null {
  const antes = texto.slice(0, cursor);
  const at = antes.lastIndexOf("@");
  if (at === -1 || !inicioValido(texto, at)) return null;

  const termo = antes.slice(at + 1);
  // Um nome pode ter UM espaco no meio ("Ana Paula"), mas dois seguidos ou
  // uma quebra de linha significam que a pessoa seguiu escrevendo a frase.
  if (/\n|\s{2}/.test(termo)) return null;
  if (termo.length > 32) return null;

  return { inicio: at, termo };
}

/** Nomes que combinam com o que ja foi digitado, do mais relevante ao menos. */
export function sugerir(termo: string, nomes: readonly string[], limite = 6): string[] {
  const t = termo.toLowerCase().trim();
  const alvos = [...nomes, MENCAO_TODOS];
  const comeca = alvos.filter((n) => n.toLowerCase().startsWith(t));
  const contem = alvos.filter((n) => !n.toLowerCase().startsWith(t) && n.toLowerCase().includes(t));
  return [...comeca, ...contem].slice(0, limite);
}
