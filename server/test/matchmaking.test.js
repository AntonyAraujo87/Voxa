import test from "node:test";
import assert from "node:assert/strict";
import { StreamRegistry } from "../lib/state.js";

test("pairs exactly one host and one viewer with a 256-bit session key", () => {
  const registry = new StreamRegistry();
  registry.identify("host-socket", "host-device", "203.0.113.10");
  registry.identify("viewer-socket", "viewer-device", "203.0.113.20");
  const host = registry.join("host-socket", "game", "host", "203.0.113.10:41000", "192.168.1.2:41000");
  assert.equal(host.peer, null);
  const viewer = registry.join("viewer-socket", "game", "viewer", "203.0.113.20:42000", "192.168.1.3:42000");
  assert.equal(viewer.peer.socketId, "host-socket");
  assert.equal(Buffer.from(viewer.room.sessionKey, "base64url").byteLength, 32);
});

test("rejects a second host and deletes empty rooms", () => {
  const registry = new StreamRegistry();
  registry.identify("a", "a-device", "127.0.0.1");
  registry.identify("b", "b-device", "127.0.0.1");
  assert.equal(registry.join("a", "room", "host", "127.0.0.1:4000", "127.0.0.1:4000").error, undefined);
  assert.match(registry.join("b", "room", "host", "127.0.0.1:4001", "127.0.0.1:4001").error, /host/);
  registry.remove("a");
  assert.equal(registry.summary().streamRooms, 0);
});

test("rotates the transport key when a peer is replaced", () => {
  const registry = new StreamRegistry();
  registry.identify("host", "host-device", "203.0.113.10");
  registry.identify("old", "old-viewer", "203.0.113.20");
  registry.identify("next", "next-viewer", "203.0.113.30");
  registry.join("host", "game", "host", "203.0.113.10:41000", "192.168.1.2:41000");
  const first = registry.join("old", "game", "viewer", "203.0.113.20:42000", "192.168.1.3:42000").room.sessionKey;
  registry.remove("old");
  const second = registry.join("next", "game", "viewer", "203.0.113.30:43000", "192.168.1.4:43000").room.sessionKey;
  assert.notEqual(second, first);
});
