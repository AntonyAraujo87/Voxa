import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';

await mkdir('work', { recursive: true });
await build({ stdin: { contents: 'export {useApp} from "./src/store/store.ts"; export {Peer} from "./src/lib/rtc/peer.ts"; export {Signaling,SignalingRequestError} from "./src/lib/signaling.ts"; export {historyCursor} from "./src/lib/historyCursor.ts";', resolveDir: process.cwd() }, bundle: true, format: 'cjs', platform: 'node', outfile: 'work/review-regression-subject.cjs', define: { 'import.meta.env': '{}' } });
globalThis.document = { hidden: false };
globalThis.window = { setTimeout, clearTimeout, addEventListener() {} };
const { useApp, Peer, Signaling, SignalingRequestError, historyCursor } = createRequire(import.meta.url)(resolve('work/review-regression-subject.cjs'));
let checks = 0;
const installerGate = await readFile('scripts/check-installer.ps1', 'utf8');
assert.doesNotMatch(installerGate, /\$builtExe|igual ao build/,
  'Nao comparar PE de NSIS com target posteriormente remendado para MSI');
assert.match(installerGate, /ProductVersion/);
assert.match(installerGate, /Check-Installed -ExpectedHash \$nsisHash/);
assert.match(installerGate, /Check-Installed -ExpectedHash \$msiHash/); checks++;
const msg = { id: 'one', channelId: 'geral', authorId: 'me', authorName: 'Alice', authorColor: '#fff', content: 'mensagem', createdAt: '2026-09-09T00:00:00.000Z' };
useApp.setState({ messages: {}, activeText: 'geral', me: { id: 'me', name: 'Alice', color: '#fff' }, unread: {}, mentions: {} });
useApp.getState().pushMessage({ ...msg, pending: true, failed: false });
useApp.getState().pushMessage({ ...msg, pending: false, failed: true });
assert.equal(useApp.getState().messages.geral[0].pending, false);
assert.equal(useApp.getState().messages.geral[0].failed, true);
useApp.getState().pushMessage({ ...msg, pending: false, failed: false, content: 'confirmada' });
assert.equal(useApp.getState().messages.geral.length, 1);
assert.equal(useApp.getState().messages.geral[0].content, 'confirmada');
useApp.getState().pushMessage({ ...msg, authorId: 'outro', content: 'colisao' });
assert.equal(useApp.getState().messages.geral[0].content, 'confirmada');
assert.deepEqual(useApp.getState().unread, {}); checks++;

useApp.getState().setMessages('geral', Array.from({ length: 700 }, (_, index) => ({ ...msg, id: String(index) })));
useApp.getState().pushMessage({ ...msg, id: 'new-live' });
assert.equal(useApp.getState().messages.geral.length, 700, 'Uma mensagem ao vivo nao pode descartar centenas de mensagens paginadas');
assert.equal(useApp.getState().messages.geral.at(-1).id, 'new-live'); checks++;

// replaceTrack real e assincrono. Controlamos sua conclusao para exercitar
// uma troca ainda pendente quando chega o pedido seguinte.
globalThis.RTCPeerConnection = class { close() {} };
const p = new Peer('remote', true, () => ({}), { onError() {} });
p.ready = true;
let release, started;
const gate = new Promise(done => release = done), began = new Promise(done => started = done);
const track = { kind: 'video', readyState: 'live' };
p.videoTx = { sender: { track: null, async replaceTrack(next) { started(); await gate; this.track = next; } } };
try {
  p.attachTracks({ mic: null, screen: track, screenAudio: null });
  await began;
  p.attachTracks({ mic: null, screen: null, screenAudio: null });
  release(); await p.tracksPending;
  assert.equal(p.videoTx.sender.track, null); checks++;
} finally { release(); p.close(); }

const sig = new Signaling();
try {
  // Socket.IO real; subEvents arma a reconexao sem abrir rede neste teste.
  sig.socket.subEvents();
  sig.ready = true; sig.credentials = { user: { id: 'me', name: 'Alice', color: '#fff' }, token: 'local-test' };
  sig.request = async () => { throw new SignalingRequestError('timeout hello', true); };
  await sig.identify();
  assert.equal(sig.socket.active, true);
  assert.ok(sig.identifyRetry); checks++;
  sig.request = async () => ({ selfId: 'restored', roster: [] });
  await sig.identify();
  assert.equal(sig.selfId, 'restored'); assert.equal(sig.identifyRetry, null); checks++;
  sig.request = async () => { throw new Error('token-invalido'); };
  await sig.identify();
  assert.equal(sig.socket.active, false); assert.equal(sig.identifyRetry, null); checks++;
} finally { sig.destroy(); }

delete globalThis.window; delete globalThis.document;
const db = new PGlite();
try {
  const older = '11111111-1111-4111-8111-111111111111', current = '22222222-2222-4222-8222-222222222222';
  await db.exec(`create table messages(id uuid, created_at timestamptz); insert into messages values ('${older}','2026-09-09T12:00:00.123100Z'),('${current}','2026-09-09T12:00:00.123500Z');`);
  const filter = historyCursor('2026-09-09T12:00:00.123500+00:00', current);
  // Usa a fronteira exata enviada ao PostgREST como parametro da consulta SQL.
  const timestamp = /^created_at\.lt\.([^,]+)/.exec(filter)[1];
  const rows = (await db.query('select id from messages where created_at < $1 or (created_at = $1 and id < $2)', [timestamp, current])).rows;
  assert.deepEqual(rows.map(row => row.id), [older]);
  assert.equal(historyCursor('2026-09-09T12:00:00Z),id.gt.foo', current), null); checks++;
} finally { await db.close(); }
await mkdir('test-results', { recursive: true });
await writeFile('test-results/review-regressions.json', JSON.stringify({ status: 'PASS', checks }, null, 2));
console.log(JSON.stringify({ status: 'PASS', checks }));
