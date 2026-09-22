import { createHmac, randomBytes } from "node:crypto";

export class StreamRegistry {
  #clients = new Map();
  #rooms = new Map();
  constructor(relayEndpoint = "", relaySecret = "") { this.relayEndpoint = relayEndpoint; this.relaySecret = relaySecret; }
  identify(socketId, ip) { this.#clients.set(socketId, { socketId, ip, room: null, role: null, endpoint: null, localEndpoint: null }); }
  get(socketId) { return this.#clients.get(socketId); }
  join(socketId, roomId, role, endpoint, localEndpoint, publicKey) {
    const client = this.#clients.get(socketId); if (!client) return { error: "nao-identificado" };
    let room = this.#rooms.get(roomId);
    if (!room) {
      const relaySession = randomRelaySession();
      room = {
        host: null, viewer: null, relaySession, relayEndpoint: this.relayEndpoint,
        relayAuth: this.relayEndpoint ? relayAuth(this.relaySecret, relaySession) : "",
      };
    }
    if (room[role] && room[role] !== socketId) return { error: role === "host" ? "Esta sala já possui um host" : "Esta sala já possui um espectador" };
    room[role] = socketId; this.#rooms.set(roomId, room); Object.assign(client, { room: roomId, role, endpoint, localEndpoint, publicKey });
    const otherId = role === "host" ? room.viewer : room.host;
    return { room, peer: otherId ? this.#clients.get(otherId) : null };
  }
  leave(socketId) {
    const client = this.#clients.get(socketId); if (!client?.room) return null;
    const roomId = client.room; const room = this.#rooms.get(roomId);
    if (room?.[client.role] === socketId) room[client.role] = null;
    const otherId = room ? (client.role === "host" ? room.viewer : room.host) : null;
    if (room && !room.host && !room.viewer) this.#rooms.delete(roomId);
    Object.assign(client, { room: null, role: null, endpoint: null, localEndpoint: null, publicKey: null });
    return { roomId, otherId };
  }
  remove(socketId) { const left = this.leave(socketId); this.#clients.delete(socketId); return left; }
  summary() { return { clients: this.#clients.size, streamRooms: this.#rooms.size }; }
}

function randomRelaySession() {
  return randomBytes(8).toString("hex");
}

function relayAuth(secret, session) {
  return createHmac("sha256", secret).update(Buffer.from(session, "hex")).digest("hex").slice(0, 16);
}
