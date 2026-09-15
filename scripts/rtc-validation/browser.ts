import { Peer } from '../../src/lib/rtc/peer';
import { PC_CONFIG } from '../../src/lib/config';
import type { LocalTracks } from '../../src/lib/rtc/types';
import type { SignalPayload } from '../../src/lib/signaling';

// Synthetic local media and host candidates only: no microphone permission,
// external signaling, environment files, STUN or TURN are used by this harness.
PC_CONFIG.iceServers = [];
PC_CONFIG.iceCandidatePoolSize = 0;
PC_CONFIG.iceTransportPolicy = 'all';
const tuning = { video: 'economica', audio: 'voz', codec: 'compatibilidade', content: 'jogo' } as const;
const targets = { maxBitrate: 300000, maxFramerate: 10, scaleDownBy: 1 };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate: () => boolean | Promise<boolean>, label: string, timeout = 10000) => {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    if (await predicate()) return;
    await pause(40);
  }
  throw new Error(`timeout: ${label}`);
};
function sections(sdp = '') {
  return sdp.split(/(?=^m=)/m).filter(x => x.startsWith('m=')).map(x => ({
    kind: /^m=(\w+)/.exec(x)?.[1],
    mid: /^a=mid:(.+)$/m.exec(x)?.[1]?.trim(),
    ufrag: /^a=ice-ufrag:(.+)$/m.exec(x)?.[1]?.trim(),
    direction: /^a=(sendrecv|recvonly|sendonly|inactive)$/m.exec(x)?.[1],
  }));
}
async function testCase(bothInitiate: boolean, iteration: number) {
  const errors: string[] = [];
  const checks: unknown[] = [];
  const signals: unknown[] = [];
  const events: { side: string; kind: string; track: string }[] = [];
  const contexts: AudioContext[] = [];
  const sources: { tracks: LocalTracks; stop: () => void }[] = [];
  const peers: Record<string, Peer> = {};
  const tracks: Record<string, LocalTracks> = {};
  const queues: Record<string, Promise<void>> = { a: Promise.resolve(), b: Promise.resolve() };
  let held: { from: string; data: SignalPayload }[] | null = [];
  let closed = false;
  const assert = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message);
  };
  function source(freq: number) {
    const context = new AudioContext();
    contexts.push(context);
    const makeAudio = (hz: number) => {
      const osc = context.createOscillator();
      const gain = context.createGain();
      const destination = context.createMediaStreamDestination();
      osc.frequency.value = hz;
      gain.gain.value = 0.15;
      osc.connect(gain).connect(destination);
      osc.start();
      return destination.stream.getAudioTracks()[0];
    };
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;
    const ctx = canvas.getContext('2d')!;
    let frame = 0;
    const timer = setInterval(() => {
      ctx.fillStyle = `hsl(${frame++ % 360} 80% 50%)`;
      ctx.fillRect(0, 0, 160, 90);
    }, 70);
    const media: LocalTracks = {
      mic: makeAudio(freq),
      screenAudio: makeAudio(freq * 2),
      screen: canvas.captureStream(10).getVideoTracks()[0],
    };
    const entry = { tracks: media, stop() { clearInterval(timer); Object.values(media).forEach(t => t?.stop()); } };
    sources.push(entry);
    return media;
  }
  function deliver(from: string, data: SignalPayload) {
    if (closed) return;
    const to = from === 'a' ? 'b' : 'a';
    queues[to] = queues[to].then(async () => {
      if (!closed) await peers[to].handleSignal(data, tracks[to], targets);
    }).catch(err => errors.push(`transport ${to}: ${String(err)}`));
  }
  function send(from: string, data: SignalPayload) {
    if (closed) return;
    if ('description' in data && data.description) {
      if (signals.length > 30) throw new Error('negotiation loop');
      signals.push({ from, type: data.description.type, sections: sections(data.description.sdp) });
    }
    if (held) held.push({ from, data });
    else deliver(from, data);
  }
  function release() {
    const pending = held!;
    held = null;
    for (const { from, data } of pending) deliver(from, data);
  }
  function newPeer(side: string) {
    const other = side === 'a' ? 'b' : 'a';
    const peer = new Peer(other, side === 'b', () => tuning, {
      send: (_to, data) => send(side, data),
      onTrack: (_id, kind, stream) => {
        if (stream) events.push({ side, kind, track: stream.getTracks()[0].id });
      },
      onConnectionState: () => {},
      onError: (_id, err) => errors.push(`${side}: ${String(err)}`),
    });
    return peer;
  }
  const stable = () => Object.values(peers).every(p => p.pc.connectionState === 'connected' && p.pc.signalingState === 'stable');
  async function snapshot() {
    const result: Record<string, any> = {};
    for (const side of ['a', 'b']) {
      const peer = peers[side];
      const report = await peer.pc.getStats();
      let audioOut = 0, audioIn = 0, videoOut = 0, videoIn = 0;
      const rtp: unknown[] = [];
      report.forEach(stat => {
        if (stat.type !== 'outbound-rtp' && stat.type !== 'inbound-rtp') return;
        rtp.push({ type: stat.type, kind: stat.kind, mid: stat.mid, codec: report.get(stat.codecId)?.mimeType, frames: stat.framesEncoded, active: stat.active, bytes: stat.bytesSent ?? stat.bytesReceived });
        if (stat.kind === 'audio') { audioOut += stat.bytesSent ?? 0; audioIn += stat.bytesReceived ?? 0; }
        if (stat.kind === 'video') { videoOut += stat.bytesSent ?? 0; videoIn += stat.bytesReceived ?? 0; }
      });
      result[side] = {
        connection: peer.pc.connectionState, signaling: peer.pc.signalingState,
        sections: sections(peer.pc.localDescription?.sdp),
        transceivers: peer.pc.getTransceivers().map(tx => ({
          mid: tx.mid, direction: tx.currentDirection, senderKind: tx.sender.track?.kind,
          senderTrack: tx.sender.track?.id, receiverTrack: tx.receiver.track.id, stopped: tx.stopped,
        })),
        audioOut, audioIn, videoOut, videoIn, rtp,
      };
    }
    return result;
  }
  async function verify(stage: string, previous?: Record<string, any>) {
    await waitFor(stable, `${stage}: stable/connected`);
    await waitFor(async () => {
      const s = await snapshot();
      return ['a', 'b'].every(side => s[side].audioOut > (previous?.[side].audioOut ?? 0) + 100 && s[side].audioIn > (previous?.[side].audioIn ?? 0) + 100 && s[side].videoIn > (previous?.[side].videoIn ?? 0) + 100);
    }, `${stage}: bidirectional audio/video RTP`);
    const s = await snapshot();
    for (const side of ['a', 'b']) {
      for (const mid of [s[side].sections[0].mid, s[side].sections[2].mid]) {
        for (const type of ['inbound-rtp', 'outbound-rtp']) {
          assert(s[side].rtp.some((r: any) => r.kind === 'audio' && r.mid === mid && r.type === type && r.bytes > 100), `${side} ${stage}: no audio on ${mid} ${type}`);
        }
      }
      const desc = s[side].sections;
      assert(desc.length === 3, `${side} ${stage}: expected 3 m-lines, got ${desc.length}`);
      assert(desc.map((x: any) => x.kind).join(',') === 'audio,video,audio', `${side} ${stage}: m-line order changed`);
      const mic = s[side].transceivers.find((tx: any) => tx.senderTrack === tracks[side].mic!.id);
      assert(mic?.mid === desc[0].mid, `${side} ${stage}: microphone not mapped to first m-line`);
      const screenAudio = s[side].transceivers.find((tx: any) => tx.senderTrack === tracks[side].screenAudio!.id);
      assert(screenAudio?.mid === desc[2].mid, `${side} ${stage}: system audio not mapped to third m-line`);
      for (const [i, kind] of ['mic', 'screen', 'screenAudio'].entries()) {
        const tx = s[side].transceivers.find((tx: any) => tx.mid === desc[i].mid);
        assert(events.some(ev => ev.side === side && ev.kind === kind && ev.track === tx.receiverTrack), `${side} ${stage}: onTrack routing mismatch for ${kind}`);
      }
    }
    checks.push({ stage, snapshot: s });
    return s;
  }
  try {
    tracks.a = source(440); tracks.b = source(660);
    await Promise.all(contexts.map(c => c.resume()));
    peers.a = newPeer('a'); peers.b = newPeer('b');
    // A receiver may get attachTracks before its remote transceivers exist.
    peers.b.attachTracks(tracks.b);
    peers.a.initiate(tracks.a, targets);
    if (bothInitiate) peers.b.initiate(tracks.b, targets);
    await waitFor(() => ['a', ...(bothInitiate ? ['b'] : [])].every(side => held!.some(item => item.from === side && 'description' in item.data && item.data.description?.type === 'offer')), 'initial offer barrier');
    release();
    const initial = await verify('initial');
    held = [];
    peers.a.pc.restartIce(); peers.b.pc.restartIce();
    await waitFor(() => ['a', 'b'].every(side => held!.some(item => item.from === side && 'description' in item.data && item.data.description?.type === 'offer')), 'restart offer barrier');
    release();
    const restarted = await verify('simultaneous ICE restart', initial);
    for (const side of ['a', 'b']) assert(initial[side].sections[0].ufrag !== restarted[side].sections[0].ufrag, `${side}: ICE credentials did not change`);
    const oldSources = [...sources];
    tracks.a = source(520); tracks.b = source(780);
    await Promise.all(contexts.map(c => c.resume()));
    peers.a.attachTracks(tracks.a); peers.b.attachTracks(tracks.b);
    await verify('replace tracks', restarted);
    oldSources.forEach(s => s.stop());
    await pause(250);
    assert(errors.length === 0, `Peer errors: ${errors.join(' | ')}`);
    return { scenario: bothInitiate ? 'both initiate' : 'receiver never initiates', iteration, ok: true, checks, errors, signals };
  } catch (err) {
    return { scenario: bothInitiate ? 'both initiate' : 'receiver never initiates', iteration, ok: false, failure: String(err), checks, errors, signals, final: await snapshot().catch(() => ({})) };
  } finally {
    closed = true;
    Object.values(peers).forEach(p => p.close());
    sources.forEach(s => s.stop());
    await Promise.all(contexts.map(c => c.close()));
  }
}
(window as any).runRtcValidation = async (count = 2) => {
  const cases = [];
  for (let i = 0; i < count; i++) {
    cases.push(await testCase(false, i));
    cases.push(await testCase(true, i));
  }
  return { passed: cases.filter(c => c.ok).length, failed: cases.filter(c => !c.ok).length, cases };
};
