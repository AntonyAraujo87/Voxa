import { GUILD } from "./state.js";
import { turnCredentials } from "./turn.js";
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
const MAX_ATTACHMENT_URL_LENGTH = 2048;
const MAX_ATTACHMENT_NAME_LENGTH = 256;
const MAX_ATTACHMENT_MIME_LENGTH = 128;
/** Mesmo teto do bucket de Storage (attachments.sql) — nao ha por que aceitar
 *  aqui um numero que o upload real ja teria recusado. */
const MAX_ATTACHMENT_SIZE_BYTES = 8 * 1024 * 1024;
/** Sockets que conectam e nunca se apresentam sao lixo ocupando memoria. */
const HELLO_TIMEOUT_MS = 20_000;

/**
 * Anexo e opcional e so faz sentido como conjunto — url/nome/mime/tamanho
 * juntos ou nenhum. O servidor nao sabe (nem precisa saber) qual bucket do
 * Supabase o deploy usa: so garante formato razoavel antes de repassar em
 * tempo real. Quem decide se o arquivo existe de verdade e a politica de
 * RLS do Storage, nao esta funcao.
 */
function sanitizeAttachment(msg) {
  const url = sanitizeText(msg?.attachmentUrl, MAX_ATTACHMENT_URL_LENGTH);
  if (!url || !/^https:\/\//.test(url)) return {};

  const name = sanitizeText(msg?.attachmentName, MAX_ATTACHMENT_NAME_LENGTH);
  const mime = sanitizeText(msg?.attachmentMime, MAX_ATTACHMENT_MIME_LENGTH);
  // So converter primitivos: objetos JSON podem sobrescrever toString/valueOf
  // com null e fazer Number(...) lancar, encerrando o servidor.
  const rawSize = msg?.attachmentSize;
  const size = typeof rawSize === "number" || typeof rawSize === "string" ? Number(rawSize) : NaN;
  if (!name || !mime || !Number.isFinite(size) || size <= 0 || size > MAX_ATTACHMENT_SIZE_BYTES) {
    return {};
  }

  return { attachmentUrl: url, attachmentName: name, attachmentMime: mime, attachmentSize: size };
}

export function registerHandlers({ io, socket, registry, limiter, token, log }) {
  const guard = (evento) => {
    const limite = EVENT_LIMITS[evento];
    if (!limite) return true;
    return limiter.allow(`${socket.id}:${evento}`, limite.windowMs, limite.max);
  };

  const identificado = () => registry.get(socket.id) !== undefined;

  // A entrada em GUILD acontece no `hello`, DEPOIS de conferir o token — nunca
  // aqui. Estar na sala e o que faz o socket receber `roster` e `chat:new`:
  // entrar antes da conferencia deixava quem so abrisse a conexao e ficasse
  // calado escutando o chat inteiro ate o timeout de identificacao expirar, e
  // repetindo a conexao a escuta virava continua, sem nunca provar que sabe a
  // senha da sala.

  const helloTimer = setTimeout(() => {
    if (!identificado()) socket.disconnect(true);
  }, HELLO_TIMEOUT_MS);

  const broadcastRoster = () => io.to(GUILD).emit("roster", registry.roster());

  /* ------------------------------- identidade ---------------------------- */

  socket.on("hello", (payload = {}, ack) => {
    if (!guard("hello")) { if (typeof ack === "function") ack({ error: "limite-de-identificacao" }); return; }
    if (identificado()) { if (typeof ack === "function") ack({ selfId: socket.id, roster: registry.roster() }); return; } // reapresentacao nao recria o cliente

    // Compatibilidade: clientes novos mandam o token no handshake e ja chegam
    // marcados; os antigos so o enviam aqui. Ambos precisam acertar.
    if (token && !socket.data.authed) {
      if (!safeEqual(payload?.token, token)) {
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
    socket.join(GUILD);

    if (typeof ack === "function") ack({ selfId: socket.id, roster: registry.roster(), iceServers: turnCredentials(socket.id) });
    broadcastRoster();
  });

  /* ------------------------------- voz / tela ---------------------------- */
  socket.on("ice:config", (_payload, ack) => {
    if (!identificado() || !guard("ice:config")) { if (typeof ack === "function") ack({ error: "nao-autorizado" }); return; }
    if (typeof ack === "function") ack({ iceServers: turnCredentials(socket.id) });
  });

  socket.on("voice:join", (payload = {}, ack) => {
    if (!identificado()) { if (typeof ack === "function") ack({ error: "nao-identificado" }); return; }
    if (!guard("voice:join")) { if (typeof ack === "function") ack({ error: "Muitas trocas de canal. Aguarde alguns segundos." }); return; }

    const channelId = sanitizeId(payload?.channelId, 64);
    const client = registry.get(socket.id);

    // Sair sem responder deixa a promise do cliente pendente para sempre — e
    // como as entradas em canal sao serializadas la, uma promise presa trava
    // todas as trocas de canal seguintes. Responder sempre, mesmo recusando.
    if (!channelId) {
      if (typeof ack === "function") ack({ error: "canal-invalido" });
      return;
    }
    if (client.voice === channelId) {
      if (typeof ack === "function") ack({ channelId, peers: registry.peersOf(channelId).filter(peer => peer.id !== socket.id) });
      return;
    }

    if (registry.peersOf(channelId).length >= 12) { if (typeof ack === "function") ack({ error: "Canal cheio (12 participantes)" }); return; }
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
    // Sair deve continuar possivel mesmo depois de exceder o limite de entrada.
    if (!identificado()) return;
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
    const source = registry.get(socket.id);
    const target = registry.get(to);
    if (to === socket.id || !source?.voice || source.voice !== target?.voice) return;
    const description = data.description;
    const candidate = data.candidate;
    const validDescription = description && ["offer", "answer"].includes(description.type) && typeof description.sdp === "string" && description.sdp.length <= 65536;
    const validCandidate = Object.hasOwn(data, "candidate") && (candidate === null || (typeof candidate === "object" && typeof candidate.candidate === "string" && candidate.candidate.length <= 4096));
    if (!validDescription && !validCandidate) return;
    // Nunca refletir campos arbitrarios enviados por um cliente.
    const clean = validDescription ? { description: { type: description.type, sdp: description.sdp } } : {
      candidate: candidate === null ? null : {
        candidate: candidate.candidate,
        sdpMid: typeof candidate.sdpMid === "string" ? candidate.sdpMid.slice(0, 64) : null,
        sdpMLineIndex: Number.isInteger(candidate.sdpMLineIndex) && candidate.sdpMLineIndex >= 0 && candidate.sdpMLineIndex < 32 ? candidate.sdpMLineIndex : null,
        usernameFragment: typeof candidate.usernameFragment === "string" ? candidate.usernameFragment.slice(0, 256) : undefined,
      },
    };
    io.to(to).emit("signal", { from: socket.id, channelId: source.voice, data: clean });
  });

  socket.on("state", (patch = {}) => {
    if (!identificado() || !guard("state")) return;
    const state = registry.patchState(socket.id, patch);
    if (state) io.to(GUILD).emit("peer:state", { id: socket.id, state });
  });

  /* ---------------------------------- chat ------------------------------- */

  const delivered = new Map();
  socket.on("chat:send", (msg = {}, ack) => {
    if (!identificado()) { if (typeof ack === "function") ack({ error: "nao-identificado" }); return; }
    if (typeof msg?.id === "string" && delivered.has(msg.id)) { if (typeof ack === "function") ack(delivered.get(msg.id)); return; }
    if (!guard("chat:send")) { if (typeof ack === "function") ack({ error: "Limite de mensagens. Tente novamente em alguns segundos." }); return; }

    const client = registry.get(socket.id);
    const content = sanitizeText(msg?.content, MAX_CHAT_LENGTH);
    const channelId = sanitizeId(msg?.channelId, 64);
    const attachment = sanitizeAttachment(msg);
    // Mensagem so-anexo (sem legenda) e valida; sem conteudo E sem anexo, nao ha o que mandar.
    if ((!content && !attachment.attachmentUrl) || !channelId) { if (typeof ack === "function") ack({ error: "Mensagem invalida ou muito longa" }); return; }

    const message = {
      id: sanitizeId(msg?.id, 64) || `${Date.now()}-${socket.id}`,
      channelId,
      content,
      // Autor vem do registro do servidor, nunca do payload: assim ninguem
      // consegue publicar uma mensagem assinada com o nome de outra pessoa.
      authorId: client.user.id,
      authorName: client.user.name,
      authorColor: client.user.color,
      createdAt: new Date().toISOString(),
      ...attachment,
    };
    delivered.set(message.id, message);
    if (delivered.size > 256) delivered.delete(delivered.keys().next().value);
    io.to(GUILD).emit("chat:new", message);
    if (typeof ack === "function") ack(message);
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

  socket.on("error", () => log.warn("erro de transporte de socket"));
}
