/**
 * Controles de abuso do signaling.
 *
 * O servidor e o unico componente publico do sistema: qualquer pessoa na
 * internet alcanca a porta. Nao ha midia passando por aqui, entao o dano
 * possivel e esgotar memoria/CPU do processo (flood de conexoes, spam de
 * eventos, payload gigante) ou poluir a sala dos outros.
 */

/** Limites por evento: { janela em ms, maximo de eventos na janela }. */
import { isIP } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { ipKeyGenerator } from "express-rate-limit";

export const EVENT_LIMITS = {
  hello: { windowMs: 10_000, max: 5 },
  "stream:join": { windowMs: 30_000, max: 10 },
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
 *
 * Mas o header e texto que o CLIENTE manda: quem alcanca o processo por fora
 * do proxy forja um IP diferente a cada conexao e o limite por IP deixa de
 * existir — cada tentativa parece vir de alguem novo.
 *
 * Exige TRUST_PROXY=1 e conexao direta de endereco privado. Isso pressupoe
 * um unico proxy confiavel, que sobrescreve o header ou acrescenta o IP
 * observado ao final. Verificar a topologia do provedor antes de habilitar;
 * redes com varios proxies exigem uma lista explicita de proxies confiaveis.
 */
const PRIVADO =
  /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::ffff:(10\.|127\.|192\.168\.)|f[cd])/i;

export function clientIp(socket) {
  const direto = socket.handshake.address || "desconhecido";
  const atrasDeProxy = PRIVADO.test(direto) && process.env.TRUST_PROXY === "1";

  if (atrasDeProxy) {
    const fwd = socket.handshake.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.length) {
      // Um proxy confiavel acrescenta o IP observado ao final. O primeiro
      // item pode ter sido fornecido pelo atacante; nunca usá-lo como chave.
      const last = fwd.split(",").at(-1).trim();
      if (isIP(last)) return normalizeIp(last);
    }
  }
  return normalizeIp(direto);
}

function normalizeIp(value) {
  const mapped = value.replace(/^::ffff:/i, "");
  if (isIP(mapped) === 4) return mapped;
  return isIP(value) ? ipKeyGenerator(value, 64) : "desconhecido";
}

export const requestIp = (req) => clientIp({ handshake: { address: req.socket.remoteAddress, headers: req.headers } });

/* -------------------------- limitador por janela -------------------------- */

export class RateLimiter {
  #hits = new Map(); // chave -> array de timestamps

  /** @returns true se a acao e permitida */
  allow(key, windowMs, max) {
    // IPs aleatorios nao podem criar um mapa ilimitado antes da varredura.
    if (!this.#hits.has(key) && this.#hits.size >= 20000) return false;
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

/** Ids de canal e de usuario: alfanumerico, hifen, underscore e ponto. */
export function sanitizeId(value, maxLength = 64) {
  if (typeof value !== "string") return "";
  return value.length > 0 && value.length <= maxLength && /^[a-zA-Z0-9._:-]+$/.test(value)
    ? value
    : "";
}

/**
 * Comparacao de segredo em tempo constante.
 * `===` sai no primeiro byte diferente, o que teoricamente vaza o prefixo
 * correto por tempo de resposta. O custo de fazer certo aqui e irrelevante.
 */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length > 4096 || b.length > 4096) return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
