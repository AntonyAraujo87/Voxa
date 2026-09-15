import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// Carrega a classe real, incluindo tuning/SDP. Somente as APIs do navegador
// sao simuladas; nenhuma funcao de Peer e substituida pelo teste.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("./peer.ts", import.meta.url))],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  define: { "import.meta.env": "{}" },
});
const { Peer } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

const TUNING = { video: "alta", audio: "voz", codec: "hardware", content: "jogo" };
const TARGETS = { maxBitrate: 1_000_000, maxFramerate: 30, scaleDownBy: 1 };
const NO_TRACKS = { mic: null, screen: null, screenAudio: null };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function sdp(mids = ["0", "1", "2"]) {
  return [
    "v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0",
    ...mids.flatMap((mid, index) => [
      `m=${index === 1 ? "video" : "audio"} 9 UDP/TLS/RTP/SAVPF ${index === 1 ? "96" : "111"}`,
      "c=IN IP4 0.0.0.0", `a=mid:${mid}`, "a=sendrecv",
      index === 1 ? "a=rtpmap:96 VP8/90000" : "a=rtpmap:111 opus/48000/2",
    ]), "",
  ].join("\r\n");
}

function description(value) {
  return { ...value, toJSON: () => ({ type: value.type, sdp: value.sdp }) };
}

function transceiver(kind, mid = null) {
  return {
    mid,
    stopped: false,
    direction: "sendrecv",
    currentDirection: null,
    sender: {
      track: null,
      async replaceTrack(track) { this.track = track; },
      getParameters: () => ({ encodings: [{}] }),
      async setParameters() {},
    },
    receiver: { track: { kind, enabled: true } },
    stop() { this.stopped = true; this.direction = "stopped"; },
    setCodecPreferences() {},
  };
}

class FakePeerConnection {
  signalingState = "stable";
  connectionState = "new";
  iceConnectionState = "new";
  currentRemoteDescription = null;
  localDescription = null;
  remoteDescription = null;
  transceivers = [];
  events = [];
  offerGate = null;
  answerGate = null;
  failRemoteOnce = false;
  createOfferCalls = 0;
  configuration = {};
  getConfiguration() { return this.configuration; }
  setConfiguration(value) { this.configuration = value; }

  addTransceiver(kind) {
    const tx = transceiver(kind);
    this.transceivers.push(tx);
    return tx;
  }
  getTransceivers() { return this.transceivers; }
  async createOffer() {
    this.createOfferCalls++;
    this.events.push("createOffer:start");
    if (this.offerGate) await this.offerGate.promise;
    this.events.push("createOffer:end");
    return { type: "offer", sdp: sdp() };
  }
  async createAnswer() {
    this.events.push("createAnswer:start");
    if (this.answerGate) await this.answerGate.promise;
    this.events.push("createAnswer:end");
    return { type: "answer", sdp: this.remoteDescription.sdp };
  }
  async setLocalDescription(value) {
    this.events.push(`local:${value.type}`);
    if (this.signalingState === "closed") throw new Error("connection closed");
    if (value.type === "rollback") {
      if (this.signalingState === "stable") throw new Error("rollback in stable");
      this.signalingState = "stable";
      this.localDescription = null;
      // Chromium pode preservar os transceivers locais sem MID apos rollback.
      for (const tx of this.transceivers) tx.mid = null;
      return;
    }
    if (value.type === "answer") this.currentRemoteDescription = this.remoteDescription;
    this.localDescription = description(value);
    this.signalingState = value.type === "offer" ? "have-local-offer" : "stable";
    if (value.type === "offer") {
      this.transceivers.filter((tx) => !tx.stopped).forEach((tx, index) => { tx.mid = String(index); });
    }
  }
  async setRemoteDescription(value) {
    this.events.push(`remote:${value.type}`);
    if (this.failRemoteOnce) {
      this.failRemoteOnce = false;
      throw new Error("remote description rejected");
    }
    this.remoteDescription = description(value);
    if (value.type === "answer") this.currentRemoteDescription = this.remoteDescription;
    this.signalingState = value.type === "offer" ? "have-remote-offer" : "stable";
    if (value.type === "offer") {
      const mids = [...value.sdp.matchAll(/^a=mid:(.+)$/gm)].map((match) => match[1].trim());
      mids.forEach((mid, index) => {
        // A lista mantem os abandonados antes dos novos: indice de array nao
        // equivale ao indice de m-line. ontrack ocorre antes de SRD resolver.
        let tx = this.transceivers.find((candidate) => candidate.mid === mid && !candidate.stopped);
        if (!tx) {
          tx = transceiver(index === 1 ? "video" : "audio", mid);
          tx.direction = "recvonly";
          this.transceivers.push(tx);
        }
        this.ontrack?.({ transceiver: tx, track: tx.receiver.track, streams: [] });
      });
    }
  }
  async addIceCandidate() { this.events.push("candidate"); }
  close() { this.events.push("close"); this.signalingState = "closed"; this.connectionState = "closed"; this.transceivers.forEach(tx => tx.stop()); }
}

globalThis.RTCPeerConnection = FakePeerConnection;
globalThis.window = { setTimeout, clearTimeout };
globalThis.RTCRtpReceiver = { getCapabilities: () => null };
globalThis.MediaStream = class {
  constructor(tracks) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
};

function setup(t, polite = true) {
  const sent = [];
  const received = [];
  const errors = [];
  const peer = new Peer("remote", polite, () => TUNING, {
    send: (_id, data) => sent.push(data),
    onTrack: (_id, kind, stream) => received.push({ kind, stream }),
    onConnectionState() {},
    onError: (_id, error) => errors.push(error),
  });
  t.after(() => peer.close());
  return { peer, pc: peer.pc, sent, received, errors };
}

test("colisao inicial aguarda createOffer e responde numa conexao limpa", async (t) => {
  const { peer, pc, sent, errors } = setup(t);
  const gate = pc.offerGate = deferred();
  t.after(() => gate.resolve());
  peer.initiate(NO_TRACKS, TARGETS);
  pc.onnegotiationneeded();
  await tick();
  const incoming = peer.handleSignal({ description: { type: "offer", sdp: sdp(["r0", "r1", "r2"]) } }, NO_TRACKS, TARGETS);
  await tick();
  assert.deepEqual(pc.events, ["createOffer:start"], "SRD/rollback nao podem atravessar createOffer em andamento");
  gate.resolve();
  await incoming;
  await tick();
  assert.deepEqual(errors, []);
  assert.deepEqual(sent.map((data) => data.description?.type), ["offer", "answer"]);
  assert.equal(peer.pc.signalingState, "stable");
  assert.notEqual(peer.pc, pc);
  assert.ok(pc.events.indexOf("createOffer:end") < pc.events.indexOf("close"));
});

test("eventos negotiationneeded concorrentes produzem uma unica oferta", async (t) => {
  const { peer, pc, sent, errors } = setup(t);
  const gate = pc.offerGate = deferred();
  t.after(() => gate.resolve());
  peer.initiate(NO_TRACKS, TARGETS);
  pc.onnegotiationneeded();
  pc.onnegotiationneeded();
  await tick();
  assert.equal(pc.createOfferCalls, 1);
  gate.resolve();
  await tick();
  assert.equal(pc.createOfferCalls, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(errors, []);
});

test("colisao inicial encerra canais antigos e preserva mic/tela/audio na nova conexao", async (t) => {
  const { peer, pc, received, errors } = setup(t);
  const tracks = {
    mic: { kind: "audio", enabled: true, id: "local-mic" },
    screen: { kind: "video", enabled: true, id: "local-screen" },
    screenAudio: { kind: "audio", enabled: true, id: "local-screen-audio" },
  };
  peer.initiate(tracks, TARGETS);
  pc.onnegotiationneeded();
  await tick();
  const abandoned = [...pc.getTransceivers()];
  await peer.handleSignal({ description: { type: "offer", sdp: sdp(["remote-mic", "remote-video", "remote-audio"]) } }, tracks, TARGETS);
  assert.equal(peer.pc.signalingState, "stable");
  assert.deepEqual(errors, []);
  assert.deepEqual(received.map(({ kind }) => kind), ["mic", "screen", "screenAudio"]);
  const active = peer.pc.getTransceivers().filter((tx) => tx.mid !== null);
  assert.equal(active.length, 3);
  assert.deepEqual(active.map((tx) => tx.sender.track), [tracks.mic, tracks.screen, tracks.screenAudio]);
  assert.ok(active.every((tx) => tx.direction === "sendrecv"));
  assert.ok(abandoned.every((tx) => tx.stopped), "transceivers sem MID nao devem voltar em uma oferta posterior");
  assert.equal(peer.estadoEnvio().micNoCanal, true);
  active[1].receiver.track.onmute();
  active[2].receiver.track.onunmute();
  assert.equal(received.at(-2).kind, "screen");
  assert.equal(received.at(-2).stream, null);
  assert.equal(received.at(-1).kind, "screenAudio");
});

test("falha de setRemoteDescription nao impede o proximo sinal", async (t) => {
  const { peer, pc, sent, errors } = setup(t);
  pc.failRemoteOnce = true;
  await peer.handleSignal({ description: { type: "answer", sdp: sdp() } }, NO_TRACKS, TARGETS);
  await peer.handleSignal({ description: { type: "offer", sdp: sdp(["r0", "r1", "r2"]) } }, NO_TRACKS, TARGETS);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /remote description rejected/);
  assert.equal(sent.at(-1)?.description?.type, "answer");
  assert.equal(pc.signalingState, "stable");
});

test("fechar enquanto createOffer aguarda nao publica SDP", async (t) => {
  const { peer, pc, sent } = setup(t);
  const gate = pc.offerGate = deferred();
  t.after(() => gate.resolve());
  peer.initiate(NO_TRACKS, TARGETS);
  pc.onnegotiationneeded();
  await tick();
  peer.close();
  gate.resolve();
  await tick();
  assert.deepEqual(sent, []);
  assert.ok(!pc.events.includes("local:offer"), "uma operacao encerrada nao deve aplicar oferta local");
});

test("fechar enquanto createAnswer aguarda nao publica SDP", async (t) => {
  const { peer, pc, sent } = setup(t);
  const gate = pc.answerGate = deferred();
  t.after(() => gate.resolve());
  const incoming = peer.handleSignal({ description: { type: "offer", sdp: sdp() } }, NO_TRACKS, TARGETS);
  await tick();
  peer.close();
  gate.resolve();
  await incoming;
  assert.deepEqual(sent, []);
  assert.ok(!pc.events.includes("local:answer"), "uma operacao encerrada nao deve aplicar resposta local");
});


test("candidato antes do SDP fica na fila e e aplicado apos a oferta", async (t) => {
  const { peer, pc, errors } = setup(t);
  const candidate = { candidate: "candidate:1 1 udp 1 127.0.0.1 9999 typ host", sdpMid: "0" };
  await peer.handleSignal({ candidate }, NO_TRACKS, TARGETS);
  assert.ok(!pc.events.includes("candidate"));
  await peer.handleSignal({ description: { type: "offer", sdp: sdp() } }, NO_TRACKS, TARGETS);
  assert.ok(pc.events.indexOf("candidate") > pc.events.indexOf("remote:offer"));
  assert.deepEqual(errors, []);
});

test("peer fechado ignora novos sinais e eventos de negociacao", async (t) => {
  const { peer, pc, sent, errors } = setup(t);
  peer.close();
  const before = [...pc.events];
  peer.initiate(NO_TRACKS, TARGETS);
  await peer.handleSignal({ description: { type: "offer", sdp: sdp() } }, NO_TRACKS, TARGETS);
  assert.deepEqual(pc.events, before);
  assert.deepEqual(sent, []);
  assert.deepEqual(errors, []);
});

test("candidato invalido na fila nao impede resposta nem os candidatos seguintes", async (t) => {
  const { peer, pc, sent, errors } = setup(t);
  let accepted = 0;
  pc.addIceCandidate = async candidate => {
    if (candidate.candidate === "bad") throw new Error("invalid candidate");
    accepted++;
  };
  await peer.handleSignal({ candidate: { candidate: "bad" } }, NO_TRACKS, TARGETS);
  await peer.handleSignal({ candidate: { candidate: "good" } }, NO_TRACKS, TARGETS);
  await peer.handleSignal({ description: { type: "offer", sdp: sdp() } }, NO_TRACKS, TARGETS);
  assert.equal(accepted, 1);
  assert.equal(sent.filter(message => message.description?.type === "answer").length, 1);
  assert.equal(errors.length, 1);
});

test("conexao presa em connecting registra timeout e tenta ICE restart", async (t) => {
  const timers = new Map();
  let nextId = 0;
  const before = globalThis.window;
  globalThis.window = {
    setTimeout(fn, delay) { timers.set(++nextId, { fn, delay }); return nextId; },
    clearTimeout(id) { timers.delete(id); },
  };
  t.after(() => { globalThis.window = before; });
  const { peer, pc, errors } = setup(t);
  let restarts = 0;
  pc.restartIce = () => { restarts++; };
  pc.connectionState = "connecting";
  pc.iceConnectionState = "checking";
  pc.onconnectionstatechange();
  const fire = () => {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id);
    timer.fn();
  };
  fire();
  assert.match(String(errors[0]), /TURN nao configurado/);
  fire();
  assert.equal(restarts, 1);
  pc.connectionState = "connected";
  pc.onconnectionstatechange();
  assert.equal(timers.size, 0);
  peer.close();
});

test("rede indisponivel continua tentando apos oito falhas e encerra timers ao sair", (t) => {
  const timers = new Map();
  const before = globalThis.window;
  let nextId = 0, restarts = 0;
  globalThis.window = {
    setTimeout(fn, delay) { timers.set(++nextId, { fn, delay }); return nextId; },
    clearTimeout(id) { timers.delete(id); },
  };
  const { peer, pc, errors } = setup(t);
  try {
    pc.restartIce = () => restarts++;
    pc.connectionState = "failed"; pc.onconnectionstatechange();
    for (let attempt = 0; attempt < 12; attempt++) {
      assert.equal(timers.size, 1, "so um retry por peer");
      const [id, timer] = timers.entries().next().value;
      if (attempt >= 8) assert.ok(timer.delay >= 60000 && timer.delay <= 60400);
      timers.delete(id); timer.fn();
    }
    assert.equal(restarts, 12);
    assert.equal(errors.length, 1, "nao inunda diagnostico durante indisponibilidade longa");
    peer.close(); assert.equal(timers.size, 0);
  } finally { peer.close(); globalThis.window = before; }
});

test("estatisticas usam os MIDs negociados e descartam metricas de relatorio ausente", async (t) => {
  const { peer } = setup(t);
  await peer.handleSignal({description:{type:"offer",sdp:sdp(["voice", "video", "game"])}}, NO_TRACKS, TARGETS);
  peer.pc.getStats = async () => new Map([
    ["mic", {type:"outbound-rtp",kind:"audio",mid:"voice",bytesSent:600}],
    ["game", {type:"outbound-rtp",kind:"audio",mid:"game",bytesSent:1200}],
    ["video", {type:"inbound-rtp",kind:"video",timestamp:1000,bytesReceived:10000,packetsReceived:20,framesPerSecond:30}],
  ]);
  const current = await peer.collectStats();
  assert.equal(current.micOutBytes,600); assert.equal(current.screenAudioOutBytes,1200); assert.equal(current.fps,30);
  peer.pc.getStats = async () => new Map();
  const empty = await peer.collectStats();
  assert.equal(empty.fps,0); assert.equal(empty.outKbps,0); assert.equal(empty.audioOutBytes,0);
});
