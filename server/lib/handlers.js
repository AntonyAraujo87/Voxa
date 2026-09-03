import { GUILD } from "./state.js";
import {
  EVENT_LIMITS,
  sanitizeColor,
  sanitizeId,
  sanitizeName,
  sanitizeText,
  safeEqual,
} from "./security.js";

/**
 * Handlers dos eventos de socket.
 *
 * Duas regras valem para todos:
 *   1. nada e repassado sem passar por sanitizacao e limite de taxa;
 *   2. o servidor so encaminha o minimo para o handshake P2P acontecer.
 *      Ele nunca ve — e nunca poderia ver — audio ou video.
 */

const MAX_CHAT_LENGTH = 2000;
/** Sockets que conectam e nunca se apresentam sao lixo ocupando memoria. */
const HELLO_TIMEOUT_MS = 20_000;

export function registerHandlers({ io, socket, registry, limiter, token, log }) {
  const guard = (evento) => {
    const limite = EVENT_LIMITS[evento];
    if (!limite) return true;
    return limiter.allow(`${socket.id}:${evento}`, limite.windowMs, limite.max);
  };

  const identificado = () => registry.get(socket.id) !== undefined;

  socket.join(GUILD);

  const helloTimer = setTimeout(() => {
    if (!identificado()) socket.disconnect(true);
  }, HELLO_TIMEOUT_MS);

  const broadcastRoster = () => io.to(GUILD).emit("roster", registry.roster());

  /* ------------------------------- identidade ---------------------------- */

  socket.on("hello", (payload = {}, ack) => {
    if (!guard("hello")) return;
    if (identificado()) return; // reapresentacao nao recria o cliente

    // Compatibilidade: clientes novos mandam o token no handshake e ja chegam
    // marcados; os antigos so o enviam aqui. Ambos precisam acertar.
    if (token && !socket.data.authed) {
      if (!safeEqual(String(payload?.token ?? ""), token)) {
        if (typeof ack === "function") ack({ error: "token-invalido" });
        socket.disconnect(true);
        return;
      }
      socket.data.authed = true;
    }

    const user = {
      id: sanitizeId(payload?.user?.id, 64) || socket.id,
      name: sanitizeName(payload?.user?.name),
      color: sanitizeColor(payload?.user?.color),
    };

    clearTimeout(helloTimer);
    registry.add(socket.id, user, socket.data.ip);

    if (typeof ack === "function") ack({ selfId: socket.id, roster: registry.roster() });
    broadcastRoster();
  });

  /* ------------------------------- voz / tela ---------------------------- */

  socket.on("voice:join", (payload = {}, ack) => {
    if (!identificado() || !guard("voice:join")) return;

    const channelId = sanitizeId(payload?.channelId, 64);
    const client = registry.get(socket.id);
    if (!channelId || client.voice === channelId) return;

    if (client.voice) leaveVoice({ silent: true });

    const peers = registry.joinVoice(socket.id, channelId);
    if (!peers) return;

    socket.join(`voice:${channelId}`);

    // O recem-chegado recebe a lista e e quem oferta; quem ja estava so
    // recebe o aviso e aguarda a oferta chegar.
    if (typeof ack === "function") ack({ channelId, peers });
    socket.to(`voice:${channelId}`).emit("voice:peer-joined", {
      id: socket.id,
      user: client.user,
      state: client.state,
      channelId,
    });
    broadcastRoster();
  });

  function leaveVoice({ silent = false } = {}) {
    const channelId = registry.leaveVoice(socket.id);
    if (!channelId) return;

    socket.leave(`voice:${channelId}`);
    socket.to(`voice:${channelId}`).emit("voice:peer-left", { id: socket.id, channelId });
    if (!silent) broadcastRoster();
  }

  socket.on("voice:leave", () => {
    if (!identificado() || !guard("voice:leave")) return;
    leaveVoice();
  });

  /* --------------------------------- sinais ------------------------------ */

  // Relay puro de SDP/ICE, endereçado a um unico destino. O servidor nao
  // inspeciona, nao registra e nao guarda nada do conteudo.
  socket.on("signal", (payload = {}) => {
    if (!identificado() || !guard("signal")) return;

    const to = sanitizeId(payload?.to, 32);
    const data = payload?.data;
    if (!to || !data || typeof data !== "object") return;

    // So entrega para quem esta de fato conectado: impede varredura de ids.
    if (!registry.get(to)) return;
    io.to(to).emit("signal", { from: socket.id, data });
  });

  socket.on("state", (patch = {}) => {
    if (!identificado() || !guard("state")) return;
    const state = registry.patchState(socket.id, patch);
    if (state) io.to(GUILD).emit("peer:state", { id: socket.id, state });
  });

  /* ---------------------------------- chat ------------------------------- */

  socket.on("chat:send", (msg = {}) => {
    if (!identificado() || !guard("chat:send")) return;

    const client = registry.get(socket.id);
    const content = sanitizeText(msg?.content, MAX_CHAT_LENGTH);
    const channelId = sanitizeId(msg?.channelId, 64);
    if (!content || !channelId) return;

    io.to(GUILD).emit("chat:new", {
      id: sanitizeId(msg?.id, 64) || `${Date.now()}-${socket.id}`,
      channelId,
      content,
      // Autor vem do registro do servidor, nunca do payload: assim ninguem
      // consegue publicar uma mensagem assinada com o nome de outra pessoa.
      authorId: client.user.id,
      authorName: client.user.name,
      authorColor: client.user.color,
      createdAt: new Date().toISOString(),
    });
  });

  socket.on("chat:typing", (payload = {}) => {
    if (!identificado() || !guard("chat:typing")) return;
    const channelId = sanitizeId(payload?.channelId, 64);
    if (!channelId) return;
    socket.to(GUILD).emit("chat:typing", { channelId, name: registry.get(socket.id).user.name });
  });

  /* --------------------------------- saida ------------------------------- */

  socket.on("disconnect", () => {
    clearTimeout(helloTimer);
    leaveVoice({ silent: true });
    registry.remove(socket.id);
    limiter.forget(`${socket.id}:`);
    broadcastRoster();
  });

  socket.on("error", (err) => log.warn("socket", err?.message ?? "erro"));
}
