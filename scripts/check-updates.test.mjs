import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const subject = await build({
  entryPoints: ['src/lib/sessionUpdates.ts'], bundle: true, write: false,
  platform: 'node', format: 'cjs',
  plugins: [{ name: 'updater-devices', setup(builder) {
    builder.onResolve({ filter: /^\.\/desktop$|^\.\/diagnostico$|^\.\.\/store\/store$/ }, args => ({ path: args.path, namespace: 'controlled' }));
    builder.onLoad({ filter: /.*/, namespace: 'controlled' }, () => ({ contents: `
      export const checkForUpdate = () => globalThis.__voxaUpdates.check();
      export const registrarErro = (...args) => globalThis.__voxaUpdates.errors.push(args);
      export const useApp = {
        setState: patch => Object.assign(globalThis.__voxaUpdates.state, patch),
        getState: () => ({ toast: (...args) => globalThis.__voxaUpdates.toasts.push(args) })
      };
    ` }));
  } }],
});
const loaded = { exports: {} };
new Function('module', 'exports', subject.outputFiles[0].text)(loaded, loaded.exports);
const { SessionUpdates } = loaded.exports;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const tick = () => new Promise(done => setImmediate(done));
function setup() {
  const env = { check: async () => null, errors: [], toasts: [], state: {} };
  globalThis.__voxaUpdates = env;
  return { manager: new SessionUpdates(), env };
}
function resource(version = '1.0.0') {
  return { version, closed: 0, installs: 0, async close() { this.closed++; }, async install() { this.installs++; } };
}

test('nova consulta libera recurso anterior, inclusive quando nao existe atualizacao', async () => {
  const { manager, env } = setup(), first = resource(), second = resource('1.1.0');
  env.check = async () => first; await manager.check();
  env.check = async () => second; await manager.check();
  assert.equal(first.closed, 1); assert.equal(second.closed, 0);
  env.check = async () => null; await manager.check();
  assert.equal(second.closed, 1); assert.equal(env.state.updateVersion, null);
  manager.destroy(); await tick(); assert.equal(second.closed, 1);
});
test('falha de consulta preserva recurso ainda instalavel', async () => {
  const { manager, env } = setup(), update = resource();
  env.check = async () => update; await manager.check();
  env.check = async () => { throw Error('offline'); }; await manager.check();
  await manager.install(); assert.equal(update.installs, 1); assert.equal(update.closed, 0);
  manager.destroy(); await tick(); assert.equal(update.closed, 1);
});
test('resposta tardia apos destroy e liberada sem republicar estado', async () => {
  const { manager, env } = setup(), update = resource(), gate = deferred();
  env.check = () => gate.promise; const checking = manager.check();
  manager.destroy(); const state = { ...env.state }; gate.resolve(update); await checking;
  assert.equal(update.closed, 1); assert.deepEqual(env.state, state); assert.equal(env.toasts.length, 0);
  await manager.check(); await manager.install(); assert.equal(update.installs, 0);
});
test('destroy espera instalacao ativa antes de liberar recurso e nao duplica cliques', async () => {
  const { manager, env } = setup(), update = resource(), gate = deferred();
  update.install = async () => { update.installs++; await gate.promise; };
  env.check = async () => update; await manager.check();
  const installing = manager.install(); await manager.install(); await manager.check();
  manager.destroy(); assert.equal(update.closed, 0); assert.equal(update.installs, 1);
  gate.resolve(); await installing; assert.equal(update.closed, 1);
  manager.destroy(); await tick(); assert.equal(update.closed, 1);
});
test('falha de download permite nova tentativa com o mesmo recurso', async () => {
  const { manager, env } = setup(), update = resource();
  update.install = async () => { if (++update.installs === 1) throw Error('download'); };
  env.check = async () => update; await manager.check(); await manager.install(); await manager.install();
  assert.equal(update.installs, 2); assert.equal(update.closed, 0); assert.equal(env.state.updateBusy, false);
  manager.destroy(); await tick(); assert.equal(update.closed, 1);
});
test('falha ao liberar recurso anterior nao descarta nova atualizacao', async () => {
  const { manager, env } = setup(), first = resource(), next = resource('1.1.0');
  first.close = async () => { throw Error('close'); };
  env.check = async () => first; await manager.check();
  env.check = async () => next; await manager.check(); await manager.install();
  assert.equal(next.installs, 1); assert.equal(env.errors.length, 1); assert.equal(env.state.updateBusy, false);
  manager.destroy(); await tick(); assert.equal(next.closed, 1);
});
