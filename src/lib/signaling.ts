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
  attachmentUrl?: string;
  attachmentName?: string;
  attachmentMime?: string;
  attachmentSize?: number;
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

  /** evita registrar os mesmos listeners de novo quando o login e repetido */
  private listenersDeConexao = false;

  connect(
    user: PeerUser,
    token: string
  ): Promise<{ selfId: string; roster: RosterEntry[] }> {
    this.handlers.onStatus?.("connecting");
    return new Promise((resolve, reject) => {
      // 45s e nao 10s: no plano free do Render o servico dorme depois de 15min
      // ociosos e leva ~30s pra acordar. Timeout curto reprovaria o primeiro
      // login do dia mesmo com tudo certo.
      const timeout = setTimeout(
        () => reject(new Error("Servidor nao respondeu. Ele pode estar acordando — tente de novo.")),
        45000
      );
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
      // Token tambem no handshake: o servidor recusa a conexao ANTES de
      // registrar qualquer handler, entao senha errada nao custa memoria nem
      // processamento. O envio no `hello` permanece para servidores antigos.
      this.socket.auth = { token };

      if (this.socket.connected) onReady();
      else {
        this.socket.once("connect", onReady);
        this.socket.connect();
      }
      // Senha errada faz o usuario tentar de novo, e cada tentativa passava
      // por aqui registrando outro par de listeners: na terceira tentativa o
      // `hello` de reconexao sairia tres vezes.
      if (this.listenersDeConexao) return;
      this.listenersDeConexao = true;

      // Reidentifica depois de cada reconexao.
      //
      // O socket.io cria um socket NOVO ao reconectar, com id novo. Ignorar o
      // ack aqui deixava o app usando o id antigo: a regra polite/impolite
      // passava a comparar contra um id que nao existe mais, o proprio tile
      // deixava de ser reconhecido como "eu", e — pior — o servidor via um
      // socket sem canal de voz, avisava os outros que saimos e a malha morria
      // enquanto a interface continuava dizendo "Voz conectada".
      this.socket.io.on("reconnect", () => {
        this.socket.emit("hello", { user, token }, (res: { selfId?: string; roster?: RosterEntry[] }) => {
          if (!res?.selfId) return;
          this.selfId = res.selfId;
          this.handlers.onReconnected?.({ selfId: res.selfId, roster: res.roster ?? [] });
        });
      });
      // "nao autorizado" vem do middleware do servidor: nao adianta insistir.
      this.socket.on("connect_error", (err) => {
        if (/autorizado|token/i.test(err?.message ?? "")) {
          this.socket.io.opts.reconnection = false;
          clearTimeout(timeout);
          reject(new Error("Senha da sala incorreta"));
        }
      });
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

  sendChat(msg: {
    id: string;
    channelId: string;
    content: string;
    attachmentUrl?: string;
    attachmentName?: string;
    attachmentMime?: string;
    attachmentSize?: number;
  }) {
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
