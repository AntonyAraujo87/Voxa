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
  private carregandoHistorico = new Set<string>();
  private carregados = new Set<string>();
  private abrindo = new Map<string, Promise<void>>();
  private timestamps: number[] = [];

  constructor(private signaling: Signaling) {}

  async openChannel(id: string) {
    app.setState({ activeText: id });
    app.getState().clearUnread(id);
    if (this.carregados.has(id)) return;
    if (this.abrindo.has(id)) return this.abrindo.get(id);
    const task = (async () => {
      try {
        const history = await loadMessages(id);
        const merged = new Map(history.map(message => [message.id, message]));
        // O banco com RLS e a fonte de autoria persistida. Um evento ao vivo
        // com id copiado nao pode sobrescrever essa linha durante a abertura.
        for (const message of app.getState().messages[id] ?? []) if (!merged.has(message.id)) merged.set(message.id, message);
        app.getState().setMessages(id, [...merged.values()].sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
        this.carregados.add(id);
      } catch { app.getState().toast("info", "Historico indisponivel. Abra o canal novamente para tentar."); }
      finally { this.abrindo.delete(id); }
    })();
    this.abrindo.set(id, task);
    return task;
  }

  send(content: string) {
    const s = app.getState();
    const text = content.trim();
    if (!text || !s.me) return false;
    if (text.length > 2000) { s.toast("info", "Use ate 2000 caracteres por mensagem."); return false; }
    if (s.status !== "online") { s.toast("error", "Sem conexao. Sua mensagem foi mantida para tentar novamente."); return false; }

    // O servidor tambem limita, mas ali a mensagem excedente e descartada em
    // silencio. Barrando aqui, quem digitou entende o que aconteceu.
    if (!this.allowance()) {
      s.toast("info", "Devagar com o chat — aguarde alguns segundos.");
      return false;
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
    return true;
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
    if (s.status !== "online") { s.toast("info", "Aguarde a conexao antes de enviar anexos."); return; }
    if (caption.trim().length > 2000) { s.toast("error", "A legenda deve ter no maximo 2000 caracteres."); return; }
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
    const anexo = await uploadAttachment(file, s.activeText);
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
    return true;
  }

  typing() {
    this.signaling.typing(app.getState().activeText);
  }

  /**
   * Carrega a pagina anterior do historico quando o usuario rola ao topo.
   * @returns quantas mensagens novas entraram
   */
  async loadOlder(channelId: string): Promise<number> {
    if (this.carregandoHistorico.has(channelId) || this.historicoCompleto.has(channelId)) return 0;

    const atuais = app.getState().messages[channelId] ?? [];
    if (atuais.length === 0) return 0;
    if (atuais.length >= 1000) { app.getState().toast("info", "Limite de 1000 mensagens carregadas neste canal."); return 0; }

    this.carregandoHistorico.add(channelId);
    try {
      const anteriores = await loadMessages(channelId, PAGINA_HISTORICO, atuais[0].createdAt, atuais[0].id);
      // Nada mais atras: marca o canal para nao consultar de novo a cada
      // rolagem ate o topo.
      if (anteriores.length === 0) {
        this.historicoCompleto.add(channelId);
        return 0;
      }
      app.getState().prependMessages(channelId, anteriores);
      return anteriores.length;
    } catch { app.getState().toast("info", "Nao foi possivel carregar mensagens antigas. Tente novamente."); return 0; } finally {
      this.carregandoHistorico.delete(channelId);
    }
  }

  /** Eco otimista + propagacao em tempo real + persistencia — o mesmo tripé
   *  pra mensagem de texto e pra anexo, so muda o que vai dentro do objeto. */
  retry(msg: ChatMessage) {
    if (msg.authorId === app.getState().me?.id) this.dispatch(msg);
  }

  private dispatch(msg: ChatMessage) {
    app.getState().pushMessage({ ...msg, pending: true, failed: false, persistenceFailed: false }); // aparece antes de sair da maquina
    void this.signaling.sendChat({
      id: msg.id,
      channelId: msg.channelId,
      content: msg.content,
      attachmentUrl: msg.attachmentUrl,
      attachmentName: msg.attachmentName,
      attachmentMime: msg.attachmentMime,
      attachmentSize: msg.attachmentSize,
    }).then(async confirmed => {
      app.getState().pushMessage({ ...confirmed, pending: false, failed: false });
      const saved = await saveMessage(confirmed);
      if (saved === false) app.getState().pushMessage({ ...confirmed, pending: false, persistenceFailed: true });
    }).catch(error => {
      app.getState().pushMessage({ ...msg, pending: false, failed: true });
      app.getState().toast("error", `Mensagem nao confirmada: ${String(error)}`);
    });
  }

  private allowance(): boolean {
    const agora = Date.now();
    this.timestamps = this.timestamps.filter((t) => agora - t < JANELA_FLOOD_MS);
    if (this.timestamps.length >= MAX_NA_JANELA) return false;
    this.timestamps.push(agora);
    return true;
  }
}
