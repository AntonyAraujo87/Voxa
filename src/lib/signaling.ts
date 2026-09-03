import { io, type Socket } from "socket.io-client";
import { SIGNALING_URL } from "./config";

export interface PeerState {
  muted: boolean;
  deafened: boolean;
  sharing: boolean;
  speaking: boolean;
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
}

export type SignalPayload =
  | { description: RTCSessionDescriptionInit }
  | { candidate: RTCIceCandidateInit | null };

interface Handlers {
  onRoster?: (roster: RosterEntry[]) => void;
  onPeerJoined?: (p: { id: string; user: PeerUser; state: PeerState; channelId: string }) => void;
  onPeerLeft?: (p: { id: string; channelId: string }) => void;
  onSignal?: (p: { from: string; data: SignalPayload }) => void;
  onPeerState?: (p: { id: string; state: PeerState }) => void;
  onChat?: (msg: ChatMessage) => void;
  onTyping?: (p: { channelId: string; name: string }) => void;
  onStatus?: (s: "connecting" | "online" | "offline") => void;
}

/**
 * Cliente do signaling. Fina camada sobre socket.io — sem estado de midia,
 * so transporte. Se cair, o P2P ja estabelecido continua vivo.
 */
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

    this.socket.on("connect", () => handlers.onStatus?.("online"));
    this.socket.on("disconnect", () => handlers.onStatus?.("offline"));
    this.socket.on("connect_error", () => handlers.onStatus?.("offline"));

    this.socket.on("roster", (r) => handlers.onRoster?.(r));
    this.socket.on("voice:peer-joined", (p) => handlers.onPeerJoined?.(p));
    this.socket.on("voice:peer-left", (p) => handlers.onPeerLeft?.(p));
    this.socket.on("signal", (p) => handlers.onSignal?.(p));
    this.socket.on("peer:state", (p) => handlers.onPeerState?.(p));
    this.socket.on("chat:new", (m) => handlers.onChat?.(m));
    this.socket.on("chat:typing", (p) => handlers.onTyping?.(p));
  }

  connect(
    user: PeerUser,
    token: string
  ): Promise<{ selfId: string; roster: RosterEntry[] }> {
    this.handlers.onStatus?.("connecting");
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Signaling nao respondeu")), 10000);
      const onReady = () => {
        this.socket.emit(
          "hello",
          { user, token },
          (res: { selfId: string; roster: RosterEntry[]; error?: string }) => {
            clearTimeout(timeout);
            if (res?.error) {
              // Sem isso o socket.io ficaria batendo na porta pra sempre com a
              // mesma senha errada, gerando reconexao infinita.
              this.socket.io.opts.reconnection = false;
              this.socket.disconnect();
              reject(new Error("Senha da sala incorreta"));
              return;
            }
            this.selfId = res.selfId;
            resolve(res);
          }
        );
      };
      if (this.socket.connected) onReady();
      else {
        this.socket.once("connect", onReady);
        this.socket.connect();
      }
      // Reidentifica automaticamente depois de cada reconexao.
      this.socket.io.on("reconnect", () => this.socket.emit("hello", { user, token }, () => {}));
    });
  }

  joinVoice(channelId: string): Promise<{ channelId: string; peers: { id: string; user: PeerUser; state: PeerState }[] }> {
    return new Promise((resolve) => {
      this.socket.emit("voice:join", { channelId }, resolve);
    });
  }

  leaveVoice() {
    this.socket.emit("voice:leave");
  }

  signal(to: string, data: SignalPayload) {
    this.socket.emit("signal", { to, data });
  }

  setState(patch: Partial<PeerState>) {
    this.socket.emit("state", patch);
  }

  sendChat(msg: { id: string; channelId: string; content: string }) {
    this.socket.emit("chat:send", msg);
  }

  typing(channelId: string) {
    this.socket.emit("chat:typing", { channelId });
  }

  destroy() {
    this.socket.removeAllListeners();
    this.socket.disconnect();
  }
}
