import { PC_CONFIG } from "../config";
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

/* ---------------------------------------------------------------------------
   Uma conexao com UM outro participante.

   Responsabilidades: negociacao (perfect negotiation), ciclo de vida dos
   transceivers, aplicacao dos parametros de encoder e leitura de metricas.
   Nao conhece a sala, nao conhece os outros pares — quem coordena e o Mesh.
--------------------------------------------------------------------------- */

export class Peer {
  readonly pc: RTCPeerConnection;

  private micTx?: RTCRtpTransceiver;
  private videoTx?: RTCRtpTransceiver;
  private screenAudioTx?: RTCRtpTransceiver;

  // --- perfect negotiation ---
  private makingOffer = false;
  private ignoreOffer = false;
  private settingRemoteAnswer = false;

  /** transceivers ja mapeados (criados por nos ou vindos da oferta remota) */
  private ready = false;

  private recoveryTimer: number | null = null;
  private recoveryAttempts = 0;
  private closed = false;

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
      this.cb.send(this.id, { candidate: candidate ? candidate.toJSON() : null });
    };

    this.pc.onnegotiationneeded = () => void this.negotiate();

    this.pc.ontrack = (ev) => {
      // Roteamento por POSICAO da m-line, nao por identidade do transceiver:
      // quando somos o lado que responde, os transceivers nascem dentro do
      // setRemoteDescription e o ontrack dispara antes de mapearmos as refs.
      const index = this.pc.getTransceivers().indexOf(ev.transceiver);
      const kind: TrackKind = index === 1 ? "screen" : index === 2 ? "screenAudio" : "mic";

      this.cb.onTrack(this.id, kind, new MediaStream([ev.track]));

      // replaceTrack(null) do outro lado chega aqui como mute/unmute — e assim
      // que detectamos "parou de compartilhar" sem renegociar nada.
      ev.track.onmute = () => this.cb.onTrack(this.id, kind, null);
      ev.track.onunmute = () => this.cb.onTrack(this.id, kind, new MediaStream([ev.track]));
      ev.track.onended = () => this.cb.onTrack(this.id, kind, null);
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
      }
      if (state === "failed") this.scheduleRecovery(0);
      if (state === "disconnected") this.scheduleRecovery(RECOVERY_GRACE_MS);
    };

    // `disconnected` costuma ser transitorio (troca de Wi-Fi, pico de latencia)
    // e frequentemente se resolve sozinho; `failed` nunca se resolve sozinho.
    this.pc.oniceconnectionstatechange = () => {
      if (this.pc.iceConnectionState === "failed") this.scheduleRecovery(0);
    };
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
    if (this.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) return;

    const backoff = delayMs + RECOVERY_BASE_MS * 2 ** this.recoveryAttempts;
    const jitter = Math.random() * 400;

    this.recoveryTimer = window.setTimeout(() => {
      this.recoveryTimer = null;
      const state = this.pc.connectionState;
      if (this.closed || state === "connected" || state === "closed") return;

      // `connecting` significa que uma tentativa esta em curso: reiniciar o
      // ICE agora abortaria justamente a negociacao que ia dar certo.
      if (state === "connecting") {
        this.scheduleRecovery(RECOVERY_GRACE_MS);
        return;
      }

      this.recoveryAttempts++;
      try {
        // restartIce() dispara onnegotiationneeded, que refaz a oferta com
        // credenciais ICE novas. A midia ja anexada continua no lugar.
        this.pc.restartIce();
      } catch (err) {
        this.cb.onError(this.id, err);
      }
      // Se nao voltar, tenta de novo com o intervalo maior.
      this.scheduleRecovery(0);
    }, Math.min(backoff + jitter, MAX_RECOVERY_DELAY_MS));
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
    if (state === "connected" || state === "new") return;
    this.recoveryAttempts = 0;
    this.cancelRecovery();
    this.scheduleRecovery(0);
  }

  /**
   * Quem chega na sala oferta primeiro. Criamos os tres transceivers na ordem
   * canonica; o outro lado apenas responde, o que elimina glare por construcao.
   */
  initiate(tracks: LocalTracks, targets: EncodingTargets) {
    if (this.ready) return;
    this.micTx = this.pc.addTransceiver("audio", { direction: "sendrecv" });
    this.videoTx = this.pc.addTransceiver("video", { direction: "sendrecv" });
    this.screenAudioTx = this.pc.addTransceiver("audio", { direction: "sendrecv" });
    this.ready = true;
    this.aplicarPendentes();

    applyCodecPreferences(this.videoTx, this.tuning().codec);
    this.attachTracks(tracks);
    void this.applyEncoding(targets);
    queueMicrotask(() => void this.negotiate());
  }

  /** Mapeia os transceivers que a oferta remota criou (lado que responde). */
  private adopt(tracks: LocalTracks) {
    if (this.ready) return;
    const txs = this.pc.getTransceivers();
    if (txs.length < 3) return;

    [this.micTx, this.videoTx, this.screenAudioTx] = txs;

    // Nascem "recvonly" por nao terem track na criacao. Sem corrigir, o answer
    // diria que nao enviamos nada e nosso microfone nunca sairia daqui.
    for (const tx of [this.micTx, this.videoTx, this.screenAudioTx]) {
      try {
        tx.direction = "sendrecv";
      } catch {
        /* alguns estados recusam a troca; o track ainda vai pelo replaceTrack */
      }
    }

    this.ready = true;
    applyCodecPreferences(this.videoTx, this.tuning().codec);
    // O que chegou mais recente ganha: se a malha ja tentou anexar o
    // microfone enquanto este peer se preparava, `ultimasTracks` esta mais
    // atual que o argumento recebido no comeco da negociacao.
    this.attachTracks(this.ultimasTracks ?? tracks);
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
    this.ultimasTracks = tracks;
    if (!this.ready) return;
    // O erro do replaceTrack era descartado com `void`. Se anexar o
    // microfone falhasse, ninguem ficava sabendo: o app seguia dizendo
    // "microfone ativo" e nao saia um byte para aquela pessoa.
    this.trocar(this.micTx, tracks.mic, "mic");
    this.trocar(this.videoTx, tracks.screen, "tela");
    this.trocar(this.screenAudioTx, tracks.screenAudio, "audio da tela");
  }

  private trocar(tx: RTCRtpTransceiver | undefined, track: MediaStreamTrack | null, nome: string) {
    if (!tx) {
      if (track) this.cb.onError(this.id, new Error(`sem canal para ${nome}`));
      return;
    }
    tx.sender.replaceTrack(track).catch((err) => {
      this.cb.onError(this.id, new Error(`nao consegui anexar ${nome}: ${String(err)}`));
    });
  }

  /** Estado do envio, para o diagnostico: onde a trilha parou. */
  estadoEnvio() {
    return {
      pronto: this.ready,
      micNoCanal: !!this.micTx?.sender.track,
      micLigado: this.micTx?.sender.track?.enabled ?? null,
      direcao: this.micTx?.currentDirection ?? this.micTx?.direction ?? "-",
    };
  }

  /** Aplica o que ficou pendente enquanto o peer nao estava pronto. */
  private aplicarPendentes() {
    if (this.ultimasTracks) this.attachTracks(this.ultimasTracks);
  }

  close() {
    this.closed = true;
    this.cancelRecovery();
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

  private async negotiate() {
    // createOffer() so e valido em `stable`. Sem esta guarda, um ICE restart
    // que caia no meio de uma oferta remota (ou uma colisao de ofertas) lanca
    // InvalidStateError e a conexao fica travada em vez de se recuperar.
    if (this.pc.signalingState !== "stable") return;

    try {
      this.makingOffer = true;
      const offer = await this.pc.createOffer();
      offer.sdp = tuneSessionDescription(offer.sdp!, this.tuning());
      await this.pc.setLocalDescription(offer);
      this.cb.send(this.id, { description: this.pc.localDescription!.toJSON() });
    } catch (err) {
      this.cb.onError(this.id, err);
    } finally {
      this.makingOffer = false;
    }
  }

  async handleSignal(data: SignalPayload, tracks: LocalTracks, targets: EncodingTargets) {
    try {
      if ("description" in data && data.description) {
        const desc = data.description;
        const readyForOffer =
          !this.makingOffer &&
          (this.pc.signalingState === "stable" || this.settingRemoteAnswer);
        const collision = desc.type === "offer" && !readyForOffer;

        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;

        this.settingRemoteAnswer = desc.type === "answer";
        await this.pc.setRemoteDescription(desc);
        this.settingRemoteAnswer = false;

        if (desc.type === "offer") {
          this.adopt(tracks);
          const answer = await this.pc.createAnswer();
          answer.sdp = tuneSessionDescription(answer.sdp!, this.tuning());
          await this.pc.setLocalDescription(answer);
          this.cb.send(this.id, { description: this.pc.localDescription!.toJSON() });
          void this.applyEncoding(targets);
        }
      } else if ("candidate" in data) {
        try {
          await this.pc.addIceCandidate(data.candidate ?? undefined);
        } catch (err) {
          // Candidato orfao de uma oferta que ignoramos nao e erro real.
          if (!this.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      this.cb.onError(this.id, err);
    }
  }

  /* ------------------------------ qualidade ----------------------------- */

  async applyEncoding(targets: EncodingTargets) {
    if (!this.ready || !this.videoTx || !this.micTx || !this.screenAudioTx) return;
    await applyVideoEncoding(this.videoTx.sender, this.tuning(), targets);
    await applyAudioEncoding(this.micTx.sender, this.screenAudioTx.sender, this.tuning());
  }

  refreshCodecPreferences() {
    if (this.ready && this.videoTx) applyCodecPreferences(this.videoTx, this.tuning().codec);
  }

  /* ------------------------------ metricas ------------------------------ */

  async collectStats(): Promise<PeerStats> {
    const report = await this.pc.getStats();
    this.stats = readStats(report, this.samples, {
      ...this.stats,
      connection: this.pc.connectionState,
    });
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
