import { memo, useMemo } from "react";
import {
  ChevronDown,
  Hash,
  Headphones,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  ScreenShare,
  Settings,
  Signal,
  Volume2,
  HeadphoneOff,
} from "lucide-react";
import { useApp } from "../store/store";
import { session } from "../lib/session";
import { Avatar } from "./Avatar";

/* ------------------------------- CANAIS ---------------------------------- */

const TextChannel = memo(function TextChannel({
  id,
  name,
  active,
}: {
  id: string;
  name: string;
  active: boolean;
}) {
  return (
    <button
      onClick={() => void session.openTextChannel(id)}
      className={`group flex w-full items-center gap-1.5 rounded px-2 py-[6px] text-[15px] transition-colors ${
        active ? "bg-base-500 text-ink" : "text-muted hover:bg-base-600/60 hover:text-ink-soft"
      }`}
    >
      <Hash size={18} className="shrink-0 text-faint" />
      <span className="truncate">{name}</span>
    </button>
  );
});

const VoiceMember = memo(function VoiceMember({
  name,
  color,
  speaking,
  muted,
  sharing,
}: {
  name: string;
  color: string;
  speaking: boolean;
  muted: boolean;
  sharing: boolean;
}) {
  return (
    <div className="flex items-center gap-2 rounded px-2 py-1 pl-7 hover:bg-base-600/50">
      <Avatar name={name} color={color} size={22} speaking={speaking} />
      <span className={`truncate text-sm ${speaking ? "text-ink" : "text-muted"}`}>{name}</span>
      <span className="ml-auto flex items-center gap-1">
        {sharing && <ScreenShare size={13} className="text-stream" />}
        {muted && <MicOff size={13} className="text-danger" />}
      </span>
    </div>
  );
});

const VoiceChannel = memo(function VoiceChannel({
  id,
  name,
  active,
}: {
  id: string;
  name: string;
  active: boolean;
}) {
  const roster = useApp((s) => s.roster);
  const speaking = useApp((s) => s.speaking);
  const members = useMemo(() => roster.filter((r) => r.voice === id), [roster, id]);

  return (
    <div>
      <button
        onClick={() => void session.joinVoice(id)}
        className={`group flex w-full items-center gap-1.5 rounded px-2 py-[6px] text-[15px] transition-colors ${
          active ? "bg-base-500 text-ink" : "text-muted hover:bg-base-600/60 hover:text-ink-soft"
        }`}
      >
        <Volume2 size={18} className="shrink-0 text-faint" />
        <span className="truncate">{name}</span>
        {members.length > 0 && (
          <span className="ml-auto text-xs text-faint">{members.length}</span>
        )}
      </button>

      {members.map((m) => (
        <VoiceMember
          key={m.id}
          name={m.user.name}
          color={m.user.color}
          speaking={!!speaking[m.id]}
          muted={m.state.muted}
          sharing={m.state.sharing}
        />
      ))}
    </div>
  );
});

/* --------------------------- STATUS DE VOZ -------------------------------- */

const VoiceStatus = memo(function VoiceStatus() {
  const activeVoice = useApp((s) => s.activeVoice);
  const channels = useApp((s) => s.channels);
  const stats = useApp((s) => s.stats);
  const sharing = useApp((s) => s.sharing);

  if (!activeVoice) return null;
  const channel = channels.find((c) => c.id === activeVoice);
  const pings = Object.values(stats).map((s) => s.rttMs).filter(Boolean);
  const ping = pings.length ? Math.max(...pings) : 0;

  return (
    <div className="border-t border-line bg-base-700 px-2 py-2">
      <div className="flex items-center gap-2 px-1">
        <Signal size={16} className={ping && ping < 80 ? "text-online" : "text-warn"} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-online">
            Voz conectada {ping ? `· ${ping}ms` : ""}
          </p>
          <p className="truncate text-xs text-muted">{channel?.name ?? activeVoice}</p>
        </div>
        <button
          onClick={() => session.leaveVoice()}
          title="Desconectar"
          className="grid size-8 place-items-center rounded text-muted transition-colors hover:bg-base-500 hover:text-danger"
        >
          <PhoneOff size={17} />
        </button>
      </div>

      <button
        onClick={() => void session.toggleShare()}
        className={`mt-2 flex w-full items-center justify-center gap-2 rounded py-1.5 text-sm font-medium transition-colors ${
          sharing
            ? "bg-danger/90 text-white hover:bg-danger"
            : "bg-base-500 text-ink-soft hover:bg-base-400"
        }`}
      >
        <MonitorUp size={16} />
        {sharing ? "Parar transmissao" : "Compartilhar tela"}
      </button>
    </div>
  );
});

/* ---------------------------- PAINEL DO USUARIO --------------------------- */

const UserPanel = memo(function UserPanel() {
  const me = useApp((s) => s.me);
  const muted = useApp((s) => s.muted);
  const deafened = useApp((s) => s.deafened);
  const selfId = useApp((s) => s.selfSocketId);
  const speaking = useApp((s) => !!s.speaking[s.selfSocketId]);
  const micReady = useApp((s) => s.micReady);

  if (!me) return null;

  return (
    <div className="flex items-center gap-1 bg-base-900 px-2 py-[7px]">
      <div className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5">
        <Avatar name={me.name} color={me.color} size={30} speaking={speaking && micReady} />
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-ink">{me.name}</p>
          <p className="truncate text-[11px] text-muted">
            {selfId ? `#${selfId.slice(0, 6)}` : "conectando..."}
          </p>
        </div>
      </div>

      <button
        onClick={() => session.toggleMute()}
        title={muted ? "Ativar microfone" : "Silenciar microfone"}
        className={`grid size-8 place-items-center rounded transition-colors hover:bg-base-500 ${
          muted ? "text-danger" : "text-muted hover:text-ink"
        }`}
      >
        {muted ? <MicOff size={18} /> : <Mic size={18} />}
      </button>
      <button
        onClick={() => session.toggleDeafen()}
        title={deafened ? "Ouvir novamente" : "Ensurdecer"}
        className={`grid size-8 place-items-center rounded transition-colors hover:bg-base-500 ${
          deafened ? "text-danger" : "text-muted hover:text-ink"
        }`}
      >
        {deafened ? <HeadphoneOff size={18} /> : <Headphones size={18} />}
      </button>
      <button
        onClick={() => useApp.setState({ showSettings: true })}
        title="Configuracoes"
        className="grid size-8 place-items-center rounded text-muted transition-colors hover:bg-base-500 hover:text-ink"
      >
        <Settings size={18} />
      </button>
    </div>
  );
});

/* -------------------------------- SIDEBAR --------------------------------- */

function ChannelSidebarBase() {
  const channels = useApp((s) => s.channels);
  const activeText = useApp((s) => s.activeText);
  const activeVoice = useApp((s) => s.activeVoice);

  const textChannels = useMemo(() => channels.filter((c) => c.kind === "text"), [channels]);
  const voiceChannels = useMemo(() => channels.filter((c) => c.kind === "voice"), [channels]);

  return (
    <aside className="flex w-60 shrink-0 flex-col bg-base-700">
      <button className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4 text-[15px] font-semibold text-ink shadow-sm transition-colors hover:bg-base-500/40">
        Voxa · LAN Party
        <ChevronDown size={18} className="text-muted" />
      </button>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        <p className="mb-1 px-1 text-[11px] font-bold uppercase tracking-wide text-faint">
          Canais de texto
        </p>
        {textChannels.map((c) => (
          <TextChannel key={c.id} id={c.id} name={c.name} active={c.id === activeText} />
        ))}

        <p className="mb-1 mt-4 px-1 text-[11px] font-bold uppercase tracking-wide text-faint">
          Canais de voz
        </p>
        {voiceChannels.map((c) => (
          <VoiceChannel key={c.id} id={c.id} name={c.name} active={c.id === activeVoice} />
        ))}
      </div>

      <VoiceStatus />
      <UserPanel />
    </aside>
  );
}

export const ChannelSidebar = memo(ChannelSidebarBase);
