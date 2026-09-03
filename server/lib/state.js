/**
 * Registro em memoria de quem esta conectado e em qual canal de voz.
 *
 * Nao ha banco: o estado vive enquanto o processo vive. Se o servidor reinicia,
 * os clientes reconectam e se reapresentam sozinhos — nenhuma sessao P2P ja
 * estabelecida cai junto, porque a midia nao passa por aqui.
 */

export const GUILD = "guild:main";
export const DEFAULT_STATE = Object.freeze({
  muted: false,
  deafened: false,
  sharing: false,
  speaking: false,
});

export class Registry {
  /** socketId -> { id, user, state, voice, ip } */
  #clients = new Map();
  /** canalDeVoz -> Set<socketId> */
  #voice = new Map();

  add(socketId, user, ip) {
    this.#clients.set(socketId, {
      id: socketId,
      user,
      state: { ...DEFAULT_STATE },
      voice: null,
      ip,
    });
  }

  get(socketId) {
    return this.#clients.get(socketId);
  }

  remove(socketId) {
    this.#clients.delete(socketId);
  }

  get size() {
    return this.#clients.size;
  }

  countByIp(ip) {
    let total = 0;
    for (const c of this.#clients.values()) if (c.ip === ip) total++;
    return total;
  }

  patchState(socketId, patch) {
    const client = this.#clients.get(socketId);
    if (!client) return null;
    // `in` lanca TypeError sobre primitivos: um cliente mandando
    // `emit("state", "boom")` derrubava o handler inteiro.
    if (patch === null || typeof patch !== "object") return client.state;
    // Lista fechada de campos: um cliente malicioso nao injeta chaves extras
    // no objeto que sera transmitido para todo mundo.
    for (const campo of ["muted", "deafened", "sharing", "speaking"]) {
      if (campo in patch) client.state[campo] = !!patch[campo];
    }
    return client.state;
  }

  /* ------------------------------ canais de voz --------------------------- */

  peersOf(channelId) {
    const room = this.#voice.get(channelId);
    if (!room) return [];
    return [...room]
      .map((id) => this.#clients.get(id))
      .filter(Boolean)
      .map((c) => ({ id: c.id, user: c.user, state: c.state }));
  }

  joinVoice(socketId, channelId) {
    const client = this.#clients.get(socketId);
    if (!client) return null;

    const peers = this.peersOf(channelId);
    const room = this.#voice.get(channelId) ?? new Set();
    room.add(socketId);
    this.#voice.set(channelId, room);
    client.voice = channelId;
    return peers;
  }

  leaveVoice(socketId) {
    const client = this.#clients.get(socketId);
    if (!client?.voice) return null;

    const channelId = client.voice;
    const room = this.#voice.get(channelId);
    if (room) {
      room.delete(socketId);
      if (room.size === 0) this.#voice.delete(channelId);
    }

    client.voice = null;
    client.state = { ...client.state, sharing: false, speaking: false };
    return channelId;
  }

  /**
   * Lista publica enviada a todos.
   *
   * So sai daqui o que a interface precisa desenhar: id de socket, apelido,
   * cor, estado de microfone e canal. Nada de IP, cabecalhos, token ou
   * qualquer dado do handshake.
   */
  roster() {
    return [...this.#clients.values()].map((c) => ({
      id: c.id,
      user: c.user,
      state: c.state,
      voice: c.voice,
    }));
  }

  /** Resumo para o /health — sem identificar ninguem. */
  summary() {
    return {
      clients: this.#clients.size,
      voiceChannels: [...this.#voice].map(([id, set]) => ({ id, peers: set.size })),
    };
  }
}
