/**
 * VOXA — Signaling Server
 * ---------------------------------------------------------------------------
 * Responsabilidade UNICA: handshake WebRTC (SDP/ICE), presenca e relay de chat.
 * Nenhum byte de audio ou video passa por aqui — tudo e P2P entre os clientes.
 *
 * Sem Express, sem ORM, sem middleware: http nativo + socket.io.
 * O que este arquivo faz e apenas montar as pecas:
 *   lib/security.js  limites de taxa, sanitizacao, comparacao de segredo
 *   lib/state.js     quem esta conectado e em qual canal
 *   lib/handlers.js  o que cada evento faz
 */
import { createServer } from "node:http";
import { Server } from "socket.io";

import { Registry } from "./lib/state.js";
import { registerHandlers } from "./lib/handlers.js";
import {
  MAX_HANDSHAKES_PER_MIN,
  MAX_SOCKETS_PER_IP,
  RateLimiter,
  clientIp,
  safeEqual,
} from "./lib/security.js";

const PORT = Number(process.env.PORT || 3001);
const ORIGIN = process.env.ORIGIN || "*";

/**
 * Senha da sala. Sem ela, qualquer um que descubra o endereco entra e escuta.
 * Vazio = servidor aberto, aceitavel apenas em localhost.
 */
const TOKEN = process.env.VOXA_TOKEN || "";

/**
 * Logs deliberadamente pobres.
 *
 * Um servidor de sinalizacao ve SDP (que carrega os IPs de todo mundo), ids de
 * sala e apelidos. Nada disso precisa ir para disco, e em plataforma gratuita
 * os logs costumam ser legiveis por terceiros. Registramos contagens e falhas,
 * nunca conteudo, nunca IP, nunca stack trace de excecao vinda da rede.
 */
const log = {
  info: (...a) => console.log("[voxa]", ...a),
  warn: (...a) => console.warn("[voxa]", ...a),
};

if (!TOKEN) log.warn("AVISO: rodando sem VOXA_TOKEN — servidor aberto.");

const registry = new Registry();
const limiter = new RateLimiter();

/* ------------------------------- HTTP ------------------------------------- */

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, {
      "content-type": "application/json",
      // Endpoint publico de status: nao ha nada a embutir nem a inferir dele.
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
    res.end(
      JSON.stringify({
        ok: true,
        ...registry.summary(),
        uptime: Math.round(process.uptime()),
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + "MB",
      })
    );
    return;
  }

  // Qualquer outra rota nao existe — e nao conta ao visitante o que existe.
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

/* ------------------------------ socket.io --------------------------------- */

const io = new Server(httpServer, {
  cors: { origin: ORIGIN, methods: ["GET", "POST"] },
  // Handshake e mensagens curtas: websocket direto, sem polling.
  transports: ["websocket"],
  perMessageDeflate: false,
  // Um SDP com muitos candidatos passa de 10 KB; 256 KB e folga suficiente e
  // corta payload gigante usado para inflar memoria do processo.
  maxHttpBufferSize: 256 * 1024,
  pingInterval: 20000,
  pingTimeout: 25000,
  connectTimeout: 20000,
});

/**
 * Porta de entrada. Roda ANTES de qualquer handler existir, entao flood e
 * senha errada morrem sem custar processamento nem alocar estado.
 */
io.use((socket, next) => {
  const ip = clientIp(socket);
  socket.data.ip = ip;

  if (!limiter.allow(`hs:${ip}`, 60_000, MAX_HANDSHAKES_PER_MIN)) {
    return next(new Error("muitas tentativas"));
  }
  if (registry.countByIp(ip) >= MAX_SOCKETS_PER_IP) {
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
    io.close(() => httpServer.close(() => process.exit(0)));
  });
}

// Uma excecao nao tratada nao pode derrubar a sala inteira. Registramos o tipo
// e seguimos: o processo continua servindo quem ja esta conectado.
process.on("uncaughtException", (err) => log.warn("excecao nao tratada:", err?.name));
process.on("unhandledRejection", (err) => log.warn("promessa rejeitada:", err?.name));
