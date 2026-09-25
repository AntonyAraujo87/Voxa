import { BlockList, isIP } from "node:net";
import { EVENT_LIMITS, sanitizeId } from "./security.js";

const HELLO_TIMEOUT_MS = 15_000;
function endpoint(value) {
  if (typeof value !== "string" || value.length > 80) return null;
  value = value.trim();
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
    codecs: peer.codecs ?? 1,
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
export function registerHandlers({ io, socket, registry, limiter }) {
  const guard = (event) => { const rule = EVENT_LIMITS[event]; return !rule || limiter.allow(`${socket.id}:${event}`, rule.windowMs, rule.max); };
  const identified = () => registry.get(socket.id) !== undefined;
  const timer = setTimeout(() => { if (!identified()) socket.disconnect(true); }, HELLO_TIMEOUT_MS); timer.unref?.();
  socket.on("hello", (payload = {}, ack) => {
    if (!guard("hello")) return ack?.({ error: "Muitas tentativas" });
    if (identified()) return ack?.({ ok: true });
    clearTimeout(timer); registry.identify(socket.id, socket.data.ip); ack?.({ ok: true });
  });
  socket.on("stream:join", (payload = {}, ack) => {
    if (!identified()) return ack?.({ error: "nao-identificado" });
    if (!guard("stream:join")) return ack?.({ error: "Aguarde antes de trocar de sala" });
    const roomId = sanitizeId(typeof payload?.room === "string" ? payload.room.trim() : payload?.room, 64); const role = payload?.role === "host" || payload?.role === "viewer" ? payload.role : null;
    const publicEndpoint = endpoint(payload?.endpoint); const localEndpoint = endpoint(payload?.localEndpoint);
    const publicKey = normalizePublicKey(payload?.publicKey);
    const codecs = normalizeCodecs(payload?.codecs);
    const roomProof = normalizeRoomProof(payload?.roomProof);
    const invalid = invalidJoinField({ roomId, role, publicEndpoint, localEndpoint, publicKey, codecs, roomProof });
    if (invalid) return ack?.({ error: invalid });
    // Se o Windows não conseguir escolher uma interface, o motor anuncia o
    // endereço de bind. 0.0.0.0 nunca é roteável.
    const usableLocalEndpoint = localEndpoint.host === "0.0.0.0" ? publicEndpoint : localEndpoint;
    if (isIP(usableLocalEndpoint.host) !== 4 || (!privateV4(usableLocalEndpoint.host) && usableLocalEndpoint !== publicEndpoint)) return ack?.({ error: "Endpoint LAN inválido" });
    if (!sameIp(publicEndpoint.host, socket.data.ip)) return ack?.({ error: "Endpoint público não corresponde à conexão" });
    if (!registry.authorize(roomId, roomProof)) return ack?.({ error: "Senha da sala incorreta" });
    const previous=registry.leave(socket.id); if(previous){socket.leave(`stream:${previous.roomId}`);for(const otherId of previous.otherIds)io.to(otherId).emit("stream:peer-left",{peerId:previous.peerId});}
    const joined = registry.join(socket.id, roomId, role, publicEndpoint.value, usableLocalEndpoint.value, publicKey, roomProof, codecs); if (joined.error) return ack?.({ error: joined.error });
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

function invalidJoinField({ roomId, role, publicEndpoint, localEndpoint, publicKey, codecs, roomProof }) {
  if (!roomId) return "Código da sala inválido";
  if (!role) return "Modo host/espectador inválido";
  if (!publicEndpoint) return "Endpoint UDP público inválido";
  if (!localEndpoint) return "Endpoint UDP local inválido";
  if (!publicKey) return "Chave X25519 inválida; atualize o Voxa";
  if (!codecs) return "Lista de codecs inválida; atualize o Voxa";
  if (!roomProof) return "Senha da sala ausente ou inválida";
  return null;
}

function normalizeCodecs(value) {
  // H.264 era implícito nas versões anteriores.
  if (value === undefined) return 1;
  return Number.isInteger(value) && value > 0 && value <= 0b111 ? value : null;
}

function normalizePublicKey(value) {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (/^[A-Za-z0-9_-]{43}$/.test(candidate)) return candidate;
  if (!/^[A-Za-z0-9_+/=-]{43,44}$/.test(candidate)) return null;
  try {
    const raw = Buffer.from(candidate, "base64url");
    return raw.length === 32 ? raw.toString("base64url") : null;
  } catch {
    return null;
  }
}

function normalizeRoomProof(proof) {
  if (typeof proof === "string" && /^[a-f0-9]{64}$/i.test(proof)) return proof.toLowerCase();
  return null;
}
