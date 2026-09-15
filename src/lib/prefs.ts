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
  systemAudioMode: "system" | "application" | "exclude-voxa";
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
  systemAudioMode: "system",
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

function validate(value: unknown): Prefs {
  const p = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const result: Prefs = structuredClone(DEFAULTS);
  for (const key of ["name", "token", "micDeviceId", "camDeviceId", "outputDeviceId"] as const) {
    if (typeof p[key] === "string" && p[key].length <= 4096) result[key] = p[key];
  }
  result.name = result.name.slice(0, 32);
  result.userId = typeof p.userId === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(p.userId) ? p.userId : crypto.randomUUID();
  if (typeof p.color === "string" && /^#[0-9a-f]{6}$/i.test(p.color)) result.color = p.color;
  for (const key of ["noiseSuppression", "systemAudio", "membersOpen", "showStats", "pushToTalk", "sounds", "overlayEnabled"] as const) {
    if (typeof p[key] === "boolean") result[key] = p[key];
  }
  if (p.outputMode === "nivelado") result.outputMode = p.outputMode;
  if (p.systemAudioMode === "application" || p.systemAudioMode === "exclude-voxa") result.systemAudioMode = p.systemAudioMode;
  const tuning = p.tuning && typeof p.tuning === "object" ? p.tuning as Record<string, unknown> : {};
  const allowed = { video: ["lan","alta","nitida","fluida","equilibrada","economica"], audio: ["voz","estudio"], codec: ["hardware","eficiencia","compatibilidade"], content: ["jogo","leitura"] };
  for (const key of Object.keys(allowed) as (keyof TuningState)[]) {
    if (typeof tuning[key] === "string" && allowed[key].includes(tuning[key])) Object.assign(result.tuning, { [key]: tuning[key] });
  }
  for (const key of ["volumes", "streamVolumes"] as const) {
    if (p[key] && typeof p[key] === "object") for (const [id, volume] of Object.entries(p[key]).slice(0, 1000)) {
      if (/^[a-zA-Z0-9_-]{1,64}$/.test(id) && typeof volume === "number" && Number.isFinite(volume)) result[key][id] = Math.max(0, Math.min(2, volume));
    }
  }
  const hotkeys = p.hotkeys && typeof p.hotkeys === "object" ? p.hotkeys as HotkeyPrefs : {};
  for (const action of ["mute", "deafen", "share", "talk"] as const) {
    const c = hotkeys[action];
    if (c === null) result.hotkeys[action] = null;
    else if (c && typeof c.code === "string" && /^[A-Za-z0-9]{1,32}$/.test(c.code)) result.hotkeys[action] = {code:c.code, ctrl:c.ctrl === true, shift:c.shift === true, alt:c.alt === true, label:typeof c.label === "string" ? c.label.slice(0,80) : c.code};
  }
  const pos = p.overlayPos as {x?:unknown;y?:unknown} | null;
  if (pos && typeof pos.x === "number" && typeof pos.y === "number" && Number.isFinite(pos.x) && Number.isFinite(pos.y)) result.overlayPos = {x:pos.x,y:pos.y};
  return result;
}

let pending: number | null = null;
let cache: Prefs | null = null;

export function loadPrefs(): Prefs {
  if (cache) return cache;
  try { cache = validate(JSON.parse(localStorage.getItem(KEY) ?? "null")); }
  catch { cache = validate(null); }
  return cache;
}

export function flushPrefs() {
  if (pending !== null) window.clearTimeout(pending);
  pending = null;
  if (!cache) return;
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* memoria preservada se disco indisponivel */ }
}

export function savePrefs(patch: Partial<Prefs>) {
  cache = validate({ ...loadPrefs(), ...patch });
  if (pending === null) pending = window.setTimeout(flushPrefs, 400);
}

export function primePrefsCache(prefs: Prefs) { cache = validate(prefs); }
export function currentPrefs(): Prefs { return loadPrefs(); }
if (typeof window !== "undefined") window.addEventListener("pagehide", flushPrefs);
