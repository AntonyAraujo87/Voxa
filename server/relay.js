import { startUdpRelay } from "./lib/relay.js";

const port = Number(process.env.VOXA_RELAY_PORT || 3479);
const secret = process.env.VOXA_RELAY_SECRET || "";
if (secret.length < 32) throw new Error("VOXA_RELAY_SECRET deve ter pelo menos 32 caracteres");
const relay = startUdpRelay({
  port,
  secret,
  log: {
    info: (...message) => console.log("[voxa]", ...message),
    warn: (...message) => console.warn("[voxa]", ...message),
  },
});

if (!relay) throw new Error("VOXA_RELAY_PORT inválida");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { relay.close(); process.exit(0); });
}
