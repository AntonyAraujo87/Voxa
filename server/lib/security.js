/**
 * Controles de abuso do signaling.
 *
 * O servidor e o unico componente publico do sistema: qualquer pessoa na
 * internet alcanca a porta. Nao ha midia passando por aqui, entao o dano
 * possivel e esgotar memoria/CPU do processo (flood de conexoes, spam de
 * eventos, payload gigante) ou poluir a sala dos outros.
 */

/** Limites por evento: { janela em ms, maximo de eventos na janela }. */
export const EVENT_LIMITS = {
  hello: { windowMs: 10_000, max: 5 },
  // ICE chega em rajada durante o handshake — o teto precisa ser alto.
  signal: { windowMs: 10_000, max: 400 },
  "voice:join": { windowMs: 30_000, max: 15 },
  "voice:leave": { windowMs: 30_000, max: 15 },
  state: { windowMs: 10_000, max: 40 },
  "chat:send": { windowMs: 5_000, max: 8 },
  "chat:typing": { windowMs: 5_000, max: 6 },
};

/** Conexoes simultaneas do mesmo IP. Amigos na mesma casa compartilham IP. */
export const MAX_SOCKETS_PER_IP = 10;
/** Tentativas de handshake por minuto, por IP. */
export const MAX_HANDSHAKES_PER_MIN = 60;

/**
 * IP real do cliente.
 *
 * Em PaaS (Render, Fly, Railway) o trafego chega por um proxy e o endereco do
 * socket e sempre o do proxy. Sem ler o x-forwarded-for, TODOS os usuarios
 * contariam como um unico IP e o limitador derrubaria a sala inteira.
 */
export function clientIp(socket) {
  const fwd = socket.handshake.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) {
    const first = fwd.split(",")[0].trim();
    if (first) return first;
  }
  return socket.handshake.address || "desconhecido";
}

/* -------------------------- limitador por janela -------------------------- */

export class RateLimiter {
  #hits = new Map(); // chave -> array de timestamps

  /** @returns true se a acao e permitida */
  allow(key, windowMs, max) {
    const now = Date.now();
    const list = this.#hits.get(key) ?? [];
    // Descarta o que saiu da janela antes de decidir.
    const recent = list.filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      this.#hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.#hits.set(key, recent);
    return true;
  }

  forget(prefix) {
    for (const key of this.#hits.keys()) {
      if (key.startsWith(prefix)) this.#hits.delete(key);
    }
  }

  /** Evita crescimento sem limite em processos de vida longa. */
  sweep(maxAgeMs = 120_000) {
    const now = Date.now();
    for (const [key, list] of this.#hits) {
      const recent = list.filter((t) => now - t < maxAgeMs);
      if (recent.length === 0) this.#hits.delete(key);
      else this.#hits.set(key, recent);
    }
  }
}

/* ------------------------------ sanitizacao ------------------------------- */

// Faixas removidas do texto, descritas por code point para que nenhum editor
// ou normalizacao de arquivo consiga corrompe-las silenciosamente:
//   0000-0008, 000B-001F, 007F  controle (quebra de linha e tab ficam)
//   00AD                        soft hyphen invisivel
//   200B-200F, 2060-2064, FEFF  zero-width e joiners
//   202A-202E                   marcas bidirecionais
// As bidi sao as mais traicoeiras: invertem visualmente a ordem do texto e
// permitem forjar uma mensagem que aparenta ter sido escrita por outra pessoa.
const FAIXAS_PROIBIDAS = [
  [0x0000, 0x0008],
  [0x000b, 0x001f],
  [0x007f, 0x007f],
  [0x00ad, 0x00ad],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0xfeff, 0xfeff],
];

let cacheRegex = null;
function PERIGOSOS() {
  if (!cacheRegex) {
    const classe = FAIXAS_PROIBIDAS.map(([ini, fim]) =>
      ini === fim
        ? String.fromCharCode(ini)
        : String.fromCharCode(ini) + "-" + String.fromCharCode(fim)
    ).join("");
    cacheRegex = new RegExp("[" + classe + "]", "g");
  }
  return cacheRegex;
}

export function sanitizeText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFC")
    .replace(PERIGOSOS(), "")
    .replace(/\r\n?/g, "\n")
    // Muros de linhas vazias empurram o historico dos outros para fora da tela.
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, maxLength);
}

export function sanitizeName(value, fallback = "anon") {
  const limpo = sanitizeText(value, 32).replace(/\s+/g, " ");
  return limpo.length >= 2 ? limpo : fallback;
}

/** Aceita apenas cores no formato #rgb / #rrggbb. */
export function sanitizeColor(value, fallback = "#5865F2") {
  return typeof value === "string" && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : fallback;
}

/** Ids de canal e de usuario: alfanumerico, hifen, underscore e ponto. */
export function sanitizeId(value, maxLength = 64) {
  if (typeof value !== "string") return "";
  return value.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, maxLength);
}

/**
 * Comparacao de segredo em tempo constante.
 * `===` sai no primeiro byte diferente, o que teoricamente vaza o prefixo
 * correto por tempo de resposta. O custo de fazer certo aqui e irrelevante.
 */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
