import { create } from "zustand";
import { DEFAULT_CHANNELS, type Channel } from "../lib/config";
import type { PeerStats, TuningState } from "../lib/rtc";
import type { ChatMessage, PeerState, PeerUser, RosterEntry } from "../lib/signaling";
import { savePrefs } from "../lib/prefs";

export type ConnStatus = "connecting" | "online" | "offline";

export interface Toast {
  id: number;
  kind: "info" | "error" | "ok";
  text: string;
}

export interface AppState {
  /* identidade */
  me: PeerUser | null;
  selfSocketId: string;
  supabaseUserId: string | null;
  status: ConnStatus;

  /* canais */
  channels: Channel[];
  activeText: string;
  activeVoice: string | null;

  /* pessoas */
  roster: RosterEntry[];
  speaking: Record<string, boolean>;
  connState: Record<string, RTCPeerConnectionState>;
  stats: Record<string, PeerStats>;

  /* chat */
  messages: Record<string, ChatMessage[]>;
  typing: Record<string, number>;
  /** canalId -> mensagens nao lidas desde a ultima visita */
  unread: Record<string, number>;

  /* estado local de midia */
  micReady: boolean;
  muted: boolean;
  deafened: boolean;
  sharing: boolean;
  /** so importa junto de `sharing: true` — o que mostrar (tela ou webcam). */
  sharingKind: "tela" | "camera" | null;
  tuning: TuningState;
  micDeviceId: string;
  mics: MediaDeviceInfo[];
  /** RNNoise (rede neural, WASM) no caminho do mic — mais forte que o
   *  noiseSuppression nativo do getUserMedia, custa CPU, por isso opcional. */
  noiseSuppression: boolean;
  camDeviceId: string;
  cameras: MediaDeviceInfo[];
  outputDeviceId: string;
  speakers: MediaDeviceInfo[];
  /** "nivelado" liga um compressor no bus de saida — sobe quem fala baixo */
  outputMode: "natural" | "nivelado";
  /** userId -> ganho 0..2 aplicado no <audio> daquela pessoa (voz do microfone) */
  volumes: Record<string, number>;
  /** userId -> ganho 0..2 aplicado no audio da tela/jogo daquela pessoa, separado da voz */
  streamVolumes: Record<string, number>;
  pushToTalk: boolean;
  talking: boolean;
  sounds: boolean;
  /** janela flutuante de quem esta falando, por cima do jogo */
  overlayEnabled: boolean;

  /* atualizacao automatica */
  updateVersion: string | null;
  updateBusy: boolean;

  /* UI */
  focusPeer: string | null;
  /** o usuario abriu a grade de quem esta transmitindo (clicou "assistir") */
  watchingLive: boolean;
  /** escolhendo qual tela/janela compartilhar, antes de comecar a transmitir */
  showSharePicker: boolean;
  showStats: boolean;
  showSettings: boolean;
  membersOpen: boolean;
  toasts: Toast[];

  set: <K extends keyof AppState>(patch: Pick<AppState, K> | Partial<AppState>) => void;
  pushMessage: (msg: ChatMessage) => void;
  setMessages: (channelId: string, msgs: ChatMessage[]) => void;
  prependMessages: (channelId: string, msgs: ChatMessage[]) => void;
  toast: (kind: Toast["kind"], text: string) => void;
  dropToast: (id: number) => void;
  patchPeerState: (id: string, state: PeerState) => void;
  setVolume: (userId: string, volume: number) => void;
  setStreamVolume: (userId: string, volume: number) => void;
  clearUnread: (channelId: string) => void;
}

let toastSeq = 0;

export const useApp = create<AppState>((set) => ({
  me: null,
  selfSocketId: "",
  supabaseUserId: null,
  status: "connecting",

  channels: DEFAULT_CHANNELS,
  activeText: "geral",
  activeVoice: null,

  roster: [],
  speaking: {},
  connState: {},
  stats: {},

  messages: {},
  typing: {},
  unread: {},

  micReady: false,
  muted: false,
  deafened: false,
  sharing: false,
  sharingKind: null,
  tuning: { video: "alta", audio: "voz", codec: "hardware", content: "jogo" },
  micDeviceId: "default",
  mics: [],
  noiseSuppression: false,
  camDeviceId: "default",
  cameras: [],
  outputDeviceId: "default",
  speakers: [],
  outputMode: "natural",
  volumes: {},
  streamVolumes: {},
  pushToTalk: false,
  talking: false,
  sounds: true,
  overlayEnabled: false,

  updateVersion: null,
  updateBusy: false,

  focusPeer: null,
  watchingLive: false,
  showSharePicker: false,
  showStats: false,
  showSettings: false,
  membersOpen: true,
  toasts: [],

  set: (patch) => set(patch as Partial<AppState>),

  pushMessage: (msg) =>
    set((s) => {
      const list = s.messages[msg.channelId] ?? [];
      if (list.some((m) => m.id === msg.id)) return s;

      // Conta como nao lida quando a mensagem nao e minha e o canal nao esta
      // aberto — ou esta aberto mas a janela nem visivel, que e o caso comum:
      // o app fica na bandeja durante o jogo.
      const minha = msg.authorId === s.me?.id;
      const vendoAgora = s.activeText === msg.channelId && !document.hidden;
      const unread =
        minha || vendoAgora
          ? s.unread
          : { ...s.unread, [msg.channelId]: (s.unread[msg.channelId] ?? 0) + 1 };

      // janela deslizante: 300 mensagens por canal em memoria, o resto vive no
      // Supabase. Evita a lista crescer sem limite numa sessao longa.
      const next = [...list, msg];
      return {
        unread,
        messages: {
          ...s.messages,
          [msg.channelId]: next.length > 300 ? next.slice(-300) : next,
        },
      };
    }),

  setMessages: (channelId, msgs) =>
    set((s) => ({ messages: { ...s.messages, [channelId]: msgs } })),

  /** Insere pagina antiga no topo, sem duplicar o que ja esta na tela. */
  prependMessages: (channelId, msgs) =>
    set((s) => {
      const atuais = s.messages[channelId] ?? [];
      const conhecidos = new Set(atuais.map((m) => m.id));
      const novas = msgs.filter((m) => !conhecidos.has(m.id));
      if (novas.length === 0) return s;
      return { messages: { ...s.messages, [channelId]: [...novas, ...atuais] } };
    }),

  toast: (kind, text) =>
    set((s) => ({ toasts: [...s.toasts, { id: ++toastSeq, kind, text }].slice(-4) })),

  dropToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  patchPeerState: (id, state) =>
    set((s) => ({
      roster: s.roster.map((r) => (r.id === id ? { ...r, state } : r)),
    })),

  clearUnread: (channelId) =>
    set((s) => {
      if (!s.unread[channelId]) return s;
      const unread = { ...s.unread };
      delete unread[channelId];
      return { unread };
    }),

  setVolume: (userId, volume) =>
    set((s) => {
      const volumes = { ...s.volumes, [userId]: volume };
      savePrefs({ volumes });
      return { volumes };
    }),

  setStreamVolume: (userId, volume) =>
    set((s) => {
      const streamVolumes = { ...s.streamVolumes, [userId]: volume };
      savePrefs({ streamVolumes });
      return { streamVolumes };
    }),
}));

/* ----------------------------- seletores ---------------------------------- */

export const selectVoiceMembers = (channelId: string | null) => (s: AppState) =>
  channelId ? s.roster.filter((r) => r.voice === channelId) : [];

export const selectTextChannels = (s: AppState) => s.channels.filter((c) => c.kind === "text");
export const selectVoiceChannels = (s: AppState) => s.channels.filter((c) => c.kind === "voice");
