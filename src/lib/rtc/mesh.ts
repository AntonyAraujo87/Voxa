import { VIDEO_PRESETS } from "../config";
import type { SignalPayload } from "../signaling";
import { AdaptiveQuality } from "./adaptive";
import { Peer } from "./peer";
import { budgetPerPeer, type EncodingTargets } from "./tuning";
import { NO_TRACKS, type LocalTracks, type MeshOptions, type PeerStats, type TuningState } from "./types";

/* ---------------------------------------------------------------------------
   Malha P2P (full mesh): cada participante abre uma conexao com cada outro.
   Zero servidor de midia, latencia de um salto so. O custo e o upload, que
   cresce com o numero de espectadores — dai o orcamento dividido por par.

   O Mesh coordena: quem entra, quem sai, quais tracks estao no ar e quando
   reaplicar qualidade. A conexao em si e responsabilidade do Peer.
--------------------------------------------------------------------------- */

const STATS_INTERVAL_MS = 1000;
const SPEAKING_INTERVAL_MS = 150;
const SPEAKING_THRESHOLD = 0.012;

export class Mesh {
  private peers = new Map<string, Peer>();
  /** peerId -> ultimo sinal em processamento, para serializar por par */
  private filas = new Map<string, Promise<void>>();
  private tracks: LocalTracks = { ...NO_TRACKS };
  private timers: number[] = [];
  private adaptive = new AdaptiveQuality();
  private detachNetworkWatch: (() => void) | null = null;

  tuning: TuningState = { video: "alta", audio: "voz", codec: "hardware", content: "jogo" };

  constructor(private opts: MeshOptions) {
    this.timers.push(
      window.setInterval(() => void this.collectStats(), STATS_INTERVAL_MS),
      window.setInterval(() => this.detectSpeaking(), SPEAKING_INTERVAL_MS)
    );
    this.watchNetwork();
  }

  /**
   * Trocar de Wi-Fi para cabo, sair do alcance ou o roteador renovar o IP nao
   * derrubam a pagina, mas invalidam os candidatos ICE. O navegador avisa; sem
   * escutar esses eventos, a conexao ficaria morta ate alguem sair e voltar.
   */
  private watchNetwork() {
    const recover = () => {
      for (const peer of this.peers.values()) peer.recoverNow();
    };

    window.addEventListener("online", recover);
    const conexao = (navigator as Navigator & { connection?: EventTarget }).connection;
    conexao?.addEventListener("change", recover);

    this.detachNetworkWatch = () => {
      window.removeEventListener("online", recover);
      conexao?.removeEventListener("change", recover);
    };
  }

  get size() {
    return this.peers.size;
  }

  /* ---------------------------- participantes --------------------------- */

  addPeer(id: string, initiator: boolean): Peer {
    const existing = this.peers.get(id);
    if (existing) return existing;

    // Criterio deterministico e igual dos dois lados, para que exatamente um
    // seja o "educado" numa colisao de ofertas.
    const polite = this.opts.selfId() > id;
    const peer = new Peer(id, polite, () => this.tuning, this.opts);
    this.peers.set(id, peer);

    if (initiator) peer.initiate(this.tracks, this.targets());
    this.rebalance();
    return peer;
  }

  removePeer(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;

    peer.close();
    this.peers.delete(id);
    // Sem isso a fila do par que saiu ficaria no mapa pra sempre, segurando
    // a referencia do Peer fechado junto.
    this.filas.delete(id);

    this.opts.onTrack(id, "mic", null);
    this.opts.onTrack(id, "screen", null);
    this.opts.onTrack(id, "screenAudio", null);
    this.rebalance();
  }

  clear() {
    for (const id of [...this.peers.keys()]) this.removePeer(id);
  }

  destroy() {
    for (const t of this.timers) window.clearInterval(t);
    this.timers = [];
    this.detachNetworkWatch?.();
    this.detachNetworkWatch = null;
    this.clear();
  }

  /* ------------------------------ signaling ----------------------------- */

  /**
   * Sinais do MESMO par sao processados um de cada vez.
   *
   * ICE chega em rajada e quem chama nao espera (`void mesh.handleSignal`),
   * entao duas chamadas seguidas rodavam concorrentes: um `addIceCandidate`
   * podia comecar antes de o `setRemoteDescription` do sinal anterior ter
   * terminado, e o candidato era descartado com "remote description is null".
   * Cada candidato perdido e um caminho de conexao a menos — em rede boa nao
   * se nota, em rede ruim e a diferenca entre conectar e nao conectar.
   *
   * A fila e POR PAR: sinais de pessoas diferentes continuam em paralelo,
   * que e o que faz a entrada numa sala cheia ser rapida.
   */
  async handleSignal(from: string, data: SignalPayload) {
    const peer = this.peers.get(from) ?? this.addPeer(from, false);

    const anterior = this.filas.get(from) ?? Promise.resolve();
    const atual = anterior
      // Um sinal que falhou nao pode travar os seguintes.
      .catch(() => {})
      .then(() => peer.handleSignal(data, this.tracks, this.targets()));

    this.filas.set(from, atual);
    await atual;
  }

  /* ---------------------------- tracks locais --------------------------- */

  setMic(track: MediaStreamTrack | null) {
    this.tracks = { ...this.tracks, mic: track };
    for (const peer of this.peers.values()) peer.attachTracks(this.tracks);
  }

  async setScreen(video: MediaStreamTrack | null, audio: MediaStreamTrack | null) {
    // Comeca sempre na qualidade cheia: o degrau anterior foi decidido para
    // outra captura, que pode ter sido de um jogo bem mais pesado.
    if (video) this.adaptive.reset();
    this.tracks = { ...this.tracks, screen: video, screenAudio: audio };
    for (const peer of this.peers.values()) peer.attachTracks(this.tracks);
    await this.applyToAll();
  }

  /* ------------------------------ qualidade ----------------------------- */

  async setTuning(patch: Partial<TuningState>) {
    const before = this.tuning;
    this.tuning = { ...before, ...patch };

    if (patch.content && this.tracks.screen) {
      this.tracks.screen.contentHint = this.tuning.content === "jogo" ? "motion" : "detail";
    }
    if (patch.codec && patch.codec !== before.codec) {
      for (const peer of this.peers.values()) peer.refreshCodecPreferences();
    }
    await this.applyToAll();
  }

  private targets(): EncodingTargets {
    const preset = VIDEO_PRESETS[this.tuning.video];
    const degrau = this.adaptive.current;
    return {
      maxBitrate: budgetPerPeer(this.tuning, this.peers.size),
      maxFramerate: Math.min(preset.fps, degrau.fpsCap),
      scaleDownBy: degrau.scaleDownBy,
    };
  }

  /** Redistribui o teto de upload — chamado quando alguem entra ou sai. */
  private rebalance() {
    void this.applyToAll();
  }

  private async applyToAll() {
    const targets = this.targets();
    await Promise.all([...this.peers.values()].map((p) => p.applyEncoding(targets)));
  }

  /* ------------------------------- metricas ----------------------------- */

  private async collectStats() {
    if (this.peers.size === 0) return;

    // Janela escondida e sem tela no ar: ninguem esta olhando as metricas e
    // nao ha encoder para adaptar. Enquanto compartilha, continua medindo —
    // e exatamente ai (app em segundo plano, jogo em primeiro) que a
    // adaptacao automatica mais importa.
    if (document.hidden && !this.tracks.screen) return;

    const out = new Map<string, PeerStats>();
    await Promise.all(
      [...this.peers.values()].map(async (peer) => {
        try {
          out.set(peer.id, await peer.collectStats());
        } catch {
          /* par removido no meio da coleta */
        }
      })
    );

    this.opts.onStats(out);

    // So adapta enquanto ha tela no ar: sem video, "limitado por CPU" nao
    // significa nada e reduzir resolucao nao teria efeito nenhum.
    if (this.tracks.screen) {
      const decisao = this.adaptive.evaluate(out.values());
      if (decisao.changed) {
        void this.applyToAll();
        this.opts.onQuality?.(decisao.step.label, decisao.reason);
      }
    }
  }

  private detectSpeaking() {
    // O anel de "falando" e puramente visual: com a janela escondida, medir
    // seria trabalho jogado fora 6 vezes por segundo.
    if (document.hidden) {
      // Mas quem estava falando no instante em que a janela sumiu ficava
      // marcado como falando pra sempre — o anel voltava aceso quando a
      // janela reaparecia, e so apagava se a pessoa falasse de novo.
      for (const peer of this.peers.values()) {
        if (!peer.speaking) continue;
        peer.speaking = false;
        this.opts.onSpeaking(peer.id, false);
      }
      return;
    }

    for (const peer of this.peers.values()) {
      const speaking = peer.audioLevel() > SPEAKING_THRESHOLD;
      if (speaking !== peer.speaking) {
        peer.speaking = speaking;
        this.opts.onSpeaking(peer.id, speaking);
      }
    }
  }

  debugSenders() {
    return [...this.peers.values()].map((p) => p.debugInfo());
  }
}
