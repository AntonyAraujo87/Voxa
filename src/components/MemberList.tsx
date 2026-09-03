import { memo, useMemo, useState } from "react";
import { MicOff, ScreenShare, Volume1, Volume2, VolumeX } from "lucide-react";
import { useApp } from "../store/store";
import { Avatar } from "./Avatar";

const VolumeControl = memo(function VolumeControl({ userId }: { userId: string }) {
  const volume = useApp((s) => s.volumes[userId] ?? 1);
  const setVolume = useApp((s) => s.setVolume);
  const [open, setOpen] = useState(false);

  const Icon = volume === 0 ? VolumeX : volume < 0.7 ? Volume1 : Volume2;

  return (
    <div className="relative flex items-center">
      <button
        onClick={() => setOpen((v) => !v)}
        title={`Volume: ${Math.round(volume * 100)}%`}
        className={`grid size-6 place-items-center rounded transition-colors hover:bg-base-400 ${
          volume === 0 ? "text-danger" : volume === 1 ? "text-faint" : "text-brand"
        }`}
      >
        <Icon size={14} />
      </button>

      {open && (
        <div className="absolute right-0 top-7 z-20 flex w-40 items-center gap-2 rounded-md border border-line bg-base-900 px-3 py-2 shadow-xl">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => setVolume(userId, Number(e.target.value))}
            className="h-1 flex-1 accent-brand"
          />
          <span className="w-8 text-right font-mono text-[11px] text-muted">
            {Math.round(volume * 100)}
          </span>
        </div>
      )}
    </div>
  );
});

function MemberListBase() {
  const roster = useApp((s) => s.roster);
  const speaking = useApp((s) => s.speaking);
  const channels = useApp((s) => s.channels);
  const selfId = useApp((s) => s.selfSocketId);

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
    userId,
    name,
    color,
    voice,
    muted,
    sharing,
  }: {
    id: string;
    userId: string;
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
      {sharing && <ScreenShare size={13} className="text-stream" />}
      {muted && <MicOff size={13} className="text-danger" />}
      {voice && id !== selfId && <VolumeControl userId={userId} />}
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
              userId={r.user.id}
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
          userId={r.user.id}
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
