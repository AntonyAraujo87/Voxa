import { FormEvent, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { NativeEngine, type EngineStatus, type StreamRole } from "./lib/nativeEngine";
import { Matchmaking, type PeerAnnouncement } from "./lib/signaling";

const DEFAULT_SIGNALING =
  (import.meta.env.VITE_SIGNALING_URL as string | undefined) ?? "http://localhost:3001";

const emptyStatus: EngineStatus = {
  phase: "idle", role: null, localEndpoint: null, publicEndpoint: null,
  peerEndpoint: null, rttMs: 0, lossPct: 0, bitrateKbps: 0,
  receivedFrames: 0, droppedFrames: 0, keyframeRequests: 0,
  renderer: "closed", capture: "idle", encoder: "idle",
  decoder: "idle", decodedFrames: 0,
  verificationCode: null,
};

export default function App() {
  const engine = useMemo(() => new NativeEngine(), []);
  const [serverUrl, setServerUrl] = useState(DEFAULT_SIGNALING);
  const [room, setRoom] = useState(localStorage.getItem("voxa-room") ?? "");
  const [token, setToken] = useState("");
  const [role, setRole] = useState<StreamRole>("viewer");
  const [status, setStatus] = useState<EngineStatus>(emptyStatus);
  const [message, setMessage] = useState("Pronto para conectar");
  const [busy, setBusy] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [updateMessage, setUpdateMessage] = useState("Verificar atualização");
  const roomValid = /^[a-zA-Z0-9._:-]{1,64}$/.test(room);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void engine.status().then(setStatus).catch(() => undefined);
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
    if (!roomValid || busy) return;
    setBusy(true);
    setMessage("Abrindo o socket UDP nativo...");
    let matchmaking: Matchmaking | null = null;
    try {
      localStorage.setItem("voxa-room", room.trim());
      const endpoint = await engine.prepare(role);
      matchmaking = new Matchmaking(serverUrl, {
        token,
        onPeer: async (peer: PeerAnnouncement) => {
          setMessage("Perfurando o NAT e autenticando o par...");
          await engine.connectPeer(peer);
          setMessage(role === "host" ? "Pipeline H.264 nativo iniciado" : "Decoder e janela D3D11 iniciados");
        },
        onPeerLeft: async () => {
          setMessage("O outro computador desconectou. Renovando as chaves...");
          await engine.disconnectPeer();
          const refreshed = await engine.prepare(role);
          if (matchmaking) await matchmaking.join(room.trim(), role, refreshed);
        },
        onError: setMessage,
        refreshEndpoint: (reconnectingRole) => engine.prepare(reconnectingRole),
      });
      engine.attachMatchmaking(matchmaking);
      await matchmaking.join(room.trim(), role, endpoint);
      setMessage(role === "host" ? "Aguardando espectador..." : "Procurando o computador host...");
      setStatus(await engine.status());
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
    setMessage("Transmissão encerrada");
    setBusy(false);
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
          <label>Sala<input value={room} onChange={(event) => setRoom(event.target.value)} maxLength={64} pattern="[a-zA-Z0-9._:-]+" title="Use letras, números, ponto, dois-pontos, hífen ou sublinhado" placeholder="ex.: sala-do-jogo" disabled={active} /></label>
          <label>Senha da sala<input value={token} onChange={(event) => setToken(event.target.value)} type="password" maxLength={256} placeholder="Obrigatória no servidor público" disabled={active} /></label>
          <details>
            <summary>Servidor de matchmaking</summary>
            <label>URL<input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} inputMode="url" disabled={active} /></label>
          </details>
          {active
            ? <><button className="primary" type="button" onClick={() => void engine.toggleFullscreen().catch((error) => setMessage(String(error)))} disabled={busy || role !== "viewer"}>Tela cheia</button><button className="primary danger" type="button" onClick={stop} disabled={busy}>Encerrar</button></>
            : <button className="primary" type="submit" disabled={busy || !roomValid}>{busy ? "Conectando..." : role === "host" ? "Começar transmissão" : "Conectar ao host"}</button>}
        </form>
      </section>
      <section className="telemetry" aria-live="polite">
        <div className={`status ${status.phase}`}><i />{message}</div>
        <div className="metrics">
          <Metric label="Rota" value={status.peerEndpoint ?? status.publicEndpoint ?? "—"} />
          <Metric label="RTT" value={`${status.rttMs} ms`} />
          <Metric label="Perda" value={`${status.lossPct.toFixed(1)}%`} />
          <Metric label="Bitrate" value={`${status.bitrateKbps} kbps`} />
          <Metric label="Código E2E" value={status.verificationCode ?? "—"} />
          <Metric label="Frames" value={`${status.decodedFrames} exibidos · ${status.droppedFrames} descartados`} />
          <Metric label="Pipeline" value={`${status.capture} · ${status.encoder} · ${status.decoder} · ${status.renderer}`} />
        </div>
        {status.verificationCode && <small>Compare o Código E2E nos dois computadores antes de confiar na sessão.</small>}
      </section>
      <section className="card update-card">
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
