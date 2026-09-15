import { IceLease } from "./iceLease";
import { io, type Socket } from "socket.io-client";
import { SIGNALING_URL, updateIceServers } from "./config";

export interface PeerState {
  watching?: boolean;
  muted: boolean;
  deafened: boolean;
  sharing: boolean;
  speaking: boolean;
  /** so importa junto de `sharing: true` — o que mostrar na UI dos outros. */
  sharingKind: "tela" | "camera" | null;
}

export interface PeerUser {
  id: string;
  name: string;
  color: string;
}

export interface RosterEntry {
  id: string;
  user: PeerUser;
  state: PeerState;
  voice: string | null;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  content: string;
  authorId: string;
  authorName: string;
  authorColor: string;
  createdAt: string;
  pending?: boolean;
  failed?: boolean;
  persistenceFailed?: boolean;
  attachmentUrl?: string;
  attachmentName?: string;
  attachmentMime?: string;
  attachmentSize?: number;
}

export type SignalPayload =
  | { description: RTCSessionDescriptionInit }
  | { candidate: RTCIceCandidateInit | null };

export class SignalingRequestError extends Error {
  constructor(message: string, readonly retryable = false) { super(message); }
}

interface Handlers {
  onRoster?: (roster: RosterEntry[]) => void;
  onPeerJoined?: (p: { id: string; user: PeerUser; state: PeerState; channelId: string }) => void;
  onPeerLeft?: (p: { id: string; channelId: string }) => void;
  onSignal?: (p: { from: string; data: SignalPayload; channelId?: string }) => void;
  onPeerState?: (p: { id: string; state: PeerState }) => void;
  onChat?: (msg: ChatMessage) => void;
  onTyping?: (p: { channelId: string; name: string }) => void;
  onStatus?: (s: "connecting" | "online" | "offline") => void;
  /** Reconectou depois de uma queda: o socket tem id NOVO. */
  onReconnected?: (p: { selfId: string; roster: RosterEntry[] }) => void;
}

/**
 * Cliente do signaling. Fina camada sobre socket.io — sem estado de midia,
 * so transporte. Se cair, o P2P ja estabelecido continua vivo.
 */
/**
 * Bate no /health do servidor para separar dois erros que, para quem usa,
 * parecem o mesmo: "senha errada" e "servidor inacessivel". Sem isso, a unica
 * mensagem possivel era generica, e a pessoa ficava tentando a senha certa
 * contra um servidor que nem estava no ar.
 */
export async function pingSignaling(timeoutMs = 8000): Promise<boolean> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const r = await fetch(`${SIGNALING_URL}/health`, { signal: abort.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export class Signaling {
  private socket: Socket;
  selfId = "";

  constructor(private handlers: Handlers = {}) {
    this.socket = io(SIGNALING_URL, {
      transports: ["websocket"],
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 800,
      reconnectionDelayMax: 5000,
      timeout: 8000,
    });

    this.socket.on("connect", () => void this.identify());
    this.socket.on("disconnect", () => handlers.onStatus?.("offline"));
    this.socket.on("connect_error", (error) => {
      handlers.onStatus?.("offline");
      if (/autorizado|token/i.test(error.message)) this.failLogin(new Error("Senha da sala incorreta"));
    });

    this.socket.on("roster", (r) => handlers.onRoster?.(r));
    this.socket.on("voice:peer-joined", (p) => handlers.onPeerJoined?.(p));
    this.socket.on("voice:peer-left", (p) => handlers.onPeerLeft?.(p));
    this.socket.on("signal", (p) => handlers.onSignal?.(p));
    this.socket.on("peer:state", (p) => handlers.onPeerState?.(p));
    this.socket.on("chat:new", (m) => handlers.onChat?.(m));
    this.socket.on("chat:typing", (p) => handlers.onTyping?.(p));
  }

  private credentials: { user: PeerUser; token: string } | null = null;
  private attempt = 0;
  private ready = false;
  private iceLease = new IceLease(
    async () => (await this.request<{ iceServers: RTCIceServer[] }>("ice:config", {})).iceServers,
    updateIceServers,
    () => this.socket.connected,
  );
  private identifyRetry: ReturnType<typeof setTimeout> | null = null;
  private login: { resolve: (value: { selfId: string; roster: RosterEntry[] }) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;

  private failLogin(error: Error) {
    this.ready = false;
    if (this.identifyRetry) clearTimeout(this.identifyRetry);
    this.identifyRetry = null;
    this.iceLease.stop();
    const pending = this.login;
    this.login = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
    this.attempt++;
    this.socket.disconnect();
    this.handlers.onStatus?.("offline");
  }

  private async identify() {
    if (this.identifyRetry) clearTimeout(this.identifyRetry);
    this.identifyRetry = null;
    const credentials = this.credentials;
    if (!credentials) return;
    const attempt = this.attempt;
    const socketId = this.socket.id;
    try {
      const response = await this.request<{ selfId: string; roster: RosterEntry[]; iceServers?: RTCIceServer[] }>("hello", credentials);
      if (attempt !== this.attempt || socketId !== this.socket.id) return;
      if (!response.selfId || !Array.isArray(response.roster)) throw new Error("Resposta de identificacao invalida");
      this.selfId = response.selfId;
      if (Array.isArray(response.iceServers)) this.iceLease.start(response.iceServers);
      const pending = this.login;
      this.login = null;
      this.handlers.onStatus?.("online");
      if (pending) { clearTimeout(pending.timer); pending.resolve(response); }
      else if (this.ready) this.handlers.onReconnected?.(response);
      this.ready = true;
    } catch (error) {
      if (attempt !== this.attempt || socketId !== this.socket.id) return;
      if ((this.ready || this.login) && error instanceof SignalingRequestError && error.retryable) {
        // Timeout de ACK nao e logout. Manter o socket ativo permite a
        // reconexao do transporte; hello repetido e idempotente no servidor.
        this.handlers.onStatus?.("connecting");
        this.identifyRetry = setTimeout(() => {
          this.identifyRetry = null;
          if (attempt === this.attempt && this.socket.connected) void this.identify();
        }, 2000);
        return;
      }
      this.failLogin(error instanceof Error ? error : new Error(String(error)));
    }
  }

  connect(user: PeerUser, token: string): Promise<{ selfId: string; roster: RosterEntry[] }> {
    if (this.login) this.failLogin(new Error("Tentativa substituida"));
    this.iceLease.stop();
    this.socket.disconnect();
    this.attempt++;
    this.ready = false;
    this.credentials = { user, token };
    this.socket.auth = { token };
    this.socket.io.reconnection(true);
    this.handlers.onStatus?.("connecting");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.failLogin(new Error("Servidor nao respondeu. Tente novamente.")), 45000);
      this.login = { resolve, reject, timer };
      this.socket.connect();
    });
  }

  private request<T>(event: string, payload: unknown): Promise<T> {
    if (!this.socket.connected) return Promise.reject(new SignalingRequestError("Sem conexao com o servidor", true));
    return new Promise((resolve, reject) => {
      this.socket.timeout(10000).emit(event, payload, (error: Error | null, response: T & { error?: string }) => {
        if (error) { reject(new SignalingRequestError("O servidor nao confirmou a operacao. Tente novamente.", true)); return; }
        if (!response || response.error) { reject(new Error(response?.error ?? "Resposta invalida do servidor")); return; }
        resolve(response);
      });
    });
  }

  async recoverNetwork() {
    if (!this.credentials || !this.ready) return false;
    if (!this.socket.connected) this.socket.connect();
    return this.iceLease.refresh();
  }

  async joinVoice(channelId: string): Promise<{ channelId: string; peers: { id: string; user: PeerUser; state: PeerState }[] }> {
    const result = await this.request<{ channelId: string; peers: { id: string; user: PeerUser; state: PeerState }[] }>("voice:join", { channelId });
    if (result.channelId !== channelId || !Array.isArray(result.peers)) throw new Error("Resposta de canal invalida");
    return { ...result, peers: result.peers.filter(peer => peer.id !== this.selfId) };
  }

  leaveVoice() {
    if (this.socket.connected) this.socket.emit("voice:leave");
  }

  signal(to: string, data: SignalPayload) {
    if (this.socket.connected) this.socket.emit("signal", { to, data });
  }

  setState(patch: Partial<PeerState>) {
    if (this.socket.connected) this.socket.emit("state", patch);
  }

  sendChat(msg: {
    id: string;
    channelId: string;
    content: string;
    attachmentUrl?: string;
    attachmentName?: string;
    attachmentMime?: string;
    attachmentSize?: number;
  }) {
    if (!this.socket.connected) return Promise.reject(new Error("Sem conexao com o servidor"));
    return new Promise<ChatMessage>((resolve, reject) => {
      let finished = false;
      const finish = (error: Error | null, message?: ChatMessage) => {
        if (finished) return;
        finished = true;
        this.socket.off("chat:new", echo);
        if (error) reject(error); else resolve(message!);
      };
      const echo = (message: ChatMessage) => { if (message.id === msg.id && message.channelId === msg.channelId) finish(null, message); };
      this.socket.on("chat:new", echo);
      this.socket.timeout(10000).emit("chat:send", msg, (error: Error | null, message: ChatMessage & {error?:string}) => {
        if (error || !message || message.error) finish(new Error(message?.error ?? "Entrega nao confirmada"));
        else finish(null, message);
      });
    });
  }

  typing(channelId: string) {
    this.socket.emit("chat:typing", { channelId });
  }

  destroy() {
    this.failLogin(new Error("Sessao encerrada"));
    this.credentials = null;
    this.iceLease.stop();
    this.socket.removeAllListeners();
    this.socket.disconnect();
  }
}
