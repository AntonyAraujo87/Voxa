import { invoke } from "@tauri-apps/api/core";
import type { Matchmaking } from "./signaling";

export type StreamRole = "host" | "viewer";
export type EnginePhase = "idle" | "binding" | "waiting" | "punching" | "connected" | "streaming" | "stopped" | "failed";
export interface PreparedEndpoint { local: string; public: string | null; }
export interface EngineStatus {
  phase: EnginePhase; role: StreamRole | null; localEndpoint: string | null;
  publicEndpoint: string | null; peerEndpoint: string | null; rttMs: number;
  lossPct: number; bitrateKbps: number; receivedFrames: number;
  droppedFrames: number; keyframeRequests: number; renderer: string;
  capture: string; encoder: string;
}

export class NativeEngine {
  private matchmaking: Matchmaking | null = null;
  attachMatchmaking(matchmaking: Matchmaking) { this.matchmaking?.close(); this.matchmaking = matchmaking; }
  prepare(role: StreamRole) { return invoke<PreparedEndpoint>("engine_prepare", { role }); }
  connectPeer(endpoint: string, sessionKey: string, peerId: string) { return invoke<void>("engine_connect_peer", { endpoint, sessionKey, peerId }); }
  disconnectPeer() { return invoke<void>("engine_disconnect_peer"); }
  openRenderer() { return invoke<void>("engine_open_renderer"); }
  status() { return invoke<EngineStatus>("engine_status"); }
  async stop() { this.matchmaking?.close(); this.matchmaking = null; await invoke("engine_stop"); }
}
