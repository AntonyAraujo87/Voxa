import { io, type Socket } from "socket.io-client";
import type { PreparedEndpoint, StreamRole } from "./nativeEngine";

const PAKE_PROTOCOL = "spake2-p256-rfc9382-v1";

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

interface PeerStub { peerId: string; role: StreamRole; }
interface PakeStart { protocol: string; share: string; }

interface Options {
  onPeer: (peer: PeerAnnouncement) => void | Promise<void>;
  onPeerLeft: (peerId: string) => void | Promise<void>;
  onCapacity: (maxViewers: number) => void | Promise<void>;
  onError: (message: string) => void;
  refreshEndpoint: (role: StreamRole) => Promise<PreparedEndpoint>;
  pakeBegin: (peerId: string, room: string, roomSecret: string) => Promise<PakeStart>;
  pakeFinish: (peerId: string, remoteShare: string) => Promise<string>;
  pakeConfirm: (peerId: string, remoteConfirmation: string) => Promise<void>;
}

type Ack = { ok?: boolean; error?: string; peers?: PeerStub[]; maxViewers?: number };

export class Matchmaking {
  private readonly socket: Socket;
  private desired: { room: string; role: StreamRole; endpoint: PreparedEndpoint; roomSecret: string } | null = null;
  private rejoinArmed = false;
  private closed = false;
  private recovering = false;
  private nextRecoveryAt = 0;
  private readonly connectionWaiters = new Set<(error?: Error) => void>();
  private readonly stubs = new Map<string, PeerStub>();
  private readonly started = new Set<string>();
  private readonly authenticated = new Set<string>();
  private readonly delivered = new Set<string>();
  private readonly earlyShares = new Map<string, string>();
  private readonly earlyReady = new Map<string, PeerAnnouncement>();
  private peerEvents: Promise<void> = Promise.resolve();

  constructor(url: string, private readonly options: Options) {
    this.socket = io(url, {
      transports: ["websocket"],
      timeout: 80_000,
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
    });
    this.socket.on("stream:peer", (peer: PeerStub) => {
      void this.enqueuePeerEvent(() => this.beginPeer(peer));
    });
    this.socket.on("stream:pake", (payload?: { peerId?: string; protocol?: string; share?: string }) => {
      if (!validPeerId(payload?.peerId) || payload?.protocol !== PAKE_PROTOCOL || typeof payload?.share !== "string") {
        return this.options.onError("Mensagem SPAKE2 inválida recebida");
      }
      void this.enqueuePeerEvent(() => this.receiveShare(payload.peerId!, payload.share!));
    });
    this.socket.on("stream:pake-confirm", (payload?: { peerId?: string; confirmation?: string }) => {
      if (!validPeerId(payload?.peerId) || typeof payload?.confirmation !== "string") {
        return this.options.onError("Confirmação SPAKE2 inválida recebida");
      }
      void this.enqueuePeerEvent(() => this.receiveConfirmation(payload.peerId!, payload.confirmation!));
    });
    this.socket.on("stream:ready", (peer: PeerAnnouncement) => {
      if (!validPeerId(peer?.peerId)) return this.options.onError("Rota autenticada sem identidade");
      void this.enqueuePeerEvent(() => this.receiveReady(peer));
    });
    this.socket.on("stream:peer-left", (payload?: { peerId?: string }) => {
      if (!validPeerId(payload?.peerId)) return this.options.onError("Identidade do computador desconectado ausente");
      this.forgetPeer(payload.peerId!);
      void this.enqueuePeerEvent(() => this.options.onPeerLeft(payload.peerId!));
    });
    this.socket.on("connect_error", (error) => this.options.onError(
      this.socket.active
        ? "Acordando o servidor gratuito de matchmaking..."
        : error.message || "Servidor indisponível",
    ));
    this.socket.on("connect", () => {
      if (this.rejoinArmed && this.desired) {
        void this.options.refreshEndpoint(this.desired.role).then((endpoint) => {
          if (this.closed || !this.desired) return;
          this.desired = { ...this.desired, endpoint };
          return this.performJoin(this.desired);
        }).catch((error) => this.options.onError(messageOf(error)));
      }
    });
  }

  async join(room: string, role: StreamRole, endpoint: PreparedEndpoint, roomSecret: string) {
    this.desired = { room, role, endpoint, roomSecret };
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

  private async performJoin(desired: { room: string; role: StreamRole; endpoint: PreparedEndpoint; roomSecret: string }) {
    this.resetPeers();
    await this.emit("hello", {});
    const response = await this.emit("stream:join", {
      room: desired.room,
      role: desired.role,
      protocol: PAKE_PROTOCOL,
    });
    await this.options.onCapacity(response.maxViewers ?? 4);
    for (const peer of response.peers ?? []) await this.enqueuePeerEvent(() => this.beginPeer(peer));
  }

  private async beginPeer(peer: PeerStub) {
    if (!validPeerId(peer?.peerId) || (peer.role !== "host" && peer.role !== "viewer")) {
      throw new Error("Identidade SPAKE2 inválida");
    }
    if (!this.desired || peer.role === this.desired.role || this.started.has(peer.peerId)) return;
    this.stubs.set(peer.peerId, peer);
    this.started.add(peer.peerId);
    const start = await this.options.pakeBegin(peer.peerId, this.desired.room, this.desired.roomSecret);
    if (start.protocol !== PAKE_PROTOCOL) throw new Error("Implementação SPAKE2 incompatível");
    await this.emit("stream:pake", {
      peerId: peer.peerId,
      protocol: start.protocol,
      share: start.share,
    });
    const early = this.earlyShares.get(peer.peerId);
    if (early) {
      this.earlyShares.delete(peer.peerId);
      await this.receiveShare(peer.peerId, early);
    }
  }

  private async receiveShare(peerId: string, share: string) {
    if (!this.started.has(peerId)) {
      this.earlyShares.set(peerId, share);
      return;
    }
    const confirmation = await this.options.pakeFinish(peerId, share);
    await this.emit("stream:pake-confirm", { peerId, confirmation });
  }

  private async receiveConfirmation(peerId: string, confirmation: string) {
    await this.options.pakeConfirm(peerId, confirmation);
    this.authenticated.add(peerId);
    const desired = this.desired;
    if (!desired) return;
    await this.emit("stream:ready", {
      peerId,
      endpoint: desired.endpoint.public ?? desired.endpoint.local,
      localEndpoint: desired.endpoint.local,
      publicKey: desired.endpoint.publicKey,
      codecs: desired.endpoint.codecs,
    });
    const ready = this.earlyReady.get(peerId);
    if (ready) {
      this.earlyReady.delete(peerId);
      await this.receiveReady(ready);
    }
  }

  private async receiveReady(peer: PeerAnnouncement) {
    if (!this.authenticated.has(peer.peerId)) {
      this.earlyReady.set(peer.peerId, peer);
      return;
    }
    if (this.delivered.has(peer.peerId)) return;
    this.delivered.add(peer.peerId);
    await this.options.onPeer(peer);
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
    this.resetPeers();
    for (const finish of [...this.connectionWaiters]) finish(new Error("Conexão encerrada"));
    this.socket.disconnect();
  }

  private forgetPeer(peerId: string) {
    this.stubs.delete(peerId);
    this.started.delete(peerId);
    this.authenticated.delete(peerId);
    this.delivered.delete(peerId);
    this.earlyShares.delete(peerId);
    this.earlyReady.delete(peerId);
  }

  private resetPeers() {
    this.stubs.clear();
    this.started.clear();
    this.authenticated.clear();
    this.delivered.clear();
    this.earlyShares.clear();
    this.earlyReady.clear();
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

function validPeerId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
