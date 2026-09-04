import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AtSign, Download, FileText, Hash, Paperclip, Send, Users } from "lucide-react";
import { useApp } from "../store/store";
import { session } from "../lib/session";
import { Avatar } from "./Avatar";
import type { ChatMessage } from "../lib/signaling";
import { MENCAO_TODOS, mencionaVoce, partirPorMencao, sugerir, trechoDeMencao } from "../lib/mencao";

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

/**
 * Texto da mensagem com as mencoes destacadas.
 *
 * Feito por partes em vez de `innerHTML` com regex: o conteudo vem de outra
 * pessoa, e montar HTML a partir dele seria abrir XSS num app que hoje nao
 * tem nenhum. Cada pedaco vira um nó de texto que o React escapa sozinho.
 */
const Texto = memo(function Texto({
  conteudo,
  nomes,
  meuNome,
}: {
  conteudo: string;
  nomes: string[];
  meuNome: string;
}) {
  const partes = useMemo(() => partirPorMencao(conteudo, nomes), [conteudo, nomes]);

  return (
    <p className="whitespace-pre-wrap break-words text-ink-soft">
      {partes.map((parte, i) =>
        parte.tipo === "texto" ? (
          parte.texto
        ) : (
          <span
            key={i}
            className={`rounded px-0.5 font-medium ${
              parte.alvo.toLowerCase() === meuNome.toLowerCase() || parte.alvo === MENCAO_TODOS
                ? "bg-brand/30 text-ink"
                : "bg-brand/15 text-brand"
            }`}
          >
            {parte.texto}
          </span>
        )
      )}
    </p>
  );
});

const Message = memo(function Message({
  msg,
  grouped,
  nomes,
  meuNome,
}: {
  msg: ChatMessage;
  grouped: boolean;
  nomes: string[];
  meuNome: string;
}) {
  const chama = useMemo(
    () => mencionaVoce(msg.content, meuNome, nomes),
    [msg.content, meuNome, nomes]
  );
  // Barra na lateral em vez de fundo colorido na linha toda: some no meio de
  // uma conversa longa e continua legivel com a mensagem selecionada.
  const realce = chama ? "border-l-2 border-brand bg-brand/[0.07]" : "";
  if (grouped) {
    return (
      <div className={`group flex gap-4 px-4 py-[1px] hover:bg-base-500/25 ${realce}`}>
        <span className="w-10 shrink-0 pt-0.5 text-right text-[10px] text-faint opacity-0 group-hover:opacity-100">
          {time(msg.createdAt)}
        </span>
        <div className="min-w-0 flex-1">
          {msg.content && <Texto conteudo={msg.content} nomes={nomes} meuNome={meuNome} />}
          <Attachment msg={msg} />
        </div>
      </div>
    );
  }

  return (
    <div className={`group mt-3 flex gap-3 px-4 py-[1px] hover:bg-base-500/25 ${realce}`}>
      <Avatar name={msg.authorName} color={msg.authorColor} size={40} />
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2">
          <span className="font-semibold" style={{ color: msg.authorColor }}>
            {msg.authorName}
          </span>
          <span className="text-[11px] text-faint">{time(msg.createdAt)}</span>
        </p>
        {msg.content && <Texto conteudo={msg.content} nomes={nomes} meuNome={meuNome} />}
        <Attachment msg={msg} />
      </div>
    </div>
  );
});

const MessageList = memo(function MessageList({ channelId }: { channelId: string }) {
  const messages = useApp((s) => s.messages[channelId]);
  const roster = useApp((s) => s.roster);
  const meuNome = useApp((s) => s.me?.name ?? "");
  const historico = useApp((s) => s.historico);
  // Derivado aqui, uma vez por lista: um seletor que fizesse `.map()` dentro
  // do Zustand devolveria array novo a cada leitura e re-renderizaria a
  // conversa inteira a cada tick de estado.
  const nomes = useMemo(() => roster.map((r) => r.user.name), [roster]);
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

      {/* Aviso discreto, e nao toast: nao e um erro que acabou de acontecer,
          e uma condicao que vale enquanto durar. Sem ele, chat sem historico
          e indistinguivel de chat onde ninguem falou ainda — foi exatamente
          essa duvida que escondeu o Supabase mal configurado por semanas. */}
      {historico === "indisponivel" && (
        <p className="mx-4 mt-3 rounded-md bg-base-500/60 px-3 py-2 text-[12px] text-muted">
          Sem histórico agora — o que for escrito aparece para quem está online,
          mas some ao fechar o app.
        </p>
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
        return (
          <Message key={m.id} msg={m} grouped={grouped} nomes={nomes} meuNome={meuNome} />
        );
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

  const roster = useApp((s) => s.roster);
  const nomes = useMemo(() => roster.map((r) => r.user.name), [roster]);

  /** Autocomplete de @mencao: sem ele so acerta quem digita o nome exato,
   *  com acento e maiuscula iguais — e nome errado nao avisa ninguem. */
  const [mencao, setMencao] = useState<{ inicio: number; termo: string } | null>(null);
  const [escolhido, setEscolhido] = useState(0);
  const sugestoes = useMemo(
    () => (mencao ? sugerir(mencao.termo, nomes) : []),
    [mencao, nomes]
  );
  const listaAberta = sugestoes.length > 0;

  const aplicarSugestao = (nome: string) => {
    const el = ref.current;
    if (!mencao || !el) return;
    const antes = text.slice(0, mencao.inicio);
    const depois = text.slice(el.selectionStart ?? text.length);
    const novo = `${antes}@${nome} ${depois}`;
    setText(novo);
    setMencao(null);
    // O cursor precisa ir pro fim do nome inserido; sem isto ele voltaria
    // pro fim do texto todo e escrever depois de uma mencao no meio da
    // frase ficaria impossivel.
    const cursor = antes.length + nome.length + 2;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(cursor, cursor);
    });
  };

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    session.sendChat(value);
    setText("");
    setMencao(null);
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
    // Com a lista aberta, as setas e o Enter pertencem a ela — senao o Enter
    // mandaria a mensagem no meio da escolha do nome.
    if (listaAberta) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setEscolhido((i) => (i + 1) % sugestoes.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setEscolhido((i) => (i - 1 + sugestoes.length) % sugestoes.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        aplicarSugestao(sugestoes[escolhido] ?? sugestoes[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMencao(null);
        return;
      }
    }

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

    const trecho = trechoDeMencao(el.value, el.selectionStart ?? el.value.length);
    setMencao(trecho);
    setEscolhido(0);
    const now = Date.now();
    if (now - lastTyping.current > 2500) {
      lastTyping.current = now;
      session.typing();
    }
  };

  return (
    <div className="relative px-4 pb-5 pt-1">
      {listaAberta && (
        <div className="absolute bottom-full left-4 right-4 mb-1 overflow-hidden rounded-lg border border-line bg-base-600 shadow-lg">
          <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-faint">
            Mencionar
          </p>
          {sugestoes.map((nome, i) => (
            <button
              key={nome}
              // onMouseDown em vez de onClick: o clique tira o foco do
              // textarea antes do onClick disparar, e ai a posicao do cursor
              // usada pra montar o texto ja se perdeu.
              onMouseDown={(e) => {
                e.preventDefault();
                aplicarSugestao(nome);
              }}
              onMouseEnter={() => setEscolhido(i)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                i === escolhido ? "bg-brand text-white" : "text-ink-soft hover:bg-base-500"
              }`}
            >
              <AtSign size={13} className="shrink-0 opacity-70" />
              <span className="truncate">{nome}</span>
              {nome === MENCAO_TODOS && (
                <span className="ml-auto text-[10px] opacity-70">avisa todo mundo</span>
              )}
            </button>
          ))}
        </div>
      )}
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
