import test from "node:test";
import assert from "node:assert/strict";
import { StreamRegistry } from "../lib/state.js";

test("pairs exactly one host and one viewer and relays only public keys", () => {
  const registry = new StreamRegistry();
  registry.identify("host-socket", "203.0.113.10");
  registry.identify("viewer-socket", "203.0.113.20");
  const host = registry.join("host-socket", "game", "host", "203.0.113.10:41000", "192.168.1.2:41000", "h".repeat(43));
  assert.equal(host.peer, null);
  const viewer = registry.join("viewer-socket", "game", "viewer", "203.0.113.20:42000", "192.168.1.3:42000", "v".repeat(43));
  assert.equal(viewer.peer.socketId, "host-socket");
  assert.equal(viewer.peer.publicKey, "h".repeat(43));
  assert.equal("sessionKey" in viewer.room, false);
});

test("rejects a second host and deletes empty rooms", () => {
  const registry = new StreamRegistry();
  registry.identify("a", "127.0.0.1");
  registry.identify("b", "127.0.0.1");
  assert.equal(registry.join("a", "room", "host", "127.0.0.1:4000", "127.0.0.1:4000", "a".repeat(43)).error, undefined);
  assert.match(registry.join("b", "room", "host", "127.0.0.1:4001", "127.0.0.1:4001", "b".repeat(43)).error, /host/);
  registry.remove("a");
  assert.equal(registry.summary().streamRooms, 0);
});

test("replaces the relayed public key when a peer is replaced", () => {
  const registry = new StreamRegistry();
  registry.identify("host", "203.0.113.10");
  registry.identify("old", "203.0.113.20");
  registry.identify("next", "203.0.113.30");
  registry.join("host", "game", "host", "203.0.113.10:41000", "192.168.1.2:41000", "h".repeat(43));
  registry.join("old", "game", "viewer", "203.0.113.20:42000", "192.168.1.3:42000", "o".repeat(43));
  registry.remove("old");
  registry.join("next", "game", "viewer", "203.0.113.30:43000", "192.168.1.4:43000", "n".repeat(43));
  assert.equal(registry.get("next").publicKey, "n".repeat(43));
});

test("issues an opaque authenticated relay allocation without a media key", () => {
  const registry = new StreamRegistry("203.0.113.90:3479", "relay-secret-that-is-longer-than-32-bytes");
  registry.identify("host", "203.0.113.10");
  const { room } = registry.join("host", "game", "host", "203.0.113.10:41000", "192.168.1.2:41000", "h".repeat(43));
  assert.match(room.relaySession, /^[a-f0-9]{16}$/);
  assert.match(room.relayAuth, /^[a-f0-9]{16}$/);
  assert.equal(room.relayEndpoint, "203.0.113.90:3479");
  assert.equal("sessionKey" in room, false);
});
