import { memo, useEffect, useMemo, useRef } from "react";
import { useApp } from "../store/store";
import { usePeerMedia } from "../store/mediaStore";

/* ---------------------------------------------------------------------------
   Elementos <audio> invisiveis, um por fonte remota (microfone + som da tela).
   Ficam fora da grade de video de proposito: assim o audio nunca e cortado
   quando o tile some da tela (foco, thumbnail, scroll).
--------------------------------------------------------------------------- */

const PeerAudio = memo(function PeerAudio({
  peerId,
  deafened,
  volume,
}: {
  peerId: string;
  deafened: boolean;
  volume: number;
}) {
  const media = usePeerMedia(peerId);
  const micRef = useRef<HTMLAudioElement>(null);
  const screenRef = useRef<HTMLAudioElement>(null);

  // HTMLMediaElement.volume so vai ate 1. Acima disso seria preciso um
  // GainNode do WebAudio, que adiciona um hop no grafo de audio — nao vale
  // o custo de latencia so pra passar de 100%.
  useEffect(() => {
    const v = Math.min(1, Math.max(0, volume));
    if (micRef.current) micRef.current.volume = v;
    if (screenRef.current) screenRef.current.volume = v;
  }, [volume, media.mic, media.screenAudio]);

  useEffect(() => {
    const el = micRef.current;
    if (el && el.srcObject !== media.mic) {
      el.srcObject = media.mic;
      if (media.mic) void el.play().catch(() => {});
    }
  }, [media.mic]);

  useEffect(() => {
    const el = screenRef.current;
    if (el && el.srcObject !== media.screenAudio) {
      el.srcObject = media.screenAudio;
      if (media.screenAudio) void el.play().catch(() => {});
    }
  }, [media.screenAudio]);

  return (
    <>
      <audio ref={micRef} autoPlay muted={deafened} />
      <audio ref={screenRef} autoPlay muted={deafened} />
    </>
  );
});

function RemoteAudioBase() {
  const roster = useApp((s) => s.roster);
  const activeVoice = useApp((s) => s.activeVoice);
  const selfId = useApp((s) => s.selfSocketId);
  const deafened = useApp((s) => s.deafened);

  const volumes = useApp((s) => s.volumes);

  const peers = useMemo(
    () =>
      roster
        .filter((r) => r.voice === activeVoice && r.id !== selfId)
        .map((r) => ({ id: r.id, userId: r.user.id })),
    [roster, activeVoice, selfId]
  );

  return (
    <div className="hidden">
      {peers.map((p) => (
        <PeerAudio
          key={p.id}
          peerId={p.id}
          deafened={deafened}
          volume={volumes[p.userId] ?? 1}
        />
      ))}
    </div>
  );
}

export const RemoteAudio = memo(RemoteAudioBase);
