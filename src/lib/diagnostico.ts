import { invoke, isDesktop } from "./desktop";
import { SIGNALING_URL } from "./config";
import { estadoSaida } from "./audioOutput";
import { useApp } from "../store/store";
import { getPeerMedia } from "../store/mediaStore";

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

  // O que esta LIGADO nesta instalacao, e nao so o que deu errado.
  //
  // As variaveis VITE_* entram no bundle na hora do build; secret vazio vira
  // string vazia e o recurso se desliga sozinho, sem erro nenhum. Foi assim
  // que o historico do chat ficou quebrado sem ninguem notar: o unico
  // sintoma era o historico estar vazio, que parece "ainda nao usamos".
  // Sem esta linha, descobrir isso exige investigar o build inteiro.
  // Lido direto do env, e nao importado de `supabase.ts`: aquele modulo
  // importa `registrarErro` daqui, e o ciclo entre os dois arriscaria ler a
  // constante antes de ela existir.
  const temSupabase = Boolean(
    import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY
  );
  const supabase = temSupabase ? "configurado" : "NAO configurado (sem historico de chat)";

  const linhas = [
    "=== Voxa — diagnostico ===",
    `versao: ${info?.version ?? "(navegador)"}`,
    `sistema: ${info ? `${info.os} ${info.arch}` : navigator.userAgent}`,
    `historico: ${supabase}`,
    `signaling: ${SIGNALING_URL}`,
    // O caminho por onde TODO o audio remoto sai. Se estiver parado, a
    // chamada fica muda com tudo o mais parecendo certo — conexao boa, anel
    // de "falando" aceso, video normal.
    (() => {
      const e = estadoSaida();
      return `saida: ${e.tocando ? "tocando" : "PARADA"} | processador=${e.contexto} | volume=${e.volumeGeral} | modo=${e.modo} | dispositivo=${e.dispositivo}`;
    })(),
    `gerado: ${new Date().toISOString()}`,
    "",
  ];

  // Uma linha por pessoa na chamada. Responde de uma vez as perguntas que
  // "nao estou ouvindo ninguem" faz e que nada respondia: o microfone esta
  // saindo daqui? o audio do outro esta chegando? a conexao fechou direto ou
  // esta em relay?
  const s = useApp.getState();

  // Estado do proprio microfone. Sem isto, "enviado=NADA" tem varias causas
  // possiveis e nenhuma delas aparece: mudo, ensurdecido, push-to-talk sem a
  // tecla apertada, ou microfone que nem abriu. Cada uma pede uma acao
  // diferente, e a pessoa costuma nem saber que apertou algo.
  const micEstado = s.semMicrofone
    ? "NAO ABRIU (ninguem te ouve)"
    : s.muted
      ? "MUDO (ninguem te ouve)"
      : "ativo";
  linhas.push(
    `microfone: ${micEstado} | push-to-talk: ${s.pushToTalk ? "LIGADO (so envia com a tecla apertada)" : "desligado"} | ensurdecido: ${s.deafened ? "SIM" : "nao"}`,
    ""
  );

  // Onde a trilha parou: existe na malha? chegou ao canal daquele par?
  // Sem isto, "enviado=NADA" nao distingue "nao capturei" de "capturei e
  // nao consegui anexar" — que sao problemas completamente diferentes.
  let envio: { temMic: boolean; pares: Record<string, { pronto: boolean; micNoCanal: boolean; micLigado: boolean | null; direcao: string }> } | null = null;
  try {
    envio = (window as unknown as { __voxaEnvio?: () => typeof envio }).__voxaEnvio?.() ?? null;
  } catch {
    /* sem sessao ativa */
  }
  if (envio) linhas.push(`trilha de microfone na malha: ${envio.temMic ? "sim" : "NAO"}`, "");

  const pares = Object.entries(s.stats);
  if (pares.length) {
    linhas.push(`--- ${pares.length} conexao(oes) ---`);
    for (const [id, e] of pares) {
      const nome = s.roster.find((r) => r.id === id)?.user.name ?? id.slice(0, 6);
      const envia = e.audioOutBytes > 0 ? `${Math.round(e.audioOutBytes / 1024)}KB` : "NADA";
      const recebe = e.audioInBytes > 0 ? `${Math.round(e.audioInBytes / 1024)}KB` : "NADA";
      // `voz` responde a pergunta que os bytes nao respondem: o audio que
      // chegou pela rede foi realmente entregue ao reprodutor? Se chega byte
      // e aqui aparece "NAO", a trilha se perdeu entre a conexao e a saida.
      const m = getPeerMedia(id);
      const voz = m.mic ? "ligada" : "NAO CHEGOU AO PLAYER";
      const env = envio?.pares[id];
      const canal = env
        ? ` [pronto=${env.pronto} micNoCanal=${env.micNoCanal} ligado=${env.micLigado} dir=${env.direcao}]`
        : "";
      linhas.push(
        `${nome}: conexao=${e.connection} via=${e.path} audio enviado=${envia} recebido=${recebe} voz=${voz} rtt=${e.rttMs}ms perda=${e.lossPct.toFixed(1)}%${canal}`
      );
    }
    linhas.push("");
  } else {
    linhas.push("--- sem ninguem conectado neste momento ---", "");
  }

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
