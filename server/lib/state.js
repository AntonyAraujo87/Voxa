import { createHmac, randomBytes } from "node:crypto";

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

  join(socketId, roomId, role) {
    const client = this.#clients.get(socketId);
    if (!client) return { error: "nao-identificado" };
    let room = this.#rooms.get(roomId);
    if (!room) room = { host: null, viewers: new Set() };
    if (role === "host") {
      if (room.host && room.host !== socketId) return { error: "Esta sala ja possui um host" };
      room.host = socketId;
    } else {
      if (!room.viewers.has(socketId) && room.viewers.size >= this.maxViewers) {
        return { error: `Esta sala atingiu o limite de ${this.maxViewers} espectadores` };
      }
      room.viewers.add(socketId);
      client.relaySession = randomBytes(8).toString("hex");
    }
    this.#rooms.set(roomId, room);
    Object.assign(client, {
      room: roomId, role, endpoint: null, localEndpoint: null, publicKey: null, codecs: 1,
    });
    const peerIds = role === "host" ? [...room.viewers] : room.host ? [room.host] : [];
    const peers = peerIds
      .map((peerId) => this.#clients.get(peerId))
      .filter(Boolean)
      .map((peer) => ({ peer, viewer: role === "viewer" ? client : peer }));
    return { room, peers };
  }

  paired(leftId, rightId) {
    const left = this.#clients.get(leftId), right = this.#clients.get(rightId);
    return Boolean(left?.room && left.room === right?.room && left.role !== right.role);
  }

  setEndpoint(socketId, endpoint, localEndpoint, publicKey, codecs) {
    const client = this.#clients.get(socketId);
    if (!client?.room) return false;
    Object.assign(client, { endpoint, localEndpoint, publicKey, codecs });
    return true;
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
