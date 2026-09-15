import { listenEvent, rebindHotkey as rebindNative, type RebindCombo } from "./desktop";
import { currentPrefs, savePrefs } from "./prefs";
import { useApp } from "../store/store";

type Action = "mute" | "deafen" | "share" | "talk";
interface Actions {
  toggleMute(): void;
  toggleDeafen(): void;
  toggleShare(): void | Promise<void>;
  setTalking(active: boolean): void;
  setPushToTalk(enabled: boolean): Promise<void>;
}

export async function rebindSessionHotkey(action: Action, combo: RebindCombo) {
  const status = await rebindNative(action, combo);
  savePrefs({ hotkeys: { ...currentPrefs().hotkeys, [action]: combo.code ? combo : null } });
  return status;
}

/** As acoes de voz permanecem na sessao; esta camada so registra atalhos. */
export async function initSessionHotkeys(actions: Actions) {
  const saved = currentPrefs().hotkeys;
  for (const action of ["mute", "deafen", "share", "talk"] as const) {
    if (saved[action] === undefined) continue;
    try {
      await rebindNative(action, saved[action] ?? { code: null, ctrl: false, shift: false, alt: false, label: null });
    } catch {
      useApp.getState().toast("info", `Atalho de ${action} nao pode ser restaurado. Escolha outra tecla nas configuracoes.`);
    }
  }
  if (useApp.getState().pushToTalk) await actions.setPushToTalk(true);
  return listenEvent<{ action: string; pressed: boolean }>("hotkey", (event) => {
    switch (event.action) {
      case "mute": if (!useApp.getState().pushToTalk) actions.toggleMute(); break;
      case "deafen": actions.toggleDeafen(); break;
      case "share": void actions.toggleShare(); break;
      case "talk": actions.setTalking(event.pressed); break;
    }
  });
}
