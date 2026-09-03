import { memo, useEffect, useState } from "react";
import { Minus, Square, X, Copy } from "lucide-react";
import { VoxaMark } from "./VoxaMark";
import { useApp } from "../store/store";

/* Barra de titulo propria (a janela roda sem decoracao nativa).
   O import do Tauri e dinamico pra o app continuar abrindo no browser. */

type TauriWindow = {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
};

let winPromise: Promise<TauriWindow | null> | null = null;
function tauriWindow(): Promise<TauriWindow | null> {
  if (!winPromise) {
    winPromise = import("@tauri-apps/api/window")
      .then((m) => m.getCurrentWindow() as unknown as TauriWindow)
      .catch(() => null);
  }
  return winPromise;
}

const STATUS_LABEL = {
  online: "conectado",
  connecting: "conectando",
  offline: "offline",
} as const;

const STATUS_COLOR = {
  online: "bg-online",
  connecting: "bg-warn",
  offline: "bg-danger",
} as const;

function TitleBarBase() {
  const status = useApp((s) => s.status);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void tauriWindow().then((w) => w?.isMaximized().then(setMaximized));
  }, []);

  const act = async (fn: "minimize" | "toggleMaximize" | "close") => {
    const w = await tauriWindow();
    if (!w) return;
    await w[fn]();
    if (fn === "toggleMaximize") setMaximized(await w.isMaximized());
  };

  return (
    <header
      data-tauri-drag-region
      className="drag-region flex h-8 shrink-0 items-center gap-2 border-b border-line bg-base-900 px-3 text-xs text-muted"
    >
      <VoxaMark size={15} className="text-ink" />
      <span className="font-semibold tracking-wide text-ink-soft">VOXA</span>
      <span className={`ml-1 size-1.5 rounded-full ${STATUS_COLOR[status]}`} />
      <span>{STATUS_LABEL[status]}</span>

      <div className="no-drag ml-auto flex items-center">
        <button
          onClick={() => void act("minimize")}
          className="grid h-8 w-11 place-items-center transition-colors hover:bg-base-700"
          title="Minimizar"
        >
          <Minus size={14} />
        </button>
        <button
          onClick={() => void act("toggleMaximize")}
          className="grid h-8 w-11 place-items-center transition-colors hover:bg-base-700"
          title="Maximizar"
        >
          {maximized ? <Copy size={12} /> : <Square size={11} />}
        </button>
        <button
          onClick={() => void act("close")}
          className="grid h-8 w-11 place-items-center transition-colors hover:bg-danger hover:text-white"
          title="Fechar"
        >
          <X size={15} />
        </button>
      </div>
    </header>
  );
}

export const TitleBar = memo(TitleBarBase);
