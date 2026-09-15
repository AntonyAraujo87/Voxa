import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readEndpoint } from './check-deployment.mjs';

async function probe(handler, overrides = {}, timeoutMs = 2000) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await readEndpoint({
      url: `http://127.0.0.1:${server.address().port}/health`,
      expectedStatus: 200, kind: 'signaling', ...overrides,
    }, { get: http.get, timeoutMs });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('health exige status correto e corpo minimo', async () => {
  for (const [status, body, expected] of [
    [200, '{"ok":true}', true], [500, '{"ok":true}', false],
    [200, '{"ok":false}', false], [200, '{"ok":true,"rss":42}', false],
    [200, '<html>proxy error</html>', false], [200, 'null', false],
  ]) {
    const result = await probe((req, res) => { res.writeHead(status); res.end(body); });
    assert.equal(result.healthy, expected, `${status} ${body}`);
  }
});

test('401 do Auth sem chave nao e confundido com login validado', async () => {
  const result = await probe((req, res) => {
    res.writeHead(401); res.end('{"message":"No API key found","hint":"private detail"}');
  }, { expectedStatus: 401, kind: 'auth-unauthenticated' });
  assert.equal(result.healthy, true);
  assert.equal(JSON.stringify(result).includes('private detail'), false);
  assert.equal(result.authorized, undefined, 'HTTP local nao comprova TLS');
});

test('corpo acima do teto encerra leitura sem imprimir conteudo', async () => {
  const result = await probe((req, res) => res.end('secret'.repeat(4000)));
  assert.equal(result.error, 'response-too-large');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('resposta interrompida encerra o probe', async () => {
  const result = await probe((req, res) => {
    res.writeHead(200, { 'content-length': '1000' }); res.write('{');
    setImmediate(() => res.destroy());
  });
  assert.equal(result.healthy, false);
  assert.ok(['response-interrupted', 'ECONNRESET'].includes(result.error));
});

test('servidor que envia bytes continuamente respeita prazo absoluto', async () => {
  const result = await probe((req, res) => {
    const timer = setInterval(() => res.write(' '), 10);
    res.once('close', () => clearInterval(timer));
  }, {}, 120);
  assert.equal(result.error, 'timeout');
  assert.equal(result.healthy, false);
});
