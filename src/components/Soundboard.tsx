import { memo, useState } from "react";
import { PartyPopper } from "lucide-react";
import { useApp } from "../store/store";
import { session } from "../lib/session";
import { SOUNDBOARD_CLIPS } from "../lib/soundboard";

/* ---------------------------------------------------------------------------
   Soundboard: um botao que abre a grade de efeitos. Cada clique toca pro
   canal de voz inteiro — quem apertou tambem ouve (bus de saida local) e os
   outros peers tambem (mixado na entrada do microfone, em session.ts).
--------------------------------------------------------------------------- */

function SoundboardBase() {
  const [open, setOpen] = useState(false);
  const micReady = useApp((s) => s.micReady);

  const tocar = (id: string) => {
    session.playSoundboard(id);
  };

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={micReady ? "Soundboard" : "Precisa do microfone aberto pra tocar pros outros"}
        disabled={!micReady}
        className={`mt-1.5 flex w-full items-center justify-center gap-2 rounded py-1.5 text-sm font-medium transition-colors ${
          open
            ? "bg-brand/20 text-brand"
            : "bg-base-500 text-ink-soft hover:bg-base-400 disabled:opacity-50 disabled:hover:bg-base-500"
        }`}
      >
        <PartyPopper size={16} />
        Soundboard
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-1 grid w-full grid-cols-3 gap-1.5 rounded-md border border-line bg-base-900 p-2 shadow-xl">
          {SOUNDBOARD_CLIPS.map((clip) => (
            <button
              key={clip.id}
              onClick={() => tocar(clip.id)}
              title={clip.label}
              className="flex flex-col items-center gap-0.5 rounded py-1.5 text-[10px] text-muted transition-colors hover:bg-base-500 hover:text-ink-soft"
            >
              <span className="text-base leading-none">{clip.emoji}</span>
              {clip.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export const Soundboard = memo(SoundboardBase);
