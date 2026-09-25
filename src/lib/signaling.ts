import { io, type Socket } from "socket.io-client";
import type { PreparedEndpoint, StreamRole } from "./nativeEngine";

export interface PeerAnnouncement {
  peerId: string;
  role: StreamRole;
  endpoint: string;
  publicKey: string;
  codecs?: number;
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
  private recovering = false;
  private nextRecoveryAt = 0;
  private readonly connectionWaiters = new Set<(error?: Error) => void>();
  private peerEvents: Promise<void> = Promise.resolve();
  constructor(url: string, private readonly options: Options) {
    this.socket = io(url, {
      transports: ["websocket"],
      timeout: 80_000,
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
    });
    this.socket.on("stream:peer", (peer: PeerAnnouncement) => {
      void this.enqueuePeerEvent(() => options.onPeer(peer));
    });
    this.socket.on("stream:peer-left", (payload?: { peerId?: string }) => {
      if (!payload?.peerId) return options.onError("Identidade do computador desconectado ausente");
      void this.enqueuePeerEvent(() => options.onPeerLeft(payload.peerId!));
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

  async recover() {
    if (this.closed || this.recovering || !this.desired || Date.now() < this.nextRecoveryAt) return;
    this.recovering = true;
    try {
      await this.waitForConnection();
      if (this.closed || !this.desired) return;
      const endpoint = await this.options.refreshEndpoint(this.desired.role);
      if (this.closed || !this.desired) return;
      this.desired = { ...this.desired, endpoint };
      await this.performJoin(this.desired);
      this.nextRecoveryAt = 0;
    } catch (error) {
      this.options.onError(`Reconexão automática: ${messageOf(error)}`);
      this.nextRecoveryAt = Date.now() + 1_500;
      throw error;
    } finally {
      this.recovering = false;
    }
  }

  private async performJoin({ room, role, endpoint, roomProof }: { room: string; role: StreamRole; endpoint: PreparedEndpoint; roomProof: string }) {
    await this.emit("hello", {});
    const response = await this.emit("stream:join", {
      room,
      role,
      endpoint: endpoint.public ?? endpoint.local,
      localEndpoint: endpoint.local,
      publicKey: endpoint.publicKey,
      codecs: endpoint.codecs,
      roomProof,
    });
    await this.options.onCapacity(response.maxViewers ?? 4);
    for (const peer of response.peers ?? []) {
      await this.enqueuePeerEvent(() => this.options.onPeer(peer));
    }
  }

  private enqueuePeerEvent(task: () => void | Promise<void>) {
    const execution = this.peerEvents.then(() => task());
    this.peerEvents = execution.catch((error) => this.options.onError(messageOf(error)));
    return execution;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.desired = null;
    for (const finish of [...this.connectionWaiters]) finish(new Error("Conexão encerrada"));
    this.socket.disconnect();
  }

  private waitForConnection(timeoutMs = 90_000) {
    if (this.closed) return Promise.reject(new Error("Conexão encerrada"));
    if (this.socket.connected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let timer = 0;
      const finish = (error?: Error) => {
        window.clearTimeout(timer);
        this.connectionWaiters.delete(finish);
        this.socket.off("connect", connected);
        if (error) reject(error); else resolve();
      };
      const connected = () => finish();
      this.connectionWaiters.add(finish);
      timer = window.setTimeout(() => finish(new Error("O servidor gratuito demorou para iniciar. Tente novamente.")), timeoutMs);
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
