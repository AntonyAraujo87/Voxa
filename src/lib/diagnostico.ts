import { invoke, isDesktop } from "./desktop";

/* ---------------------------------------------------------------------------
   Diagnostico para quando algo quebra na maquina de outra pessoa.

   Nao envia nada para servidor nenhum — e um buffer em memoria que a pessoa
   copia e cola quando pede ajuda. Antes disto, "deu erro aqui" era literalmente
   toda a informacao disponivel: o console do WebView2 fica atras de um menu de
   contexto escondido, e panic do Rust morria com o processo.

   O buffer e circular de proposito: um erro que se repete em loop (render que
   falha a cada frame) nao pode consumir memoria sem limite justamente no
   momento em que o app ja esta mal.
--------------------------------------------------------------------------- */

const MAX_EVENTOS = 40;

export interface EventoDiagnostico {
  quando: string;
  origem: string;
  mensagem: string;
  detalhe?: string;
}

const eventos: EventoDiagnostico[] = [];

export function registrarErro(origem: string, erro: unknown, detalhe?: string) {
  const mensagem = erro instanceof Error ? `${erro.name}: ${erro.message}` : String(erro);
  eventos.push({
    quando: new Date().toISOString(),
    origem,
    mensagem,
    // Pilha inteira raramente ajuda e polui o texto colado; as primeiras
    // linhas ja apontam o arquivo.
    detalhe: detalhe ?? (erro instanceof Error ? erro.stack?.split("\n").slice(1, 4).join("\n") : undefined),
  });
  if (eventos.length > MAX_EVENTOS) eventos.splice(0, eventos.length - MAX_EVENTOS);
}

export function eventosRegistrados(): readonly EventoDiagnostico[] {
  return eventos;
}

/**
 * Liga o coletor a erros que ninguem trata: excecao solta e promise rejeitada.
 * Chamado uma vez no boot.
 */
export function iniciarDiagnostico() {
  if (typeof window === "undefined") return;
  window.addEventListener("error", (e) => registrarErro("janela", e.error ?? e.message));
  window.addEventListener("unhandledrejection", (e) => registrarErro("promessa", e.reason));
}

/**
 * Copia texto para a area de transferencia.
 *
 * `navigator.clipboard` e o caminho bom, mas recusa quando o documento nao
 * esta focado (janela em segundo plano, WebView em certos estados) — e este
 * botao e usado justamente quando algo ja esta estranho. O caminho antigo com
 * textarea nao depende de permissao nem de foco.
 */
export async function copiarTexto(texto: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    /* tenta o jeito antigo */
  }

  try {
    const area = document.createElement("textarea");
    area.value = texto;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Texto pronto para colar num chat pedindo ajuda. */
export async function montarRelatorio(): Promise<string> {
  const info = isDesktop
    ? await invoke<{ os: string; arch: string; version: string }>("runtime_info")
    : null;

  const panics = isDesktop ? await invoke<string>("read_panic_log") : null;

  const linhas = [
    "=== Voxa — diagnostico ===",
    `versao: ${info?.version ?? "(navegador)"}`,
    `sistema: ${info ? `${info.os} ${info.arch}` : navigator.userAgent}`,
    `gerado: ${new Date().toISOString()}`,
    "",
  ];

  if (panics?.trim()) {
    linhas.push("--- falhas do processo nativo ---", panics.trim(), "");
  }

  if (eventos.length === 0) {
    linhas.push("--- nenhum erro registrado nesta sessao ---");
  } else {
    linhas.push(`--- ${eventos.length} erro(s) nesta sessao ---`);
    for (const e of eventos) {
      linhas.push(`[${e.quando}] (${e.origem}) ${e.mensagem}`);
      if (e.detalhe) linhas.push(e.detalhe);
    }
  }

  return linhas.join("\n");
}
