import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// PostgreSQL local em memoria: nunca conecta ao Supabase real.
const db = new PGlite();
let checks = 0;
const a='11111111-1111-4111-8111-111111111111', b='22222222-2222-4222-8222-222222222222', outsider='33333333-3333-4333-8333-333333333333';
try {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text,metadata jsonb);
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1] $$;
    grant usage on schema public,auth,storage to anon,authenticated;
    grant select,insert on storage.objects to authenticated;
    grant select on storage.objects to anon;
    insert into auth.users values ('${a}'),('${b}'),('${outsider}');
  `);
  for (const file of ['schema.sql','attachments.sql','hardening.sql','fechar-historico.sql','hardening-2.sql']) {
    let sql=await readFile(`supabase/${file}`,'utf8');
    // PGlite inclui gen_random_uuid e sha256 no nucleo; pgcrypto nao e necessario.
    sql=sql.replace('create extension if not exists "pgcrypto";', '');
    await db.exec(sql);
  }
  const asUser=async id=>db.exec(`reset role; select set_config('request.jwt.claim.sub','${id}',false); set role authenticated;`);
  for(const [id,name] of [[a,'Alice'],[b,'Bob']]) {
    await asUser(id);
    assert.equal((await db.query("select public.join_guild('COLE-AQUI-O-VOXA-TOKEN') as joined")).rows[0].joined,true);
    await db.query('insert into public.profiles(id,username) values($1,$2)',[id,name]);
  }
  await db.exec('reset role');
  await db.exec(await readFile('supabase/audit-online.sql','utf8'));
  await db.exec(await readFile('supabase/audit-online.sql','utf8'));
  // Caminho real de producao: online ja aplicado, depois somente Storage.
  const storageOnly = await readFile('supabase/attachments-private.sql','utf8');
  await db.exec(storageOnly);
  await db.exec(storageOnly);
  // O arquivo completo de bootstrap deve continuar equivalente ao cutover.
  const fullAudit = await readFile('supabase/audit-3.sql','utf8');
  const storageStart = 'create or replace function public.can_read_attachment';
  assert.equal(storageOnly.slice(storageOnly.indexOf(storageStart)), fullAudit.slice(fullAudit.indexOf(storageStart)));
  await db.exec(await readFile('supabase/audit-3.sql','utf8'));
  await db.exec(await readFile('supabase/audit-3.sql','utf8')); // idempotencia
  checks++;
  await asUser(a);
  assert.equal((await db.query('select * from public.profiles')).rows.length,2); checks++;
  const room=(await db.query("select id from public.rooms where slug='geral'")).rows[0].id;
  const object=`${a}/${room}/example.png`;
  await db.query("insert into storage.objects(bucket_id,name) values('chat-attachments',$1)",[object]);
  await asUser(b);
  assert.equal((await db.query('select * from storage.objects')).rows.length,1); checks++;
  await db.exec('reset role');
  await db.query("insert into storage.objects(bucket_id,name) values('chat-attachments',$1)", [`${a}/legacy.png`]);
  await asUser(b);
  assert.equal((await db.query('select * from storage.objects')).rows.length,2); checks++;
  await db.exec('reset role; set role anon');
  assert.equal((await db.query('select * from storage.objects')).rows.length,0); checks++;
  await asUser(outsider);
  assert.equal((await db.query('select * from public.profiles')).rows.length,0);
  assert.equal((await db.query('select * from storage.objects')).rows.length,0);
  await assert.rejects(db.query("insert into storage.objects(bucket_id,name) values('chat-attachments',$1)",[`${outsider}/${room}/file.png`])); checks++;
  await asUser(a);
  for(let i=0;i<15;i++) await db.query("insert into public.messages(room_id,author_id,content,created_at) values($1,$2,'rate test','2000-01-01')",[room,a]);
  await assert.rejects(db.query("insert into public.messages(room_id,author_id,content,created_at) values($1,$2,'overflow','2000-01-01')",[room,a])); checks++;
  await db.exec('reset role');
  assert.equal((await db.query("select public from storage.buckets where id='chat-attachments'")).rows[0].public,false); checks++;
  await db.exec("update public.guild_secret set hash=encode(sha256(convert_to('rotated-local-test','UTF8')),'hex') where id=1");
  assert.equal((await db.query('select count(*)::int as count from public.room_members')).rows[0].count,0); checks++;
  await asUser(b);
  assert.equal((await db.query('select * from public.messages')).rows.length,0);
  assert.equal((await db.query('select * from storage.objects')).rows.length,0); checks++;
  assert.equal((await db.query("select public.join_guild('rotated-local-test') as joined")).rows[0].joined,true); checks++;
  for (let i=0;i<25;i++) await db.query("insert into storage.objects(bucket_id,name) values('chat-attachments',$1)", [`${b}/${room}/quota-${i}.png`]);
  await assert.rejects(db.query("insert into storage.objects(bucket_id,name) values('chat-attachments',$1)", [`${b}/${room}/overflow.png`])); checks++;
  console.log(JSON.stringify({ status:'PASS', checks, engine:'PostgreSQL/PGlite', scope:'SQL e RLS locais; API Storage/Supabase hospedado nao exercitados' }));
} finally { await db.close(); }
