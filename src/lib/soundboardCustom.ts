import { audioContext } from "./media";
import { registrarErro } from "./diagnostico";

/* ---------------------------------------------------------------------------
   Sons proprios do soundboard.

   Ficam em IndexedDB, e nao no localStorage: o localStorage guarda texto e
   tem teto de poucos MB por origem — um unico audio ja estouraria. Aqui o
   arquivo vai como Blob, do jeito que veio do disco.

   Nao passam pelo Supabase de proposito. Seria preciso subir o arquivo,
   distribuir para todo mundo e lidar com direito autoral de audio de
   terceiros. Como o efeito e MIXADO no microfone antes de sair (ver
   session.playSoundboard), os outros ouvem o som sem precisar ter o arquivo
   — a mesma coisa que acontece quando alguem poe musica perto do mic.
--------------------------------------------------------------------------- */

const BANCO = "voxa";
const LOJA = "soundboard";
const VERSAO = 1;

/** Teto por arquivo. Efeito de soundboard e curto por natureza; permitir
 *  arquivos grandes so encheria o disco e travaria a decodificacao. */
export const TAMANHO_MAX = 2 * 1024 * 1024;
export const MAX_SONS = 12;

export interface SomProprio {
  id: string;
  label: string;
  emoji: string;
  /** o arquivo original, como veio do disco */
  blob: Blob;
}

function abrir(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BANCO, VERSAO);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(LOJA)) {
        req.result.createObjectStore(LOJA, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function comLoja<T>(modo: IDBTransactionMode, fn: (loja: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await abrir();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(LOJA, modo);
    const req = fn(tx.objectStore(LOJA));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

export async function listarSons(): Promise<SomProprio[]> {
  try {
    return (await comLoja<SomProprio[]>("readonly", (l) => l.getAll())) ?? [];
  } catch (err) {
    registrarErro("soundboard", err);
    return [];
  }
}

export async function salvarSom(arquivo: File, label: string, emoji: string): Promise<string | null> {
  if (arquivo.size > TAMANHO_MAX) {
    throw new Error(`Arquivo muito grande (max ${Math.round(TAMANHO_MAX / 1024 / 1024)} MB).`);
  }
  if ((await listarSons()).length >= MAX_SONS) {
    throw new Error(`Limite de ${MAX_SONS} sons.`);
  }

  // Decodifica ANTES de guardar: melhor recusar aqui, com o arquivo na mao,
  // do que salvar algo que so vai falhar na hora de tocar — quando a pessoa
  // ja apertou o botao na frente dos outros.
  const bytes = await arquivo.arrayBuffer();
  try {
    await audioContext().decodeAudioData(bytes.slice(0));
  } catch {
    throw new Error("Nao consegui ler esse audio. Use mp3, wav, ogg ou m4a.");
  }

  const id = `meu:${crypto.randomUUID()}`;
  await comLoja("readwrite", (l) =>
    l.put({ id, label: label.trim().slice(0, 24) || arquivo.name.slice(0, 24), emoji, blob: arquivo })
  );
  return id;
}

export async function removerSom(id: string) {
  await comLoja("readwrite", (l) => l.delete(id));
  cache.delete(id);
}

/** Decodificado uma vez por som: decodificar a cada clique daria atraso
 *  audivel justamente no efeito, que precisa sair na hora. */
const cache = new Map<string, AudioBuffer>();

export async function bufferDoSom(id: string): Promise<AudioBuffer | null> {
  const pronto = cache.get(id);
  if (pronto) return pronto;

  try {
    const som = await comLoja<SomProprio | undefined>("readonly", (l) => l.get(id));
    if (!som) return null;
    const buffer = await audioContext().decodeAudioData(await som.blob.arrayBuffer());
    cache.set(id, buffer);
    return buffer;
  } catch (err) {
    registrarErro("soundboard", err);
    return null;
  }
}
