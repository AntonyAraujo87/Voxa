import { EMPTY_SAMPLE, type PeerStats, type Sample } from "./types";

/* ---------------------------------------------------------------------------
   Leitura do getStats(). Isolado porque e o unico ponto do sistema que lida
   com o formato cru do relatorio WebRTC — um mapa heterogeneo sem tipagem util.
--------------------------------------------------------------------------- */

export interface StatsSamples {
  out: Sample;
  in: Sample;
  audio?: Map<string, Sample>;
}

export function newSamples(): StatsSamples {
  return { out: { ...EMPTY_SAMPLE }, in: { ...EMPTY_SAMPLE } };
}

type Report = Record<string, unknown>;

/**
 * Deriva as metricas exibidas no overlay a partir de um relatorio bruto.
 * Recebe e devolve as amostras anteriores porque taxa por segundo so existe
 * comparando duas leituras.
 */
export function readStats(
  report: RTCStatsReport,
  previous: StatsSamples,
  base: PeerStats,
  mids: { mic: string | null; screenAudio: string | null } = { mic: "0", screenAudio: "2" },
): PeerStats {
  const s: PeerStats = { ...base, outKbps: 0, inKbps: 0, fps: 0, width: 0, height: 0, rttMs: 0, availableOutKbps: 0, limitation: "none", audioOutBytes: 0, audioInBytes: 0, micOutBytes: 0, micInBytes: 0, screenAudioOutBytes: 0, screenAudioInBytes: 0, sampleAt: Date.now(), jitterMs: 0, lossPct: 0, rttMeasured: false, lossMeasured: false, path: "-" };
  previous.audio ??= new Map();
  let selectedPair: string | undefined;
  let audioReceived = 0, audioLost = 0;
  const codecs = new Map<string, string>();
  const candidates = new Map<string, string>();
  const audioIds = new Set<string>();

  report.forEach((r: Report) => {
    if (r.type === "transport" && r.selectedCandidatePairId) selectedPair = String(r.selectedCandidatePairId);
    if (r.type === "codec") {
      codecs.set(r.id as string, String(r.mimeType ?? "").split("/")[1] ?? "-");
    }
    if (r.type === "local-candidate" || r.type === "remote-candidate") {
      candidates.set(r.id as string, String(r.candidateType ?? ""));
    }
  });

  report.forEach((r: Report) => {
    // Audio: so o acumulado, que e o que responde "esta passando ou nao".
    if (r.type === "outbound-rtp" && r.kind === "audio") {
      const bytes = (r.bytesSent as number) ?? 0;
      s.audioOutBytes += bytes;
      if (mids.mic !== null && r.mid === mids.mic) s.micOutBytes! += bytes;
      if (mids.screenAudio !== null && r.mid === mids.screenAudio) s.screenAudioOutBytes! += bytes;
    }
    if (r.type === "inbound-rtp" && r.kind === "audio") {
      const bytes = (r.bytesReceived as number) ?? 0;
      s.audioInBytes += bytes;
      if (mids.mic !== null && r.mid === mids.mic) s.micInBytes! += bytes;
      if (mids.screenAudio !== null && r.mid === mids.screenAudio) s.screenAudioInBytes! += bytes;
      audioIds.add(String(r.id));
      const packets = Number(r.packetsReceived ?? 0), lost = Number(r.packetsLost ?? 0), ts = Number(r.timestamp ?? 0);
      const prior = previous.audio!.get(String(r.id));
      if (prior && ts > prior.ts && packets >= prior.packets) {
        audioReceived += packets - prior.packets;
        audioLost += Math.max(0, lost - prior.lost);
        s.lossMeasured = true;
      }
      previous.audio!.set(String(r.id), { bytes, packets, lost, ts });
      s.jitterMs = Math.max(s.jitterMs, Math.round(Number(r.jitter ?? 0) * 1000));
    }

    if (r.type === "outbound-rtp" && r.kind === "video") {
      const ts = r.timestamp as number;
      const bytes = (r.bytesSent as number) ?? 0;
      if (previous.out.ts && ts > previous.out.ts) {
        s.outKbps = Math.max(0, Math.round(((bytes - previous.out.bytes) * 8) / (ts - previous.out.ts)));
      }
      previous.out = { bytes, ts, packets: 0, lost: 0 };
      s.fps = Math.round((r.framesPerSecond as number) ?? 0);
      s.encoder = String(r.encoderImplementation ?? "-");
      s.limitation = String(r.qualityLimitationReason ?? "none");
      if (r.codecId) s.codec = codecs.get(r.codecId as string) ?? s.codec;
    }

    if (r.type === "inbound-rtp" && r.kind === "video") {
      const ts = r.timestamp as number;
      const bytes = (r.bytesReceived as number) ?? 0;
      const packets = (r.packetsReceived as number) ?? 0;
      const lost = (r.packetsLost as number) ?? 0;

      if (previous.in.ts && ts > previous.in.ts) {
        s.inKbps = Math.max(0, Math.round(((bytes - previous.in.bytes) * 8) / (ts - previous.in.ts)));
        const dPackets = packets - previous.in.packets;
        const dLost = lost - previous.in.lost;
        s.lossPct = dPackets + dLost > 0 ? Math.max(0, (dLost / (dPackets + dLost)) * 100) : 0;
        s.lossMeasured = dPackets >= 0;
      }
      previous.in = { bytes, ts, packets, lost };

      s.fps = Math.round((r.framesPerSecond as number) ?? s.fps);
      s.width = (r.frameWidth as number) ?? s.width;
      s.height = (r.frameHeight as number) ?? s.height;
      s.jitterMs = Math.round(((r.jitter as number) ?? 0) * 1000);
      s.decoder = String(r.decoderImplementation ?? "-");
      if (r.codecId) s.codec = codecs.get(r.codecId as string) ?? s.codec;
    }

    if (r.type === "candidate-pair" && (selectedPair ? r.id === selectedPair : r.nominated && r.state === "succeeded")) {
      const rtt = (r.currentRoundTripTime as number) ?? 0;
      if (rtt) s.rttMs = Math.round(rtt * 1000);
      s.rttMeasured = typeof r.currentRoundTripTime === "number";

      const avail = (r.availableOutgoingBitrate as number) ?? 0;
      if (avail) s.availableOutKbps = Math.round(avail / 1000);

      // "relay" = passando por TURN, o que custa banda de quem paga o relay.
      const local = candidates.get(r.localCandidateId as string) ?? "";
      const remote = candidates.get(r.remoteCandidateId as string) ?? "";
      if (local || remote) {
        s.path = local === "relay" || remote === "relay" ? "relay" : "direto";
      }
    }
  });

  if (audioReceived + audioLost > 0) s.lossPct = Math.max(s.lossPct, 100 * audioLost / (audioReceived + audioLost));
  for (const id of previous.audio.keys()) if (!audioIds.has(id)) previous.audio.delete(id);

  return s;
}

/** Encoder rodando na GPU? Serve para o overlay e para a adaptacao automatica. */
export function isHardwareEncoder(stats: PeerStats): boolean {
  return /nvenc|qsv|mediafoundation|d3d|vaapi|videotoolbox|hardware/i.test(
    stats.encoder
  );
}
