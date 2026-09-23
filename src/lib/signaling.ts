import { io, type Socket } from "socket.io-client";
import type { PreparedEndpoint, StreamRole } from "./nativeEngine";

export interface PeerAnnouncement {
  peerId: string;
  role: StreamRole;
  endpoint: string;
  publicKey: string;
  relayEndpoint: string | null;
  relaySession: string | null;
  relayAuth: string | null;
}

interface Options {
  token: string;
  onPeer: (peer: PeerAnnouncement) => void | Promise<void>;
  onPeerLeft: (peerId: string) => void | Promise<void>;
  onCapacity: (maxViewers: number) => void | Promise<void>;
  onError: (message: string) => void;
  refreshEndpoint: (role: StreamRole) => Promise<PreparedEndpoint>;
}

type Ack = { ok?: boolean; error?: string; peers?: PeerAnnouncement[]; maxViewers?: number };

export class Matchmaking {
  private readonly socket: Socket;
  private desired: { room: string; role: StreamRole; endpoint: PreparedEndpoint } | null = null;
  private rejoinArmed = false;
  private closed = false;
  constructor(url: string, private readonly options: Options) {
    this.socket = io(url, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
      auth: { token: options.token },
    });
    this.socket.on("stream:peer", (peer: PeerAnnouncement) => {
      void Promise.resolve(options.onPeer(peer)).catch((error) => options.onError(messageOf(error)));
    });
    this.socket.on("stream:peer-left", (payload?: { peerId?: string }) => {
      if (!payload?.peerId) return options.onError("Identidade do computador desconectado ausente");
      void Promise.resolve(options.onPeerLeft(payload.peerId)).catch((error) => options.onError(messageOf(error)));
    });
    this.socket.on("connect_error", (error) => options.onError(error.message || "Servidor indisponível"));
    this.socket.on("connect", () => {
      if (this.rejoinArmed && this.desired) {
        void options.refreshEndpoint(this.desired.role).then((endpoint) => {
          if (this.closed || !this.desired) return;
          this.desired = { ...this.desired, endpoint };
          return this.performJoin(this.desired);
        }).catch((error) => options.onError(messageOf(error)));
      }
    });
  }

  async join(room: string, role: StreamRole, endpoint: PreparedEndpoint) {
    this.desired = { room, role, endpoint };
    await this.performJoin(this.desired);
    this.rejoinArmed = true;
  }

  private async performJoin({ room, role, endpoint }: { room: string; role: StreamRole; endpoint: PreparedEndpoint }) {
    await this.emit("hello", { token: this.options.token });
    const response = await this.emit("stream:join", {
      room,
      role,
      endpoint: endpoint.public ?? endpoint.local,
      localEndpoint: endpoint.local,
      publicKey: endpoint.publicKey,
    });
    await this.options.onCapacity(response.maxViewers ?? 4);
    for (const peer of response.peers ?? []) await this.options.onPeer(peer);
  }

  close() { this.closed = true; this.desired = null; this.socket.disconnect(); }

  private emit(event: string, payload: unknown): Promise<Ack> {
    return new Promise((resolve, reject) => {
      this.socket.timeout(10_000).emit(event, payload, (error: Error | null, response?: Ack) => {
        if (error) return reject(new Error("O servidor de matchmaking não respondeu"));
        if (!response || response.error) return reject(new Error(response?.error ?? "Resposta inválida do servidor"));
        resolve(response);
      });
    });
  }
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
