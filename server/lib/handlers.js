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
function announcement(peer, sessionKey, requesterIp) {
  return { peerId: peer.socketId, role: peer.role, endpoint: peer.ip === requesterIp ? peer.localEndpoint : peer.endpoint, sessionKey };
}
export function registerHandlers({ io, socket, registry, limiter, token }) {
  const guard = (event) => { const rule = EVENT_LIMITS[event]; return !rule || limiter.allow(`${socket.id}:${event}`, rule.windowMs, rule.max); };
  const identified = () => registry.get(socket.id) !== undefined;
  const timer = setTimeout(() => { if (!identified()) socket.disconnect(true); }, HELLO_TIMEOUT_MS); timer.unref?.();
  socket.on("hello", (payload = {}, ack) => {
    if (!guard("hello")) return ack?.({ error: "Muitas tentativas" });
    if (identified()) return ack?.({ ok: true });
    if (token && !socket.data.authed && !safeEqual(payload?.token, token)) { ack?.({ error: "Senha inválida" }); return socket.disconnect(true); }
    const deviceId = sanitizeId(payload?.deviceId, 64); if (!deviceId) return ack?.({ error: "Identidade inválida" });
    clearTimeout(timer); registry.identify(socket.id, deviceId, socket.data.ip); ack?.({ ok: true });
  });
  socket.on("stream:join", (payload = {}, ack) => {
    if (!identified()) return ack?.({ error: "nao-identificado" });
    if (!guard("stream:join")) return ack?.({ error: "Aguarde antes de trocar de sala" });
    const roomId = sanitizeId(payload?.room, 64); const role = payload?.role === "host" || payload?.role === "viewer" ? payload.role : null;
    const publicEndpoint = endpoint(payload?.endpoint); const localEndpoint = endpoint(payload?.localEndpoint);
    if (!roomId || !role || !publicEndpoint || !localEndpoint) return ack?.({ error: "Parâmetros de conexão inválidos" });
    if (isIP(localEndpoint.host) !== 4 || !privateV4(localEndpoint.host)) return ack?.({ error: "Endpoint LAN inválido" });
    if (isIP(socket.data.ip) === 4 && publicEndpoint.host !== socket.data.ip) return ack?.({ error: "Endpoint público não corresponde à conexão" });
    const previous=registry.leave(socket.id); if(previous){socket.leave(`stream:${previous.roomId}`);if(previous.otherId)io.to(previous.otherId).emit("stream:peer-left");}
    const joined = registry.join(socket.id, roomId, role, publicEndpoint.value, localEndpoint.value); if (joined.error) return ack?.({ error: joined.error });
    socket.join(`stream:${roomId}`); const self = registry.get(socket.id);
    const peer = joined.peer ? announcement(joined.peer, joined.room.sessionKey, self.ip) : undefined;
    ack?.({ ok: true, peer });
    if (joined.peer) io.to(joined.peer.socketId).emit("stream:peer", announcement(self, joined.room.sessionKey, joined.peer.ip));
  });
  socket.on("disconnect", () => {
    clearTimeout(timer); const left = registry.remove(socket.id); limiter.forget(`${socket.id}:`);
    if (left?.otherId) io.to(left.otherId).emit("stream:peer-left");
  });
}
