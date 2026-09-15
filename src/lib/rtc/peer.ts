import { PC_CONFIG, hasTurn } from "../config";
import type { SignalPayload } from "../signaling";
import { readStats, newSamples, type StatsSamples } from "./stats";
import {
  applyAudioEncoding,
  applyCodecPreferences,
  applyVideoEncoding,
  tuneSessionDescription,
  type EncodingTargets,
} from "./tuning";
import {
  EMPTY_STATS,
  type LocalTracks,
  type PeerCallbacks,
  type PeerStats,
  type TrackKind,
  type TuningState,
} from "./types";

/** Espera antes de agir num `disconnected`, que costuma se resolver sozinho. */
const RECOVERY_GRACE_MS = 2500;
const RECOVERY_BASE_MS = 1200;
const MAX_RECOVERY_DELAY_MS = 20_000;
const MAX_RECOVERY_ATTEMPTS = 8;
const CONNECTION_TIMEOUT_MS = 20_000;

/* ---------------------------------------------------------------------------
   Uma conexao com UM outro participante.

   Responsabilidades: negociacao (perfect negotiation), ciclo de vida dos
   transceivers, aplicacao dos parametros de encoder e leitura de metricas.
   Nao conhece a sala, nao conhece os outros pares — quem coordena e o Mesh.
--------------------------------------------------------------------------- */

export class Peer {
  pc: RTCPeerConnection;

  private micTx?: RTCRtpTransceiver;
  private videoTx?: RTCRtpTransceiver;
  private screenAudioTx?: RTCRtpTransceiver;

  // --- perfect negotiation ---
  private ignoreOffer = false;
  private operations: Promise<void> = Promise.resolve();
  private negotiationQueued = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private tracksPending: Promise<void> = Promise.resolve();
  private connectionTimer: number | null = null;
  private iceErrors = new Set<number>();
  private localCandidates = new Set<string>();
  private remoteCandidates = new Set<string>();
  private retired = new WeakSet<RTCRtpTransceiver>();

  /** transceivers ja mapeados (criados por nos ou vindos da oferta remota) */
  private ready = false;

  private recoveryTimer: number | null = null;
  private recoveryAttempts = 0;
  private closed = false;
  private encodingTask: Promise<void> | null = null;
  private encodingRevision = 0;
  private lastEncoding: EncodingTargets | null = null;
  private encodingRetry: number | null = null;
  private encodingFailures = 0;

  private samples: StatsSamples = newSamples();
  stats: PeerStats = { ...EMPTY_STATS };
  speaking = false;

  constructor(
    readonly id: string,
    /** o educado desfaz a propria oferta numa colisao; o grosseiro ignora a do outro */
    private readonly polite: boolean,
    private readonly tuning: () => TuningState,
    private readonly cb: PeerCallbacks
  ) {
    this.pc = new RTCPeerConnection(PC_CONFIG);
    this.wire();
  }

  get isReady() {
    return this.ready;
  }

  /* --------------------------- ciclo de vida ---------------------------- */

  private wire() {
    this.pc.onicecandidate = ({ candidate }) => {
      if (this.closed) return;
      if (candidate?.type) this.localCandidates.add(candidate.type);
      this.cb.send(this.id, { candidate: candidate ? candidate.toJSON() : null });
    };
    this.pc.onicecandidateerror = (event) => {
      // Codigos apenas: enderecos e credenciais nao entram no diagnostico.
      this.iceErrors.add(event.errorCode);
    };

    this.pc.onnegotiationneeded = () => void this.negotiate();

    this.pc.ontrack = (ev) => {
      // getTransceivers() pode conter canais abandonados pelo rollback.
      // O MID identifica a m-line negociada, mesmo antes de adopt().
      const kind = this.trackKind(ev.transceiver);
      if (!kind || this.closed) return;
      const publish = (stream: MediaStream | null) => {
        if (!this.closed && this.trackKind(ev.transceiver) === kind) {
          this.cb.onTrack(this.id, kind, stream);
        }
      };
      publish(new MediaStream([ev.track]));

      // replaceTrack(null) do outro lado chega aqui como mute/unmute — e assim
      // que detectamos "parou de compartilhar" sem renegociar nada.
      ev.track.onmute = () => publish(null);
      ev.track.onunmute = () => publish(new MediaStream([ev.track]));
      ev.track.onended = () => publish(null);
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      this.stats.connection = state;
      this.cb.onConnectionState(this.id, state);

      if (state === "connected") {
        // Reconectou: zera o backoff para que a proxima queda seja tratada
        // com a mesma agressividade da primeira.
        this.recoveryAttempts = 0;
        this.cancelRecovery();
        this.cancelConnectionTimeout();
      }
      if (state === "connecting") this.watchConnectionTimeout();
      if (state === "failed") this.scheduleRecovery(0);
      if (state === "disconnected") this.scheduleRecovery(RECOVERY_GRACE_MS);
    };

    // `disconnected` costuma ser transitorio (troca de Wi-Fi, pico de latencia)
    // e frequentemente se resolve sozinho; `failed` nunca se resolve sozinho.
    this.pc.oniceconnectionstatechange = () => {
      if (this.pc.iceConnectionState === "failed") this.scheduleRecovery(0);
    };
  }

  private mediaMids(): string[] {
    return [...(this.pc.remoteDescription?.sdp ?? "").matchAll(/^a=mid:(.+)$/gm)]
      .map((match) => match[1].trim());
  }

  private trackKind(tx: RTCRtpTransceiver): TrackKind | undefined {
    if (this.retired.has(tx) || tx.mid === null || !this.pc.getTransceivers().includes(tx)) return undefined;
    const index = this.mediaMids().indexOf(tx.mid);
    return (["mic", "screen", "screenAudio"] as const)[index];
  }

  private watchConnectionTimeout() {
    if (this.connectionTimer !== null || this.closed) return;
    this.connectionTimer = window.setTimeout(() => {
      this.connectionTimer = null;
      if (this.closed || this.pc.connectionState === "connected") return;
      this.cb.onError(this.id, new Error(
        `Conexao sem midia apos 20s: ICE=${this.pc.iceConnectionState}, SDP=${this.pc.signalingState}. ` +
        (hasTurn ? "Verifique a disponibilidade do TURN e a rede." : "TURN nao configurado; a rede pode impedir conexao direta.")
      ));
      this.scheduleRecovery(0);
    }, CONNECTION_TIMEOUT_MS);
  }

  private cancelConnectionTimeout() {
    if (this.connectionTimer !== null) window.clearTimeout(this.connectionTimer);
    this.connectionTimer = null;
  }

  /* --------------------------- recuperacao de rede ----------------------- */

  /**
   * Reinicia a negociacao ICE apos uma queda.
   *
   * Trocar de Wi-Fi para cabo, cair a rede por alguns segundos ou o roteador
   * renovar o IP invalidam os candidatos combinados no handshake. Sem o
   * restart, a conexao fica em `failed` para sempre e a unica saida seria o
   * usuario sair e voltar do canal.
   *
   * O atraso cresce a cada tentativa e leva um jitter aleatorio: sem isso,
   * numa sala de quatro pessoas todo mundo tentaria renegociar no mesmo
   * instante e as ofertas colidiriam em rajada.
   */
  private scheduleRecovery(delayMs: number) {
    if (this.recoveryTimer !== null || this.closed) return;
    if (this.recoveryAttempts === MAX_RECOVERY_ATTEMPTS) {
      this.cb.onConnectionState(this.id, "failed");
      this.cb.onError(this.id, new Error("A rede ainda impede a conexao. Continuaremos tentando a cada minuto; verifique o TURN."));
    }

    const slow = this.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS;
    const backoff = delayMs + RECOVERY_BASE_MS * 2 ** Math.min(this.recoveryAttempts, MAX_RECOVERY_ATTEMPTS);
    const jitter = Math.random() * 400;

    this.recoveryTimer = window.setTimeout(() => {
      this.recoveryTimer = null;
      const state = this.pc.connectionState;
      if (this.closed || state === "connected" || state === "closed") return;

      this.recoveryAttempts++;
      try {
        // restartIce() dispara onnegotiationneeded, que refaz a oferta com
        // credenciais ICE novas. A midia ja anexada continua no lugar.
        this.pc.setConfiguration({ ...this.pc.getConfiguration(), iceServers: PC_CONFIG.iceServers });
        this.pc.restartIce();
      } catch (err) {
        this.cb.onError(this.id, err);
      }
      // Se nao voltar, tenta de novo com o intervalo maior.
      this.scheduleRecovery(CONNECTION_TIMEOUT_MS);
    }, slow ? 60_000 + jitter : Math.min(backoff + jitter, MAX_RECOVERY_DELAY_MS));
  }

  private cancelRecovery() {
    if (this.recoveryTimer !== null) {
      window.clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  /** Forca reconexao imediata — usado quando o SO avisa que a rede mudou. */
  recoverNow() {
    if (this.closed) return;
    const state = this.pc.connectionState;
    if (state === "connected") return;
    this.recoveryAttempts = 0;
    this.cancelRecovery();
    this.scheduleRecovery(0);
  }

  /**
   * Quem chega na sala oferta primeiro. Criamos os tres transceivers na ordem
   * canonica; o outro lado apenas responde, o que elimina glare por construcao.
   */
  initiate(tracks: LocalTracks, targets: EncodingTargets) {
    if (this.ready || this.closed) return;
    this.watchConnectionTimeout();
    this.micTx = this.pc.addTransceiver("audio", { direction: "sendrecv" });
    this.videoTx = this.pc.addTransceiver("video", { direction: "sendrecv" });
    this.screenAudioTx = this.pc.addTransceiver("audio", { direction: "sendrecv" });
    this.ready = true;

    applyCodecPreferences(this.videoTx, this.tuning().codec);
    this.attachTracks(this.ultimasTracks ?? tracks);
    void this.applyEncoding(targets);
    queueMicrotask(() => void this.negotiate());
  }

  /** Mapeia os transceivers que a oferta remota criou (lado que responde). */
  private async adopt(tracks: LocalTracks) {
    const previousVideo = this.videoTx;
    const txs = this.pc.getTransceivers();
    const mapped = this.mediaMids().slice(0, 3)
      .map((mid) => txs.find((tx) => tx.mid === mid && !(tx as RTCRtpTransceiver & { stopped?: boolean }).stopped));
    if (mapped.length !== 3 || mapped.some((tx) => !tx)) {
      throw new Error("Oferta sem os tres canais de midia esperados");
    }
    [this.micTx, this.videoTx, this.screenAudioTx] = mapped as RTCRtpTransceiver[];
    // Impede que canais locais desassociados reaparecam em futuras ofertas.
    for (const tx of txs) {
      if (tx.mid === null && !this.retired.has(tx) && !mapped.includes(tx)) {
        this.retired.add(tx);
        await tx.sender.replaceTrack(null);
        if (this.closed) return;
        tx.stop();
      }
    }

    // Nascem "recvonly" por nao terem track na criacao. Sem corrigir, o answer
    // diria que nao enviamos nada e nosso microfone nunca sairia daqui.
    for (const tx of [this.micTx, this.videoTx, this.screenAudioTx]) {
      if (tx.direction !== "sendrecv") tx.direction = "sendrecv";
    }

    this.ready = true;
    if (this.videoTx !== previousVideo) applyCodecPreferences(this.videoTx, this.tuning().codec);
    // O que chegou mais recente ganha: se a malha ja tentou anexar o
    // microfone enquanto este peer se preparava, `ultimasTracks` esta mais
    // atual que o argumento recebido no comeco da negociacao.
    this.attachTracks(this.ultimasTracks ?? tracks);
    await this.tracksPending;
  }

  /**
   * Ultimas trilhas que a malha mandou anexar. Guardadas mesmo quando o peer
   * ainda nao esta pronto.
   *
   * Antes isto era um `if (!this.ready) return` seco, e a trilha ia embora:
   * quem tentasse anexar o microfone antes de a negociacao terminar
   * simplesmente nunca o enviava para aquela pessoa — para sempre, porque
   * nada tentava de novo. Receber continuava funcionando, entao o sintoma era
   * o pior possivel: "eu ouco ele, ele nao me ouve", com a conexao dizendo
   * "connected" e sem erro nenhum. Numa sala de tres, dava para funcionar com
   * um e falhar com outro ao mesmo tempo.
   */
  private ultimasTracks: LocalTracks | null = null;

  attachTracks(tracks: LocalTracks) {
    if (this.closed) return;
    this.ultimasTracks = tracks;
    if (!this.ready) return;
    // O erro do replaceTrack era descartado com `void`. Se anexar o
    // microfone falhasse, ninguem ficava sabendo: o app seguia dizendo
    // "microfone ativo" e nao saia um byte para aquela pessoa.
    this.tracksPending = this.tracksPending.then(async () => {
      if (this.closed) return;
      const latest = this.ultimasTracks!;
      await Promise.all([
        this.trocar(this.micTx, latest.mic, "mic"),
        this.trocar(this.videoTx, latest.screen, "tela"),
        this.trocar(this.screenAudioTx, latest.screenAudio, "audio da tela"),
      ]);
    });
  }

  private trocar(tx: RTCRtpTransceiver | undefined, track: MediaStreamTrack | null, nome: string) {
    if (!tx) {
      if (track) this.cb.onError(this.id, new Error(`sem canal para ${nome}`));
      return;
    }
    if (tx.sender.track === track) return;
    return tx.sender.replaceTrack(track).catch((err) => {
      if (!this.closed && !(tx as RTCRtpTransceiver & { stopped?: boolean }).stopped) this.cb.onError(this.id, new Error(`nao consegui anexar ${nome}: ${String(err)}`));
    });
  }

  /** Estado do envio, para o diagnostico: onde a trilha parou. */
  estadoEnvio() {
    return {
      pronto: this.ready,
      micNoCanal: !!this.micTx?.sender.track,
      micLigado: this.micTx?.sender.track?.enabled ?? null,
      direcao: this.micTx?.currentDirection ?? this.micTx?.direction ?? "-",
      conexao: this.pc.connectionState,
      ice: this.pc.iceConnectionState,
      sinalizacao: this.pc.signalingState,
      coleta: this.pc.iceGatheringState,
      candidatosLocais: [...this.localCandidates].join(",") || "nenhum",
      candidatosRemotos: [...this.remoteCandidates].join(",") || "nenhum",
      errosIce: [...this.iceErrors].join(",") || "nenhum",
      audioTelaNoCanal: !!this.screenAudioTx?.sender.track,
    };
  }

  close() {
    this.closed = true;
    this.cancelRecovery();
    this.cancelConnectionTimeout();
    if (this.encodingRetry !== null) window.clearTimeout(this.encodingRetry);
    this.encodingRetry = null;
    this.pendingCandidates = [];
    this.pc.onicecandidateerror = null;
    this.pc.oniceconnectionstatechange = null;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onnegotiationneeded = null;
    this.pc.onconnectionstatechange = null;
    try {
      this.pc.close();
    } catch {
      /* ja fechada */
    }
  }

  /* ---------------------------- negociacao ------------------------------ */

  /** Uma fila para TODAS as operacoes SDP, incluindo as ofertas locais. */
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.operations.then(async () => {
      if (!this.closed) await operation();
    }).catch((err) => {
      if (!this.closed) this.cb.onError(this.id, err);
    });
    this.operations = next;
    return next;
  }

  private negotiate() {
    if (this.closed || this.negotiationQueued) return;
    this.negotiationQueued = true;
    return this.enqueue(async () => {
      if (!this.ready || this.pc.signalingState !== "stable") return;
      await this.tracksPending;
      if (this.closed) return;
      const offer = await this.pc.createOffer();
      if (this.closed) return;
      offer.sdp = tuneSessionDescription(offer.sdp!, this.tuning());
      await this.pc.setLocalDescription(offer);
      if (!this.closed) this.cb.send(this.id, { description: this.pc.localDescription!.toJSON() });
    }).finally(() => { this.negotiationQueued = false; });
  }

  handleSignal(data: SignalPayload, tracks: LocalTracks, targets: EncodingTargets) {
    return this.enqueue(async () => {
      if ("description" in data && data.description) {
        this.watchConnectionTimeout();
        const desc = data.description;
        const collision = desc.type === "offer" && this.pc.signalingState !== "stable";
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        // A fila garante que createOffer/setLocalDescription terminaram antes
        // de desfazer a oferta. Nunca fazemos rollback em stable.
        if (collision) {
          if (!this.pc.currentRemoteDescription) {
            // Nenhuma midia foi estabelecida ainda. O Chromium preserva
            // transceivers locais sem MID no rollback inicial, provocando
            // ofertas extras e roteamento ambiguo. Responde numa conexao limpa.
            const old = this.pc;
            old.onicecandidate = null;
            old.onicecandidateerror = null;
            old.onnegotiationneeded = null;
            old.ontrack = null;
            old.onconnectionstatechange = null;
            old.oniceconnectionstatechange = null;
            old.close();
            this.pc = new RTCPeerConnection(PC_CONFIG);
            this.ready = false;
            this.micTx = this.videoTx = this.screenAudioTx = undefined;
            this.localCandidates.clear();
            this.wire();
          }
          // Para uma conexao estabelecida, SRD(offer) faz rollback atomico.
          // Separa-lo em SLD(rollback)+SRD pode interromper o encoder no Chromium.
        }
        await this.pc.setRemoteDescription(desc);
        if (this.closed) return;
        for (const candidate of this.pendingCandidates.splice(0)) {
          try { await this.pc.addIceCandidate(candidate); }
          catch (error) { if (!this.ignoreOffer) this.cb.onError(this.id, error); }
          if (this.closed) return;
        }
        if (desc.type === "offer") {
          await this.adopt(tracks);
          if (this.closed) return;
          const answer = await this.pc.createAnswer();
          if (this.closed) return;
          answer.sdp = tuneSessionDescription(answer.sdp!, this.tuning());
          await this.pc.setLocalDescription(answer);
          if (this.closed) return;
          this.cb.send(this.id, { description: this.pc.localDescription!.toJSON() });
          if (collision && this.videoTx?.sender.track) {
            // So em stable: trocar durante have-remote-offer pode derrubar
            // o renderer do Chromium depois de um rollback de ICE restart.
            const video = this.videoTx.sender.track;
            await this.videoTx.sender.replaceTrack(null);
            if (this.closed) return;
            await this.videoTx.sender.replaceTrack(this.ultimasTracks ? this.ultimasTracks.screen : video);
          }
        }
        void this.applyEncoding(this.lastEncoding ?? targets);
      } else if ("candidate" in data && data.candidate) {
        const type = / typ (\w+)/.exec(data.candidate.candidate ?? "")?.[1];
        if (type) this.remoteCandidates.add(type);
        if (!this.pc.remoteDescription) {
          if (this.ignoreOffer) return;
          if (this.pendingCandidates.length >= 256) throw new Error("Candidatos ICE demais antes da oferta");
          this.pendingCandidates.push(data.candidate);
          return;
        }
        try {
          await this.pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (!this.ignoreOffer) throw err;
        }
      }
    });
  }

  /* ------------------------------ qualidade ----------------------------- */

  async applyEncoding(targets: EncodingTargets): Promise<void> {
    this.lastEncoding = targets;
    this.encodingRevision++;
    if (this.encodingTask) return this.encodingTask;
    if (this.closed || !this.ready || !this.videoTx || !this.micTx || !this.screenAudioTx || this.pc.signalingState !== "stable") return;
    const task = (async () => {
      let revision: number;
      do {
        revision = this.encodingRevision;
        await applyVideoEncoding(this.videoTx!.sender, this.tuning(), this.lastEncoding!);
        if (this.closed) return;
        await applyAudioEncoding(this.micTx!.sender, this.screenAudioTx!.sender, this.tuning());
      } while (!this.closed && this.pc.signalingState === "stable" && revision !== this.encodingRevision);
      this.encodingFailures = 0;
    })().catch(error => {
      if (this.closed) return;
      if (++this.encodingFailures <= 2 && this.encodingRetry === null) {
        this.encodingRetry = window.setTimeout(() => {
          this.encodingRetry = null;
          if (!this.closed && this.lastEncoding) void this.applyEncoding(this.lastEncoding);
        }, 1000);
      } else this.cb.onError(this.id, error);
    });
    this.encodingTask = task;
    try { await task; } finally { if (this.encodingTask === task) this.encodingTask = null; }
  }

  refreshCodecPreferences() {
    if (this.ready && this.videoTx) applyCodecPreferences(this.videoTx, this.tuning().codec);
    void this.negotiate();
  }

  /* ------------------------------ metricas ------------------------------ */

  async collectStats(): Promise<PeerStats> {
    const report = await this.pc.getStats();
    this.stats = readStats(report, this.samples, {
      ...this.stats,
      connection: this.pc.connectionState,
    }, { mic: this.micTx?.mid ?? null, screenAudio: this.screenAudioTx?.mid ?? null });
    return this.stats;
  }

  /**
   * Nivel de audio do par via `getSynchronizationSources()`: o proprio RTP
   * carrega o volume (RFC 6464), entao nao precisa de WebAudio. Custo ~zero.
   */
  audioLevel(): number {
    const receiver = this.micTx?.receiver as
      | (RTCRtpReceiver & { getSynchronizationSources?: () => { audioLevel?: number }[] })
      | undefined;
    const sources = receiver?.getSynchronizationSources?.();
    if (!sources?.length) return 0;
    return Math.max(...sources.map((s) => s.audioLevel ?? 0));
  }

  /** Snapshot para depuracao no console (`__voxa.senders()`). */
  debugInfo() {
    return {
      id: this.id,
      ready: this.ready,
      connection: this.pc.connectionState,
      ice: this.pc.iceConnectionState,
      tentativasDeReconexao: this.recoveryAttempts,
      encodings: this.videoTx?.sender.getParameters().encodings ?? [],
      degradation: this.videoTx
        ? (this.videoTx.sender.getParameters() as unknown as Record<string, unknown>)
            .degradationPreference
        : null,
    };
  }
}
