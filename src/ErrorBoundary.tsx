import { Component, type ErrorInfo, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Props { children: ReactNode }
interface State { failed: boolean }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[voxa] falha no painel", error.name, info.componentStack);
  }

  private readonly restart = async () => {
    // Uma falha visual nao pode deixar captura ou sockets executando sem
    // controles na tela. Encerra o motor antes de recarregar o WebView.
    await invoke("engine_stop").catch(() => undefined);
    window.location.reload();
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="shell">
        <section className="card">
          <h1>O painel encontrou um erro.</h1>
          <p>O motor de transmissao sera encerrado com seguranca antes de reiniciar.</p>
          <button className="primary" type="button" onClick={() => void this.restart()}>
            Reiniciar Voxa
          </button>
        </section>
      </main>
    );
  }
}
