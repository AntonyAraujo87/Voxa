import { memo, useMemo } from "react";
import { Activity, MonitorUp } from "lucide-react";
import { useApp } from "../store/store";
import { session } from "../lib/session";
import { VideoTile } from "./VideoTile";
import { RemoteAudio } from "./RemoteAudio";

/** colunas por quantidade — evita CSS grid auto-fit, que reflow a cada resize */
function columns(n: number) {
  if (n <= 1) return "grid-cols-1";
  if (n <= 4) return "grid-cols-2";
  if (n <= 9) return "grid-cols-3";
  return "grid-cols-4";
}

function StageGridBase() {
  const activeVoice = useApp((s) => s.activeVoice);
  const roster = useApp((s) => s.roster);
  const selfId = useApp((s) => s.selfSocketId);
  const sharing = useApp((s) => s.sharing);
  const selfMuted = useApp((s) => s.muted);
  const speaking = useApp((s) => s.speaking);
  const focusPeer = useApp((s) => s.focusPeer);
  const showStats = useApp((s) => s.showStats);

  const members = useMemo(
    () => roster.filter((r) => r.voice === activeVoice),
    [roster, activeVoice]
  );

  if (!activeVoice) return null;

  const anyScreen = members.some((m) => (m.id === selfId ? sharing : m.state.sharing));
  const focused = focusPeer && members.some((m) => m.id === focusPeer) ? focusPeer : null;
  const thumbs = focused ? members.filter((m) => m.id !== focused) : [];
  const focusedMember = focused ? members.find((m) => m.id === focused) : null;

  const tileOf = (m: (typeof members)[number], isFocus = false) => (
    <VideoTile
      key={m.id}
      peerId={m.id}
      name={m.user.name}
      color={m.user.color}
      isSelf={m.id === selfId}
      muted={m.id === selfId ? selfMuted : m.state.muted}
      speaking={!!speaking[m.id]}
      focused={isFocus}
      hasScreen={m.id === selfId ? sharing : m.state.sharing}
    />
  );

  return (
    <section className="relative flex min-h-0 flex-1 flex-col bg-base-800">
      <RemoteAudio />

      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3 text-sm text-muted">
        <span className="font-medium text-ink-soft">
          {members.length} na chamada
        </span>
        {anyScreen && (
          <span className="flex items-center gap-1 rounded bg-stream/15 px-1.5 py-0.5 text-xs text-stream">
            <MonitorUp size={12} /> transmitindo
          </span>
        )}
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
            sharing ? "bg-danger/90 text-white" : "bg-base-600 text-ink-soft hover:bg-base-500"
          }`}
        >
          {sharing ? "parar" : "compartilhar"}
        </button>
      </div>

      {focused && focusedMember ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
          <div className="min-h-0 flex-1">{tileOf(focusedMember, true)}</div>
          {thumbs.length > 0 && (
            <div className="flex h-24 shrink-0 gap-2 overflow-x-auto">
              {thumbs.map((m) => (
                <div key={m.id} className="aspect-video h-full shrink-0">
                  {tileOf(m)}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className={`grid min-h-0 flex-1 gap-2 p-2 ${columns(members.length)}`}>
          {members.map((m) => tileOf(m))}
        </div>
      )}
    </section>
  );
}

export const StageGrid = memo(StageGridBase);
