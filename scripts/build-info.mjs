import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function buildInfo(env) {
  const hash = createHash('sha256');
  const walk = path => {
    for (const entry of readdirSync(path, {withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name === 'target') continue;
      const file = join(path, entry.name);
      if (entry.isDirectory()) walk(file);
      else { hash.update(file.replaceAll('\\','/')); hash.update(readFileSync(file)); }
    }
  };
  for(const path of ['src','src-tauri/src','server/lib']) walk(path);
  for(const path of ['package.json','package-lock.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json','server/index.js']) hash.update(readFileSync(path));
  let commit='unavailable';
  try { commit=execFileSync('git',['rev-parse','--short','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(); } catch {}
  return {version:JSON.parse(readFileSync('package.json','utf8')).version, commit, source:hash.digest('hex').slice(0,16), builtAt:new Date().toISOString(), history:Boolean(env.VITE_SUPABASE_URL&&env.VITE_SUPABASE_ANON_KEY), staticTurn:Boolean(env.VITE_TURN_URLS)};
}
