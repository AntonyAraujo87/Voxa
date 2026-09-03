/* Fachada da camada P2P: o resto do app importa daqui e nao dos modulos
   internos, o que mantem a liberdade de reorganizar peer/mesh/stats/tuning
   sem tocar em nenhum componente. */
export { Mesh } from "./mesh";
export { Peer } from "./peer";
export { isHardwareEncoder } from "./stats";
export { budgetPerPeer } from "./tuning";
export type {
  LocalTracks,
  MeshOptions,
  PeerStats,
  TrackKind,
  TuningState,
} from "./types";
