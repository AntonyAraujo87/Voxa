import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { NativeEngine, type AudioProcessInfo, type CaptureTargetInfo, type EngineStatus, type GraphicsAdapterInfo, type StreamRole } from "./lib/nativeEngine";
import { Matchmaking, type PeerAnnouncement } from "./lib/signaling";

const DEFAULT_SIGNALING =
  (import.meta.env.VITE_SIGNALING_URL as string | undefined) ?? "http://localhost:3001";

const emptyStatus: EngineStatus = {
  phase: "idle", role: null, localEndpoint: null, publicEndpoint: null,
  peerEndpoint: null, rttMs: 0, lossPct: 0, bitrateKbps: 0,
  receivedFrames: 0, encodedFrames: 0, droppedFrames: 0, keyframeRequests: 0,
  renderer: "closed", capture: "idle", encoder: "idle",
  decoder: "idle", decoderGpu: null, audio: "idle", audioBitrateKbps: 0, audioError: null, rejoinRequired: false, decodedFrames: 0,
  avSyncMs: 0, encoderCapacity: 1, cursorVisible: true, hdr: false, captureRestarts: 0,
  latencyP50Ms: 0, latencyP95Ms: 0, latencyP99Ms: 0,
  verificationCode: null, connectedPeers: 0, maxPeers: 4, peerVerifications: [], peerMetrics: [], lastError: null,
};

export default function App() {
  const engine = useMemo(() => new NativeEngine(), []);
  const [serverUrl, setServerUrl] = useState(DEFAULT_SIGNALING);
  const [room, setRoom] = useState(() => localStorage.getItem("voxa-room") ?? randomRoom());
  const [roomPassword, setRoomPassword] = useState("");
  const [role, setRole] = useState<StreamRole>("viewer");
  const [status, setStatus] = useState<EngineStatus>(emptyStatus);
  const [message, setMessage] = useState("Pronto para conectar");
  const [busy, setBusy] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [captureTargets, setCaptureTargets] = useState<CaptureTargetInfo[]>([]);
  const [captureTargetIndex, setCaptureTargetIndex] = useState(0);
  const [audioProcesses, setAudioProcesses] = useState<AudioProcessInfo[]>([]);
  const [audioProcessId, setAudioProcessId] = useState(0);
  const [cursorVisible, setCursorVisible] = useState(true);
  const [graphicsAdapters, setGraphicsAdapters] = useState<GraphicsAdapterInfo[]>([]);
  const [decoderAdapterIndex, setDecoderAdapterIndex] = useState(-1);
  const captureTargetRef = useRef<CaptureTargetInfo | null>(null);
  const audioProcessRef = useRef(0);
  const approvedPeersRef = useRef(new Map<string, string>());
  const [pendingPeers, setPendingPeers] = useState<Array<{ peer: PeerAnnouncement; code: string }>>([]);
  const [updateMessage, setUpdateMessage] = useState("Verificar atualização");
  const roomValid = /^[a-zA-Z0-9._:-]{1,64}$/.test(room);
  const passwordValid = roomPassword.length >= 12 && roomPassword.length <= 128;

  useEffect(() => {
    void engine.captureTargets().then((targets) => {
      setCaptureTargets(targets);
      const primary = targets.findIndex((target) => target.primary);
      setCaptureTargetIndex(primary >= 0 ? primary : 0);
    }).catch(() => setCaptureTargets([]));
  }, [engine]);

  useEffect(() => {
    void engine.audioProcesses().then(setAudioProcesses).catch(() => setAudioProcesses([]));
    void engine.graphicsAdapters().then(setGraphicsAdapters).catch(() => setGraphicsAdapters([]));
  }, [engine]);

  useEffect(() => {
    captureTargetRef.current = captureTargets[captureTargetIndex] ?? null;
  }, [captureTargets, captureTargetIndex]);

  useEffect(() => { audioProcessRef.current = audioProcessId; }, [audioProcessId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void engine.status().then((next) => {
        setStatus(next);
        if (next.rejoinRequired) {
          setMessage("A rede mudou. Refazendo a rota e as chaves...");
          void engine.recoverSignaling().catch((error) => setMessage(String(error)));
        }
      }).catch(() => undefined);
    }, 500);
    return () => window.clearInterval(timer);
  }, [engine]);

  useEffect(() => {
    const unlisten = listen("stream-window-closed", async () => {
      setBusy(true);
      await engine.stop().catch(() => undefined);
      setStatus(await engine.status().catch(() => emptyStatus));
      setMessage("Janela de transmissão fechada");
      setBusy(false);
    });
    return () => { void unlisten.then((dispose) => dispose()); };
  }, [engine]);

  useEffect(() => {
    let disposed = false;
    void check({ timeout: 8_000 }).then((update) => {
      if (disposed) { void update?.close(); return; }
      setAvailableUpdate(update);
      setUpdateMessage(update ? `Atualizar para ${update.version}` : "Voxa atualizado");
    }).catch(() => setUpdateMessage("Verificar atualização"));
    return () => { disposed = true; };
  }, []);

  async function checkForUpdate() {
    setUpdateMessage("Procurando atualização...");
    try {
      await availableUpdate?.close();
      setAvailableUpdate(null);
      const update = await check({ timeout: 10_000 });
      setAvailableUpdate(update);
      setUpdateMessage(update ? `Atualizar para ${update.version}` : "Voxa atualizado");
    } catch (error) {
      setUpdateMessage(error instanceof Error ? error.message : "Falha ao verificar atualização");
    }
  }

  async function installUpdate() {
    if (!availableUpdate || active || busy) return;
    setBusy(true);
    setPendingPeers([]);
    try {
      let received = 0;
      let total = 0;
      await availableUpdate.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        if (event.event === "Progress") received += event.data.chunkLength;
        setUpdateMessage(total > 0 ? `Baixando ${Math.min(100, Math.round(received * 100 / total))}%` : "Baixando atualização...");
      }, { timeout: 120_000 });
      await relaunch();
    } catch (error) {
      setUpdateMessage(error instanceof Error ? error.message : "Falha ao instalar atualização");
      setBusy(false);
    }
  }

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (!roomValid || !passwordValid || busy) return;
    setBusy(true);
    setMessage("Abrindo o socket UDP nativo...");
    setPendingPeers([]);
    approvedPeersRef.current.clear();
    let matchmaking: Matchmaking | null = null;
    try {
      const roomId = room.trim();
      const roomSecret = await engine.roomSecret(roomId, roomPassword);
      localStorage.setItem("voxa-room", roomId);
      const selectedCaptureTarget = role === "host" ? captureTargets[captureTargetIndex]?.id ?? null : null;
      const selectedAudioProcess = role === "host" && audioProcessId > 0 ? audioProcessId : null;
      const endpoint = await engine.prepare(
        role,
        selectedCaptureTarget,
        selectedAudioProcess,
        role === "viewer" && decoderAdapterIndex >= 0 ? decoderAdapterIndex : null,
      );
      matchmaking = new Matchmaking(validSignalingUrl(serverUrl), {
        onPeer: async (peer: PeerAnnouncement) => {
          if (role === "host") {
            if (approvedPeersRef.current.get(peer.peerId) === peer.publicKey) {
              setMessage("A rede do espectador mudou. Restaurando a rota aprovada...");
              await engine.connectPeer(peer);
              setMessage("Rota do espectador restaurada");
              return;
            }
            if (await engine.isTrusted(peer.publicKey).catch(() => false)) {
              setMessage("Computador confiável reconhecido. Restaurando a transmissão...");
              await engine.connectPeer(peer);
              approvedPeersRef.current.set(peer.peerId, peer.publicKey);
              setMessage("Computador confiável conectado");
              return;
            }
            const code = await engine.previewPeer(peer);
            setPendingPeers((current) => [
              ...current.filter((candidate) => candidate.peer.peerId !== peer.peerId),
              { peer, code },
            ]);
            setMessage("Novo espectador aguardando sua aprovação");
            return;
          }
          setMessage("Perfurando o NAT e autenticando o par...");
          await engine.connectPeer(peer);
          setMessage("Decoder e janela D3D11 iniciados");
        },
        onPeerLeft: async (peerId) => {
          setPendingPeers((current) => current.filter((candidate) => candidate.peer.peerId !== peerId));
          await engine.disconnectPeer(peerId);
          if (role === "host") {
            setMessage("Um espectador desconectou. A sala continua aberta.");
          } else {
            setMessage("O host desconectou. Renovando as chaves...");
            const refreshed = await engine.prepare(
              role,
              selectedCaptureTarget,
              null,
              decoderAdapterIndex >= 0 ? decoderAdapterIndex : null,
              true,
            );
            if (matchmaking) await matchmaking.join(roomId, role, refreshed, roomSecret);
          }
        },
        onCapacity: (maxViewers) => engine.setMaxPeers(maxViewers),
        onError: setMessage,
        pakeBegin: (peerId, pakeRoom, secret) => engine.pakeBegin(peerId, pakeRoom, secret),
        pakeFinish: (peerId, remoteShare) => engine.pakeFinish(peerId, remoteShare),
        pakeConfirm: (peerId, remoteConfirmation) => engine.pakeConfirm(peerId, remoteConfirmation),
        refreshEndpoint: (reconnectingRole) => engine.prepare(
          reconnectingRole,
          reconnectingRole === "host" ? captureTargetRef.current?.id ?? null : null,
          reconnectingRole === "host" && audioProcessRef.current > 0 ? audioProcessRef.current : null,
          reconnectingRole === "viewer" && decoderAdapterIndex >= 0 ? decoderAdapterIndex : null,
          true,
        ),
      });
      engine.attachMatchmaking(matchmaking);
      await matchmaking.join(roomId, role, endpoint, roomSecret);
      const preparedStatus = await engine.status();
      setStatus(preparedStatus);
      setMessage(role === "host"
        ? preparedStatus.encoderCapacity < 4
          ? `GPU permite ${preparedStatus.encoderCapacity} espectador(es) simultâneo(s)`
          : "Aguardando espectador..."
        : "Procurando o computador host...");
    } catch (error) {
      matchmaking?.close();
      await engine.stop().catch(() => undefined);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  }

  async function stop() {
    setBusy(true);
    await engine.stop().catch(() => undefined);
    setStatus(await engine.status().catch(() => emptyStatus));
    setPendingPeers([]);
    approvedPeersRef.current.clear();
    setMessage("Transmissão encerrada");
    setBusy(false);
  }

  async function approvePeer(peerId: string, remember = false) {
    const pending = pendingPeers.find((candidate) => candidate.peer.peerId === peerId);
    if (!pending || busy) return;
    setBusy(true);
    try {
      setMessage("Autenticando e liberando o espectador...");
      await engine.connectPeer(pending.peer);
      let trustSaved = false;
      if (remember) {
        trustSaved = await engine.trustPeer(pending.peer.peerId, pending.peer.publicKey)
          .then(() => true)
          .catch(() => false);
      }
      approvedPeersRef.current.set(pending.peer.peerId, pending.peer.publicKey);
      setPendingPeers((current) => current.filter((candidate) => candidate.peer.peerId !== peerId));
      setMessage(remember
        ? trustSaved
          ? "Espectador aprovado e protegido como computador confiável."
          : "Espectador conectado; o Windows não permitiu salvar o pareamento."
        : "Espectador aprovado. Pipeline nativo iniciado.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function selectCaptureTarget(index: number) {
    setCaptureTargetIndex(index);
    const target = captureTargets[index];
    captureTargetRef.current = target ?? null;
    if (!active || role !== "host" || !target) return;
    setBusy(true);
    try {
      setMessage("Trocando monitor e reiniciando os encoders...");
      await engine.switchCapture(target.id);
      setMessage("Monitor alterado sem encerrar a sala");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function selectAudioSource(processId: number) {
    setAudioProcessId(processId);
    audioProcessRef.current = processId;
    if (!active || role !== "host") return;
    setBusy(true);
    try {
      await engine.switchAudio(processId > 0 ? processId : null);
      setMessage(processId > 0 ? "Áudio isolado no jogo; retorno do Discord bloqueado" : "Capturando todo o som do sistema");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function toggleCursor() {
    const next = !cursorVisible;
    setCursorVisible(next);
    try {
      await engine.setCursorVisible(next);
      setMessage(next ? "Cursor remoto visível" : "Cursor remoto oculto");
    } catch (error) {
      setCursorVisible(!next);
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function clearTrustedPeers() {
    try {
      await engine.clearTrusted();
      setMessage("Computadores confiáveis removidos. Novas conexões exigirão aprovação.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function exportDiagnostic() {
    try {
      const path = await engine.exportDiagnostic();
      setMessage(`Diagnóstico salvo em ${path}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  const active = status.phase !== "idle" && status.phase !== "stopped";
  return (
    <main className="shell">
      <header className="titlebar" data-tauri-drag-region>
        <div className="brand"><span className="brand-dot" /> VOXA STREAM</div>
        <div className="window-actions">
          <button aria-label="Minimizar" onClick={() => invoke("minimize_main")}>—</button>
          <button aria-label="Fechar" onClick={() => invoke("hide_main")}>×</button>
        </div>
      </header>
      <section className="hero">
        <div className="eyebrow">NATIVE UDP ENGINE</div>
        <h1>Controle simples.<br />Vídeo fora do navegador.</h1>
        <p>O painel negocia a sessão. Captura, transporte e a janela de reprodução pertencem ao motor Rust.</p>
      </section>
      <section className="card">
        <form onSubmit={connect}>
          <div className="role-picker" aria-label="Modo de conexão">
            <button type="button" className={role === "host" ? "selected" : ""} onClick={() => setRole("host")} disabled={active}>
              <strong>Hospedar</strong><span>Transmitir este PC</span>
            </button>
            <button type="button" className={role === "viewer" ? "selected" : ""} onClick={() => setRole("viewer")} disabled={active}>
              <strong>Conectar</strong><span>Assistir outro PC</span>
            </button>
          </div>
          {role === "host" && <label>Monitor e GPU
            <select value={captureTargetIndex} onChange={(event) => void selectCaptureTarget(Number(event.target.value))} disabled={busy}>
              {captureTargets.length === 0
                ? <option value={0}>Monitor principal automático</option>
                : captureTargets.map((target, index) => <option key={`${target.id.adapterIndex}:${target.id.outputIndex}`} value={index}>
                    {target.primary ? "Principal · " : ""}{target.monitor} · {target.width}×{target.height}{target.hdr ? " · HDR" : ""} · {target.gpu}
                  </option>)}
            </select>
          </label>}
          {role === "host" && <button className="secondary" type="button" onClick={() => void toggleCursor()} disabled={busy || !active}>
            {cursorVisible ? "Ocultar cursor transmitido" : "Mostrar cursor transmitido"}
          </button>}
          {role === "host" && <button className="secondary" type="button" onClick={() => void clearTrustedPeers()} disabled={busy || active}>
            Remover computadores confiáveis
          </button>}
          {role === "host" && <label>Áudio transmitido
            <select value={audioProcessId} onChange={(event) => void selectAudioSource(Number(event.target.value))} disabled={busy}>
              <option value={0}>Todo o som do sistema (pode incluir Discord)</option>
              {audioProcesses.map((process) => <option key={process.processId} value={process.processId}>
                Somente {process.name} · PID {process.processId}
              </option>)}
            </select>
            <button className="secondary" type="button" onClick={() => void engine.audioProcesses().then(setAudioProcesses).catch(() => setMessage("Não foi possível atualizar os processos"))} disabled={busy}>Atualizar processos</button>
            <small>{audioProcessId > 0 ? "Proteção contra eco do Discord ativa: somente o processo do jogo e seus filhos entram no stream." : "Escolha o jogo para impedir que Discord e o próprio Voxa retornem ao espectador."}</small>
          </label>}
          {role === "viewer" && <label>GPU de reprodução
            <select value={decoderAdapterIndex} onChange={(event) => setDecoderAdapterIndex(Number(event.target.value))} disabled={active || busy}>
              <option value={-1}>Automática (melhor GPU compatível)</option>
              {graphicsAdapters.map((adapter) => <option key={adapter.adapterIndex} value={adapter.adapterIndex}>
                {adapter.name} · {adapter.dedicatedMemoryMb} MB · driver {adapter.driverVersion ?? "não informado"}
              </option>)}
            </select>
          </label>}
          <label>Código da sala<input value={room} onChange={(event) => setRoom(event.target.value)} maxLength={64} pattern="[a-zA-Z0-9._:-]+" title="Use letras, números, ponto, dois-pontos, hífen ou sublinhado" placeholder="ex.: sala-do-jogo" disabled={active} /></label>
          <label>Senha da sala<input value={roomPassword} onChange={(event) => setRoomPassword(event.target.value)} type="password" minLength={12} maxLength={128} autoComplete="new-password" placeholder="Use 12 ou mais caracteres nos dois computadores" disabled={active} /></label>
          <details>
            <summary>Servidor de matchmaking</summary>
            <label>URL<input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} inputMode="url" disabled={active} /></label>
          </details>
          {active
            ? <><button className="primary" type="button" onClick={() => void engine.toggleFullscreen().catch((error) => setMessage(String(error)))} disabled={busy || role !== "viewer"}>Tela cheia</button><button className="primary" type="button" onClick={() => void engine.openNewSession().catch((error) => setMessage(String(error)))} disabled={busy}>Abrir outra sessão</button><button className="primary danger" type="button" onClick={stop} disabled={busy}>Encerrar</button></>
            : <button className="primary" type="submit" disabled={busy || !roomValid || !passwordValid}>{busy ? "Conectando..." : role === "host" ? "Começar transmissão" : "Conectar ao host"}</button>}
        </form>
      </section>
      {role === "host" && pendingPeers.length > 0 && <section className="card approvals" aria-live="assertive">
        <h2>Aprovação de espectadores</h2>
        <p>Compare o código abaixo com o exibido no computador do espectador. A tela e o áudio só serão enviados depois da aprovação.</p>
        {pendingPeers.map(({ peer, code }, index) => <div className="approval" key={peer.peerId}>
          <div><strong>Espectador {index + 1}</strong><span>Código E2E: {code}</span></div>
          <div className="approval-actions">
            <button className="secondary" type="button" onClick={() => void approvePeer(peer.peerId)} disabled={busy}>Aprovar uma vez</button>
            <button className="primary" type="button" onClick={() => void approvePeer(peer.peerId, true)} disabled={busy}>Aprovar e confiar</button>
          </div>
        </div>)}
      </section>}
      <section className="telemetry" aria-live="polite">
        <div className={`status ${status.phase}`}><i />{message}</div>
        <div className="metrics">
          <Metric label="Rota" value={status.peerEndpoint ?? status.publicEndpoint ?? "—"} />
          <Metric label="Espectadores" value={role === "host" ? `${status.connectedPeers}/${status.maxPeers}` : status.connectedPeers ? "Conectado" : "Aguardando"} />
          <Metric label="RTT" value={`${status.rttMs} ms`} />
          <Metric label="Perda" value={`${status.lossPct.toFixed(1)}%`} />
          <Metric label="Bitrate" value={`${status.bitrateKbps} kbps`} />
          <Metric label="Código E2E" value={role === "host" && status.peerVerifications.length > 0 ? status.peerVerifications.map(({ code }, index) => `#${index + 1} ${code}`).join(" · ") : status.verificationCode ?? "—"} />
          <Metric label="Frames" value={role === "host" ? `${status.encodedFrames} codificados · ${status.droppedFrames} descartados` : `${status.receivedFrames} recebidos · ${status.decodedFrames} exibidos · ${status.droppedFrames} descartados`} />
          <Metric label="Latência vídeo" value={status.latencyP50Ms ? `P50 ${status.latencyP50Ms} · P95 ${status.latencyP95Ms} · P99 ${status.latencyP99Ms} ms` : "medindo..."} />
          <Metric label="Sincronia A/V" value={`${status.avSyncMs > 0 ? "+" : ""}${status.avSyncMs} ms`} />
          <Metric label="GPU host" value={`${status.encoderCapacity} encoder(es)${status.hdr ? " · HDR→SDR" : " · SDR"}`} />
          <Metric label="Pipeline" value={`${status.capture} · ${status.encoder} · ${status.decoder}${status.decoderGpu ? ` (${status.decoderGpu})` : ""} · ${status.renderer}`} />
          <Metric label="Áudio" value={`${status.audio} · ${status.audioBitrateKbps || "—"} kbps`} />
          <Metric label="Recuperações" value={`${status.captureRestarts} reinício(s) do pipeline`} />
        </div>
        {status.lastError && <small className="native-error">Erro nativo: {status.lastError}</small>}
        {status.audioError && <small className="native-error">Erro de áudio: {status.audioError}</small>}
        {role === "host" && status.peerMetrics.length > 0 && <div className="peer-metrics">
          {status.peerMetrics.map((peer, index) => <div key={peer.peerId}>
            <strong>Espectador {index + 1}</strong>
            <span>{peer.phase} · {peer.rttMs} ms · {peer.lossPct.toFixed(1)}% · {peer.bitrateKbps} kbps · P95 {peer.latencyP95Ms || "—"} ms</span>
            <small title={peer.endpoint ?? undefined}>{peer.endpoint ?? "Rota em negociação"}</small>
          </div>)}
        </div>}
        {(status.verificationCode || status.peerVerifications.length > 0) && <small>Compare cada Código E2E com o espectador correspondente antes de confiar na sessão.</small>}
      </section>
      <section className="card update-card">
        <button type="button" onClick={() => void exportDiagnostic()} disabled={busy}>Exportar diagnóstico</button>
        <button type="button" onClick={availableUpdate ? installUpdate : checkForUpdate} disabled={busy || active}>
          {updateMessage}
        </button>
        {active && availableUpdate && <small>Encerre a transmissão antes de atualizar.</small>}
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong title={value}>{value}</strong></div>;
}

function randomRoom() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function validSignalingUrl(value: string) {
  const url = new URL(value.trim());
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("O matchmaking deve usar HTTPS; HTTP é permitido somente no computador local");
  }
  return url.origin;
}
