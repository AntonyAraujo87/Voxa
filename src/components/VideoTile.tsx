import { memo, useEffect, useRef, useState } from "react";
import { Loader2, Maximize2, MicOff, Minimize2, ScreenShare } from "lucide-react";
import { useApp } from "../store/store";
import { usePeerMedia, useLocalScreen } from "../store/mediaStore";
import { Avatar } from "./Avatar";
import type { PeerStats } from "../lib/rtc";

/* --------------------------- overlay de metricas --------------------------- */

const LIMIT_LABEL: Record<string, string> = {
  none: "livre",
  cpu: "limitado por CPU",
  bandwidth: "limitado por banda",
  other: "limitado",
};

const StatsOverlay = memo(function StatsOverlay({ stats }: { stats?: PeerStats }) {
  if (!stats) return null;
  const kbps = stats.inKbps || stats.outKbps;
  const hw = /nvenc|qsv|mediafoundation|d3d|vaapi|videotoolbox|hardware/i.test(
    stats.encoder + stats.decoder
  );

  return (
    <div className="pointer-events-none absolute left-2 top-2 rounded bg-black/70 px-2 py-1.5 font-mono text-[11px] leading-tight text-ink-soft backdrop-blur-sm">
      <div className="flex gap-3">
        <span className={stats.fps >= 50 ? "text-online" : stats.fps >= 25 ? "text-warn" : "text-danger"}>
          {stats.fps} fps
        </span>
        <span>{(kbps / 1000).toFixed(1)} Mbps</span>
        <span className={stats.rttMs < 60 ? "text-online" : "text-warn"}>{stats.rttMs} ms</span>
      </div>
      <div className="flex gap-3 text-faint">
        <span>{stats.width ? `${stats.width}x${stats.height}` : "-"}</span>
        <span>{stats.codec}</span>
        <span className={hw ? "text-online" : "text-warn"}>{hw ? "GPU" : "CPU"}</span>
      </div>
      <div className="text-faint">
        perda {stats.lossPct.toFixed(1)}% · jitter {stats.jitterMs}ms ·{" "}
        {LIMIT_LABEL[stats.limitation] ?? stats.limitation}
      </div>
      <div className={stats.path === "relay" ? "text-warn" : "text-faint"}>
        rota: {stats.path === "relay" ? "relay TURN" : stats.path}
      </div>
    </div>
  );
});

/** Metricas da propria captura: sozinho na sala nao existe peer, logo nao existe
 *  getStats(). Lemos o que a fonte esta realmente entregando. */
function useLocalCaptureInfo(stream: MediaStream | null, enabled: boolean) {
  const [info, setInfo] = useState<MediaTrackSettings | null>(null);

  useEffect(() => {
    if (!stream || !enabled) {
      setInfo(null);
      return;
    }
    const read = () => {
      const track = stream.getVideoTracks()[0];
      setInfo(track ? track.getSettings() : null);
    };
    read();
    const t = window.setInterval(read, 1000);
    return () => window.clearInterval(t);
  }, [stream, enabled]);

  return info;
}

const LocalOverlay = memo(function LocalOverlay({ info }: { info: MediaTrackSettings | null }) {
  if (!info) return null;
  const surface = (info as { displaySurface?: string }).displaySurface ?? "?";
  return (
    <div className="pointer-events-none absolute left-2 top-2 rounded bg-black/70 px-2 py-1.5 font-mono text-[11px] leading-tight text-ink-soft backdrop-blur-sm">
      <div className="flex gap-3">
        <span className="text-online">{Math.round(info.frameRate ?? 0)} fps captura</span>
        <span>
          {info.width ?? 0}x{info.height ?? 0}
        </span>
      </div>
      <div className="text-faint">
        fonte: {surface === "monitor" ? "monitor" : surface === "window" ? "janela" : surface} ·
        sem espectador ainda
      </div>
    </div>
  );
});

/* --------------------------------- tile ----------------------------------- */

interface Props {
  peerId: string;
  name: string;
  color: string;
  isSelf: boolean;
  muted: boolean;
  speaking: boolean;
  focused: boolean;
  hasScreen: boolean;
}

function VideoTileBase({ peerId, name, color, isSelf, muted, speaking, focused, hasScreen }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const remote = usePeerMedia(peerId);
  const local = useLocalScreen();
  const stream = isSelf ? local : remote.screen;
  const showStats = useApp((s) => s.showStats);
  const stats = useApp((s) => (showStats ? s.stats[peerId] : undefined));
  const conexao = useApp((s) => s.connState[peerId]);
  const localInfo = useLocalCaptureInfo(stream, showStats && isSelf && hasScreen);

  // `hasScreen` PRECISA estar nas dependencias: o track remoto costuma chegar
  // antes do estado "sharing" daquela pessoa (caminhos diferentes — um vem do
  // WebRTC, outro do signaling). Enquanto sharing=false o tile mostra o avatar
  // e nao existe <video> nenhum; quando ele finalmente monta, o stream ja e o
  // mesmo de antes e o efeito nao rodaria de novo — o elemento novo ficaria
  // para sempre sem srcObject, ou seja, tile preto com bytes chegando.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    if (!stream) return;

    // Uma chamada unica a play() nao basta: quando o stream chega com a janela
    // minimizada ou o tile ainda sem layout, a promise e rejeitada e o elemento
    // fica pausado pra sempre — video parado apesar dos bytes chegando.
    // Reagendamos em cada evento que indica "agora da pra tocar".
    const play = () => void el.play().catch(() => {});
    play();
    el.addEventListener("loadedmetadata", play);
    el.addEventListener("canplay", play);
    el.addEventListener("pause", play);
    document.addEventListener("visibilitychange", play);

    return () => {
      el.removeEventListener("loadedmetadata", play);
      el.removeEventListener("canplay", play);
      el.removeEventListener("pause", play);
      document.removeEventListener("visibilitychange", play);
      el.srcObject = null;
    };
  }, [stream, hasScreen]);

  const toggleFocus = () =>
    useApp.setState((s) => ({ focusPeer: s.focusPeer === peerId ? null : peerId }));

  return (
    <div
      onDoubleClick={toggleFocus}
      // size-full e obrigatorio: no modo destaque o pai tem altura vinda do
      // flex, e sem isso o tile ficaria com altura de conteudo — que e zero,
      // porque o <video> dentro dele pede 100% da altura do proprio tile.
      className={`gpu-layer group relative size-full overflow-hidden rounded-lg bg-base-900 ${
        speaking ? "ring-2 ring-online" : "ring-1 ring-line"
      }`}
    >
      {stream && hasScreen ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          // O audio da tela sai pelos <audio> dedicados (controle de volume por
          // pessoa); aqui fica sempre mudo pra nao duplicar nem causar eco.
          muted
          className="size-full object-contain"
        />
      ) : (
        <div className="flex size-full flex-col items-center justify-center gap-3 py-8">
          <Avatar name={name} color={color} size={focused ? 96 : 64} speaking={speaking} />
          <span className="text-sm text-muted">{name}</span>
        </div>
      )}

      {showStats && hasScreen && (isSelf && !stats ? <LocalOverlay info={localInfo} /> : <StatsOverlay stats={stats} />)}

      {/* A reconexao acontece sozinha; o aviso existe para o usuario nao achar
          que travou e sair do canal no meio da recuperacao. */}
      {!isSelf && (conexao === "disconnected" || conexao === "failed") && (
        <div className="absolute inset-x-0 top-0 flex items-center justify-center gap-2 bg-warn/90 py-1 text-[12px] font-medium text-black">
          <Loader2 size={13} className="animate-spin" />
          reconectando...
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-2 py-1.5">
        <span className="truncate text-[13px] font-medium text-ink">
          {name}
          {isSelf && " (voce)"}
        </span>
        {hasScreen && <ScreenShare size={13} className="text-stream" />}
        {muted && <MicOff size={13} className="text-danger" />}
      </div>

      <button
        onClick={toggleFocus}
        className="absolute right-2 top-2 grid size-7 place-items-center rounded bg-black/60 text-ink-soft opacity-0 transition-opacity hover:bg-black/80 group-hover:opacity-100"
        title={focused ? "Sair do destaque" : "Destacar"}
      >
        {focused ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
      </button>
    </div>
  );
}

export const VideoTile = memo(VideoTileBase);
