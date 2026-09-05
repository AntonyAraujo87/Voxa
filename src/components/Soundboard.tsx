import { memo, useCallback, useEffect, useRef, useState } from "react";
import { PartyPopper, Plus, X } from "lucide-react";
import { useApp } from "../store/store";
import { session } from "../lib/session";
import { SOUNDBOARD_CLIPS } from "../lib/soundboard";
import { listarSons, removerSom, salvarSom, MAX_SONS, type SomProprio } from "../lib/soundboardCustom";

/* ---------------------------------------------------------------------------
   Soundboard: um botao que abre a grade de efeitos. Cada clique toca pro
   canal de voz inteiro — quem apertou tambem ouve (bus de saida local) e os
   outros peers tambem (mixado na entrada do microfone, em session.ts).

   Alem dos efeitos que vem prontos, da pra adicionar arquivos proprios. Eles
   ficam so nesta maquina (IndexedDB) e nao sao enviados a ninguem: como o
   efeito e misturado no microfone antes de sair, os outros ouvem o som sem
   precisar ter o arquivo.
--------------------------------------------------------------------------- */

const EMOJIS = ["🔊", "😂", "🎉", "💥", "🐸", "👻", "🎺", "🔥"];

function SoundboardBase() {
  const [open, setOpen] = useState(false);
  const [meus, setMeus] = useState<SomProprio[]>([]);
  const [erro, setErro] = useState("");
  const micReady = useApp((s) => s.micReady);
  const fileRef = useRef<HTMLInputElement>(null);

  const recarregar = useCallback(() => {
    void listarSons().then(setMeus);
  }, []);

  useEffect(() => {
    if (open) recarregar();
  }, [open, recarregar]);

  const escolher = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const arquivo = e.target.files?.[0];
    e.target.value = ""; // sem isto, escolher o MESMO arquivo de novo nao dispara
    if (!arquivo) return;

    setErro("");
    try {
      // O nome do arquivo vira o rotulo: pedir para digitar um nome antes de
      // ouvir o som seria uma etapa a mais para nada.
      const nome = arquivo.name.replace(/\.[^.]+$/, "");
      const emoji = EMOJIS[meus.length % EMOJIS.length];
      await salvarSom(arquivo, nome, emoji);
      recarregar();
    } catch (err) {
      setErro((err as Error).message);
    }
  };

  const apagar = async (id: string, ev: React.MouseEvent) => {
    ev.stopPropagation(); // nao tocar o som ao clicar no X
    await removerSom(id);
    recarregar();
  };

  const todos = [...SOUNDBOARD_CLIPS, ...meus.map((m) => ({ id: m.id, label: m.label, emoji: m.emoji }))];

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
        <div className="absolute bottom-full left-0 z-30 mb-1 w-full rounded-md border border-line bg-base-900 p-2 shadow-xl">
          <div className="grid grid-cols-3 gap-1.5">
            {todos.map((clip) => (
              <button
                key={clip.id}
                onClick={() => session.playSoundboard(clip.id)}
                title={clip.label}
                className="group relative flex flex-col items-center gap-0.5 rounded py-1.5 text-[10px] text-muted transition-colors hover:bg-base-500 hover:text-ink-soft"
              >
                <span className="text-base leading-none">{clip.emoji}</span>
                <span className="w-full truncate px-1">{clip.label}</span>

                {clip.id.startsWith("meu:") && (
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={`Remover ${clip.label}`}
                    onClick={(ev) => void apagar(clip.id, ev)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter") void apagar(clip.id, ev as unknown as React.MouseEvent);
                    }}
                    className="absolute -right-0.5 -top-0.5 hidden size-4 place-items-center rounded-full bg-danger text-white group-hover:grid"
                  >
                    <X size={9} />
                  </span>
                )}
              </button>
            ))}

            {meus.length < MAX_SONS && (
              <button
                onClick={() => fileRef.current?.click()}
                title="Adicionar um som seu"
                className="flex flex-col items-center gap-0.5 rounded border border-dashed border-line py-1.5 text-[10px] text-faint transition-colors hover:border-brand hover:text-brand"
              >
                <Plus size={16} />
                Adicionar
              </button>
            )}
          </div>

          <input
            ref={fileRef}
            type="file"
            accept="audio/mpeg,audio/wav,audio/ogg,audio/mp4,audio/x-m4a,audio/*"
            onChange={(e) => void escolher(e)}
            className="hidden"
          />

          {erro && <p className="mt-1.5 px-1 text-[10px] text-danger">{erro}</p>}

          <p className="mt-1.5 px-1 text-[10px] leading-tight text-faint">
            Seus sons ficam só neste computador. Os outros ouvem porque o efeito entra junto do
            seu microfone.
          </p>
        </div>
      )}
    </div>
  );
}

export const Soundboard = memo(SoundboardBase);
