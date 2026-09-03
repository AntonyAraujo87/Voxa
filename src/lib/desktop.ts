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

/* ------------------------------- captura --------------------------------- */

export interface CaptureSource {
  id: string;
  label: string;
  kind: "monitor" | "window";
}

export const listCaptureSources = () => invoke<CaptureSource[]>("list_capture_sources");
export const getCaptureSource = () => invoke<string>("get_capture_source");
export const setCaptureSource = (title: string) => invoke("set_capture_source", { title });
export const setPushToTalkNative = (enabled: boolean) => invoke("set_push_to_talk", { enabled });

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
