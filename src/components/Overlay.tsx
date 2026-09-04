import { useCallback, useEffect, useState } from "react";
import { Check, MicOff, Move } from "lucide-react";
import {
  dragOverlay,
  emitEvent,
  getOverlayPosition,
  listenEvent,
  setOverlayMovable,
} from "../lib/desktop";

/* ---------------------------------------------------------------------------
   Janela flutuante, por cima do jogo — so mostra quem esta no canal de voz
   agora e quem esta falando. Roda num processo de WebView totalmente
   separado da janela principal (ver overlay.rs): nao tem store, nao tem
   sessao, nao sabe de nada por conta propria. O unico dado que chega e o
   evento "overlay:roster", emitido pela janela principal (App.tsx) sempre
   que o roster do canal atual muda.

   Clique atravessa pra baixo (set_ignore_cursor_events no Rust) — e so um
   indicador visual, ninguem interage com ele.

   A excecao e o MODO POSICIONAR: enquanto ele vale, a janela volta a
   receber clique pra poder ser arrastada. Como nesse estado o overlay fica
   no caminho do mouse, ele tem tres saidas independentes — o botao, a tecla
   Esc e desligar o overlay pelas Configuracoes.
--------------------------------------------------------------------------- */

export interface OverlayPeer {
  id: string;
  name: string;
  color: string;
  speaking: boolean;
  muted: boolean;
}

/** So aparece durante o modo posicionar, pra janela ter tamanho de verdade
 *  mesmo com ninguem no canal — senao a pessoa arrastaria uma tira fina e
 *  descobriria depois que o overlay real e maior e cobre outra coisa. */
const EXEMPLO: OverlayPeer[] = [
  { id: "_ex1", name: "Voce", color: "#5865F2", speaking: true, muted: false },
  { id: "_ex2", name: "Fulano", color: "#3BA55D", speaking: false, muted: true },
];

export function Overlay() {
  const [peers, setPeers] = useState<OverlayPeer[]>([]);
  const [posicionando, setPosicionando] = useState(false);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    void listenEvent<OverlayPeer[]>("overlay:roster", setPeers).then((off) => {
      dispose = off;
    });
    return () => dispose?.();
  }, []);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    void listenEvent<boolean>("overlay:posicionar", setPosicionando).then((off) => {
      dispose = off;
    });
    return () => dispose?.();
  }, []);

  // Esta janela nasce DEPOIS da principal, entao qualquer estado emitido
  // antes daqui se perdeu — inclusive o roster, que so e reenviado quando
  // muda. Sem este aviso, ligar o overlay no meio de uma conversa parada
  // mostrava uma janela vazia ate alguem falar, e pedir "posicionar" com o
  // overlay desligado abria uma janela que capturava clique sem explicar
  // por que. O `listen` acima ja esta registrado quando isto roda.
  useEffect(() => {
    void emitEvent("overlay:pronto", true);
  }, []);

  /** Fixa onde esta: le a posicao, destrava o clique de volta e avisa a
   *  janela principal, que e quem guarda as preferencias. */
  const fixar = useCallback(async () => {
    const pos = await getOverlayPosition();
    await setOverlayMovable(false);
    setPosicionando(false);
    if (pos) await emitEvent("overlay:posicionado", { x: pos[0], y: pos[1] });
    else await emitEvent("overlay:posicionado", null);
  }, []);

  // Saida de emergencia: se a janela for parar num canto onde o botao nao
  // da pra alcancar (fora da tela, atras da barra de tarefas), o Esc
  // devolve o clique pro jogo sem precisar reiniciar o app.
  useEffect(() => {
    if (!posicionando) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void fixar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [posicionando, fixar]);

  // Ultima rede de seguranca. Enquanto o modo posicionar vale, o overlay
  // come os cliques que iriam pro jogo — e o Esc so funciona com a janela
  // em foco, que e justamente o que se perde ao voltar pro jogo. Nenhum
  // posicionamento honesto leva tres minutos, entao passado esse tempo ele
  // se fixa sozinho em vez de ficar no caminho pra sempre.
  useEffect(() => {
    if (!posicionando) return;
    const t = window.setTimeout(() => void fixar(), 180_000);
    return () => window.clearTimeout(t);
  }, [posicionando, fixar]);

  // So em dev: fora do app empacotado nao ha janela Tauri de verdade pra
  // emitir o evento, entao nao ha como ver o overlay sem isso.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as Record<string, unknown>;
    w.__voxaOverlayDebug = setPeers;
    w.__voxaOverlayPosicionar = setPosicionando;
  }, []);

  const lista = posicionando && peers.length === 0 ? EXEMPLO : peers;

  if (!posicionando && lista.length === 0) return null;

  return (
    <div
      className={`flex flex-col gap-1 p-2 ${
        posicionando ? "cursor-move rounded-lg ring-2 ring-dashed ring-brand" : ""
      }`}
      // A janela inteira arrasta, nao so uma barra de titulo: ela e pequena
      // e quase toda ocupada pela lista, entao exigir mira numa alca seria
      // pior. O botao para a propagacao pra continuar clicavel.
      onPointerDown={posicionando ? () => void dragOverlay() : undefined}
    >
      {posicionando && (
        <div className="flex items-center gap-1.5 rounded-md bg-brand px-2 py-1.5 text-white">
          <Move size={12} className="shrink-0" />
          <span className="min-w-0 flex-1 text-[11px] font-medium leading-tight">
            Arraste pra onde quiser
          </span>
        </div>
      )}

      {lista.map((p) => (
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

      {posicionando && (
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => void fixar()}
          className="flex items-center justify-center gap-1.5 rounded-md bg-online px-2 py-1.5 text-[11px] font-semibold text-white hover:brightness-110"
        >
          <Check size={12} />
          Fixar aqui
          <span className="font-normal opacity-70">ou Esc</span>
        </button>
      )}
    </div>
  );
}
