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

interface AppState {
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

  /* estado local de midia */
  micReady: boolean;
  muted: boolean;
  deafened: boolean;
  sharing: boolean;
  tuning: TuningState;
  micDeviceId: string;
  mics: MediaDeviceInfo[];
  /** userId -> ganho 0..2 aplicado no <audio> daquela pessoa */
  volumes: Record<string, number>;
  pushToTalk: boolean;
  talking: boolean;
  sounds: boolean;

  /* atualizacao automatica */
  updateVersion: string | null;
  updateBusy: boolean;

  /* UI */
  focusPeer: string | null;
  showStats: boolean;
  showSettings: boolean;
  membersOpen: boolean;
  toasts: Toast[];

  set: <K extends keyof AppState>(patch: Pick<AppState, K> | Partial<AppState>) => void;
  pushMessage: (msg: ChatMessage) => void;
  setMessages: (channelId: string, msgs: ChatMessage[]) => void;
  toast: (kind: Toast["kind"], text: string) => void;
  dropToast: (id: number) => void;
  patchPeerState: (id: string, state: PeerState) => void;
  setVolume: (userId: string, volume: number) => void;
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

  micReady: false,
  muted: false,
  deafened: false,
  sharing: false,
  tuning: { video: "alta", audio: "voz", codec: "hardware", content: "jogo" },
  micDeviceId: "default",
  mics: [],
  volumes: {},
  pushToTalk: false,
  talking: false,
  sounds: true,

  updateVersion: null,
  updateBusy: false,

  focusPeer: null,
  showStats: false,
  showSettings: false,
  membersOpen: true,
  toasts: [],

  set: (patch) => set(patch as Partial<AppState>),

  pushMessage: (msg) =>
    set((s) => {
      const list = s.messages[msg.channelId] ?? [];
      if (list.some((m) => m.id === msg.id)) return s;
      // janela deslizante: 300 mensagens por canal em memoria, o resto vive no
      // Supabase. Evita a lista crescer sem limite numa sessao longa.
      const next = [...list, msg];
      return {
        messages: {
          ...s.messages,
          [msg.channelId]: next.length > 300 ? next.slice(-300) : next,
        },
      };
    }),

  setMessages: (channelId, msgs) =>
    set((s) => ({ messages: { ...s.messages, [channelId]: msgs } })),

  toast: (kind, text) =>
    set((s) => ({ toasts: [...s.toasts, { id: ++toastSeq, kind, text }].slice(-4) })),

  dropToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  patchPeerState: (id, state) =>
    set((s) => ({
      roster: s.roster.map((r) => (r.id === id ? { ...r, state } : r)),
    })),

  setVolume: (userId, volume) =>
    set((s) => {
      const volumes = { ...s.volumes, [userId]: volume };
      savePrefs({ volumes });
      return { volumes };
    }),
}));

/* ----------------------------- seletores ---------------------------------- */

export const selectVoiceMembers = (channelId: string | null) => (s: AppState) =>
  channelId ? s.roster.filter((r) => r.voice === channelId) : [];

export const selectTextChannels = (s: AppState) => s.channels.filter((c) => c.kind === "text");
export const selectVoiceChannels = (s: AppState) => s.channels.filter((c) => c.kind === "voice");
