-- =============================================================================
-- VOXA — Hardening de RLS (auditoria)
--
-- Rode DEPOIS do schema.sql e do attachments.sql. Idempotente.
--
-- Tudo aqui e seguro e nao muda comportamento nenhum do app: fecha superficie
-- que estava aberta sem necessidade. Pode rodar a qualquer momento.
-- =============================================================================

-- `enforce_message_rate` e uma funcao de TRIGGER: o Postgres a executa como
-- dona da tabela, ninguem precisa de EXECUTE pra que ela rode. Mas por estar
-- no schema `public`, o PostgREST a expunha em /rest/v1/rpc/enforce_message_rate
-- pra qualquer um chamar. Nao ha exploracao obvia (fora de trigger ela erra em
-- `new`), mas funcao SECURITY DEFINER exposta sem motivo e superficie de graca.
revoke all on function public.enforce_message_rate() from public, anon, authenticated;

-- `can_read_room` PRECISA continuar executavel por `authenticated`: ela e
-- avaliada dentro das policies, no contexto de quem consulta. Mas `anon` (a
-- chave crua, sem sign-in) nao tem o que fazer com ela.
revoke all on function public.can_read_room(uuid) from anon;

-- Storage: o bucket de anexos e publico para LEITURA de proposito (a imagem
-- precisa carregar direto no <img>), mas ninguem alem do dono deveria poder
-- sobrescrever ou apagar o arquivo de outro. O schema de anexos ja nao cria
-- policy de update/delete; estas linhas garantem que nenhuma sobra de teste
-- tenha ficado para tras.
drop policy if exists chat_attachments_update on storage.objects;
drop policy if exists chat_attachments_delete on storage.objects;

-- A PARTE 2 (fechar o historico do chat) virou arquivo proprio:
--   supabase/fechar-historico.sql
-- Ela muda o modelo de acesso e tem ordem de aplicacao propria — leia o
-- cabecalho daquele arquivo antes de rodar.
