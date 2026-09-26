import { BlockList, isIP } from "node:net";
import { EVENT_LIMITS, sanitizeId } from "./security.js";

const HELLO_TIMEOUT_MS = 15_000;
const PAKE_PROTOCOL = "spake2-p256-rfc9382-v1";

function endpoint(value) {
  if (typeof value !== "string" || value.length > 80) return null;
  value = value.trim();
  const match = /^\[([^\]]+)]:(\d+)$/.exec(value) ?? /^([^:]+):(\d+)$/.exec(value);
  if (!match || !isIP(match[1])) return null;
  const port = Number(match[2]);
  return port >= 1024 && port <= 65535 ? { value, host: match[1] } : null;
}

const privateV4 = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.)/.test(ip);
const peerStub = (peer) => ({ peerId: peer.socketId, role: peer.role });

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
  const guard = (event) => {
    const rule = EVENT_LIMITS[event];
    return !rule || limiter.allow(`${socket.id}:${event}`, rule.windowMs, rule.max);
  };
  const identified = () => registry.get(socket.id) !== undefined;
  const timer = setTimeout(() => { if (!identified()) socket.disconnect(true); }, HELLO_TIMEOUT_MS);
  timer.unref?.();

  socket.on("hello", (_payload = {}, ack) => {
    if (!guard("hello")) return ack?.({ error: "Muitas tentativas" });
    if (identified()) return ack?.({ ok: true });
    clearTimeout(timer);
    registry.identify(socket.id, socket.data.ip);
    ack?.({ ok: true });
  });

  socket.on("stream:join", (payload = {}, ack) => {
    if (!identified()) return ack?.({ error: "nao-identificado" });
    if (!guard("stream:join")) return ack?.({ error: "Aguarde antes de trocar de sala" });
    const roomId = sanitizeId(typeof payload?.room === "string" ? payload.room.trim() : payload?.room, 64);
    const role = payload?.role === "host" || payload?.role === "viewer" ? payload.role : null;
    if (!roomId) return ack?.({ error: "Código da sala inválido" });
    if (!role) return ack?.({ error: "Modo host/espectador inválido" });
    if (payload?.protocol !== PAKE_PROTOCOL) return ack?.({ error: "Atualize o Voxa para usar SPAKE2" });

    const previous = registry.leave(socket.id);
    if (previous) {
      socket.leave(`stream:${previous.roomId}`);
      for (const otherId of previous.otherIds) io.to(otherId).emit("stream:peer-left", { peerId: previous.peerId });
    }
    const joined = registry.join(socket.id, roomId, role);
    if (joined.error) return ack?.({ error: joined.error });
    socket.join(`stream:${roomId}`);
    const peers = joined.peers.map(({ peer }) => peerStub(peer));
    ack?.({ ok: true, peers, maxViewers: registry.maxViewers });
    const self = registry.get(socket.id);
    for (const { peer } of joined.peers) io.to(peer.socketId).emit("stream:peer", peerStub(self));
  });

  socket.on("stream:pake", (payload = {}, ack) => {
    if (!guard("stream:pake")) return ack?.({ error: "Muitas mensagens SPAKE2" });
    const target = sanitizePeer(payload?.peerId);
    if (!target || payload?.protocol !== PAKE_PROTOCOL || !validB64Bytes(payload?.share, 65)) {
      return ack?.({ error: "Mensagem SPAKE2 inválida" });
    }
    if (!registry.paired(socket.id, target)) return ack?.({ error: "Par SPAKE2 inválido" });
    io.to(target).emit("stream:pake", {
      peerId: socket.id,
      protocol: PAKE_PROTOCOL,
      share: payload.share,
    });
    ack?.({ ok: true });
  });

  socket.on("stream:pake-confirm", (payload = {}, ack) => {
    if (!guard("stream:pake-confirm")) return ack?.({ error: "Muitas confirmações SPAKE2" });
    const target = sanitizePeer(payload?.peerId);
    if (!target || !validB64Bytes(payload?.confirmation, 32)) {
      return ack?.({ error: "Confirmação SPAKE2 inválida" });
    }
    if (!registry.paired(socket.id, target)) return ack?.({ error: "Par SPAKE2 inválido" });
    io.to(target).emit("stream:pake-confirm", {
      peerId: socket.id,
      confirmation: payload.confirmation,
    });
    ack?.({ ok: true });
  });

  socket.on("stream:ready", (payload = {}, ack) => {
    if (!guard("stream:ready")) return ack?.({ error: "Muitas tentativas de rota" });
    const targetId = sanitizePeer(payload?.peerId);
    if (!targetId || !registry.paired(socket.id, targetId)) return ack?.({ error: "Par inválido" });
    const publicEndpoint = endpoint(payload?.endpoint);
    const localEndpoint = endpoint(payload?.localEndpoint);
    const publicKey = normalizePublicKey(payload?.publicKey);
    const codecs = normalizeCodecs(payload?.codecs);
    const invalid = invalidReadyField({ publicEndpoint, localEndpoint, publicKey, codecs });
    if (invalid) return ack?.({ error: invalid });
    const usableLocalEndpoint = localEndpoint.host === "0.0.0.0" ? publicEndpoint : localEndpoint;
    if (isIP(usableLocalEndpoint.host) !== 4 || (!privateV4(usableLocalEndpoint.host) && usableLocalEndpoint.value !== publicEndpoint.value)) {
      return ack?.({ error: "Endpoint LAN inválido" });
    }
    if (!sameIp(publicEndpoint.host, socket.data.ip)) {
      return ack?.({ error: "Endpoint público não corresponde à conexão" });
    }
    registry.setEndpoint(socket.id, publicEndpoint.value, usableLocalEndpoint.value, publicKey, codecs);
    const self = registry.get(socket.id), target = registry.get(targetId);
    const viewer = self.role === "viewer" ? self : target;
    io.to(targetId).emit("stream:ready", announcement(self, target.ip, registry.relay(viewer, target.role)));
    ack?.({ ok: true });
  });

  socket.on("disconnect", () => {
    clearTimeout(timer);
    const left = registry.remove(socket.id);
    limiter.forget(`${socket.id}:`);
    if (left) for (const otherId of left.otherIds) io.to(otherId).emit("stream:peer-left", { peerId: left.peerId });
  });
}

function invalidReadyField({ publicEndpoint, localEndpoint, publicKey, codecs }) {
  if (!publicEndpoint) return "Endpoint UDP público inválido";
  if (!localEndpoint) return "Endpoint UDP local inválido";
  if (!publicKey) return "Chave X25519 inválida; atualize o Voxa";
  if (!codecs) return "Lista de codecs inválida; atualize o Voxa";
  return null;
}

function normalizeCodecs(value) {
  return Number.isInteger(value) && value > 0 && value <= 0b111 ? value : null;
}

function normalizePublicKey(value) {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(candidate)) return null;
  try {
    return Buffer.from(candidate, "base64url").length === 32 ? candidate : null;
  } catch {
    return null;
  }
}

function sanitizePeer(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

function validB64Bytes(value, expectedBytes) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === expectedBytes && decoded.toString("base64url") === value;
  } catch {
    return false;
  }
}
