import { memo, useEffect, useMemo } from "react";
import { Activity, Camera, MonitorUp, Radio, X } from "lucide-react";
import { useApp } from "../store/store";
import { session } from "../lib/session";
import { VideoTile } from "./VideoTile";

/* ---------------------------------------------------------------------------
   Area de transmissao — nao invasiva por padrao.

   Regra central: enquanto ninguem esta compartilhando tela, isto nao mostra
   NADA — a chamada de voz e o chat ocupam o espaco inteiro, exatamente como
   a maioria das chamadas passa a maior parte do tempo. Quando alguem comeca
   a transmitir, aparece so uma faixa fina avisando; quem quiser assiste.

   O audio (voz + audio da transmissao) NAO depende deste componente — mora
   em <RemoteAudio/>, sempre montado enquanto se esta no canal, em App.tsx.
   Sem essa separacao, ninguem ouviria ninguem enquanto nao houvesse tela
   compartilhada, porque este componente ficaria desmontado o tempo todo.
--------------------------------------------------------------------------- */

function nomesDeQuemTransmite(nomes: string[]): string {
  if (nomes.length === 1) return nomes[0];
  if (nomes.length === 2) return `${nomes[0]} e ${nomes[1]}`;
  return `${nomes.slice(0, -1).join(", ")} e ${nomes[nomes.length - 1]}`;
}

/** "esta transmitindo" so quando todos sao tela; "ligou a camera" so quando
 *  todos sao camera; misto cai num rotulo neutro. */
function rotuloDeQuemTransmite(kinds: ("tela" | "camera" | null)[]): string {
  const plural = kinds.length > 1;
  if (kinds.every((k) => k === "camera")) return plural ? "ligaram a câmera" : "ligou a câmera";
  if (kinds.every((k) => k === "tela")) return plural ? "estão transmitindo" : "está transmitindo";
  return plural ? "estão ao vivo" : "está ao vivo";
}

/** Faixa fina: "Fulano esta transmitindo" + botao para abrir a grade. */
const LiveBanner = memo(function LiveBanner({
  names,
  kinds,
}: {
  names: string[];
  kinds: ("tela" | "camera" | null)[];
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-line bg-stream/10 px-3 py-2">
      <span className="relative flex size-2 shrink-0">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-stream opacity-75" />
        <span className="relative inline-flex size-2 rounded-full bg-stream" />
      </span>
      <span className="min-w-0 truncate text-[13px] text-ink-soft">
        <b className="text-ink">{nomesDeQuemTransmite(names)}</b> {rotuloDeQuemTransmite(kinds)}
      </span>
      <button
        onClick={() => useApp.setState({ watchingLive: true })}
        className="ml-auto flex shrink-0 items-center gap-1.5 rounded bg-stream px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-stream/80"
      >
        <Radio size={12} />
        Assistir
      </button>
    </div>
  );
});

function StageGridBase() {
  const activeVoice = useApp((s) => s.activeVoice);
  const roster = useApp((s) => s.roster);
  const selfId = useApp((s) => s.selfSocketId);
  const sharing = useApp((s) => s.sharing);
  const sharingKind = useApp((s) => s.sharingKind);
  const selfMuted = useApp((s) => s.muted);
  const speaking = useApp((s) => s.speaking);
  const focusPeer = useApp((s) => s.focusPeer);
  const showStats = useApp((s) => s.showStats);
  const watchingLive = useApp((s) => s.watchingLive);

  const members = useMemo(
    () => roster.filter((r) => r.voice === activeVoice),
    [roster, activeVoice]
  );

  const streamers = useMemo(
    () => members.filter((m) => (m.id === selfId ? sharing : m.state.sharing)),
    [members, selfId, sharing]
  );

  const kindOf = (m: (typeof streamers)[number]): "tela" | "camera" | null =>
    m.id === selfId ? sharingKind : m.state.sharingKind;

  // Comecar a propria transmissao abre a grade sozinho — faz sentido ver a
  // propria previa na hora. Transmissao de outra pessoa nunca abre sozinha:
  // so a faixa fina aparece, e quem quiser clica em "Assistir".
  useEffect(() => {
    if (sharing) useApp.setState({ watchingLive: true });
  }, [sharing]);

  // Ninguem mais transmitindo: fecha a grade e solta o foco, senao a proxima
  // pessoa a compartilhar reabriria direto na visao ampliada de quem ja saiu.
  useEffect(() => {
    if (streamers.length === 0) useApp.setState({ watchingLive: false, focusPeer: null });
  }, [streamers.length]);

  if (!activeVoice || streamers.length === 0) return null;

  if (!watchingLive) {
    return (
      <LiveBanner
        names={streamers.map((m) => m.user.name)}
        kinds={streamers.map(kindOf)}
      />
    );
  }

  const focused = focusPeer && streamers.some((m) => m.id === focusPeer) ? focusPeer : null;
  const focusedMember = focused ? streamers.find((m) => m.id === focused) : undefined;
  const thumbs = focused ? streamers.filter((m) => m.id !== focused) : streamers;

  const tileOf = (m: (typeof streamers)[number], opts: { focused?: boolean; onClick?: () => void; onBack?: () => void } = {}) => (
    <VideoTile
      key={m.id}
      peerId={m.id}
      userId={m.user.id}
      name={m.user.name}
      color={m.user.color}
      isSelf={m.id === selfId}
      muted={m.id === selfId ? selfMuted : m.state.muted}
      speaking={!!speaking[m.id]}
      focused={!!opts.focused}
      hasScreen
      kind={kindOf(m) ?? "tela"}
      onClick={opts.onClick}
      onBack={opts.onBack}
    />
  );

  return (
    <section className="relative flex min-h-0 flex-1 flex-col bg-base-800">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3 text-sm text-muted">
        <MonitorUp size={14} className="text-stream" />
        <span className="font-medium text-ink-soft">
          {streamers.length} {streamers.length > 1 ? "transmissões" : "transmissão"}
        </span>
        <button
          onClick={() => useApp.setState({ showStats: !showStats })}
          className={`ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors hover:bg-base-600 ${
            showStats ? "text-online" : "text-muted"
          }`}
          title="Overlay de metricas (fps, bitrate, ping)"
        >
          <Activity size={13} /> metricas
        </button>
        <button
          onClick={() => void session.toggleShare()}
          className={`rounded px-2 py-1 text-xs transition-colors ${
            sharingKind === "tela" ? "bg-danger/90 text-white" : "bg-base-600 text-ink-soft hover:bg-base-500"
          }`}
        >
          {sharingKind === "tela" ? "parar" : "compartilhar"}
        </button>
        <button
          onClick={() => session.toggleWebcam()}
          className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors ${
            sharingKind === "camera" ? "bg-danger/90 text-white" : "bg-base-600 text-ink-soft hover:bg-base-500"
          }`}
        >
          <Camera size={12} />
          {sharingKind === "camera" ? "parar câmera" : "câmera"}
        </button>
        <button
          onClick={() => useApp.setState({ watchingLive: false, focusPeer: null })}
          className="grid size-7 place-items-center rounded text-muted transition-colors hover:bg-base-600 hover:text-ink"
          title="Ocultar transmissões"
        >
          <X size={14} />
        </button>
      </div>

      {focused && focusedMember ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
          <div className="min-h-0 flex-1">
            {tileOf(focusedMember, {
              focused: true,
              onBack: () => useApp.setState({ focusPeer: null }),
            })}
          </div>
          {thumbs.length > 0 && (
            <div className="flex h-24 shrink-0 gap-2 overflow-x-auto">
              {thumbs.map((m) => (
                <div key={m.id} className="aspect-video h-full shrink-0">
                  {tileOf(m, { onClick: () => useApp.setState({ focusPeer: m.id }) })}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        // Grade so de miniaturas de quem transmite — ninguem que so esta de
        // voz aparece aqui, essa pessoa ja tem seu lugar na lista ao lado.
        <div className="flex flex-wrap content-start gap-3 overflow-y-auto p-3">
          {streamers.map((m) => (
            <div key={m.id} className="aspect-video w-56 shrink-0">
              {tileOf(m, { onClick: () => useApp.setState({ focusPeer: m.id }) })}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export const StageGrid = memo(StageGridBase);
