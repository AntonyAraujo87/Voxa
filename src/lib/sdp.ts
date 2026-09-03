/* ---------------------------------------------------------------------------
   SDP munging — o que a API publica do WebRTC nao deixa configurar.
   `RTCRtpSender.setParameters()` cobre maxBitrate/maxFramerate, mas NAO cobre:
     · bitrate INICIAL (x-google-start-bitrate) — sem isso o encoder comeca em
       ~300 kbps e leva 10-20s de rampa ate 1080p60 ficar nitido;
     · bitrate MINIMO (x-google-min-bitrate) — impede o congestion control de
       desabar pra 200 kbps num pico de perda;
     · opus stereo / maxaveragebitrate / dtx.
   Por isso mexemos no SDP na mao, antes de setLocalDescription.
--------------------------------------------------------------------------- */

export interface VideoTune {
  startKbps: number;
  minKbps: number;
  maxKbps: number;
}

export interface OpusTune {
  stereo: boolean;
  /** bits/s */
  bitrate: number;
  /** DTX corta o envio no silencio (economiza banda, ruim pra musica) */
  dtx: boolean;
  /** tamanho do frame em ms — 10ms = menor latencia, 20ms = padrao */
  ptimeMs: number;
}

interface Section {
  kind: string;
  lines: string[];
}

function parse(sdp: string): { head: string[]; sections: Section[] } {
  const lines = sdp.split(/\r\n|\n/);
  const head: string[] = [];
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const line of lines) {
    if (line.startsWith("m=")) {
      current = { kind: line.slice(2).split(" ")[0], lines: [line] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      head.push(line);
    }
  }
  return { head, sections };
}

function serialize(head: string[], sections: Section[]): string {
  return [...head, ...sections.flatMap((s) => s.lines)]
    .filter((l) => l.length > 0)
    .join("\r\n") + "\r\n";
}

/** payload types de um codec (case-insensitive), ignorando rtx/red/fec */
function payloadTypesFor(section: Section, codec: RegExp): string[] {
  const out: string[] = [];
  for (const line of section.lines) {
    const m = /^a=rtpmap:(\d+) ([^/]+)\//.exec(line);
    if (m && codec.test(m[2])) out.push(m[1]);
  }
  return out;
}

function upsertFmtp(section: Section, pt: string, params: Record<string, string | number>) {
  const idx = section.lines.findIndex((l) => l.startsWith(`a=fmtp:${pt} `));
  if (idx === -1) {
    const kv = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(";");
    // insere logo depois do rtpmap correspondente
    const at = section.lines.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `));
    section.lines.splice(at === -1 ? section.lines.length : at + 1, 0, `a=fmtp:${pt} ${kv}`);
    return;
  }
  const existing = section.lines[idx].slice(`a=fmtp:${pt} `.length);
  const map = new Map<string, string>();
  for (const pair of existing.split(";")) {
    const eq = pair.indexOf("=");
    if (eq > 0) map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    else if (pair.trim()) map.set(pair.trim(), "");
  }
  for (const [k, v] of Object.entries(params)) map.set(k, String(v));
  section.lines[idx] =
    `a=fmtp:${pt} ` +
    [...map].map(([k, v]) => (v === "" ? k : `${k}=${v}`)).join(";");
}

function setBandwidth(section: Section, kbps: number) {
  section.lines = section.lines.filter((l) => !l.startsWith("b=AS:") && !l.startsWith("b=TIAS:"));
  // b= vai obrigatoriamente logo depois de c=
  const cIdx = section.lines.findIndex((l) => l.startsWith("c="));
  const at = cIdx === -1 ? 1 : cIdx + 1;
  section.lines.splice(at, 0, `b=AS:${kbps}`, `b=TIAS:${kbps * 1000}`);
}

export interface TuneOptions {
  video?: VideoTune;
  /** aplicado na 1a secao de audio (microfone) */
  micAudio?: OpusTune;
  /** aplicado na 2a secao de audio (som da tela/jogo) */
  screenAudio?: OpusTune;
}

export function tuneSdp(sdp: string, opts: TuneOptions): string {
  const { head, sections } = parse(sdp);
  let audioIndex = 0;

  for (const section of sections) {
    if (section.kind === "video" && opts.video) {
      const { startKbps, minKbps, maxKbps } = opts.video;
      setBandwidth(section, maxKbps);
      const pts = payloadTypesFor(section, /^(VP8|VP9|H264|H265|AV1|AV1X)$/i);
      for (const pt of pts) {
        upsertFmtp(section, pt, {
          "x-google-start-bitrate": startKbps,
          "x-google-min-bitrate": minKbps,
          "x-google-max-bitrate": maxKbps,
        });
      }
    }

    if (section.kind === "audio") {
      const tune = audioIndex === 0 ? opts.micAudio : opts.screenAudio;
      audioIndex++;
      if (!tune) continue;
      setBandwidth(section, Math.ceil(tune.bitrate / 1000));
      for (const pt of payloadTypesFor(section, /^opus$/i)) {
        upsertFmtp(section, pt, {
          stereo: tune.stereo ? 1 : 0,
          "sprop-stereo": tune.stereo ? 1 : 0,
          maxaveragebitrate: tune.bitrate,
          maxplaybackrate: 48000,
          "sprop-maxcapturerate": 48000,
          useinbandfec: 1,
          usedtx: tune.dtx ? 1 : 0,
          cbr: 0,
        });
      }
      const ptimeIdx = section.lines.findIndex((l) => l.startsWith("a=ptime:"));
      const ptimeLine = `a=ptime:${tune.ptimeMs}`;
      if (ptimeIdx === -1) section.lines.push(ptimeLine);
      else section.lines[ptimeIdx] = ptimeLine;
    }
  }

  return serialize(head, sections);
}

/**
 * Reordena os payload types da m-line de video colocando `preferred` na frente.
 * Fallback pra navegadores sem `setCodecPreferences`.
 */
export function preferVideoCodec(sdp: string, preferred: string): string {
  const { head, sections } = parse(sdp);
  for (const section of sections) {
    if (section.kind !== "video") continue;
    const wanted = payloadTypesFor(section, new RegExp(`^${preferred}$`, "i"));
    if (!wanted.length) continue;
    const m = section.lines[0].split(" ");
    const fixed = m.slice(0, 3);
    const pts = m.slice(3);
    section.lines[0] = [...fixed, ...wanted, ...pts.filter((p) => !wanted.includes(p))].join(" ");
  }
  return serialize(head, sections);
}
