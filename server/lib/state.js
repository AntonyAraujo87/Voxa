import { randomBytes } from "node:crypto";

export class StreamRegistry {
  #clients = new Map();
  #rooms = new Map();
  identify(socketId, ip) { this.#clients.set(socketId, { socketId, ip, room: null, role: null, endpoint: null, localEndpoint: null }); }
  get(socketId) { return this.#clients.get(socketId); }
  join(socketId, roomId, role, endpoint, localEndpoint) {
    const client = this.#clients.get(socketId); if (!client) return { error: "nao-identificado" };
    const room = this.#rooms.get(roomId) ?? { host: null, viewer: null, sessionKey: randomBytes(32).toString("base64url") };
    if (room[role] && room[role] !== socketId) return { error: role === "host" ? "Esta sala já possui um host" : "Esta sala já possui um espectador" };
    room[role] = socketId; this.#rooms.set(roomId, room); Object.assign(client, { room: roomId, role, endpoint, localEndpoint });
    const otherId = role === "host" ? room.viewer : room.host;
    // Cada pareamento recebe material criptográfico novo. Um participante que
    // saiu não pode reutilizar a chave antiga contra a próxima sessão.
    if (otherId) room.sessionKey = randomBytes(32).toString("base64url");
    return { room, peer: otherId ? this.#clients.get(otherId) : null };
  }
  leave(socketId) {
    const client = this.#clients.get(socketId); if (!client?.room) return null;
    const roomId = client.room; const room = this.#rooms.get(roomId);
    if (room?.[client.role] === socketId) room[client.role] = null;
    const otherId = room ? (client.role === "host" ? room.viewer : room.host) : null;
    if (room && !room.host && !room.viewer) this.#rooms.delete(roomId);
    Object.assign(client, { room: null, role: null, endpoint: null, localEndpoint: null });
    return { roomId, otherId };
  }
  remove(socketId) { const left = this.leave(socketId); this.#clients.delete(socketId); return left; }
  summary() { return { clients: this.#clients.size, streamRooms: this.#rooms.size }; }
}
