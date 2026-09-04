import type { TuningState } from "./rtc";
import type { RebindCombo } from "./desktop";

/** acao -> combinacao customizada. Chave ausente = nunca mexeu, usa o padrao
 *  do Rust; `null` = usuario removeu o atalho de proposito. */
export type HotkeyPrefs = Partial<Record<"mute" | "deafen" | "share" | "talk", RebindCombo | null>>;

/* ---------------------------------------------------------------------------
   Preferencias em disco.

   O WebView2 guarda o localStorage na pasta de dados do proprio app
   (EBWebView), entao ele ja e persistente entre reinicios e por instalacao —
   nao precisa de arquivo, plugin de FS nem permissao extra.
   Excecao: a fonte de captura mora do lado do Rust, porque precisa ser lida
   ANTES do WebView existir (vira flag de linha de comando do Chromium).
--------------------------------------------------------------------------- */

const KEY = "voxa:prefs";

export interface Prefs {
  /** id estavel do usuario: sobrevive a reinicios, entao volume por pessoa
   *  e historico no Supabase continuam apontando pra mesma identidade. */
  userId: string;
  name: string;
  color: string;
  token: string;
  tuning: TuningState;
  micDeviceId: string;
  noiseSuppression: boolean;
  systemAudio: boolean;
  camDeviceId: string;
  outputDeviceId: string;
  outputMode: "natural" | "nivelado";
  /** peerUserId -> 0..2 (1 = normal, 2 = dobro) — volume da voz */
  volumes: Record<string, number>;
  /** peerUserId -> 0..2 — volume do audio da transmissao de tela, separado da voz */
  streamVolumes: Record<string, number>;
  membersOpen: boolean;
  showStats: boolean;
  pushToTalk: boolean;
  sounds: boolean;
  hotkeys: HotkeyPrefs;
  overlayEnabled: boolean;
  /** Canto superior esquerdo do overlay, em coordenadas LOGICAS (ver
   *  overlay.rs). `null` = nunca foi movido, nasce no canto padrao. */
  overlayPos: { x: number; y: number } | null;
}

const DEFAULTS: Prefs = {
  userId: "",
  name: "",
  color: "#5865F2",
  token: "",
  tuning: { video: "alta", audio: "voz", codec: "hardware", content: "jogo" },
  micDeviceId: "default",
  noiseSuppression: false,
  systemAudio: false,
  camDeviceId: "default",
  outputDeviceId: "default",
  outputMode: "natural",
  volumes: {},
  streamVolumes: {},
  membersOpen: true,
  showStats: false,
  pushToTalk: false,
  sounds: true,
  hotkeys: {},
  overlayEnabled: false,
  overlayPos: null,
};

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS, userId: crypto.randomUUID() };
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      ...DEFAULTS,
      ...parsed,
      userId: parsed.userId || crypto.randomUUID(),
      tuning: { ...DEFAULTS.tuning, ...(parsed.tuning ?? {}) },
      volumes: { ...(parsed.volumes ?? {}) },
      streamVolumes: { ...(parsed.streamVolumes ?? {}) },
      hotkeys: { ...(parsed.hotkeys ?? {}) },
    };
  } catch {
    return { ...DEFAULTS };
  }
}

let pending: number | null = null;
let cache: Prefs = DEFAULTS;

/** Grava com debounce: mexer no slider de volume nao pode escrever 60x/s. */
export function savePrefs(patch: Partial<Prefs>) {
  cache = { ...cache, ...patch };
  if (pending !== null) return;
  pending = window.setTimeout(() => {
    pending = null;
    try {
      localStorage.setItem(KEY, JSON.stringify(cache));
    } catch {
      /* quota cheia ou storage bloqueado: preferencia se perde, app segue */
    }
  }, 400);
}

export function primePrefsCache(prefs: Prefs) {
  cache = prefs;
}

/** Preferencias como estao AGORA, incluindo o que `savePrefs` ainda nao
 *  gravou. `loadPrefs` le o localStorage, que fica ate 400ms atrasado por
 *  causa do debounce: ler de la logo depois de salvar devolve o valor
 *  antigo. Use isto sempre que gravar e reler no mesmo gesto do usuario. */
export function currentPrefs(): Prefs {
  return cache;
}
