import { useApp } from "../store/store";
import type { ChatMessage, Signaling } from "./signaling";
import { loadMessages, saveMessage, supabaseEnabled, uploadAttachment } from "./supabase";

const app = useApp;

/* ---------------------------------------------------------------------------
   Chat de texto: envio, anexo, historico e o freio de flood do lado do
   cliente.

   Vive separado da Session porque nao depende de NADA de midia — nem malha
   P2P, nem microfone, nem captura. So precisa de um canal por onde emitir
   (o Signaling) e do store. Isso torna a regra de chat testavel sozinha e
   tira 130 linhas de um arquivo que ja coordenava voz, tela, atalhos e
   ciclo de vida ao mesmo tempo.
--------------------------------------------------------------------------- */

/** Mesma janela usada pelo servidor: 8 mensagens a cada 5 segundos. */
const JANELA_FLOOD_MS = 5000;
const MAX_NA_JANELA = 8;
const PAGINA_HISTORICO = 40;

export class Chat {
  /** canais que ja chegaram ao inicio do historico — evita consultas inuteis */
  private historicoCompleto = new Set<string>();
  private carregandoHistorico = false;
  private timestamps: number[] = [];

  constructor(private signaling: Signaling) {}

  async openChannel(id: string) {
    app.setState({ activeText: id });
    app.getState().clearUnread(id);
    if (app.getState().messages[id]) return;
    const history = await loadMessages(id);
    app.getState().setMessages(id, history);
  }

  send(content: string) {
    const s = app.getState();
    const text = content.trim();
    if (!text || !s.me) return;

    // O servidor tambem limita, mas ali a mensagem excedente e descartada em
    // silencio. Barrando aqui, quem digitou entende o que aconteceu.
    if (!this.allowance()) {
      s.toast("info", "Devagar com o chat — aguarde alguns segundos.");
      return;
    }

    this.dispatch({
      id: crypto.randomUUID(),
      channelId: s.activeText,
      content: text,
      authorId: s.me.id,
      authorName: s.me.name,
      authorColor: s.me.color,
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * Sobe o arquivo pro Storage e manda como mensagem (com legenda opcional).
   * Sem Supabase configurado o anexo nao tem onde morar — nem tenta, avisa e
   * volta. O toast de "enviando" existe porque upload de imagem/video pode
   * levar alguns segundos e a pessoa precisa saber que esta acontecendo.
   */
  async sendAttachment(file: File, caption = "") {
    const s = app.getState();
    if (!s.me) return;
    if (!this.allowance()) {
      s.toast("info", "Devagar com o chat — aguarde alguns segundos.");
      return;
    }

    if (!supabaseEnabled) {
      s.toast(
        "error",
        "Anexo precisa do historico do Supabase configurado — sem ele nao ha onde guardar o arquivo."
      );
      return;
    }

    s.toast("info", `Enviando ${file.name}...`);
    const anexo = await uploadAttachment(file);
    if (!anexo) {
      s.toast("error", `Nao foi possivel enviar ${file.name}.`);
      return;
    }

    this.dispatch({
      id: crypto.randomUUID(),
      channelId: s.activeText,
      content: caption.trim(),
      authorId: s.me.id,
      authorName: s.me.name,
      authorColor: s.me.color,
      createdAt: new Date().toISOString(),
      attachmentUrl: anexo.url,
      attachmentName: anexo.name,
      attachmentMime: anexo.mime,
      attachmentSize: anexo.size,
    });
  }

  typing() {
    this.signaling.typing(app.getState().activeText);
  }

  /**
   * Carrega a pagina anterior do historico quando o usuario rola ao topo.
   * @returns quantas mensagens novas entraram
   */
  async loadOlder(channelId: string): Promise<number> {
    if (this.carregandoHistorico || this.historicoCompleto.has(channelId)) return 0;

    const atuais = app.getState().messages[channelId] ?? [];
    if (atuais.length === 0) return 0;

    this.carregandoHistorico = true;
    try {
      const anteriores = await loadMessages(channelId, PAGINA_HISTORICO, atuais[0].createdAt);
      // Nada mais atras: marca o canal para nao consultar de novo a cada
      // rolagem ate o topo.
      if (anteriores.length === 0) {
        this.historicoCompleto.add(channelId);
        return 0;
      }
      app.getState().prependMessages(channelId, anteriores);
      return anteriores.length;
    } finally {
      this.carregandoHistorico = false;
    }
  }

  /** Eco otimista + propagacao em tempo real + persistencia — o mesmo tripé
   *  pra mensagem de texto e pra anexo, so muda o que vai dentro do objeto. */
  private dispatch(msg: ChatMessage) {
    app.getState().pushMessage(msg); // aparece antes de sair da maquina
    this.signaling.sendChat({
      id: msg.id,
      channelId: msg.channelId,
      content: msg.content,
      attachmentUrl: msg.attachmentUrl,
      attachmentName: msg.attachmentName,
      attachmentMime: msg.attachmentMime,
      attachmentSize: msg.attachmentSize,
    });
    void saveMessage(msg);
  }

  private allowance(): boolean {
    const agora = Date.now();
    this.timestamps = this.timestamps.filter((t) => agora - t < JANELA_FLOOD_MS);
    if (this.timestamps.length >= MAX_NA_JANELA) return false;
    this.timestamps.push(agora);
    return true;
  }
}
