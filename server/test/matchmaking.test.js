import test from "node:test";
import assert from "node:assert/strict";
import { StreamRegistry } from "../lib/state.js";

const join = (registry, id, role, port, key = id[0]) =>
  registry.join(id, "game", role, `203.0.113.${port % 200 + 1}:${port}`, `192.168.1.${port % 200 + 1}:${port}`, key.repeat(43));

test("pairs one host with four viewers and keeps public keys isolated", () => {
  const registry = new StreamRegistry();
  for (const [id, ip] of [["host", "203.0.113.10"], ["v1", "203.0.113.11"], ["v2", "203.0.113.12"], ["v3", "203.0.113.13"], ["v4", "203.0.113.14"], ["v5", "203.0.113.15"]]) registry.identify(id, ip);
  assert.equal(join(registry, "host", "host", 41000, "h").peers.length, 0);
  for (let index = 1; index <= 4; index++) {
    const result = join(registry, `v${index}`, "viewer", 42000 + index, String(index));
    assert.equal(result.peers.length, 1);
    assert.equal(result.peers[0].peer.socketId, "host");
    assert.equal(result.peers[0].peer.publicKey, "h".repeat(43));
    assert.equal("sessionKey" in result.room, false);
  }
  assert.match(join(registry, "v5", "viewer", 42005, "x").error, /limite de 4/);
});

test("a host joining later receives every waiting viewer", () => {
  const registry = new StreamRegistry();
  for (const id of ["host", "a", "b"]) registry.identify(id, "127.0.0.1");
  assert.equal(join(registry, "a", "viewer", 42001, "a").peers.length, 0);
  assert.equal(join(registry, "b", "viewer", 42002, "b").peers.length, 0);
  assert.deepEqual(join(registry, "host", "host", 41000, "h").peers.map(({peer}) => peer.socketId).sort(), ["a", "b"]);
});

test("rejects a second host and deletes empty rooms", () => {
  const registry = new StreamRegistry();
  registry.identify("a", "127.0.0.1"); registry.identify("b", "127.0.0.1");
  assert.equal(join(registry, "a", "host", 4000, "a").error, undefined);
  assert.match(join(registry, "b", "host", 4001, "b").error, /host/);
  registry.remove("a");
  assert.equal(registry.summary().streamRooms, 0);
});

test("leaving one viewer preserves the other pairings", () => {
  const registry = new StreamRegistry();
  for (const id of ["host", "old", "next"]) registry.identify(id, "203.0.113.10");
  join(registry, "host", "host", 41000, "h"); join(registry, "old", "viewer", 42000, "o"); join(registry, "next", "viewer", 43000, "n");
  const left = registry.remove("old");
  assert.deepEqual(left.otherIds, ["host"]);
  assert.equal(registry.get("next").publicKey, "n".repeat(43));
  assert.equal(registry.summary().streamRooms, 1);
});

test("issues a distinct authenticated relay allocation for each viewer", () => {
  const registry = new StreamRegistry("203.0.113.90:3479", "relay-secret-that-is-longer-than-32-bytes");
  for (const id of ["host", "a", "b"]) registry.identify(id, "203.0.113.10");
  join(registry, "host", "host", 41000, "h");
  const firstPair = join(registry, "a", "viewer", 42001, "a").peers[0];
  const secondPair = join(registry, "b", "viewer", 42002, "b").peers[0];
  const first = registry.relay(firstPair.viewer, "viewer");
  const firstHost = registry.relay(firstPair.viewer, "host");
  const second = registry.relay(secondPair.viewer, "viewer");
  assert.equal(first.endpoint, "203.0.113.90:3479");
  assert.match(first.session, /^[a-f0-9]{16}$/); assert.match(first.auth, /^[a-f0-9]{16}$/);
  assert.notEqual(first.session, second.session);
  assert.notEqual(first.auth, firstHost.auth);
  assert.equal("sessionKey" in first, false);
});
