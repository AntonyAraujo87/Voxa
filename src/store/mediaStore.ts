import { useSyncExternalStore } from "react";
import type { TrackKind } from "../lib/rtc";

/* ---------------------------------------------------------------------------
   MediaStreams NAO moram no estado do React.
   Motivo: um stream chegando re-renderizaria a arvore inteira e trocaria o
   srcObject dos <video> vizinhos, causando flash preto no meio da partida.
   Aqui cada peer tem sua propria lista de listeners: so o tile daquele peer
   re-renderiza quando o stream dele muda.
--------------------------------------------------------------------------- */

export interface PeerMedia {
  mic: MediaStream | null;
  screen: MediaStream | null;
  screenAudio: MediaStream | null;
}

const EMPTY: PeerMedia = { mic: null, screen: null, screenAudio: null };

const media = new Map<string, PeerMedia>();
const listeners = new Map<string, Set<() => void>>();

function notify(peerId: string) {
  listeners.get(peerId)?.forEach((fn) => fn());
}

export function setPeerStream(peerId: string, kind: TrackKind, stream: MediaStream | null) {
  const prev = media.get(peerId) ?? EMPTY;
  if (prev[kind] === stream) return;
  media.set(peerId, { ...prev, [kind]: stream });
  notify(peerId);
}

export function clearPeerMedia(peerId: string) {
  if (!media.has(peerId)) return;
  media.delete(peerId);
  notify(peerId);
}

export function getPeerMedia(peerId: string): PeerMedia {
  return media.get(peerId) ?? EMPTY;
}

function subscribe(peerId: string, cb: () => void) {
  let set = listeners.get(peerId);
  if (!set) {
    set = new Set();
    listeners.set(peerId, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) listeners.delete(peerId);
  };
}

export function usePeerMedia(peerId: string): PeerMedia {
  return useSyncExternalStore(
    (cb) => subscribe(peerId, cb),
    () => media.get(peerId) ?? EMPTY
  );
}

/* -------------------- stream local (minha tela / meu mic) ------------------ */

let localScreen: MediaStream | null = null;
const localListeners = new Set<() => void>();

export function setLocalScreen(stream: MediaStream | null) {
  if (localScreen === stream) return;
  localScreen = stream;
  localListeners.forEach((fn) => fn());
}

export function useLocalScreen(): MediaStream | null {
  return useSyncExternalStore(
    (cb) => {
      localListeners.add(cb);
      return () => localListeners.delete(cb);
    },
    () => localScreen
  );
}
