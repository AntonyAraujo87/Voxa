import { memo, useMemo } from "react";
import { MicOff, ScreenShare, Volume2 } from "lucide-react";
import { useApp } from "../store/store";
import { Avatar } from "./Avatar";

/**
 * Ponto de saude da conexao com aquela pessoa.
 *
 * Existe porque, quando alguem picota, ninguem sabe de quem e o problema. O
 * ping so aparecia no overlay de metricas, que fica escondido atras de um
 * botao e so mostra quem esta com a tela aberta.
 */
const HealthDot = memo(function HealthDot({ peerId }: { peerId: string }) {
  const stats = useApp((s) => s.stats[peerId]);
  const conn = useApp((s) => s.connState[peerId]);

  if (!conn) return null;

  const reconectando = conn === "disconnected" || conn === "failed";
  const rtt = stats?.rttMs ?? 0;
  const perda = stats?.lossPct ?? 0;

  const ruim = reconectando || perda > 5 || rtt > 200;
  const atencao = perda > 1.5 || rtt > 90;

  const cor = ruim ? "bg-danger" : atencao ? "bg-warn" : "bg-online";
  const titulo = reconectando ? "reconectando" : `${rtt || "?"}ms · perda ${perda.toFixed(1)}%`;

  return (
    <span
      title={titulo}
      className={`size-2 shrink-0 rounded-full ${cor} ${reconectando ? "animate-pulse" : ""}`}
    />
  );
});

/**
 * Lista pura de quem esta no servidor — sem controles de audio.
 *
 * Ajustar volume e coisa de canal de voz (ao lado de quem esta falando, na
 * barra esquerda) ou de transmissao (no proprio video); aqui e so presenca:
 * quem esta online, em qual canal, e se esta mudo ou transmitindo.
 */
function MemberListBase() {
  const roster = useApp((s) => s.roster);
  const speaking = useApp((s) => s.speaking);
  const channels = useApp((s) => s.channels);

  const { inVoice, idle } = useMemo(
    () => ({
      inVoice: roster.filter((r) => r.voice),
      idle: roster.filter((r) => !r.voice),
    }),
    [roster]
  );

  const channelName = (id: string | null) => channels.find((c) => c.id === id)?.name ?? id ?? "";

  const Row = ({
    id,
    name,
    color,
    voice,
    muted,
    sharing,
  }: {
    id: string;
    name: string;
    color: string;
    voice: string | null;
    muted: boolean;
    sharing: boolean;
  }) => (
    <div className="flex items-center gap-2 rounded px-2 py-1 hover:bg-base-500/50">
      <Avatar name={name} color={color} size={32} speaking={!!speaking[id]} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] text-ink-soft">{name}</p>
        {voice && (
          <p className="flex items-center gap-1 truncate text-[11px] text-muted">
            <Volume2 size={11} /> {channelName(voice)}
          </p>
        )}
      </div>
      {voice && <HealthDot peerId={id} />}
      {sharing && <ScreenShare size={13} className="text-stream" />}
      {muted && <MicOff size={13} className="text-danger" />}
    </div>
  );

  return (
    <aside className="w-60 shrink-0 overflow-y-auto bg-base-700 px-2 py-4">
      {inVoice.length > 0 && (
        <>
          <p className="mb-1 px-2 text-[11px] font-bold uppercase tracking-wide text-faint">
            Em voz — {inVoice.length}
          </p>
          {inVoice.map((r) => (
            <Row
              key={r.id}
              id={r.id}
              name={r.user.name}
              color={r.user.color}
              voice={r.voice}
              muted={r.state.muted}
              sharing={r.state.sharing}
            />
          ))}
        </>
      )}

      <p className="mb-1 mt-4 px-2 text-[11px] font-bold uppercase tracking-wide text-faint">
        Online — {idle.length}
      </p>
      {idle.map((r) => (
        <Row
          key={r.id}
          id={r.id}
          name={r.user.name}
          color={r.user.color}
          voice={null}
          muted={r.state.muted}
          sharing={false}
        />
      ))}
    </aside>
  );
}

export const MemberList = memo(MemberListBase);
