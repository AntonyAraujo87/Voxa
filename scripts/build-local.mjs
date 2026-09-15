import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { verifyNative } from './check-native.mjs';
import { createHash } from 'node:crypto';

// Instalador de teste local. O workflow de release continua usando os secrets
// de producao e a assinatura do atualizador.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.includes('--bundle-only')) {
  throw new Error('--bundle-only foi removido: o pacote precisa recompilar as fontes para nao distribuir um executavel antigo.');
}
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Este empacotamento local requer Windows x64.');
}
const env = { ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || join(tmpdir(), 'voxa-cargo-target') };
function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root, env, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} terminou com codigo ${result.status}`);
  return result.stdout;
}
const host = /^host: (.+)$/m.exec(run('rustc', ['-vV'], true))?.[1].trim();
if (!host?.startsWith('x86_64-pc-windows-')) throw new Error(`Target nao suportado: ${host}`);
const metadata = JSON.parse(run('cargo', ['metadata', '--offline', '--locked', '--format-version=1',
  '--filter-platform', host, '--manifest-path', 'src-tauri/Cargo.toml'], true));
const webview = metadata.packages.find(pkg => pkg.name === 'webview2-com-sys');
if (!webview) throw new Error('Dependencia webview2-com-sys nao encontrada.');
const artifacts = join(root, 'artifacts');
const native = join(artifacts, 'native');
mkdirSync(native, { recursive: true });
const loader = join(native, 'WebView2Loader.dll');
// A versao vem do Cargo.lock. Nenhuma DLL e buscada em sites avulsos.
copyFileSync(join(dirname(webview.manifest_path), 'x64', 'WebView2Loader.dll'), loader);
const config = join(artifacts, 'local-bundle.json');
writeFileSync(config, JSON.stringify({ bundle: {
  createUpdaterArtifacts: false,
  resources: { [loader]: 'WebView2Loader.dll' },
} }, null, 2));
run(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'),
  'build',
  '--bundles', 'nsis', '--no-sign', '--config', config]);
const manifest = readFileSync(join(env.CARGO_TARGET_DIR, 'release/nsis/x64/installer.nsi'), 'utf8');
if (!/File[^\r\n]*\/oname=WebView2Loader\.dll/i.test(manifest)) {
  throw new Error('Instalador nao inclui WebView2Loader.dll ao lado do executavel.');
}
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const imports = verifyNative(join(env.CARGO_TARGET_DIR, 'release/voxa.exe'), join(env.CARGO_TARGET_DIR, 'release/nsis/x64/installer.nsi'));
const installer = join(artifacts, `Voxa_${version}_x64-setup-corrigido.exe`);
copyFileSync(join(env.CARGO_TARGET_DIR, `release/bundle/nsis/Voxa_${version}_x64-setup.exe`), installer);
writeFileSync(join(artifacts, `Voxa_${version}_manifest.json`), JSON.stringify({version,host,imports,installer,sha256:createHash('sha256').update(readFileSync(installer)).digest('hex'),updaterSigned:false},null,2));
console.log(`Instalador com WebView2Loader.dll: ${installer}`);
