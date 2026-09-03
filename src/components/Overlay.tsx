import { useEffect, useState } from "react";
import { MicOff } from "lucide-react";
import { listenEvent } from "../lib/desktop";

/* ---------------------------------------------------------------------------
   Janela flutuante, por cima do jogo — so mostra quem esta no canal de voz
   agora e quem esta falando. Roda num processo de WebView totalmente
   separado da janela principal (ver overlay.rs): nao tem store, nao tem
   sessao, nao sabe de nada por conta propria. O unico dado que chega e o
   evento "overlay:roster", emitido pela janela principal (App.tsx) sempre
   que o roster do canal atual muda.

   Clique atravessa pra baixo (set_ignore_cursor_events no Rust) — e so um
   indicador visual, ninguem interage com ele.
--------------------------------------------------------------------------- */

export interface OverlayPeer {
  id: string;
  name: string;
  color: string;
  speaking: boolean;
  muted: boolean;
}

export function Overlay() {
  const [peers, setPeers] = useState<OverlayPeer[]>([]);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    void listenEvent<OverlayPeer[]>("overlay:roster", setPeers).then((off) => {
      dispose = off;
    });
    return () => dispose?.();
  }, []);

  // So em dev: fora do app empacotado nao ha janela Tauri de verdade pra
  // emitir o evento, entao nao ha como ver o overlay sem isso.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as Record<string, unknown>).__voxaOverlayDebug = setPeers;
  }, []);

  if (peers.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 p-2">
      {peers.map((p) => (
        <div
          key={p.id}
          className="flex items-center gap-2 rounded-md bg-black/55 px-2 py-1.5 backdrop-blur-sm"
        >
          <span
            className={`grid size-6 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white ${
              p.speaking ? "ring-2 ring-online" : ""
            }`}
            style={{ background: p.color }}
          >
            {p.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-white">
            {p.name}
          </span>
          {p.muted && <MicOff size={12} className="shrink-0 text-red-400" />}
        </div>
      ))}
    </div>
  );
}
