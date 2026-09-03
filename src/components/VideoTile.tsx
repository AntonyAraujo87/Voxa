import { memo, useEffect, useRef, useState } from "react";
import {
  Camera,
  Expand,
  Loader2,
  MicOff,
  PictureInPicture2,
  ScreenShare,
  Shrink,
  X,
} from "lucide-react";
import { useApp } from "../store/store";
import { usePeerMedia, useLocalScreen } from "../store/mediaStore";
import { Avatar } from "./Avatar";
import { VolumeControl } from "./VolumeControl";
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
  userId: string;
  name: string;
  color: string;
  isSelf: boolean;
  muted: boolean;
  speaking: boolean;
  focused: boolean;
  hasScreen: boolean;
  /** tela ou webcam — so importa visualmente quando hasScreen e true. */
  kind?: "tela" | "camera";
  /** clique na miniatura (grade de quem esta transmitindo) — foca esse tile */
  onClick?: () => void;
  /** so existe no tile grande: volta para a grade de miniaturas */
  onBack?: () => void;
}

function VideoTileBase({
  peerId,
  userId,
  name,
  color,
  isSelf,
  muted,
  speaking,
  focused,
  hasScreen,
  kind = "tela",
  onClick,
  onBack,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [emTelaCheia, setEmTelaCheia] = useState(false);
  const [emPip, setEmPip] = useState(false);
  const remote = usePeerMedia(peerId);
  const local = useLocalScreen();
  const stream = isSelf ? local : remote.screen;
  const showStats = useApp((s) => s.showStats);
  const stats = useApp((s) => (showStats ? s.stats[peerId] : undefined));
  const conexao = useApp((s) => s.connState[peerId]);
  const localInfo = useLocalCaptureInfo(stream, showStats && isSelf && hasScreen);
  const streamVolume = useApp((s) => s.streamVolumes[userId] ?? 1);
  const setStreamVolume = useApp((s) => s.setStreamVolume);

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

  // O estado precisa vir do documento, nao de um clique nosso: sair com Esc
  // ou pelo gesto do sistema tambem tem que atualizar o icone.
  useEffect(() => {
    const syncFullscreen = () => setEmTelaCheia(document.fullscreenElement === containerRef.current);
    const syncPip = () => setEmPip(document.pictureInPictureElement === videoRef.current);
    document.addEventListener("fullscreenchange", syncFullscreen);
    document.addEventListener("enterpictureinpicture", syncPip);
    document.addEventListener("leavepictureinpicture", syncPip);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreen);
      document.removeEventListener("enterpictureinpicture", syncPip);
      document.removeEventListener("leavepictureinpicture", syncPip);
    };
  }, []);

  /**
   * Tela cheia de verdade, sobre todo o monitor.
   *
   * Antes so existia o "destaque", que cresce dentro da janela — e a unica
   * forma de tela cheia era o menu de contexto do WebView2, escondido atras
   * de "Mostrar todas as opcoes". Agora: duplo clique no video, ou o botao no
   * canto. Esc sai, que e o que todo mundo ja espera.
   */
  const toggleFullscreen = async () => {
    const el = containerRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await el.requestFullscreen({ navigationUI: "hide" });
    } catch {
      // Alguns estados da janela recusam; o botao continua ali pra tentar de novo.
    }
  };

  /** Picture-in-picture: assistir a transmissao numa janela flutuante enquanto
   *  usa outro programa — o proprio jogo, por exemplo. */
  const togglePip = async () => {
    const el = videoRef.current;
    if (!el) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await el.requestPictureInPicture();
    } catch {
      // Sem suporte no runtime do WebView2 instalado; os outros controles seguem.
    }
  };

  const pipDisponivel =
    typeof document !== "undefined" && "pictureInPictureEnabled" in document
      ? (document as Document & { pictureInPictureEnabled: boolean }).pictureInPictureEnabled
      : false;

  return (
    <div
      ref={containerRef}
      onClick={onClick}
      onDoubleClick={hasScreen ? () => void toggleFullscreen() : undefined}
      // size-full e obrigatorio: no modo destaque o pai tem altura vinda do
      // flex, e sem isso o tile ficaria com altura de conteudo — que e zero,
      // porque o <video> dentro dele pede 100% da altura do proprio tile.
      className={`gpu-layer group relative size-full overflow-hidden rounded-lg bg-base-900 ${
        speaking ? "ring-2 ring-online" : "ring-1 ring-line"
      } ${onClick ? "cursor-pointer" : ""}`}
    >
      {stream && hasScreen ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          // O audio da tela sai pelos <audio> dedicados (controle de volume por
          // pessoa); aqui fica sempre mudo pra nao duplicar nem causar eco.
          muted
          // So a PROPRIA webcam espelha — e como a pessoa se ve no espelho,
          // convencao universal de qualquer app de video. Espelhar a do outro
          // lado inverteria texto e gestos pra quem esta assistindo.
          className={`size-full object-contain ${
            isSelf && kind === "camera" ? "-scale-x-100" : ""
          }`}
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
        {hasScreen &&
          (kind === "camera" ? (
            <Camera size={13} className="text-stream" />
          ) : (
            <ScreenShare size={13} className="text-stream" />
          ))}
        {muted && <MicOff size={13} className="text-danger" />}
      </div>

      <div
        className={`absolute right-2 top-2 flex gap-1 transition-opacity ${
          focused ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
      >
        {/* Volume da transmissao, separado do volume da voz — nao existe para
            a propria tela, so faz sentido regular o audio de quem se ouve. */}
        {hasScreen && !isSelf && (
          <VolumeControl
            volume={streamVolume}
            onChange={(v) => setStreamVolume(userId, v)}
            title={`Volume da transmissao: ${Math.round(streamVolume * 100)}%`}
            size={14}
            className="bg-black/60 text-ink-soft hover:bg-black/80"
          />
        )}
        {hasScreen && pipDisponivel && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              void togglePip();
            }}
            className={`grid size-7 place-items-center rounded bg-black/60 text-ink-soft transition-colors hover:bg-black/80 ${
              emPip ? "text-brand" : ""
            }`}
            title="Picture-in-picture"
          >
            <PictureInPicture2 size={14} />
          </button>
        )}
        {hasScreen && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              void toggleFullscreen();
            }}
            className="grid size-7 place-items-center rounded bg-black/60 text-ink-soft transition-colors hover:bg-black/80"
            title={emTelaCheia ? "Sair da tela cheia (Esc)" : "Tela cheia (ou duplo clique)"}
          >
            {emTelaCheia ? <Shrink size={14} /> : <Expand size={14} />}
          </button>
        )}
        {onBack && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onBack();
            }}
            className="grid size-7 place-items-center rounded bg-black/60 text-ink-soft transition-colors hover:bg-black/80"
            title="Voltar para a grade"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

export const VideoTile = memo(VideoTileBase);
