import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve('.');
const env = {
  ...process.env,
  CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || join(tmpdir(), 'voxa-cargo-test-target'),
};
let rustHost = '';

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} terminou com codigo ${result.status}`);
  return result.stdout;
}

if (process.platform === 'win32') {
  rustHost = /^host: (.+)$/m.exec(run('rustc', ['-vV'], true))?.[1].trim() ?? '';
  if (!rustHost) throw new Error('Rust nao encontrado.');
  const metadata = JSON.parse(run('cargo', [
    'metadata', '--offline', '--locked', '--format-version=1', '--filter-platform', rustHost,
    '--manifest-path', 'src-tauri/Cargo.toml',
  ], true));
  const webview = metadata.packages.find((pkg) => pkg.name === 'webview2-com-sys');
  if (!webview) throw new Error('WebView2Loader nao encontrado no Cargo.lock.');
  const native = join(dirname(webview.manifest_path), 'x64');
  // Os executaveis de teste ficam em target/debug/deps. Prependemos a DLL
  // correspondente ao Cargo.lock para que o Windows nao carregue outra versao
  // encontrada no PATH e falhe com STATUS_ENTRYPOINT_NOT_FOUND.
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = [native, env[pathKey]].filter(Boolean).join(';');
  env.LIBRARY_PATH = [native, env.LIBRARY_PATH].filter(Boolean).join(';');
}

run('cargo', ['test', '--locked', '--manifest-path', 'src-tauri/native-core/Cargo.toml']);
if (!rustHost.endsWith('-gnu')) {
  run('cargo', ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml']);
} else {
  console.warn('Testes Tauri omitidos no MinGW: o linker GNU mistura manifests e o binario de teste nao inicializa. O CI executa esta etapa com MSVC.');
}
