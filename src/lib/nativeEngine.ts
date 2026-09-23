import { invoke } from "@tauri-apps/api/core";
import type { Matchmaking } from "./signaling";

export type StreamRole = "host" | "viewer";
export type EnginePhase = "idle" | "binding" | "waiting" | "punching" | "connected" | "decoding" | "streaming" | "recovering" | "stopped" | "failed";
export interface PreparedEndpoint { local: string; public: string | null; publicKey: string; }
export interface EngineStatus {
  phase: EnginePhase; role: StreamRole | null; localEndpoint: string | null;
  publicEndpoint: string | null; peerEndpoint: string | null; rttMs: number;
  lossPct: number; bitrateKbps: number; receivedFrames: number;
  droppedFrames: number; keyframeRequests: number; renderer: string;
  capture: string; encoder: string; decoder: string; decodedFrames: number;
  verificationCode: string | null; connectedPeers: number; maxPeers: number;
  peerVerifications: Array<{ peerId: string; code: string }>;
}

export class NativeEngine {
  private matchmaking: Matchmaking | null = null;
  attachMatchmaking(matchmaking: Matchmaking) { this.matchmaking?.close(); this.matchmaking = matchmaking; }
  prepare(role: StreamRole) { return invoke<PreparedEndpoint>("engine_prepare", { role }); }
  setMaxPeers(maxPeers: number) { return invoke<void>("engine_set_max_peers", { maxPeers }); }
  connectPeer(peer: { endpoint: string; publicKey: string; peerId: string; relayEndpoint: string | null; relaySession: string | null; relayAuth: string | null }) {
    return invoke<void>("engine_connect_peer", { request: {
      endpoint: peer.endpoint, peerPublicKey: peer.publicKey, peerId: peer.peerId,
      relayEndpoint: peer.relayEndpoint, relaySession: peer.relaySession, relayAuth: peer.relayAuth,
    } });
  }
  disconnectPeer(peerId: string) { return invoke<void>("engine_disconnect_peer", { peerId }); }
  status() { return invoke<EngineStatus>("engine_status"); }
  toggleFullscreen() { return invoke<boolean>("engine_toggle_fullscreen"); }
  async stop() { this.matchmaking?.close(); this.matchmaking = null; await invoke("engine_stop"); }
}
