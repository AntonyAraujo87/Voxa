import { invoke } from "@tauri-apps/api/core";
import type { Matchmaking } from "./signaling";

export type StreamRole = "host" | "viewer";
export type EnginePhase = "idle" | "binding" | "waiting" | "punching" | "connected" | "decoding" | "streaming" | "recovering" | "stopped" | "failed";
export interface PreparedEndpoint { local: string; public: string | null; publicKey: string; codecs: number; }
export interface CaptureTargetId { adapterIndex: number; outputIndex: number; }
export interface CaptureTargetInfo {
  id: CaptureTargetId; gpu: string; monitor: string;
  width: number; height: number; primary: boolean;
}
export interface AudioProcessInfo { processId: number; name: string; }
export interface GraphicsAdapterInfo { adapterIndex: number; name: string; dedicatedMemoryMb: number; }
export interface EngineStatus {
  phase: EnginePhase; role: StreamRole | null; localEndpoint: string | null;
  publicEndpoint: string | null; peerEndpoint: string | null; rttMs: number;
  lossPct: number; bitrateKbps: number; receivedFrames: number; encodedFrames: number;
  droppedFrames: number; keyframeRequests: number; renderer: string;
  capture: string; encoder: string; decoder: string; decoderGpu: string | null; decodedFrames: number;
  audio: string; audioBitrateKbps: number; audioError: string | null;
  rejoinRequired: boolean;
  latencyP50Ms: number; latencyP95Ms: number; latencyP99Ms: number;
  verificationCode: string | null; connectedPeers: number; maxPeers: number;
  peerVerifications: Array<{ peerId: string; code: string }>;
  peerMetrics: Array<{ peerId: string; endpoint: string | null; phase: string; rttMs: number;
    lossPct: number; bitrateKbps: number; receivedFrames: number; droppedFrames: number;
    latencyP50Ms: number; latencyP95Ms: number; latencyP99Ms: number }>;
  lastError: string | null;
}

export class NativeEngine {
  private matchmaking: Matchmaking | null = null;
  attachMatchmaking(matchmaking: Matchmaking) { this.matchmaking?.close(); this.matchmaking = matchmaking; }
  captureTargets() { return invoke<CaptureTargetInfo[]>("engine_capture_targets"); }
  audioProcesses() { return invoke<AudioProcessInfo[]>("engine_audio_processes"); }
  graphicsAdapters() { return invoke<GraphicsAdapterInfo[]>("engine_graphics_adapters"); }
  roomProof(room: string, password: string) {
    return invoke<string>("derive_room_proof", { room, password });
  }
  switchCapture(captureTarget: CaptureTargetId) {
    return invoke<void>("engine_switch_capture", { captureTarget });
  }
  switchAudio(audioProcessId: number | null) {
    return invoke<void>("engine_switch_audio", { audioProcessId });
  }
  prepare(role: StreamRole, captureTarget: CaptureTargetId | null = null, audioProcessId: number | null = null, decoderAdapterIndex: number | null = null, reuseIdentity = false) {
    return invoke<PreparedEndpoint>("engine_prepare", { role, captureTarget, audioProcessId, decoderAdapterIndex, reuseIdentity });
  }
  setMaxPeers(maxPeers: number) { return invoke<void>("engine_set_max_peers", { maxPeers }); }
  previewPeer(peer: { publicKey: string; peerId: string }) {
    return invoke<string>("engine_preview_peer", { peerId: peer.peerId, peerPublicKey: peer.publicKey });
  }
  connectPeer(peer: { endpoint: string; publicKey: string; peerId: string; codecs?: number; relayEndpoint: string | null; relaySession: string | null; relayAuth: string | null }) {
    return invoke<void>("engine_connect_peer", { request: {
      endpoint: peer.endpoint, peerPublicKey: peer.publicKey, peerId: peer.peerId, peerCodecs: peer.codecs ?? 1,
      relayEndpoint: peer.relayEndpoint, relaySession: peer.relaySession, relayAuth: peer.relayAuth,
    } });
  }
  disconnectPeer(peerId: string) { return invoke<void>("engine_disconnect_peer", { peerId }); }
  status() { return invoke<EngineStatus>("engine_status"); }
  recoverSignaling() { return this.matchmaking?.recover() ?? Promise.resolve(); }
  toggleFullscreen() { return invoke<boolean>("engine_toggle_fullscreen"); }
  openNewSession() { return invoke<void>("open_new_session"); }
  async stop() { this.matchmaking?.close(); this.matchmaking = null; await invoke("engine_stop"); }
}
