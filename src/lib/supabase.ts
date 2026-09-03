import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_CHANNELS, type Channel } from "./config";
import type { ChatMessage } from "./signaling";

/* ---------------------------------------------------------------------------
   Persistencia opcional. O app funciona 100% sem Supabase (chat em tempo real
   via signaling, so que sem historico).
   O SDK entra por import() dinamico: quem nao configurou Supabase nunca baixa
   os ~120 kB da lib — o bundle inicial fica menor pra todo mundo.
--------------------------------------------------------------------------- */

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabaseEnabled = Boolean(URL && KEY);

let clientPromise: Promise<SupabaseClient | null> | null = null;

function db(): Promise<SupabaseClient | null> {
  if (!supabaseEnabled) return Promise.resolve(null);
  if (!clientPromise) {
    clientPromise = import("@supabase/supabase-js")
      .then((m) =>
        m.createClient(URL!, KEY!, {
          auth: { persistSession: false, autoRefreshToken: false },
          realtime: { params: { eventsPerSecond: 2 } },
          global: { headers: { "x-client-info": "voxa" } },
        })
      )
      .catch(() => null);
  }
  return clientPromise;
}

/** slug -> uuid (as tabelas usam uuid, a UI usa slug) */
const roomIds = new Map<string, string>();
export const roomUuid = (slug: string) => roomIds.get(slug) ?? null;

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
    for (const r of data) roomIds.set(r.slug, r.id);
    return data.map((r) => ({
      id: r.slug,
      name: r.name,
      kind: r.kind as Channel["kind"],
      topic: r.topic ?? undefined,
    }));
  } catch {
    return DEFAULT_CHANNELS;
  }
}

export async function loadMessages(channelSlug: string, limit = 60): Promise<ChatMessage[]> {
  const sb = await db();
  const uuid = roomUuid(channelSlug);
  if (!sb || !uuid) return [];
  try {
    const { data, error } = await sb
      .from("messages")
      .select("id,content,author_id,author_name,author_color,created_at")
      .eq("room_id", uuid)
      .order("created_at", { ascending: false })
      .limit(limit);
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
      }))
      .reverse();
  } catch {
    return [];
  }
}

export async function saveMessage(msg: ChatMessage, authorUuid: string | null) {
  const sb = await db();
  const uuid = roomUuid(msg.channelId);
  if (!sb || !uuid) return;
  try {
    await sb.from("messages").insert({
      room_id: uuid,
      author_id: authorUuid,
      author_name: msg.authorName,
      author_color: msg.authorColor,
      content: msg.content,
    });
  } catch {
    /* offline: a mensagem ja foi entregue em tempo real, so nao vira historico */
  }
}

export interface StoredUser {
  id: string;
  username: string;
  color: string;
}

export async function upsertUser(username: string, color: string): Promise<StoredUser | null> {
  const sb = await db();
  if (!sb) return null;
  try {
    const { data, error } = await sb.rpc("upsert_user", {
      p_username: username,
      p_color: color,
    });
    if (error || !data) return null;
    const row = Array.isArray(data) ? data[0] : data;
    return { id: row.id, username: row.username, color: row.color };
  } catch {
    return null;
  }
}
