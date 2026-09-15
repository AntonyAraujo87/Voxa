import { useDialogFocus } from "../lib/useDialogFocus";
import { memo, useEffect, useState } from "react";
import { AppWindow, Monitor, RotateCw, X } from "lucide-react";
import { useApp } from "../store/store";
import { session } from "../lib/session";
import {
  getActiveCaptureSource,
  listCaptureSources,
  relaunchApp,
  setCaptureSource,
  type CaptureSource,
} from "../lib/desktop";

/* ---------------------------------------------------------------------------
   Escolher o que compartilhar — antes de começar a transmitir, não depois.

   O WebView2 não tem o seletor nativo do Chrome (aquele com abas "Tela
   inteira / Janela / Aba"). A fonte que ele captura vira um argumento de
   linha de comando do Chromium, lido uma única vez quando o processo nasce
   — não dá pra trocar em tempo real, só reiniciando. Este seletor contorna
   isso: se a fonte escolhida já é a que está ativa, some sem interromper e
   a transmissão começa; se for outra, salva a escolha e propõe reiniciar
   agora, deixando claro o porquê em vez de fingir que é instantâneo.
--------------------------------------------------------------------------- */

function SharePickerBase() {
  const open = useApp((s) => s.showSharePicker);
  const dialog = useDialogFocus(open, () => useApp.setState({ showSharePicker: false }));
  const systemAudio = useApp((s) => s.systemAudio);
  const audioMode = useApp((s) => s.systemAudioMode);
  const audioProcessId = useApp((s) => s.audioProcessId);
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [active, setActive] = useState("");
  const [carregando, setCarregando] = useState(true);
  /** titulo escolhido que so vale depois de reiniciar, ou null se nao houver */
  const [pendente, setPendente] = useState<string | null>(null);
  const [reiniciando, setReiniciando] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setCarregando(true);
    setPendente(null);
    Promise.all([listCaptureSources(), getActiveCaptureSource()]).then(([list, current]) => {
      if (!alive) return;
      setSources(list ?? []);
      setActive(current ?? "");
      setCarregando(false);
    });
    return () => { alive = false; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") fechar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  const fechar = () => useApp.setState({ showSharePicker: false });

  const escolher = async (fonte: CaptureSource) => {
    if (fonte.id === active) {
      fechar();
      await session.startShare();
      return;
    }
    // Diferente da que esta ativa: grava, mas so vale no proximo boot.
    await setCaptureSource(fonte.id);
    setPendente(fonte.label);
  };

  const reiniciarAgora = async () => {
    setReiniciando(true);
    await relaunchApp();
  };

  return (
    <div ref={dialog} role="dialog" aria-modal="true" aria-label="Escolher fonte de transmissao" tabIndex={-1}
      className="absolute inset-0 z-50 grid place-items-center bg-black/60 p-6"
      onClick={fechar}
    >
      <div
        className="animate-pop flex max-h-[80%] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-line bg-base-600 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex h-12 shrink-0 items-center border-b border-line px-5">
          <h2 className="font-semibold text-ink">O que você quer compartilhar?</h2>
          <button
            onClick={fechar}
            className="ml-auto grid size-8 place-items-center rounded text-muted hover:bg-base-500 hover:text-ink"
          >
            <X size={18} />
          </button>
        </header>

        {pendente ? (
          <div className="p-5">
            <p className="text-sm text-ink-soft">
              <b className="text-ink">{pendente}</b> foi salvo, mas só é aplicado no próximo
              início do Voxa — o WebView2 lê a fonte de captura uma vez só, quando o app abre.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => void reiniciarAgora()}
                disabled={reiniciando}
                className="flex flex-1 items-center justify-center gap-2 rounded-md bg-brand py-2 text-sm font-semibold text-white transition-colors enabled:hover:bg-brand-hover disabled:opacity-60"
              >
                <RotateCw size={15} className={reiniciando ? "animate-spin" : ""} />
                {reiniciando ? "Reiniciando..." : "Reiniciar agora"}
              </button>
              <button
                onClick={fechar}
                className="rounded-md bg-base-500 px-4 py-2 text-sm text-ink-soft transition-colors hover:bg-base-400"
              >
                Depois
              </button>
            </div>
            <p className="mt-3 text-center text-[11px] text-faint">
              Você volta pra tela inicial e entra de novo — o nome e a cor continuam salvos.
            </p>
          </div>
        ) : (
          <div className="overflow-y-auto p-3">
            <label className="mb-3 flex items-start gap-2 rounded-md bg-base-500/50 p-3 text-sm text-ink-soft">
              <input type="checkbox" checked={systemAudio}
                onChange={(event) => session.setSystemAudio(event.target.checked)} />
              <span>Compartilhar som do computador
                <span className="block text-xs text-muted">Escolha abaixo quais aplicativos entram no som da transmissao.</span>
              </span>
            </label>
            {systemAudio && <div className="mb-3 space-y-2 rounded-md bg-base-500/50 p-3 text-sm text-ink-soft">
              <label className="block">Origem do som
                <select aria-label="Origem do som da transmissao" value={audioMode}
                  onChange={event => session.setSystemAudioMode(event.target.value as typeof audioMode)}
                  className="mt-1 w-full rounded bg-base-700 p-2">
                  <option value="system">Computador inteiro (inclui chamadas)</option>
                  <option value="exclude-voxa">Computador sem o som do Voxa</option>
                  <option value="application">Somente um jogo ou aplicativo</option>
                </select>
              </label>
              {audioMode === "application" && <label className="block">Aplicativo para capturar audio
                <select aria-label="Aplicativo para capturar audio" value={audioProcessId ?? ""}
                  onChange={event => useApp.setState({ audioProcessId: event.target.value ? Number(event.target.value) : null })}
                  className="mt-1 w-full rounded bg-base-700 p-2">
                  <option value="">Selecione o jogo ou aplicativo</option>
                  {sources.filter(source => source.process_id).map(source => <option key={`${source.id}:${source.process_id}`} value={source.process_id!}>{source.label}</option>)}
                </select>
              </label>}
              {audioMode !== "system" && <p className="text-xs text-muted">Requer Windows build 20348 ou posterior. Se indisponivel, a tela continua sem som; a captura nao muda para o computador inteiro.</p>}
            </div>}
            {carregando ? (
              <p className="p-4 text-center text-sm text-muted">carregando fontes...</p>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {sources.map((fonte) => (
                  <button
                    key={`${fonte.id || "monitor"}:${fonte.process_id ?? 0}`}
                    disabled={systemAudio && audioMode === "application" && !audioProcessId}
                    onClick={() => void escolher(fonte)}
                    className={`flex flex-col items-center gap-2 rounded-lg border p-4 text-center transition-colors ${
                      fonte.id === active
                        ? "border-brand bg-brand/15"
                        : "border-transparent bg-base-500/50 hover:bg-base-500"
                    }`}
                  >
                    <div className="grid size-12 place-items-center rounded-md bg-base-700">
                      {fonte.kind === "monitor" ? (
                        <Monitor size={22} className="text-ink-soft" />
                      ) : (
                        <AppWindow size={22} className="text-ink-soft" />
                      )}
                    </div>
                    <span className="line-clamp-2 text-xs text-ink-soft">{fonte.label}</span>
                    {fonte.id === active && (
                      <span className="text-[10px] font-medium text-brand">ativo agora</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export const SharePicker = memo(SharePickerBase);
