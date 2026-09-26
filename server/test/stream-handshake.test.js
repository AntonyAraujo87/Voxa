import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { io } from "socket.io-client";

const protocol = "spake2-p256-rfc9382-v1";
const share = Buffer.alloc(65, 1).toString("base64url");
const confirmation = Buffer.alloc(32, 2).toString("base64url");

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(error => error ? reject(error) : resolve(port)); });
  });
}
function emit(socket, event, payload) { return new Promise((resolve, reject) => socket.timeout(3000).emit(event, payload, (error, response) => error ? reject(error) : resolve(response))); }
async function waitHealth(url) { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${url}/health`)).ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error("server did not start"); }

test("real signaling relays PAKE and hides routes until peers confirm locally", { timeout: 15_000 }, async () => {
  const port = await freePort(); const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server/index.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), TRUST_PROXY: "0", VOXA_RELAY_PUBLIC_ENDPOINT: "203.0.113.90:3479", VOXA_RELAY_SECRET: "test-relay-secret-with-at-least-32-bytes" }, stdio: "ignore" });
  const sockets = [];
  try {
    await waitHealth(url);
    const connect = () => new Promise((resolve, reject) => { const socket = io(url, { transports: ["websocket"] }); sockets.push(socket); socket.once("connect", async () => { try { assert.equal((await emit(socket, "hello", {})).ok, true); resolve(socket); } catch (error) { reject(error); } }); socket.once("connect_error", reject); });
    const legacy = await connect();
    assert.match((await emit(legacy, "stream:join", { room: "legacy", role: "host" })).error, /SPAKE2/);

    const host = await connect(); const viewer = await connect();
    assert.equal((await emit(host, "stream:join", { room: "race", role: "host", protocol })).ok, true);
    const hostStub = new Promise(resolve => host.once("stream:peer", resolve));
    const joined = await emit(viewer, "stream:join", { room: "race", role: "viewer", protocol });
    assert.equal(joined.maxViewers, 4);
    assert.deepEqual(Object.keys(joined.peers[0]).sort(), ["peerId", "role"]);
    assert.deepEqual(Object.keys(await hostStub).sort(), ["peerId", "role"]);

    const shortShare = Buffer.alloc(33, 1).toString("base64url");
    assert.match((await emit(viewer, "stream:pake", { peerId: host.id, protocol, share: shortShare })).error, /SPAKE2/);
    const hostShare = new Promise(resolve => host.once("stream:pake", resolve));
    assert.equal((await emit(viewer, "stream:pake", { peerId: host.id, protocol, share })).ok, true);
    assert.equal((await hostShare).peerId, viewer.id);
    const shortConfirmation = Buffer.alloc(16, 2).toString("base64url");
    assert.match((await emit(host, "stream:pake-confirm", { peerId: viewer.id, confirmation: shortConfirmation })).error, /Confirmação/);
    const viewerConfirm = new Promise(resolve => viewer.once("stream:pake-confirm", resolve));
    assert.equal((await emit(host, "stream:pake-confirm", { peerId: viewer.id, confirmation })).ok, true);
    assert.equal((await viewerConfirm).peerId, host.id);

    const malformed = await emit(viewer, "stream:ready", { peerId: host.id, endpoint: "127.0.0.1:42000", localEndpoint: "192.168.1.20:42000", publicKey: "curta", codecs: 1 });
    assert.match(malformed.error, /X25519/);

    const hostReady = new Promise(resolve => host.once("stream:ready", resolve));
    assert.equal((await emit(viewer, "stream:ready", { peerId: host.id, endpoint: "127.0.0.1:42000", localEndpoint: "192.168.1.20:42000", publicKey: "v".repeat(43), codecs: 1 })).ok, true);
    const announced = await hostReady;
    assert.equal(announced.peerId, viewer.id);
    assert.equal(announced.endpoint, "192.168.1.20:42000");
    assert.equal(announced.publicKey, "v".repeat(43));
    assert.equal(announced.relayEndpoint, "203.0.113.90:3479");
    assert.equal("sessionKey" in announced, false);

    const attacker = await connect();
    assert.equal((await emit(attacker, "stream:join", { room: "other", role: "viewer", protocol })).ok, true);
    assert.ok((await emit(attacker, "stream:pake", { peerId: host.id, protocol, share })).error);
    assert.ok((await emit(attacker, "stream:ready", { peerId: host.id, endpoint: "127.0.0.1:44000", localEndpoint: "192.168.1.40:44000", publicKey: "x".repeat(43), codecs: 1 })).error);

    const leavingId = viewer.id; const peerLeft = new Promise(resolve => host.once("stream:peer-left", resolve));
    viewer.disconnect(); assert.equal((await peerLeft).peerId, leavingId);
  } finally { for (const socket of sockets) socket.disconnect(); child.kill(); }
});
