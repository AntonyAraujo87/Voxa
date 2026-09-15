// Leitura publica limitada; nao autentica nem imprime corpos ou headers privados.
import https from 'node:https';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const endpoints = [
  { url: 'https://voxa-signaling.onrender.com/health', expectedStatus: 200, kind: 'signaling' },
  // Sem chave, 401 confirma apenas disponibilidade do endpoint e transporte.
  { url: 'https://qqnpporyphqycuzxucwz.supabase.co/auth/v1/health', expectedStatus: 401, kind: 'auth-unauthenticated' },
];

export function readEndpoint(endpoint, { get = https.get, timeoutMs = 90000 } = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    let metadata = { url: endpoint.url }, settled = false, req;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({ ...metadata, elapsedMs: Date.now() - started, ...result });
    };
    // Prazo absoluto: receber bytes lentamente nao prolonga o probe indefinidamente.
    const deadline = setTimeout(() => {
      finish({ healthy: false, error: 'timeout' });
      req?.destroy();
    }, timeoutMs);
    try {
      req = get(endpoint.url, res => {
        metadata.status = res.statusCode;
        let body = '', bytes = 0;
        res.setEncoding('utf8');
        res.on('data', part => {
          bytes += Buffer.byteLength(part);
          if (bytes > 16384) {
            finish({ healthy: false, error: 'response-too-large' });
            req.destroy();
          } else body += part;
        });
        res.on('error', () => finish({ healthy: false, error: 'response-interrupted' }));
        res.on('close', () => {
          if (!res.complete) finish({ healthy: false, error: 'response-interrupted' });
        });
        res.on('end', () => {
          let payload;
          try { payload = JSON.parse(body); }
          catch { finish({ healthy: false, error: 'invalid-json' }); return; }
          const object = payload !== null && typeof payload === 'object' && !Array.isArray(payload);
          const keys = object ? Object.keys(payload) : [];
          const validBody = endpoint.kind === 'signaling'
            ? object && payload.ok === true && keys.length === 1
            : object && typeof payload.message === 'string' && payload.message.length > 0;
          const healthy = res.statusCode === endpoint.expectedStatus && validBody;
          // Valores e nomes arbitrarios retornados pelo servidor nao vao para logs.
          finish({ healthy, ...(!healthy ? { error: 'unexpected-health-response' } : {}) });
        });
      });
      req.on('socket', socket => {
        const captureTls = () => {
          const cert = socket.getPeerCertificate();
          metadata = { ...metadata, tls: socket.getProtocol(), authorized: socket.authorized, certificateExpires: cert.valid_to };
        };
        // Tambem cobre conexao TLS reutilizada pelo agente HTTP.
        if (socket.encrypted && !socket.connecting) captureTls();
        else socket.once('secureConnect', captureTls);
      });
      req.on('error', error => finish({ healthy: false, error: error.code ?? 'request-failed' }));
    } catch { finish({ healthy: false, error: 'request-failed' }); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await Promise.all(endpoints.map(endpoint => readEndpoint(endpoint)));
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/deployment.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (results.some(result => !result.healthy || !result.authorized)) process.exitCode = 1;
}
