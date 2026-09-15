import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, utimesSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Desenvolvimento Windows GNU: target sem acentos e loader da dependencia
// fixada no Cargo.lock. Nao instala o aplicativo nem gera instalador.
const root=resolve('.');
const env={...process.env};
if(process.platform==='win32') {
  const rust=spawnSync('rustc',['-vV'],{encoding:'utf8',windowsHide:true});
  const host=/^host: (.+)$/m.exec(rust.stdout??'')?.[1].trim();
  if(!host) throw new Error('Rust nao encontrado.');
  const result=spawnSync('cargo',['metadata','--offline','--locked','--format-version=1','--filter-platform',host,'--manifest-path','src-tauri/Cargo.toml'],{encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
  if(result.status!==0) throw new Error(`Cargo metadata falhou: ${result.stderr?.slice(0,1000)}`);
  const metadata=JSON.parse(result.stdout);
  const webview=metadata.packages.find(pkg=>pkg.name==='webview2-com-sys');
  if(!webview) throw new Error('WebView2Loader nao encontrado no Cargo.lock.');
  env.CARGO_TARGET_DIR ||= join(tmpdir(),'voxa-cargo-target');
  const native=join(dirname(webview.manifest_path),'x64');
  const output=join(env.CARGO_TARGET_DIR,'debug');
  mkdirSync(output,{recursive:true});
  copyFileSync(join(native,'WebView2Loader.dll'),join(output,'WebView2Loader.dll'));
  env.LIBRARY_PATH=[native,env.LIBRARY_PATH].filter(Boolean).join(';');
  // O cache externo pode ter seus manifests temporarios limpos pelo Windows.
  // Regenerar o build script restaura ACLs; nunca retirar permissoes da config.
  const now=new Date();utimesSync('src-tauri/build.rs',now,now);
}
const child=spawn(process.execPath,[join(root,'node_modules/@tauri-apps/cli/tauri.js'),'dev',...process.argv.slice(2)],{env,stdio:'inherit',windowsHide:true});
child.on('exit',code=>process.exit(code??1));
child.on('error',error=>{console.error(error.message);process.exit(1);});
