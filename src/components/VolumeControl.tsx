import { memo, useState } from "react";
import { Volume1, Volume2, VolumeX } from "lucide-react";

/* ---------------------------------------------------------------------------
   Controle de volume generico: um icone que abre um slider.
   Usado em dois lugares com significados diferentes — volume da VOZ de
   alguem (canal de voz, na sidebar) e volume da TRANSMISSAO de tela de
   alguem (no tile de video) — por isso nao guarda estado proprio, so recebe
   o valor atual e devolve o novo.
--------------------------------------------------------------------------- */

interface Props {
  volume: number;
  onChange: (volume: number) => void;
  title?: string;
  size?: number;
  /** classe extra pro botao — para variar contraste sobre fundo claro/escuro */
  className?: string;
}

function VolumeControlBase({ volume, onChange, title, size = 14, className = "" }: Props) {
  const [open, setOpen] = useState(false);
  const Icon = volume === 0 ? VolumeX : volume < 0.7 ? Volume1 : Volume2;

  return (
    <div className="relative flex items-center" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={title ?? `Volume: ${Math.round(volume * 100)}%`}
        className={`grid place-items-center rounded transition-colors hover:bg-base-400 ${
          volume === 0 ? "text-danger" : volume === 1 ? "text-faint" : "text-brand"
        } ${className}`}
        style={{ width: size + 10, height: size + 10 }}
      >
        <Icon size={size} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 flex w-40 items-center gap-2 rounded-md border border-line bg-base-900 px-3 py-2 shadow-xl">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => onChange(Number(e.target.value))}
            className="h-1 flex-1 accent-brand"
          />
          <span className="w-8 text-right font-mono text-[11px] text-muted">
            {Math.round(volume * 100)}
          </span>
        </div>
      )}
    </div>
  );
}

export const VolumeControl = memo(VolumeControlBase);
