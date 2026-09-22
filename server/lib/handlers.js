import { isIP } from "node:net";
import { EVENT_LIMITS, safeEqual, sanitizeId } from "./security.js";

const HELLO_TIMEOUT_MS = 15_000;
function endpoint(value) {
  if (typeof value !== "string" || value.length > 80) return null;
  const match = /^\[([^\]]+)]:(\d+)$/.exec(value) ?? /^([^:]+):(\d+)$/.exec(value);
  if (!match || !isIP(match[1])) return null;
  const port = Number(match[2]); return port >= 1024 && port <= 65535 ? { value, host: match[1] } : null;
}
const privateV4 = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.)/.test(ip);
function announcement(peer, requesterIp, room) {
  return {
    peerId: peer.socketId,
    role: peer.role,
    endpoint: peer.ip === requesterIp ? peer.localEndpoint : peer.endpoint,
    publicKey: peer.publicKey,
    relayEndpoint: room.relayEndpoint || null,
    relaySession: room.relayEndpoint ? room.relaySession : null,
    relayAuth: room.relayEndpoint ? room.relayAuth : null,
  };
}
export function registerHandlers({ io, socket, registry, limiter, token }) {
  const guard = (event) => { const rule = EVENT_LIMITS[event]; return !rule || limiter.allow(`${socket.id}:${event}`, rule.windowMs, rule.max); };
  const identified = () => registry.get(socket.id) !== undefined;
  const timer = setTimeout(() => { if (!identified()) socket.disconnect(true); }, HELLO_TIMEOUT_MS); timer.unref?.();
  socket.on("hello", (payload = {}, ack) => {
    if (!guard("hello")) return ack?.({ error: "Muitas tentativas" });
    if (identified()) return ack?.({ ok: true });
    if (token && !socket.data.authed && !safeEqual(payload?.token, token)) { ack?.({ error: "Senha inválida" }); return socket.disconnect(true); }
    clearTimeout(timer); registry.identify(socket.id, socket.data.ip); ack?.({ ok: true });
  });
  socket.on("stream:join", (payload = {}, ack) => {
    if (!identified()) return ack?.({ error: "nao-identificado" });
    if (!guard("stream:join")) return ack?.({ error: "Aguarde antes de trocar de sala" });
    const roomId = sanitizeId(payload?.room, 64); const role = payload?.role === "host" || payload?.role === "viewer" ? payload.role : null;
    const publicEndpoint = endpoint(payload?.endpoint); const localEndpoint = endpoint(payload?.localEndpoint);
    const publicKey = typeof payload?.publicKey === "string" && /^[A-Za-z0-9_-]{43}$/.test(payload.publicKey) ? payload.publicKey : null;
    if (!roomId || !role || !publicEndpoint || !localEndpoint || !publicKey) return ack?.({ error: "Parâmetros de conexão inválidos" });
    if (isIP(localEndpoint.host) !== 4 || !privateV4(localEndpoint.host)) return ack?.({ error: "Endpoint LAN inválido" });
    if (isIP(socket.data.ip) === 4 && publicEndpoint.host !== socket.data.ip && !registry.relayEndpoint) return ack?.({ error: "Endpoint público não corresponde à conexão" });
    const previous=registry.leave(socket.id); if(previous){socket.leave(`stream:${previous.roomId}`);if(previous.otherId)io.to(previous.otherId).emit("stream:peer-left");}
    const joined = registry.join(socket.id, roomId, role, publicEndpoint.value, localEndpoint.value, publicKey); if (joined.error) return ack?.({ error: joined.error });
    socket.join(`stream:${roomId}`); const self = registry.get(socket.id);
    const peer = joined.peer ? announcement(joined.peer, self.ip, joined.room) : undefined;
    ack?.({ ok: true, peer });
    if (joined.peer) io.to(joined.peer.socketId).emit("stream:peer", announcement(self, joined.peer.ip, joined.room));
  });
  socket.on("disconnect", () => {
    clearTimeout(timer); const left = registry.remove(socket.id); limiter.forget(`${socket.id}:`);
    if (left?.otherId) io.to(left.otherId).emit("stream:peer-left");
  });
}
