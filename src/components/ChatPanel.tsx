import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Download, FileText, Hash, Paperclip, Send, Users } from "lucide-react";
import { useApp } from "../store/store";
import { session } from "../lib/session";
import { Avatar } from "./Avatar";
import type { ChatMessage } from "../lib/signaling";

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

const GROUP_WINDOW_MS = 5 * 60 * 1000;

function tamanhoLegivel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Imagem inline se o mime bater; senao um card com nome/tamanho e link de download. */
const Attachment = memo(function Attachment({ msg }: { msg: ChatMessage }) {
  if (!msg.attachmentUrl) return null;

  if (msg.attachmentMime?.startsWith("image/")) {
    return (
      <a href={msg.attachmentUrl} target="_blank" rel="noreferrer" className="mt-1 block">
        <img
          src={msg.attachmentUrl}
          alt={msg.attachmentName ?? "imagem"}
          className="max-h-80 max-w-sm rounded-lg border border-line object-contain"
        />
      </a>
    );
  }

  return (
    <a
      href={msg.attachmentUrl}
      target="_blank"
      rel="noreferrer"
      className="mt-1 flex max-w-sm items-center gap-2 rounded-lg border border-line bg-base-500/60 px-3 py-2 transition-colors hover:bg-base-500"
    >
      <FileText size={20} className="shrink-0 text-faint" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-ink-soft">{msg.attachmentName}</p>
        {typeof msg.attachmentSize === "number" && (
          <p className="text-[11px] text-faint">{tamanhoLegivel(msg.attachmentSize)}</p>
        )}
      </div>
      <Download size={16} className="shrink-0 text-faint" />
    </a>
  );
});

const Message = memo(function Message({
  msg,
  grouped,
}: {
  msg: ChatMessage;
  grouped: boolean;
}) {
  if (grouped) {
    return (
      <div className="group flex gap-4 px-4 py-[1px] hover:bg-base-500/25">
        <span className="w-10 shrink-0 pt-0.5 text-right text-[10px] text-faint opacity-0 group-hover:opacity-100">
          {time(msg.createdAt)}
        </span>
        <div className="min-w-0 flex-1">
          {msg.content && (
            <p className="whitespace-pre-wrap break-words text-ink-soft">{msg.content}</p>
          )}
          <Attachment msg={msg} />
        </div>
      </div>
    );
  }

  return (
    <div className="group mt-3 flex gap-3 px-4 py-[1px] hover:bg-base-500/25">
      <Avatar name={msg.authorName} color={msg.authorColor} size={40} />
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2">
          <span className="font-semibold" style={{ color: msg.authorColor }}>
            {msg.authorName}
          </span>
          <span className="text-[11px] text-faint">{time(msg.createdAt)}</span>
        </p>
        {msg.content && (
          <p className="whitespace-pre-wrap break-words text-ink-soft">{msg.content}</p>
        )}
        <Attachment msg={msg} />
      </div>
    </div>
  );
});

const MessageList = memo(function MessageList({ channelId }: { channelId: string }) {
  const messages = useApp((s) => s.messages[channelId]);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [carregando, setCarregando] = useState(false);

  const items = messages ?? [];

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;

    // Chegou perto do topo: busca a pagina anterior e devolve o usuario a
    // posicao de leitura. Sem restaurar o scroll, inserir conteudo acima
    // jogaria a vista para longe do ponto onde ele estava.
    if (el.scrollTop < 80) {
      const alturaAntes = el.scrollHeight;
      setCarregando(true);
      void session.loadOlderMessages(channelId).then((qtd) => {
        setCarregando(false);
        if (qtd === 0) return;
        requestAnimationFrame(() => {
          const atual = scroller.current;
          if (atual) atual.scrollTop = atual.scrollHeight - alturaAntes;
        });
      });
    }
  }, [channelId]);

  // useLayoutEffect: cola no fim ANTES do browser pintar, sem pulo visivel.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  return (
    <div
      ref={scroller}
      onScroll={onScroll}
      className="flex-1 overflow-y-auto overflow-x-hidden pb-4"
    >
      {carregando && (
        <p className="py-2 text-center text-[11px] text-faint">carregando historico...</p>
      )}
      {items.length === 0 && (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
          <Hash size={44} className="text-base-500" />
          <p className="text-sm">Nenhuma mensagem por aqui ainda.</p>
        </div>
      )}
      {items.map((m, i) => {
        const prev = items[i - 1];
        const grouped =
          !!prev &&
          prev.authorId === m.authorId &&
          new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_WINDOW_MS;
        return <Message key={m.id} msg={m} grouped={grouped} />;
      })}
    </div>
  );
});

const TIPOS_ACEITOS =
  "image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm," +
  "audio/mpeg,audio/ogg,audio/wav,application/pdf,text/plain,application/zip";

const Composer = memo(function Composer({ channelName }: { channelName: string }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    session.sendChat(value);
    setText("");
    if (ref.current) ref.current.style.height = "auto";
  };

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // sem isso, escolher o MESMO arquivo de novo nao dispara onChange
    if (!file) return;
    void session.sendAttachment(file, text);
    setText("");
    if (ref.current) ref.current.style.height = "auto";
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
    const now = Date.now();
    if (now - lastTyping.current > 2500) {
      lastTyping.current = now;
      session.typing();
    }
  };

  return (
    <div className="px-4 pb-5 pt-1">
      <div className="flex items-end gap-2 rounded-lg bg-base-500 px-4 py-2.5">
        <input
          ref={fileRef}
          type="file"
          accept={TIPOS_ACEITOS}
          onChange={onPickFile}
          className="hidden"
        />
        <button
          onClick={() => fileRef.current?.click()}
          title="Anexar imagem ou arquivo"
          className="grid size-8 shrink-0 place-items-center rounded text-muted transition-colors hover:bg-base-400 hover:text-ink"
        >
          <Paperclip size={18} />
        </button>
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder={`Conversar em #${channelName}`}
          className="max-h-[200px] flex-1 resize-none bg-transparent text-[15px] text-ink-soft outline-none placeholder:text-faint"
        />
        <button
          onClick={submit}
          disabled={!text.trim()}
          className="grid size-8 shrink-0 place-items-center rounded text-muted transition-colors enabled:hover:bg-base-400 enabled:hover:text-ink disabled:opacity-40"
        >
          <Send size={17} />
        </button>
      </div>
    </div>
  );
});

function ChatPanelBase() {
  const activeText = useApp((s) => s.activeText);
  const channels = useApp((s) => s.channels);
  const membersOpen = useApp((s) => s.membersOpen);
  const typing = useApp((s) => s.typing);

  const channel = useMemo(
    () => channels.find((c) => c.id === activeText),
    [channels, activeText]
  );

  // O relogio so corre enquanto existe alguem digitando: sem isso o painel
  // re-renderizaria a cada 1,5s pelo resto da sessao.
  const [now, setNow] = useState(0);
  const someoneTyping = Object.keys(typing).length > 0;
  useEffect(() => {
    if (!someoneTyping) return;
    const t = window.setInterval(() => setNow(Date.now()), 1500);
    return () => window.clearInterval(t);
  }, [someoneTyping]);

  const whoIsTyping = useMemo(
    () =>
      Object.entries(typing)
        .filter(([key, ts]) => key.endsWith(activeText) && now - ts < 4000)
        .map(([key]) => key.slice(0, key.length - activeText.length)),
    [typing, activeText, now]
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-base-600">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4 shadow-sm">
        <Hash size={20} className="text-faint" />
        <span className="font-semibold text-ink">{channel?.name ?? activeText}</span>
        {channel?.topic && (
          <>
            <span className="mx-1 h-5 w-px bg-base-500" />
            <span className="truncate text-sm text-muted">{channel.topic}</span>
          </>
        )}
        <button
          onClick={() => useApp.setState({ membersOpen: !membersOpen })}
          className={`ml-auto grid size-8 place-items-center rounded transition-colors hover:bg-base-500 ${
            membersOpen ? "text-ink" : "text-muted"
          }`}
          title="Lista de membros"
        >
          <Users size={20} />
        </button>
      </header>

      <MessageList channelId={activeText} />

      <div className="h-4 px-5 text-[11px] text-muted">
        {whoIsTyping.length > 0 &&
          `${whoIsTyping.join(", ")} ${whoIsTyping.length > 1 ? "estao" : "esta"} digitando...`}
      </div>

      <Composer channelName={channel?.name ?? activeText} />
    </div>
  );
}

export const ChatPanel = memo(ChatPanelBase);
