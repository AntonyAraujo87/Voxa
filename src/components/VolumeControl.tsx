import { createPortal } from "react-dom";
import { memo, useState, useEffect, useRef } from "react";
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

/** Acima disso a saida ja pode estourar (clipping) — aviso, nao limite. */
const LIMIAR_ESTOURO = 1.5;

function VolumeControlBase({ volume, onChange, title, size = 14, className = "" }: Props) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({top:0,left:0});
  useEffect(() => {
    if (!open) return;
    const place = () => { const rect=button.current?.getBoundingClientRect(); if(rect) setPosition({top:Math.max(8,Math.min(rect.bottom+4,window.innerHeight-100)),left:Math.max(8,Math.min(rect.right-176,window.innerWidth-184))}); };
    const outside = (event: PointerEvent) => { if (!button.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if(event.key === "Escape") {setOpen(false);button.current?.focus();} };
    place(); popup.current?.querySelector("input")?.focus();
    window.addEventListener("resize",place);window.addEventListener("scroll",place,true);document.addEventListener("pointerdown",outside);document.addEventListener("keydown",escape);
    return () => {window.removeEventListener("resize",place);window.removeEventListener("scroll",place,true);document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape);};
  },[open]);
  const Icon = volume === 0 ? VolumeX : volume < 0.7 ? Volume1 : Volume2;
  const estourando = volume > LIMIAR_ESTOURO;

  return (
    <div className="relative flex items-center" onClick={(e) => e.stopPropagation()}>
      <button ref={button} aria-label={title ?? "Ajustar volume"} aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={title ?? `Volume: ${Math.round(volume * 100)}%`}
        className={`grid place-items-center rounded transition-colors hover:bg-base-400 ${
          volume === 0
            ? "text-danger"
            : estourando
              ? "text-warn"
              : volume === 1
                ? "text-faint"
                : "text-brand"
        } ${className}`}
        style={{ width: size + 10, height: size + 10 }}
      >
        <Icon size={size} />
      </button>

      {open && createPortal(
        <div ref={popup} style={position} className="fixed z-[70] w-44 rounded-md border border-line bg-base-900 px-3 py-2 shadow-xl">
          <div className="flex items-center gap-2">
            {/* Vai ate 200%: HTMLMediaElement.volume trava em 100% por
                especificacao do HTML, entao o audio passa por um GainNode do
                WebAudio — so assim da pra amplificar de verdade acima disso. */}
            <input
              type="range"
              aria-label={title ?? "Volume"}
              min={0}
              max={2}
              step={0.05}
              value={volume}
              onChange={(e) => onChange(Number(e.target.value))}
              className="h-1 flex-1 accent-brand"
            />
            <span
              className={`w-10 text-right font-mono text-[11px] ${estourando ? "text-warn" : "text-muted"}`}
            >
              {Math.round(volume * 100)}%
            </span>
          </div>
          {estourando && (
            <p className="mt-1 text-[10px] text-warn">acima disso pode distorcer</p>
          )}
        </div>, document.body
      )}
    </div>
  );
}

export const VolumeControl = memo(VolumeControlBase);
