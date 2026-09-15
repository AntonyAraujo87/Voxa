import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import { registerHandlers } from '../lib/handlers.js';
import { Registry } from '../lib/state.js';
import { RateLimiter } from '../lib/security.js';

function fixture(run) {
  const previousUrls = process.env.VOXA_TURN_URLS, previousSecret = process.env.VOXA_TURN_SECRET;
  const broadcasts = [], registry = new Registry(), socket = new EventEmitter();
  const destination = { emit: (...args) => broadcasts.push(args) };
  const secret = 'local-test-only';
  process.env.VOXA_TURN_URLS = 'turn:relay.invalid:3478';
  process.env.VOXA_TURN_SECRET = secret;
  Object.assign(socket, { id: 'socket-test', data: { authed: true, ip: '127.0.0.1' }, join() {}, leave() {}, to: () => destination });
  socket.disconnect = () => socket.emit('disconnect');
  registerHandlers({ io: { to: () => destination }, socket, registry, limiter: new RateLimiter(), token: 'room-test-only', log: { warn() {} } });
  const hello = payload => { let response; socket.emit('hello', payload, value => { response = value; }); return response; };
  try { run({ socket, hello, registry, broadcasts, secret }); }
  finally {
    socket.disconnect();
    if (previousUrls === undefined) delete process.env.VOXA_TURN_URLS; else process.env.VOXA_TURN_URLS = previousUrls;
    if (previousSecret === undefined) delete process.env.VOXA_TURN_SECRET; else process.env.VOXA_TURN_SECRET = previousSecret;
  }
}

test('hello repetido entrega TURN quando a primeira resposta nao foi recebida', () => fixture(({ socket, hello, secret }) => {
  socket.emit('hello', { user: { id: 'alice', name: 'Alice', color: '#fff' } });
  const response = hello({});
  assert.equal(response.selfId, socket.id);
  assert.ok(Array.isArray(response.iceServers), 'retry deve conter configuracao ICE');
  const [turn] = response.iceServers;
  assert.deepEqual(turn.urls, ['turn:relay.invalid:3478']);
  assert.equal(turn.credential, createHmac('sha1', secret).update(turn.username).digest('base64'));
  assert.ok(Number(turn.username.split(':')[0]) > Date.now() / 1000);
}));

test('reapresentacao preserva identidade e canal e nao repete broadcast', () => fixture(({ socket, hello, registry, broadcasts }) => {
  hello({ user: { id: 'alice', name: 'Alice', color: '#fff' } });
  socket.emit('voice:join', { channelId: 'lounge' });
  const count = broadcasts.length;
  const response = hello({ user: { id: 'changed', name: 'Other', color: '#000' } });
  assert.equal(registry.size, 1);
  assert.equal(response.roster[0].user.id, 'alice');
  assert.equal(response.roster[0].voice, 'lounge');
  assert.equal(broadcasts.length, count);
  assert.equal(response.iceServers?.length, 1);
}));
