import { audioContext } from "./media";
import workletUrl from "./pcmWorklet.ts?worker&url";
import { isDesktop } from "./desktop";
import { registrarErro } from "./diagnostico";

/* ---------------------------------------------------------------------------
   Audio do sistema (WASAPI loopback) virando um MediaStreamTrack.

   O `getDisplayMedia` do WebView2 entrega o audio da janela escolhida â€” quando
   entrega. Com jogo em tela cheia o normal e vir nada, e quem assiste ve a
   imagem em silencio. O Rust captura o que a placa esta tocando (sysaudio.rs)
   e manda blocos de f32 intercalado por um Channel do Tauri, em bytes crus.

   Aqui esses blocos entram num AudioWorklet e saem como track de midia, que a
   malha WebRTC envia igual a qualquer outro.

   O buffer no worklet e o coracao disto: IPC nao entrega com a regularidade de
   um relogio de audio. Sem folga, cada atraso vira clique; com folga demais, o
   som atrasa em relacao a imagem. O worklet segura ~60 ms e descarta o excesso
   quando passa de 400 ms â€” atrasar meio segundo e pior que perder um pedaco.
--------------------------------------------------------------------------- */

/** Modulo independente empacotado pelo Vite; carregado uma vez por contexto. */
const worklets = new WeakMap<AudioContext, Promise<void>>();
let quadrosProcessados = 0;
let quadrosComSom = 0;
let geracao = 0;
let captura: { node: AudioWorkletNode; destino: MediaStreamAudioDestinationNode } | null = null;
let pendente: Promise<MediaStreamTrack | null> | null = null;
let comandos: Promise<unknown> = Promise.resolve();
let estado = "desligado";
let blocos = 0;

export function estadoAudioDoSistema() { return { estado, blocos, quadrosProcessados, quadrosComSom }; }

/** Serializa start/stop nativos, inclusive quando a abertura ainda aguarda WASAPI. */
function comando<T>(run: () => Promise<T>): Promise<T> {
  const next = comandos.then(run, run);
  comandos = next.catch(() => {});
  return next;
}

export function iniciarAudioDoSistema(onFailure?: (message: string) => void, options: { mode?: "system" | "application" | "exclude-voxa"; processId?: number | null } = {}): Promise<MediaStreamTrack | null> {
  if (!isDesktop) return Promise.resolve(null);
  if (pendente) return pendente;
  if (captura) return Promise.resolve(captura.destino.stream.getAudioTracks()[0] ?? null);
  const token = ++geracao;
  estado = "iniciando";
  blocos = quadrosProcessados = quadrosComSom = 0;
  const iniciar = async () => {
    const ctx = audioContext();
    let modulo = worklets.get(ctx);
    if (!modulo) {
      modulo = ctx.audioWorklet.addModule(workletUrl).catch((err) => { worklets.delete(ctx); throw err; });
      worklets.set(ctx, modulo);
    }
    await modulo;
    if (token !== geracao) return null;
    const { Channel, invoke } = await import("@tauri-apps/api/core");
    if (token !== geracao) return null;
    const atual = {
      node: new AudioWorkletNode(ctx, "fila-pcm", { outputChannelCount: [2] }),
      destino: ctx.createMediaStreamDestination(),
    };
    captura = atual;
    atual.node.connect(atual.destino);
    const canal = new Channel<ArrayBuffer>();
    const erros = new Channel<string>();
    let erroNativo: string | null = null;
    canal.onmessage = (bloco) => {
      if (captura !== atual) return;
      blocos++;
      atual.node.port.postMessage(bloco, [bloco]);
    };
    atual.node.port.onmessage = (event) => {
      if (captura !== atual) return;
      quadrosProcessados += Number(event.data.quadros) || 0;
      quadrosComSom += Number(event.data.comSom) || 0;
    };
    const falhar = (mensagem: string) => {
      if (captura !== atual) return;
      erroNativo = mensagem;
      if (estado !== "capturando") return;
      registrarErro("audio-sistema", new Error(mensagem));
      pararAudioDoSistema();
      estado = `falhou: ${mensagem}`;
      onFailure?.(mensagem);
    };
    erros.onmessage = falhar;
    atual.node.onprocessorerror = () => falhar("O processador de audio falhou. Reinicie a transmissao.");
    await comando(() => invoke("start_system_audio", { canal, erros, mode: options.mode ?? "system", processId: options.processId ?? null }));
    if (token !== geracao) return null;
    if (erroNativo) throw new Error(erroNativo);
    estado = "capturando";
    return atual.destino.stream.getAudioTracks()[0] ?? null;
  };
  const tarefa = iniciar().catch((err) => {
    if (token !== geracao) return null;
    pararAudioDoSistema();
    estado = `falhou: ${String(err)}`;
    registrarErro("audio-sistema", err);
    throw err;
  }).finally(() => { if (pendente === tarefa) pendente = null; });
  pendente = tarefa;
  return tarefa;
}

export function pararAudioDoSistema() {
  geracao++;
  pendente = null;
  const atual = captura;
  captura = null;
  estado = "desligado";
  if (atual) {
    atual.node.disconnect();
    atual.node.port.close();
    atual.destino.stream.getTracks().forEach((track) => track.stop());
    atual.destino.disconnect();
    void comando(async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("stop_system_audio");
    }).catch((err) => registrarErro("audio-sistema:parar", err));
  }
}
