import dgram from "node:dgram";
import { createHmac, timingSafeEqual } from "node:crypto";

const MAGIC = Buffer.from("VRLY");
const HEADER = 22;
const MAX_PACKET = 1_200;
const SESSION_TTL_MS = 60_000;
const MAX_SESSIONS = 4_096;
const MAX_PACKETS_PER_IP_SECOND = 6_000;

export function startUdpRelay({ port, secret, host = "0.0.0.0", log = console }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535 || typeof secret !== "string" || secret.length < 32) return null;
  const socket = dgram.createSocket("udp4");
  const sessions = new Map();
  const rates = new Map();
  socket.on("message", (packet, remote) => {
    if (packet.length <= HEADER || packet.length > MAX_PACKET || !packet.subarray(0, 4).equals(MAGIC) || packet[4] !== 1 || packet[5] > 1) return;
    const second = Math.floor(Date.now() / 1_000);
    const rate = rates.get(remote.address);
    if (rate?.second === second) {
      if (++rate.count > MAX_PACKETS_PER_IP_SECOND) return;
    } else {
      rates.set(remote.address, { second, count: 1 });
    }
    const session = packet.readBigUInt64BE(6).toString(16);
    const expected = createHmac("sha256", secret).update(packet.subarray(6, 14)).digest().subarray(0, 8);
    if (!timingSafeEqual(packet.subarray(14, 22), expected)) return;
    const role = packet[5];
    const now = Date.now();
    const existing = sessions.get(session);
    if (!existing && sessions.size >= MAX_SESSIONS) return;
    const pair = existing ?? { peers: [null, null], seen: now };
    pair.peers[role] = { address: remote.address, port: remote.port };
    pair.seen = now;
    sessions.set(session, pair);
    const destination = pair.peers[role ^ 1];
    if (destination) socket.send(packet.subarray(HEADER), destination.port, destination.address);
  });
  socket.on("error", (error) => log.warn?.("relay UDP:", error?.code ?? "erro"));
  const sweep = setInterval(() => {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, pair] of sessions) if (pair.seen < cutoff) sessions.delete(id);
    for (const [ip, rate] of rates) if (rate.second < Math.floor(Date.now() / 1_000) - 2) rates.delete(ip);
  }, 30_000);
  sweep.unref?.();
  socket.bind(port, host, () => log.info?.(`relay UDP em ${host}:${port}`));
  return { close: () => { clearInterval(sweep); socket.close(); }, sessions, socket };
}
