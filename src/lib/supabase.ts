import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_CHANNELS, type Channel } from "./config";
import type { ChatMessage } from "./signaling";

/* ---------------------------------------------------------------------------
   Persistencia opcional do historico de texto.

   O app funciona sem Supabase (chat em tempo real pelo signaling, sem
   historico). Quando configurado, cada instalacao faz um sign-in ANONIMO: o
   banco passa a ver um usuario real, com `auth.uid()` proprio, e as politicas
   de RLS deixam de ser decorativas.

   Sem esse sign-in, a chave `anon` — que esta dentro do binario e portanto e
   publica — chegaria ao banco sem identidade nenhuma, e qualquer politica do
   tipo "so o dono edita" seria impossivel de avaliar.

   O SDK entra por import() dinamico: quem nao usa Supabase nunca baixa os
   ~120 kB da biblioteca.
--------------------------------------------------------------------------- */

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabaseEnabled = Boolean(URL && KEY);

let clientPromise: Promise<SupabaseClient | null> | null = null;

/** Cliente ja autenticado, ou null se o Supabase nao estiver configurado. */
function db(): Promise<SupabaseClient | null> {
  if (!supabaseEnabled) return Promise.resolve(null);

  if (!clientPromise) {
    clientPromise = (async () => {
      try {
        const { createClient } = await import("@supabase/supabase-js");
        const client = createClient(URL!, KEY!, {
          auth: {
            // A sessao anonima e persistida para que o mesmo dispositivo
            // continue sendo o mesmo usuario depois de reiniciar o app.
            persistSession: true,
            autoRefreshToken: true,
            storageKey: "voxa:supabase-auth",
          },
          realtime: { params: { eventsPerSecond: 2 } },
          global: { headers: { "x-client-info": "voxa" } },
        });

        const session = await ensureSession(client);
        if (!session) {
          console.info(
            "[supabase] sign-in anonimo indisponivel — habilite em " +
              "Authentication > Providers > Anonymous sign-ins. " +
              "Seguindo sem historico."
          );
          return null;
        }
        return client;
      } catch {
        return null;
      }
    })();
  }
  return clientPromise;
}

async function ensureSession(client: SupabaseClient): Promise<Session | null> {
  const { data } = await client.auth.getSession();
  if (data.session) return data.session;

  const { data: novo, error } = await client.auth.signInAnonymously();
  if (error) return null;
  return novo.session ?? null;
}

async function currentUserId(client: SupabaseClient): Promise<string | null> {
  const { data } = await client.auth.getUser();
  return data.user?.id ?? null;
}

/** slug -> uuid (as tabelas usam uuid, a UI usa slug) */
const roomIds = new Map<string, string>();
export const roomUuid = (slug: string) => roomIds.get(slug) ?? null;

/* --------------------------------- canais --------------------------------- */

export async function loadChannels(): Promise<Channel[]> {
  const sb = await db();
  if (!sb) return DEFAULT_CHANNELS;

  try {
    const { data, error } = await sb
      .from("rooms")
      .select("id,slug,name,kind,topic,position")
      .order("position", { ascending: true });

    if (error || !data?.length) return DEFAULT_CHANNELS;

    roomIds.clear();
    for (const r of data) roomIds.set(r.slug as string, r.id as string);

    return data.map((r) => ({
      id: r.slug as string,
      name: r.name as string,
      kind: r.kind as Channel["kind"],
      topic: (r.topic as string) ?? undefined,
    }));
  } catch {
    return DEFAULT_CHANNELS;
  }
}

/* -------------------------------- mensagens -------------------------------- */

/**
 * Ultimas mensagens do canal, ou as anteriores a um instante (paginacao).
 *
 * `antesDe` recebe o `createdAt` da mensagem mais antiga ja carregada. Usar o
 * timestamp em vez de OFFSET importa: com OFFSET, uma mensagem nova chegando
 * entre duas paginas empurraria a janela e faria a proxima pagina repetir uma
 * linha ja exibida.
 */
export async function loadMessages(
  channelSlug: string,
  limit = 60,
  antesDe?: string
): Promise<ChatMessage[]> {
  const sb = await db();
  const uuid = roomUuid(channelSlug);
  if (!sb || !uuid) return [];

  try {
    // A view junta o autor sem expor auth.users e roda com security_invoker,
    // ou seja: continua sujeita as politicas de quem consulta.
    let query = sb
      .from("messages_with_author")
      .select(
        "id,content,author_id,author_name,author_color,created_at,attachment_url,attachment_name,attachment_mime,attachment_size"
      )
      .eq("room_id", uuid)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (antesDe) query = query.lt("created_at", antesDe);

    const { data, error } = await query;

    if (error || !data) return [];

    return data
      .map((m) => ({
        id: m.id as string,
        channelId: channelSlug,
        content: m.content as string,
        authorId: (m.author_id as string) ?? "",
        authorName: m.author_name as string,
        authorColor: m.author_color as string,
        createdAt: m.created_at as string,
        attachmentUrl: (m.attachment_url as string) ?? undefined,
        attachmentName: (m.attachment_name as string) ?? undefined,
        attachmentMime: (m.attachment_mime as string) ?? undefined,
        attachmentSize: (m.attachment_size as number) ?? undefined,
      }))
      .reverse();
  } catch {
    return [];
  }
}

export async function saveMessage(msg: ChatMessage) {
  const sb = await db();
  const uuid = roomUuid(msg.channelId);
  if (!sb || !uuid) return;

  try {
    const userId = await currentUserId(sb);
    if (!userId) return;

    // author_id vem da sessao, nunca do objeto da UI. A politica de RLS exige
    // que ele seja igual a auth.uid(), entao nem adiantaria mentir aqui.
    await sb.from("messages").insert({
      room_id: uuid,
      author_id: userId,
      content: msg.content,
      attachment_url: msg.attachmentUrl ?? null,
      attachment_name: msg.attachmentName ?? null,
      attachment_mime: msg.attachmentMime ?? null,
      attachment_size: msg.attachmentSize ?? null,
    });
  } catch {
    // Offline ou limite de flood: a mensagem ja foi entregue em tempo real,
    // apenas nao vira historico.
  }
}

/* -------------------------------- anexos ----------------------------------- */

export interface UploadedAttachment {
  url: string;
  name: string;
  mime: string;
  size: number;
}

const TAMANHO_MAX_ANEXO = 8 * 1024 * 1024; // mesmo teto do bucket, attachments.sql

/**
 * Sobe um arquivo pro bucket `chat-attachments` e devolve a URL publica.
 * `null` quando o Supabase nao esta configurado (modo efemero nao tem onde
 * guardar arquivo) ou quando o upload falha por qualquer motivo — rede,
 * politica de RLS, tipo/tamanho recusado pelo bucket.
 */
export async function uploadAttachment(file: File): Promise<UploadedAttachment | null> {
  const sb = await db();
  if (!sb) return null;
  if (file.size > TAMANHO_MAX_ANEXO) return null;

  try {
    const userId = await currentUserId(sb);
    if (!userId) return null;

    // Path comeca com o proprio uid: e exatamente o que a politica de INSERT
    // do bucket exige, e evita duas pessoas colidirem no mesmo nome de arquivo.
    const extensao = file.name.includes(".") ? file.name.split(".").pop() : "";
    const caminho = `${userId}/${crypto.randomUUID()}${extensao ? "." + extensao : ""}`;

    const { error } = await sb.storage.from("chat-attachments").upload(caminho, file, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
    if (error) return null;

    const { data } = sb.storage.from("chat-attachments").getPublicUrl(caminho);
    return {
      url: data.publicUrl,
      name: file.name,
      mime: file.type || "application/octet-stream",
      size: file.size,
    };
  } catch {
    return null;
  }
}

/* --------------------------------- perfil ---------------------------------- */

export interface StoredUser {
  id: string;
  username: string;
  color: string;
}

/** Cria ou atualiza o perfil publico ligado a sessao anonima deste aparelho. */
export async function upsertUser(username: string, color: string): Promise<StoredUser | null> {
  const sb = await db();
  if (!sb) return null;

  try {
    const userId = await currentUserId(sb);
    if (!userId) return null;

    const { data, error } = await sb
      .from("profiles")
      .upsert(
        { id: userId, username, color, last_seen: new Date().toISOString() },
        { onConflict: "id" }
      )
      .select("id,username,color")
      .single();

    if (error || !data) return null;
    return { id: data.id as string, username: data.username as string, color: data.color as string };
  } catch {
    return null;
  }
}
