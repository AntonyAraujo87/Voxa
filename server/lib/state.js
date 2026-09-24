import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const DEFAULT_MAX_VIEWERS = 4;

export class StreamRegistry {
  #clients = new Map();
  #rooms = new Map();

  constructor(relayEndpoint = "", relaySecret = "", maxViewers = DEFAULT_MAX_VIEWERS) {
    this.relayEndpoint = relayEndpoint;
    this.relaySecret = relaySecret;
    this.maxViewers = Number.isInteger(maxViewers) && maxViewers > 0
      ? Math.min(maxViewers, 16)
      : DEFAULT_MAX_VIEWERS;
  }

  identify(socketId, ip) {
    this.#clients.set(socketId, {
      socketId, ip, room: null, role: null, endpoint: null, localEndpoint: null,
      publicKey: null, codecs: 1, relaySession: null,
    });
  }

  get(socketId) { return this.#clients.get(socketId); }

  authorize(roomId, roomProof) {
    if (!validRoomProof(roomProof)) return false;
    const existing = this.#rooms.get(roomId);
    return !existing || safeProof(existing.proof, roomProof);
  }

  join(socketId, roomId, role, endpoint, localEndpoint, publicKey, roomProof, codecs = 1) {
    const client = this.#clients.get(socketId);
    if (!client) return { error: "nao-identificado" };
    if (!this.authorize(roomId, roomProof)) return { error: "Senha da sala incorreta" };
    let room = this.#rooms.get(roomId);
    if (!room) room = { host: null, viewers: new Set(), proof: roomProof };

    if (role === "host") {
      if (room.host && room.host !== socketId) return { error: "Esta sala ja possui um host" };
      room.host = socketId;
    } else {
      if (!room.viewers.has(socketId) && room.viewers.size >= this.maxViewers) {
        return { error: `Esta sala atingiu o limite de ${this.maxViewers} espectadores` };
      }
      room.viewers.add(socketId);
      client.relaySession = randomRelaySession();
    }

    this.#rooms.set(roomId, room);
    Object.assign(client, { room: roomId, role, endpoint, localEndpoint, publicKey, codecs });
    const peerIds = role === "host" ? [...room.viewers] : room.host ? [room.host] : [];
    const peers = peerIds.map((peerId) => {
      const peer = this.#clients.get(peerId);
      const viewer = role === "viewer" ? client : peer;
      return { peer, viewer };
    }).filter(({ peer }) => peer);
    return { room, peers };
  }

  leave(socketId) {
    const client = this.#clients.get(socketId);
    if (!client?.room) return null;
    const roomId = client.room;
    const room = this.#rooms.get(roomId);
    let otherIds = [];
    if (room) {
      if (client.role === "host" && room.host === socketId) {
        room.host = null;
        otherIds = [...room.viewers];
      } else if (client.role === "viewer") {
        room.viewers.delete(socketId);
        if (room.host) otherIds = [room.host];
      }
      if (!room.host && room.viewers.size === 0) this.#rooms.delete(roomId);
    }
    Object.assign(client, {
      room: null, role: null, endpoint: null, localEndpoint: null, publicKey: null, codecs: 1,
      relaySession: null,
    });
    return { roomId, otherIds, peerId: socketId };
  }

  remove(socketId) {
    const left = this.leave(socketId);
    this.#clients.delete(socketId);
    return left;
  }

  summary() { return { clients: this.#clients.size, streamRooms: this.#rooms.size }; }

  relay(viewer, role) {
    return relayAllocation(this.relayEndpoint, this.relaySecret, viewer, role);
  }
}

function randomRelaySession() { return randomBytes(8).toString("hex"); }

function validRoomProof(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function safeProof(left, right) {
  if (!validRoomProof(left) || !validRoomProof(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function relayAuth(secret, session, role) {
  return createHmac("sha256", secret)
    .update(Buffer.from(session, "hex"))
    .update(Buffer.from([role === "host" ? 0 : 1]))
    .digest("hex")
    .slice(0, 16);
}

function relayAllocation(endpoint, secret, viewer, role) {
  return {
    endpoint: endpoint || null,
    session: endpoint ? viewer?.relaySession ?? null : null,
    auth: endpoint ? relayAuth(secret, viewer?.relaySession ?? "", role) : null,
  };
}
