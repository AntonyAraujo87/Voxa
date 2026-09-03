import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

/* ---------------------------------------------------------------------------
   Isola falhas de render.

   Sem isto, uma excecao dentro de um unico tile de video derruba a arvore
   inteira do React e o app inteiro vira tela branca — no meio de uma chamada.
   Com o boundary, o painel quebrado vira um aviso com botao de recarregar e
   todo o resto (voz, chat, lista de pessoas) continua funcionando.

   Boundaries so pegam erros de RENDER. Erros dentro de callbacks assincronos
   (WebRTC, sockets) sao tratados nos proprios modulos.
--------------------------------------------------------------------------- */

interface Props {
  /** aparece na mensagem: "o painel de chat encontrou um erro" */
  area: string;
  children: ReactNode;
  compact?: boolean;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Fica no console do app; nao vai para servidor nenhum.
    console.error(`[ui:${this.props.area}]`, error, info.componentStack);
  }

  private retry = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        className={`flex flex-col items-center justify-center gap-3 bg-base-800 text-center ${
          this.props.compact ? "size-full p-3" : "min-h-0 flex-1 p-6"
        }`}
      >
        <AlertTriangle size={this.props.compact ? 20 : 32} className="text-warn" />
        <div>
          <p className="text-sm font-medium text-ink">Erro em {this.props.area}</p>
          <p className="mt-0.5 max-w-sm text-xs text-muted">
            O resto do app continua funcionando.
          </p>
        </div>
        <button
          onClick={this.retry}
          className="flex items-center gap-1.5 rounded-md bg-base-500 px-3 py-1.5 text-xs text-ink-soft transition-colors hover:bg-base-400"
        >
          <RotateCcw size={13} />
          Tentar de novo
        </button>
      </div>
    );
  }
}
