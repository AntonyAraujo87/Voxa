import { memo, useEffect, useState } from "react";
import { Keyboard, X } from "lucide-react";
import { useApp } from "../../store/store";
import { session } from "../../lib/session";
import { getHotkeyStatus, isDesktop, type HotkeyStatus, type RebindCombo } from "../../lib/desktop";
import { Section } from "./Primitives";

/* ---------------------------------------------------------------------------
   Secao de atalhos globais — a unica das configuracoes com maquina de estado
   propria (capturar tecla, aplicar, reverter em erro), o que justificava tirar
   do modal: eram ~180 linhas de logica que nao tinham nada a ver com as
   outras secoes, todas simples select/toggle.

   O status vem do Rust, nao daqui: o registro de atalho global e exclusivo do
   sistema e pode falhar (outro programa ja usa a tecla). Quem manda no que
   aparece na tela e sempre a resposta de la.
--------------------------------------------------------------------------- */

export type HotkeyAction = "mute" | "deafen" | "share" | "talk";

const MODIFICADORES = new Set([
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

/** "KeyM" -> "M", "Digit5" -> "5", "Space" -> "Espaço" — o resto (F1..F12,
 *  setas ja com nome curto) passa direto. */
function nomeDaTecla(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  switch (code) {
    case "Space":
      return "Espaço";
    case "Escape":
      return "Esc";
    case "ArrowUp":
      return "↑";
    case "ArrowDown":
      return "↓";
    case "ArrowLeft":
      return "←";
    case "ArrowRight":
      return "→";
    default:
      return code;
  }
}

function rotuloDoCombo(code: string, ctrl: boolean, shift: boolean, alt: boolean): string {
  const partes: string[] = [];
  if (ctrl) partes.push("Ctrl");
  if (shift) partes.push("Shift");
  if (alt) partes.push("Alt");
  partes.push(nomeDaTecla(code));
  return partes.join("+");
}

function HotkeyRow({
  label,
  combo,
  capturando,
  onCapture,
  onRemove,
}: {
  label: string;
  combo: string | null | undefined;
  capturando: boolean;
  onCapture: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-muted">{label}</span>
      <div className="flex items-center gap-1.5">
        {capturando ? (
          <kbd className="animate-pulse rounded bg-brand/20 px-1.5 py-0.5 font-mono text-[11px] text-brand">
            pressione uma tecla (Esc cancela)
          </kbd>
        ) : combo ? (
          <kbd className="rounded bg-base-700 px-1.5 py-0.5 font-mono text-[11px] text-ink-soft">
            {combo}
          </kbd>
        ) : (
          <span className="text-[11px] text-faint">nao configurado</span>
        )}
        <button
          onClick={onCapture}
          disabled={capturando}
          className="rounded px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-base-500 hover:text-ink-soft disabled:opacity-50"
        >
          trocar
        </button>
        {combo && !capturando && (
          <button
            onClick={onRemove}
            title="remover atalho"
            className="grid size-5 place-items-center rounded text-muted transition-colors hover:bg-base-500 hover:text-danger"
          >
            <X size={11} />
          </button>
        )}
      </div>
    </div>
  );
}

const LINHAS: { acao: HotkeyAction; label: string }[] = [
  { acao: "mute", label: "Microfone" },
  { acao: "deafen", label: "Ensurdecer" },
  { acao: "share", label: "Compartilhar tela" },
  { acao: "talk", label: "Falar (push-to-talk)" },
];

function HotkeysSectionBase({ open }: { open: boolean }) {
  const [atalhos, setAtalhos] = useState<HotkeyStatus | null>(null);
  const [capturando, setCapturando] = useState<HotkeyAction | null>(null);

  useEffect(() => {
    if (!open || !isDesktop) return;
    void getHotkeyStatus().then(setAtalhos);
  }, [open]);

  const aplicar = async (action: HotkeyAction, combo: RebindCombo) => {
    try {
      setAtalhos(await session.rebindHotkey(action, combo));
    } catch (err) {
      useApp.getState().toast("error", (err as Error).message);
    }
  };

  const remover = (action: HotkeyAction) =>
    void aplicar(action, { code: null, ctrl: false, shift: false, alt: false, label: null });

  // Captura em fase de "capture" e para a propagacao: precisa vencer o
  // listener de Escape do proprio modal (Escape aqui cancela a captura, nao
  // fecha a janela) e nao pode deixar a tecla vazar pro resto da pagina.
  useEffect(() => {
    if (!capturando) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (MODIFICADORES.has(e.code)) return; // modificador sozinho ainda nao e atalho
      if (e.code === "Escape") {
        setCapturando(null);
        return;
      }
      const acao = capturando;
      setCapturando(null);
      void aplicar(acao, {
        code: e.code,
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey,
        label: rotuloDoCombo(e.code, e.ctrlKey, e.shiftKey, e.altKey),
      });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturando]);

  return (
    <Section icon={<Keyboard size={13} />} title="Atalhos globais">
      <div className="rounded-md bg-base-500/50 px-3 py-1 text-xs">
        {LINHAS.map(({ acao, label }) => (
          <HotkeyRow
            key={acao}
            label={label}
            combo={atalhos?.[acao]}
            capturando={capturando === acao}
            onCapture={() => setCapturando(acao)}
            onRemove={() => remover(acao)}
          />
        ))}
      </div>
      <p className="mt-1 text-xs text-faint">
        Atalho global pertence a um programa so — se outro programa ja usa a tecla
        escolhida, o Voxa avisa e mantem a anterior. Push-to-talk nao aceita
        Ctrl/Shift/Alt: precisa ser uma tecla que da pra segurar sozinha o jogo inteiro.
      </p>
    </Section>
  );
}

export const HotkeysSection = memo(HotkeysSectionBase);
