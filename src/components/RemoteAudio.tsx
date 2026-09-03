import { memo, useEffect, useMemo, useRef } from "react";
import { useApp } from "../store/store";
import { usePeerMedia } from "../store/mediaStore";

/* ---------------------------------------------------------------------------
   Elementos <audio> invisiveis, um por fonte remota (microfone + som da tela).
   Ficam fora da grade de video de proposito: assim o audio nunca e cortado
   quando o tile some da tela (foco, thumbnail, scroll, ou nem existe tile —
   a maioria das chamadas nao tem ninguem transmitindo tela).

   Voz e transmissao tem volumes INDEPENDENTES: uma pessoa pode estar alta
   demais no microfone mas o audio do jogo dela estar baixo, ou vice-versa.
--------------------------------------------------------------------------- */

const PeerAudio = memo(function PeerAudio({
  peerId,
  deafened,
  micVolume,
  streamVolume,
}: {
  peerId: string;
  deafened: boolean;
  micVolume: number;
  streamVolume: number;
}) {
  const media = usePeerMedia(peerId);
  const micRef = useRef<HTMLAudioElement>(null);
  const screenRef = useRef<HTMLAudioElement>(null);

  // HTMLMediaElement.volume so vai ate 1. Acima disso seria preciso um
  // GainNode do WebAudio, que adiciona um hop no grafo de audio — nao vale
  // o custo de latencia so pra passar de 100%.
  useEffect(() => {
    if (micRef.current) micRef.current.volume = Math.min(1, Math.max(0, micVolume));
  }, [micVolume, media.mic]);

  useEffect(() => {
    if (screenRef.current) screenRef.current.volume = Math.min(1, Math.max(0, streamVolume));
  }, [streamVolume, media.screenAudio]);

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
  const streamVolumes = useApp((s) => s.streamVolumes);

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
          micVolume={volumes[p.userId] ?? 1}
          streamVolume={streamVolumes[p.userId] ?? 1}
        />
      ))}
    </div>
  );
}

export const RemoteAudio = memo(RemoteAudioBase);
