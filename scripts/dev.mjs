// Sobe o signaling server e o app Tauri no mesmo terminal.
import { spawn } from "node:child_process";

const procs = [];
function run(name, cmd, args, opts = {}) {
  const p = spawn(cmd, args, { stdio: "inherit", shell: true, ...opts });
  p.on("exit", (code) => {
    console.log(`[${name}] saiu com codigo ${code}`);
    kill();
  });
  procs.push(p);
  return p;
}
function kill() {
  for (const p of procs) {
    if (!p.killed) try { p.kill(); } catch {}
  }
  process.exit(0);
}
process.on("SIGINT", kill);
process.on("SIGTERM", kill);

run("signaling", "node", ["server/index.js"]);
run("tauri", "npm", ["run", "tauri", "dev"]);
