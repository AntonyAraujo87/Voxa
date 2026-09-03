import { memo, useEffect, useMemo, useRef } from "react";
import { useApp } from "../store/store";
import { usePeerMedia } from "../store/mediaStore";
import { audioContext } from "../lib/media";

/* ---------------------------------------------------------------------------
   Audio remoto (voz + som da transmissao), roteado por WebAudio em vez de
   <audio>.volume — HTMLMediaElement.volume trava em 1.0 por especificacao;
   o slider desta aplicacao vai ate 2.0 (200%), e so um GainNode alcanca isso.

   Ficam fora da grade de video de proposito: assim o audio nunca e cortado
   quando o tile some da tela (foco, thumbnail, scroll, ou nem existe tile —
   a maioria das chamadas nao tem ninguem transmitindo tela).

   Voz e transmissao tem ganhos INDEPENDENTES: uma pessoa pode estar alta
   demais no microfone mas o audio do jogo dela estar baixo, ou vice-versa.
--------------------------------------------------------------------------- */

/**
 * Liga um MediaStream a um GainNode no destino padrao do AudioContext.
 *
 * Reconstroi o grafo sempre que o STREAM muda — nao só o volume. O peer
 * troca de objeto MediaStream a cada mute/unmute remoto (`new MediaStream([track])`
 * em rtc/peer.ts), entao o source node antigo ficaria apontando pra um
 * stream morto se so o ganho fosse atualizado.
 */
function useGainStream(stream: MediaStream | null, gain: number, silenciado: boolean) {
  const gainNodeRef = useRef<GainNode | null>(null);

  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) return;

    const ctx = audioContext();
    const source = ctx.createMediaStreamSource(stream);
    const gainNode = ctx.createGain();
    gainNodeRef.current = gainNode;

    source.connect(gainNode);
    gainNode.connect(ctx.destination);

    return () => {
      try {
        source.disconnect();
        gainNode.disconnect();
      } catch {
        /* stream ja parou, contexto ja fechou — nao ha o que desfazer */
      }
      if (gainNodeRef.current === gainNode) gainNodeRef.current = null;
    };
    // Recria so quando o STREAM troca. gain/silenciado tem seu proprio efeito
    // abaixo, que atualiza o node existente sem religar a fonte.
  }, [stream]);

  // Ganho e mudo sao atualizados no node existente, sem recriar o grafo —
  // arrastar o slider nao pode religar a fonte a cada pixel.
  useEffect(() => {
    const node = gainNodeRef.current;
    if (!node) return;
    node.gain.value = silenciado ? 0 : Math.max(0, gain);
  }, [gain, silenciado]);
}

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
  useGainStream(media.mic, micVolume, deafened);
  useGainStream(media.screenAudio, streamVolume, deafened);
  return null;
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
    <>
      {peers.map((p) => (
        <PeerAudio
          key={p.id}
          peerId={p.id}
          deafened={deafened}
          micVolume={volumes[p.userId] ?? 1}
          streamVolume={streamVolumes[p.userId] ?? 1}
        />
      ))}
    </>
  );
}

export const RemoteAudio = memo(RemoteAudioBase);
