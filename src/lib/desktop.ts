/* ---------------------------------------------------------------------------
   Ponte com o Rust. Tudo aqui e import() dinamico e falha em silencio quando o
   app roda num navegador comum (dev, teste) — a UI continua funcionando, so
   sem atalho global, sem picker de fonte e sem auto-update.
--------------------------------------------------------------------------- */

export const isDesktop =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as object);

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isDesktop) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke(cmd, args)) as T;
  } catch (err) {
    console.warn("[desktop] invoke falhou:", cmd, err);
    return null;
  }
}

export async function listenEvent<T>(
  event: string,
  handler: (payload: T) => void
): Promise<() => void> {
  if (!isDesktop) return () => {};
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<T>(event, (e) => handler(e.payload));
  } catch {
    return () => {};
  }
}

/** Manda um evento pra TODAS as janelas do app — e como a principal fala
 *  com a do overlay, que roda um processo de WebView separado. */
export async function emitEvent<T>(event: string, payload: T): Promise<void> {
  if (!isDesktop) return;
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(event, payload);
  } catch {
    /* overlay pode nao existir ainda; nao ha o que fazer alem de tentar de novo na proxima mudanca */
  }
}

/* ------------------------------- captura --------------------------------- */

export interface CaptureSource {
  id: string;
  label: string;
  kind: "monitor" | "window";
}

export const listCaptureSources = () => invoke<CaptureSource[]>("list_capture_sources");

/** Modo de compatibilidade: desliga as flags de GPU e audio que aceleram a
 *  captura na maioria das maquinas e travam a interface em algumas. So vale
 *  no proximo boot — as flags sao lidas antes do WebView2 nascer. */
export const setSafeMode = (on: boolean) => invoke("set_safe_mode", { on });
export const getSafeMode = () => invoke<boolean>("get_safe_mode");
export const getCaptureSource = () => invoke<string>("get_capture_source");
export const setCaptureSource = (title: string) => invoke("set_capture_source", { title });

/**
 * Traz a janela pra frente e foca — usada antes de abrir o seletor de
 * transmissao, porque o atalho global (Ctrl+Shift+E) pode disparar com o
 * app escondido na bandeja, e o seletor precisa estar visivel pra escolher.
 */
let winPromise: Promise<{ show: () => Promise<void>; setFocus: () => Promise<void> } | null> | null =
  null;
export async function focusWindow(): Promise<void> {
  if (!isDesktop) return;
  if (!winPromise) {
    winPromise = import("@tauri-apps/api/window")
      .then((m) => m.getCurrentWindow())
      .catch(() => null);
  }
  const win = await winPromise;
  await win?.show().catch(() => {});
  await win?.setFocus().catch(() => {});
}

/** Reinicia o app — usado depois de trocar a fonte de captura, que so vale no proximo boot. */
export async function relaunchApp(): Promise<void> {
  if (!isDesktop) return;
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
export const setPushToTalkNative = (enabled: boolean) => invoke("set_push_to_talk", { enabled });

/**
 * Pede ao Rust que devolva ao sistema as paginas de memoria ociosas — do
 * processo do app e dos processos do WebView2, que sao a maior parte do
 * consumo. Chamado quando a janela deixa de estar visivel.
 */
export const releaseMemory = () => invoke("release_memory");

/** Pisca o icone na barra de tarefas — aviso nativo, sem plugin nem permissao. */
export const flashTaskbar = () => invoke("flash_taskbar");

export interface HotkeyStatus {
  mute: string | null;
  deafen: string | null;
  share: string | null;
  talk: string | null;
}

/**
 * Combinacoes que realmente ficaram registradas. Atalho global e exclusivo do
 * sistema: se outro programa ja tiver a combinacao, a nossa nao vale. A
 * interface precisa mostrar a que funciona, nao a que estava no plano.
 */
export const getHotkeyStatus = () => invoke<HotkeyStatus>("hotkey_status");

export interface RebindCombo {
  /** `KeyboardEvent.code` cru — "KeyM", "F9", "Digit5"... `null` remove o atalho. */
  code: string | null;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** rotulo amigavel pronto pra mostrar ("Ctrl+Shift+M"), calculado no frontend. */
  label: string | null;
}

/** Troca a tecla de uma acao. Rejeita com a razao quando a combinacao nao vale. */
export async function rebindHotkey(
  action: "mute" | "deafen" | "share" | "talk",
  combo: RebindCombo
): Promise<HotkeyStatus> {
  if (!isDesktop) throw new Error("atalhos globais so existem no app instalado");
  const { invoke: chamar } = await import("@tauri-apps/api/core");
  return chamar("rebind_hotkey", { action, ...combo }) as Promise<HotkeyStatus>;
}

/* ------------------------------- update ---------------------------------- */

export interface UpdateInfo {
  version: string;
  notes?: string;
  install: () => Promise<void>;
}

/**
 * Procura atualizacao no endpoint configurado em tauri.conf.json.
 * Retorna null quando nao ha nada novo, quando roda no navegador, ou quando o
 * endpoint ainda nao foi configurado (repo nao publicado).
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isDesktop) return null;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      notes: update.body ?? undefined,
      install: async () => {
        await update.downloadAndInstall();
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      },
    };
  } catch (err) {
    // Sem rede, endpoint 404 ou assinatura invalida: nao e motivo pra alarme.
    console.info("[update] indisponivel:", err);
    return null;
  }
}

/* -------------------------------- overlay --------------------------------- */

/** Cria/fecha a janela flutuante de quem esta falando, por cima do jogo.
 *  `pos` e a posicao logica salva; sem ela o overlay nasce no canto padrao. */
export const setOverlayWindowEnabled = (on: boolean, pos?: { x: number; y: number } | null) =>
  invoke("set_overlay_enabled", { on, x: pos?.x, y: pos?.y });

/** Modo posicionar: com `on`, o overlay volta a receber clique pra ser
 *  arrastado. Enquanto valer, ele fica no caminho do mouse. */
export const setOverlayMovable = (on: boolean) => invoke("overlay_set_movable", { on });

/** Arrasta a janela do overlay junto com o mouse (chamado no pointerdown). */
export const dragOverlay = () => invoke("overlay_drag");

/** Posicao logica atual do overlay, pra guardar nas preferencias. */
export const getOverlayPosition = () => invoke<[number, number]>("overlay_position");
