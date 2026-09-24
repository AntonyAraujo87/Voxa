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
  onPeer: (peer: PeerAnnouncement) => void | Promise<void>;
  onPeerLeft: (peerId: string) => void | Promise<void>;
  onCapacity: (maxViewers: number) => void | Promise<void>;
  onError: (message: string) => void;
  refreshEndpoint: (role: StreamRole) => Promise<PreparedEndpoint>;
}

type Ack = { ok?: boolean; error?: string; peers?: PeerAnnouncement[]; maxViewers?: number };

export class Matchmaking {
  private readonly socket: Socket;
  private desired: { room: string; role: StreamRole; endpoint: PreparedEndpoint; roomProof: string } | null = null;
  private rejoinArmed = false;
  private closed = false;
  constructor(url: string, private readonly options: Options) {
    this.socket = io(url, {
      transports: ["websocket"],
      timeout: 80_000,
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
    });
    this.socket.on("stream:peer", (peer: PeerAnnouncement) => {
      void Promise.resolve(options.onPeer(peer)).catch((error) => options.onError(messageOf(error)));
    });
    this.socket.on("stream:peer-left", (payload?: { peerId?: string }) => {
      if (!payload?.peerId) return options.onError("Identidade do computador desconectado ausente");
      void Promise.resolve(options.onPeerLeft(payload.peerId)).catch((error) => options.onError(messageOf(error)));
    });
    this.socket.on("connect_error", (error) => options.onError(
      this.socket.active
        ? "Acordando o servidor gratuito de matchmaking..."
        : error.message || "Servidor indisponível",
    ));
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

  async join(room: string, role: StreamRole, endpoint: PreparedEndpoint, roomProof: string) {
    this.desired = { room, role, endpoint, roomProof };
    await this.waitForConnection();
    await this.performJoin(this.desired);
    this.rejoinArmed = true;
  }

  private async performJoin({ room, role, endpoint, roomProof }: { room: string; role: StreamRole; endpoint: PreparedEndpoint; roomProof: string }) {
    await this.emit("hello", {});
    const response = await this.emit("stream:join", {
      room,
      role,
      endpoint: endpoint.public ?? endpoint.local,
      localEndpoint: endpoint.local,
      publicKey: endpoint.publicKey,
      roomProof,
    });
    await this.options.onCapacity(response.maxViewers ?? 4);
    for (const peer of response.peers ?? []) await this.options.onPeer(peer);
  }

  close() { this.closed = true; this.desired = null; this.socket.disconnect(); }

  private waitForConnection(timeoutMs = 90_000) {
    if (this.closed) return Promise.reject(new Error("Conexão encerrada"));
    if (this.socket.connected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        window.clearTimeout(timer);
        this.socket.off("connect", connected);
        if (error) reject(error); else resolve();
      };
      const connected = () => finish();
      const timer = window.setTimeout(() => finish(new Error("O servidor gratuito demorou para iniciar. Tente novamente.")), timeoutMs);
      this.socket.once("connect", connected);
    });
  }

  private emit(event: string, payload: unknown): Promise<Ack> {
    return new Promise((resolve, reject) => {
      this.socket.timeout(15_000).emit(event, payload, (error: Error | null, response?: Ack) => {
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
