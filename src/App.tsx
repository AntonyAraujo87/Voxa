import { useEffect, useState } from "react";
import { TitleBar } from "./components/TitleBar";
import { ServerRail } from "./components/ServerRail";
import { ChannelSidebar } from "./components/ChannelSidebar";
import { ChatPanel } from "./components/ChatPanel";
import { StageGrid } from "./components/StageGrid";
import { RemoteAudio } from "./components/RemoteAudio";
import { MemberList } from "./components/MemberList";
import { SettingsModal } from "./components/SettingsModal";
import { SharePicker } from "./components/SharePicker";
import { Toasts } from "./components/Toasts";
import { LoginGate } from "./components/LoginGate";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useApp, type AppState } from "./store/store";
import { session } from "./lib/session";
import { savePrefs } from "./lib/prefs";
import { emitEvent, listenEvent, releaseMemory } from "./lib/desktop";
import { iniciarDiagnostico } from "./lib/diagnostico";
import type { OverlayPeer } from "./components/Overlay";

export default function App() {
  const [ready, setReady] = useState(false);
  const membersOpen = useApp((s) => s.membersOpen);
  const activeVoice = useApp((s) => s.activeVoice);

  // Preferencias salvas entram ANTES do primeiro render util.
  useEffect(() => {
    iniciarDiagnostico();
    session.hydrate();
  }, []);

  // Persiste o que a UI muda direto no store, sem passar pela session.
  useEffect(() => {
    let last = useApp.getState();
    return useApp.subscribe((s) => {
      if (s.membersOpen !== last.membersOpen || s.showStats !== last.showStats) {
        savePrefs({ membersOpen: s.membersOpen, showStats: s.showStats });
      }
      last = s;
    });
  }, []);

  // Atalhos globais (Rust) + checagem de atualizacao, so depois de logado.
  useEffect(() => {
    if (!ready) return;
    let dispose: (() => void) | undefined;
    void session.initHotkeys().then((off) => {
      dispose = off;
    });
    const timer = window.setTimeout(() => void session.checkUpdate(), 4000);
    return () => {
      dispose?.();
      window.clearTimeout(timer);
    };
  }, [ready]);

  useEffect(() => {
    // Atalhos globais estilo Discord.
    const onKey = (e: KeyboardEvent) => {
      if (!ready) return;
      const typing = (e.target as HTMLElement)?.tagName;
      if (typing === "INPUT" || typing === "TEXTAREA") return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.code === "KeyM") {
        e.preventDefault();
        if (!useApp.getState().pushToTalk) session.toggleMute();
      }
      if (mod && e.shiftKey && e.code === "KeyD") {
        e.preventDefault();
        session.toggleDeafen();
      }
      if (mod && e.shiftKey && e.code === "KeyE") {
        e.preventDefault();
        void session.toggleShare();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ready]);

  useEffect(() => {
    const bye = () => session.destroy();
    window.addEventListener("beforeunload", bye);
    return () => window.removeEventListener("beforeunload", bye);
  }, []);

  // Alimenta a janela overlay (processo de WebView separado, sem store
  // proprio) com quem esta no canal de voz agora. So serializa e emite
  // quando o resultado muda de verdade — "speaking" oscila o tempo todo,
  // mas na maioria dos ticks ninguem come started/parou de falar.
  useEffect(() => {
    const montar = (s: AppState): OverlayPeer[] => {
      if (!s.overlayEnabled || !s.activeVoice || !s.me) return [];
      return s.roster
        .filter((r) => r.voice === s.activeVoice)
        .map((r) => ({
          id: r.id,
          name: r.user.name,
          color: r.user.color,
          speaking: !!s.speaking[r.id],
          muted: r.id === s.selfSocketId ? s.muted : r.state.muted,
        }));
    };

    let ultimo = "";
    const emitir = (s: AppState) => {
      const peers = montar(s);
      const serial = JSON.stringify(peers);
      if (serial === ultimo) return;
      ultimo = serial;
      void emitEvent("overlay:roster", peers);
    };

    emitir(useApp.getState());
    const parar = useApp.subscribe(emitir);

    // A janela do overlay avisa quando terminou de montar: como `emitir`
    // ignora repeticao, sem isto ela nasceria vazia e so se preencheria na
    // proxima mudanca de roster.
    let dispose: (() => void) | undefined;
    void listenEvent("overlay:pronto", () => {
      ultimo = "";
      emitir(useApp.getState());
    }).then((off) => {
      dispose = off;
    });

    return () => {
      parar();
      dispose?.();
    };
  }, []);

  // O app passa horas em segundo plano enquanto o jogo roda. Alguns segundos
  // depois de sumir da tela, devolve ao Windows a memoria que nao esta usando.
  // O atraso evita fazer isso num alt-tab rapido, quando a janela volta logo.
  useEffect(() => {
    let timer = 0;
    const onVisibility = () => {
      window.clearTimeout(timer);
      if (document.hidden) {
        timer = window.setTimeout(() => void releaseMemory(), 5000);
        return;
      }
      // Voltou a olhar: o canal aberto passa a estar lido de novo.
      const { activeText, clearUnread } = useApp.getState();
      clearUnread(activeText);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  if (!ready) {
    return (
      <div className="flex h-full flex-col">
        <TitleBar />
        <div className="min-h-0 flex-1">
          <LoginGate onDone={() => setReady(true)} />
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col">
      <TitleBar />

      <div className="flex min-h-0 flex-1">
        <ServerRail />
        <ErrorBoundary area="canais" compact>
          <ChannelSidebar />
        </ErrorBoundary>

        {/* Cada painel tem seu proprio boundary: uma falha no player de video
            nao pode levar junto o chat, e vice-versa. */}
        <main className="flex min-w-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            {/* RemoteAudio fica FORA do boundary de video e sempre montado
                enquanto ha canal de voz: audio nao pode depender da UI de
                transmissao, que na maior parte do tempo nao mostra nada. */}
            {activeVoice && <RemoteAudio />}
            {activeVoice && (
              <ErrorBoundary area="video">
                <StageGrid />
              </ErrorBoundary>
            )}
            <ErrorBoundary area="chat">
              <ChatPanel />
            </ErrorBoundary>
          </div>
          {membersOpen && (
            <ErrorBoundary area="lista de membros" compact>
              <MemberList />
            </ErrorBoundary>
          )}
        </main>
      </div>

      <SettingsModal />
      <SharePicker />
      <Toasts />
    </div>
  );
}
