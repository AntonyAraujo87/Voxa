import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { startUdpRelay } from "../lib/relay.js";

import { createHmac } from "node:crypto";

const SECRET = "test-relay-secret-with-at-least-32-bytes";
function packet(role, session, payload, secret = SECRET) {
  const header = Buffer.alloc(22);
  header.write("VRLY");
  header[4] = 1;
  header[5] = role;
  header.writeBigUInt64BE(session, 6);
  createHmac("sha256", secret).update(header.subarray(6, 14)).digest().copy(header, 14, 0, 8);
  return Buffer.concat([header, Buffer.from(payload)]);
}

function bind(socket) {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", resolve);
  });
}

function receive(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("relay timeout")), 1_000);
    socket.once("message", (message) => { clearTimeout(timer); resolve(message); });
  });
}

function expectNoMessage(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 80);
    socket.once("message", () => { clearTimeout(timer); reject(new Error("relay accepted invalid credential")); });
  });
}

test("blind UDP relay pairs roles and forwards only encrypted payload bytes", async () => {
  const relay = startUdpRelay({ port: 0, secret: SECRET, host: "127.0.0.1", log: { info() {}, warn() {} } });
  const host = dgram.createSocket("udp4");
  const viewer = dgram.createSocket("udp4");
  try {
    await Promise.all([new Promise(resolve => relay.socket.once("listening", resolve)), bind(host), bind(viewer)]);
    const target = relay.socket.address();
    const session = 0x1020304050607080n;
    host.send(packet(0, session, "host-register"), target.port, target.address);
    await new Promise(resolve => setTimeout(resolve, 20));
    viewer.send(packet(1, session, "forged", "wrong-secret-with-at-least-32-bytes"), target.port, target.address);
    await expectNoMessage(host);
    const received = receive(host);
    viewer.send(packet(1, session, "ciphertext"), target.port, target.address);
    assert.equal((await received).toString(), "ciphertext");
  } finally {
    host.close();
    viewer.close();
    relay.close();
  }
});
