/**
 * VOXA — Signaling Server
 * ---------------------------------------------------------------------------
 * Responsabilidade unica: autenticar a sala e trocar endpoints UDP.
 * Nenhum frame ou comando de input passa por este processo.
 *
 * Express limita HTTP; Engine.IO limita transportes antes da autenticacao.
 * O que este arquivo faz e apenas montar as pecas:
 *   lib/security.js  limites de taxa, sanitizacao, comparacao de segredo
 *   lib/state.js     quem esta conectado e em qual canal
 *   lib/handlers.js  o que cada evento faz
 */
import { createServer } from "node:http";
import { isIP } from "node:net";
import { Server } from "socket.io";
import { createHttpApp } from "./lib/http.js";
import { Admission } from "./lib/admission.js";
import { startUdpRelay } from "./lib/relay.js";

import { StreamRegistry } from "./lib/state.js";
import { registerHandlers } from "./lib/handlers.js";
import {
  MAX_HANDSHAKES_PER_MIN,
  MAX_SOCKETS_PER_IP,
  RateLimiter,
  clientIp,
  requestIp,
  safeEqual,
} from "./lib/security.js";

const PORT = Number(process.env.PORT || 3001);
const ORIGIN = process.env.ORIGIN || "*";
const RELAY_PORT = Number(process.env.VOXA_RELAY_PORT || 0);
const RELAY_PUBLIC_ENDPOINT = process.env.VOXA_RELAY_PUBLIC_ENDPOINT || "";
const RELAY_SECRET = process.env.VOXA_RELAY_SECRET || "";
const MAX_VIEWERS = Number(process.env.VOXA_MAX_VIEWERS || 4);
if (!Number.isInteger(MAX_VIEWERS) || MAX_VIEWERS < 1 || MAX_VIEWERS > 16) {
  throw new Error("VOXA_MAX_VIEWERS deve estar entre 1 e 16");
}
if (RELAY_PUBLIC_ENDPOINT && !validUdpEndpoint(RELAY_PUBLIC_ENDPOINT)) {
  throw new Error("VOXA_RELAY_PUBLIC_ENDPOINT deve ser um IP:porta UDP válido");
}
if ((RELAY_PUBLIC_ENDPOINT || RELAY_PORT > 0) && RELAY_SECRET.length < 32) {
  throw new Error("VOXA_RELAY_SECRET deve ter pelo menos 32 caracteres");
}

/**
 * Senha da sala. Sem ela, qualquer um que descubra o endereco entra e escuta.
 * Vazio = servidor aberto, aceitavel apenas em localhost.
 */
const TOKEN = process.env.VOXA_TOKEN || "";

/**
 * Logs deliberadamente pobres.
 *
 * O servidor ve endpoints UDP, ids de sala e ids efemeros de dispositivos.
 * Nada disso precisa ir para disco, e em plataforma gratuita
 * os logs costumam ser legiveis por terceiros. Registramos contagens e falhas,
 * nunca conteudo, nunca IP, nunca stack trace de excecao vinda da rede.
 */
const log = {
  info: (...a) => console.log("[voxa]", ...a),
  warn: (...a) => console.warn("[voxa]", ...a),
};

if (!TOKEN) log.warn("AVISO: rodando sem VOXA_TOKEN — servidor aberto.");

const registry = new StreamRegistry(RELAY_PUBLIC_ENDPOINT, RELAY_SECRET, MAX_VIEWERS);
const limiter = new RateLimiter();
const relay = RELAY_PORT > 0 ? startUdpRelay({ port: RELAY_PORT, secret: RELAY_SECRET, log }) : null;

/* ------------------------------- HTTP ------------------------------------- */

const httpServer = createServer({ requestTimeout: 10000, headersTimeout: 10000, maxHeaderSize: 16384 }, createHttpApp());
const admission = new Admission(128, MAX_SOCKETS_PER_IP);
const reservations = new WeakMap();

/* ------------------------------ socket.io --------------------------------- */

const io = new Server(httpServer, {
  allowRequest: (req, callback) => {
    const ip = requestIp(req);
    if (!limiter.allow(`transport:${ip}`, 60000, MAX_HANDSHAKES_PER_MIN)) return callback("muitas tentativas", false);
    const reservation = admission.reserve(ip);
    if (!reservation) return callback("limite de conexoes", false);
    reservations.set(req, reservation);
    callback(null, true);
  },
  cors: { origin: ORIGIN, methods: ["GET", "POST"] },
  // Handshake e mensagens curtas: websocket direto, sem polling.
  transports: ["websocket"],
  perMessageDeflate: false,
  // Os eventos carregam apenas endpoints e uma chave curta. O limite reduz o
  // custo de payloads usados para inflar memoria do processo.
  maxHttpBufferSize: 16 * 1024,
  pingInterval: 20000,
  pingTimeout: 25000,
  connectTimeout: 20000,
});

/**
 * Porta de entrada. Roda ANTES de qualquer handler existir, entao flood e
 * senha errada morrem sem custar processamento nem alocar estado.
 */
io.engine.on("connection", (client) => {
  const reservation = reservations.get(client.request);
  reservation?.connected();
  client.once("close", () => reservation?.release());
});

io.use((socket, next) => {
  const ip = clientIp(socket);
  socket.data.ip = ip;

  if (!limiter.allow(`hs:${ip}`, 60_000, MAX_HANDSHAKES_PER_MIN)) {
    return next(new Error("muitas tentativas"));
  }
  if (io.engine.clientsCount > 128 || [...io.sockets.sockets.values()].filter(client => client.data.ip === ip).length >= MAX_SOCKETS_PER_IP) {
    return next(new Error("limite de conexoes"));
  }

  // Caminho novo: token no handshake, rejeitado antes de abrir o socket.
  // Caminho antigo (app ja instalado): token vem no evento `hello`.
  const enviado = socket.handshake.auth?.token;
  if (TOKEN && typeof enviado === "string" && enviado.length > 0) {
    if (!safeEqual(enviado, TOKEN)) return next(new Error("nao autorizado"));
    socket.data.authed = true;
  }

  next();
});

io.on("connection", (socket) => {
  registerHandlers({ io, socket, registry, limiter, token: TOKEN, log });
});

/* ------------------------------ manutencao -------------------------------- */

// O limitador guarda timestamps por chave; sem varredura periodica ele so
// cresce num processo que fica meses no ar.
const sweeper = setInterval(() => limiter.sweep(), 60_000);
sweeper.unref?.();

httpServer.listen(PORT, () => {
  log.info(`ws://localhost:${PORT} (health: /health)`);
  log.info(`protegido por token: ${TOKEN ? "sim" : "NAO"}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    clearInterval(sweeper);
    relay?.close();
    io.close(() => httpServer.close(() => process.exit(0)));
  });
}

// Uma excecao nao tratada encerra o processo para o supervisor reinicia-lo em
// estado limpo. Registramos somente o tipo para evitar dados sensiveis.
process.on("uncaughtException", (err) => { log.warn("excecao nao tratada:", err?.name); process.exit(1); });
process.on("unhandledRejection", (err) => {
  log.warn("promessa rejeitada:", err?.name);
  process.exit(1);
});

function validUdpEndpoint(value) {
  const match = /^\[([^\]]+)]:(\d+)$/.exec(value) ?? /^([^:]+):(\d+)$/.exec(value);
  if (!match || !isIP(match[1])) return false;
  const port = Number(match[2]);
  return port >= 1 && port <= 65535;
}
