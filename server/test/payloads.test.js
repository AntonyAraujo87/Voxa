import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

test('payloads JSON malformados nao derrubam signaling nem clientes validos', { timeout: 25000 }, async () => {
  const url = 'http://127.0.0.1:3213', token = 'payload-test-only';
  const server = spawn(process.execPath, [fileURLToPath(new URL('../index.js', import.meta.url))], {
    env: { ...process.env, PORT: '3213', VOXA_TOKEN: token }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let startupError = '';
  server.stderr.on('data', chunk => { startupError = (startupError + chunk.toString()).slice(-1500); });
  server.on('error', error => { startupError = error.message; });
  const clients = [];
  const connect = async auth => {
    const socket = io(url, { transports: ['websocket'], reconnection: false, auth, timeout: 1500 });
    clients.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    return socket;
  };
  const send = (socket, event, payload) => socket.timeout(1500).emitWithAck(event, payload);
  try {
    let ready = false;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && server.exitCode === null) {
      try { if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, `servidor local iniciou: exit=${server.exitCode}; ${startupError}`);
    const user = { id: 'valid-user', name: 'Valid', color: '#fff' };
    const valid = await connect({ token });
    assert.ok((await send(valid, 'hello', { user })).selfId);

    const outsider = await connect({});
    // Sao objetos JSON comuns, sem funcoes: a coercao String/Number tenta
    // chamar propriedades nao executaveis e lancava TypeError no handler.
    const rejected = await send(outsider, 'hello', { token: { toString: null, valueOf: null } });
    assert.equal(rejected.error, 'token-invalido');
    assert.equal(server.exitCode, null); assert.equal(valid.connected, true);

    const base = { channelId: 'geral', content: 'texto preservado', attachmentUrl: 'https://example.com/file', attachmentName: 'file', attachmentMime: 'text/plain' };
    const malformed = await send(valid, 'chat:send', { ...base, id: 'bad-size', attachmentSize: { toString: null, valueOf: null } });
    assert.equal(malformed.content, base.content); assert.equal(malformed.attachmentUrl, undefined);
    const numeric = await send(valid, 'chat:send', { ...base, id: 'valid-size', attachmentSize: 12 });
    assert.equal(numeric.attachmentSize, 12);
    const legacy = await send(valid, 'chat:send', { ...base, id: 'string-size', attachmentSize: '12' });
    assert.equal(legacy.attachmentSize, 12);
    assert.equal((await fetch(`${url}/health`)).status, 200);
    assert.equal(server.exitCode, null); assert.equal(valid.connected, true);
  } finally {
    for (const client of clients) client.close();
    if (server.pid && server.exitCode === null && server.signalCode === null) {
      const exited = new Promise(resolve => server.once('exit', resolve));
      server.kill(); await exited;
    }
  }
});
