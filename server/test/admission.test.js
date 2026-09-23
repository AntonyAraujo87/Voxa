import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Admission } from "../lib/admission.js";
import { clientIp, observedClientIp } from "../lib/security.js";
import { createHttpApp } from "../lib/http.js";
import { spawn } from "node:child_process";

test("reserva de transporte limita simultaneos e libera exatamente uma vez", () => {
  const gate = new Admission(3, 2);
  const a = gate.reserve("a"), b = gate.reserve("a"), c = gate.reserve("b");
  assert.ok(a && b && c);
  assert.equal(gate.reserve("a"), null);
  assert.equal(gate.reserve("c"), null);
  a.release(); a.release();
  const d = gate.reserve("c"); assert.ok(d);
  assert.equal(gate.reserve("d"), null);
  b.release(); c.release(); d.release();
});

test("XFF nao usa prefixo forjado e IPv6 agrupa a mesma rede", () => {
  const previous = process.env.TRUST_PROXY;
  try {
    process.env.TRUST_PROXY = "1";
    const socket = { handshake: { address: "127.0.0.1", headers: { "x-forwarded-for": "1.1.1.1, 8.8.8.8" } } };
    assert.equal(clientIp(socket), "8.8.8.8");
    socket.handshake.address = "9.9.9.9";
    assert.equal(clientIp(socket), "9.9.9.9");
    process.env.TRUST_PROXY = "0";
    socket.handshake.address = "::ffff:192.168.0.1";
    assert.equal(clientIp(socket), "192.168.0.1");
    socket.handshake.address = "2001:db8::1";
    const key = clientIp(socket);
    socket.handshake.address = "2001:0db8:0:0::abcd";
    assert.equal(clientIp(socket), key);
    assert.equal(observedClientIp(socket), "2001:0db8:0:0::abcd");
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = previous;
  }
});

test("HTTP real responde 429 no limite e health nao revela ocupacao", async () => {
  const server = createServer(createHttpApp());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/health`;
    const first = await fetch(url);
    assert.deepEqual(await first.json(), { ok: true });
    assert.equal(first.headers.get("x-powered-by"), null);
    for (let i = 1; i < 120; i++) { const result = await fetch(url); assert.equal(result.status, 200); await result.text(); }
    const limited = await fetch(url);
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get("retry-after"));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("flood de transportes sem Socket.IO hello e bloqueado antes da autenticacao", { timeout: 15000 }, async () => {
  const child = spawn(process.execPath, ["server/index.js"], { env: { ...process.env, PORT: "3302", VOXA_TOKEN: "local-only", TRUST_PROXY: "0" }, stdio: "ignore", windowsHide: true });
  const sockets = [];
  const open = () => new Promise(resolve => {
    const socket = new WebSocket("ws://127.0.0.1:3302/socket.io/?EIO=4&transport=websocket");
    sockets.push(socket);
    socket.onopen = () => resolve(true);
    socket.onerror = () => resolve(false);
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch("http://127.0.0.1:3302/health")).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.deepEqual(await Promise.all(Array.from({ length: 10 }, open)), Array(10).fill(true));
    assert.equal(await open(), false);
    sockets[0].close();
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await open(), true);
  } finally {
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.close();
    child.kill();
  }
});
