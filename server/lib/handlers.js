import { BlockList, isIP } from "node:net";
import { EVENT_LIMITS, safeEqual, sanitizeId } from "./security.js";

const HELLO_TIMEOUT_MS = 15_000;
function endpoint(value) {
  if (typeof value !== "string" || value.length > 80) return null;
  const match = /^\[([^\]]+)]:(\d+)$/.exec(value) ?? /^([^:]+):(\d+)$/.exec(value);
  if (!match || !isIP(match[1])) return null;
  const port = Number(match[2]); return port >= 1024 && port <= 65535 ? { value, host: match[1] } : null;
}
const privateV4 = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.)/.test(ip);
function announcement(peer, requesterIp, relay) {
  return {
    peerId: peer.socketId,
    role: peer.role,
    endpoint: peer.ip === requesterIp ? peer.localEndpoint : peer.endpoint,
    publicKey: peer.publicKey,
    relayEndpoint: relay.endpoint,
    relaySession: relay.session,
    relayAuth: relay.auth,
  };
}
function sameIp(left, right) {
  const version = isIP(left);
  if (!version || version !== isIP(right)) return false;
  const type = version === 4 ? "ipv4" : "ipv6";
  const list = new BlockList();
  list.addAddress(left, type);
  return list.check(right, type);
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
    if (!sameIp(publicEndpoint.host, socket.data.ip)) return ack?.({ error: "Endpoint público não corresponde à conexão" });
    const previous=registry.leave(socket.id); if(previous){socket.leave(`stream:${previous.roomId}`);for(const otherId of previous.otherIds)io.to(otherId).emit("stream:peer-left",{peerId:previous.peerId});}
    const joined = registry.join(socket.id, roomId, role, publicEndpoint.value, localEndpoint.value, publicKey); if (joined.error) return ack?.({ error: joined.error });
    socket.join(`stream:${roomId}`); const self = registry.get(socket.id);
    const peers = joined.peers.map(({peer,viewer})=>announcement(peer,self.ip,registry.relay(viewer,self.role)));
    ack?.({ ok: true, peers, peer: peers[0], maxViewers: registry.maxViewers });
    for(const {peer,viewer} of joined.peers)io.to(peer.socketId).emit("stream:peer",announcement(self,peer.ip,registry.relay(viewer,peer.role)));
  });
  socket.on("disconnect", () => {
    clearTimeout(timer); const left = registry.remove(socket.id); limiter.forget(`${socket.id}:`);
    if(left)for(const otherId of left.otherIds)io.to(otherId).emit("stream:peer-left",{peerId:left.peerId});
  });
}
