# Operação do Voxa

Configuração suportada pelo código 0.5.29. Este documento não confirma aplicação
nos serviços hospedados.

## Sinalização

O `render.yaml` instala com `npm ci --omit=dev`, inicia `server/index.js`
e usa `/health` para saúde agregada. Mantenha uma instância: sockets e salas ficam
em memória. Reiniciar desconecta clientes, que tentam reidentificar e reentrar.
Suspensão do serviço pode atrasar o login; não há prazo garantido de inicialização.

Configure `VOXA_TOKEN` no servidor; convidados digitam a senha no aplicativo.
Nunca coloque a senha ou o segredo do TURN em `VITE_*`: esses valores são públicos.

O Blueprint habilita `TRUST_PROXY=1` atrás do proxy do Render. Em acesso direto,
use `0`. Só habilite se a infraestrutura controlar e higienizar
`X-Forwarded-For`; não há lista detalhada de proxies no código. Limites: 128 sockets
e 12 participantes por canal de voz. Exceção não tratada encerra o processo;
a hospedagem precisa oferecer restart supervisionado.

## TURN

TURN depende de disponibilidade, portas, credenciais e políticas de rede.
Mídia retransmitida consome banda do serviço.

O servidor emite credenciais temporárias compatíveis com coturn configurado com
`use-auth-secret`. Configure no ambiente do servidor:

```dotenv
VOXA_TURN_URLS=turn:turn.exemplo.com:3478,turns:turn.exemplo.com:5349
VOXA_TURN_SECRET=segredo-compartilhado-com-o-coturn
```

São exemplos, não um serviço provisionado. O segredo fica no servidor.
As credenciais duram uma hora; o cliente renova a cada 40 minutos, repete em
5–60 segundos se falhar e renova após suspensão/mudança de rede. Atualiza o
peer ao recuperar a conexão. O fallback legado `VITE_TURN_URLS`,
`VITE_TURN_USERNAME` e `VITE_TURN_CREDENTIAL` continua suportado em ambientes
controlados, mas é extraível do instalador.

Um build de teste com `VITE_ICE_POLICY=relay` exige relay. Confirme tráfego
bidirecional e rota relay no diagnóstico. Esse teste no serviço real não foi
executado nesta correção.

## Supabase e anexos privados

Sem `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`, há chat ao vivo, sem
histórico/anexos. Com Supabase, habilite autenticação anônima e suas proteções
contra abuso. A chave pública do cliente não é um segredo. A senha de
`join_guild` precisa corresponder à senha da sinalização.

Para banco novo, revise e execute nesta ordem:

1. `supabase/schema.sql`
2. `supabase/attachments.sql`
3. `supabase/hardening.sql`
4. `supabase/fechar-historico.sql` — substitua o token de exemplo.
5. `supabase/hardening-2.sql`
6. `supabase/audit-3.sql`

Para banco existente com os cinco primeiros scripts, **distribua primeiro o
cliente que resolve URLs assinadas e depois aplique audit-3.sql**. A migração
torna o bucket privado; clientes antigos deixam de abrir anexos por URL pública.
Faça backup e valide em homologação antes de aplicar em produção.

A migração corrige leitura de perfis, autoriza anexos por sala, serializa limites
no banco e revoga associações quando o hash da senha muda. Aplicá-la não muda
a senha. URLs já assinadas continuam válidas até expirar, em até cinco minutos.

Quota conservadora: 25 objetos por proprietário, 100 no bucket e 8 MiB por
arquivo. Não existe limpeza automática de órfãos. O administrador precisa revisar
e remover arquivos pela API/painel do Storage e suas referências correspondentes.
Essa quota não cobre histórico ou outros consumos. Limites por identidade anônima
não impedem abuso com várias identidades; use também as proteções do provedor.

Os testes locais validam SQL/RLS. Não validam a API hospedada do Storage, seu
fluxo de upload nem concorrência de um serviço real. A senha compartilhada autoriza
o grupo inteiro; não existe modelo de contas/cargos ou canais privados por pessoa.

## Release e atualização

Mantenha versões iguais em `package.json`, `package-lock.json`,
`src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` e `src-tauri/tauri.conf.json`.
O workflow exige tag `vVERSAO` igual ao pacote e executa CI no mesmo commit.
Cria um draft e só promove após verificar artefatos e dependências nativas.
Uma versão inferior não substitui a maior versão estável como latest.

| Secret no GitHub Actions | Finalidade |
|---|---|
| TAURI_SIGNING_PRIVATE_KEY | Assinar artefatos do atualizador |
| VITE_SIGNALING_URL | Endereço da sinalização |
| VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY | Histórico opcional |
| VITE_TURN_URLS / VITE_TURN_USERNAME / VITE_TURN_CREDENTIAL | Fallback legado opcional |

Mantenha `bundle.createUpdaterArtifacts` habilitado e cópia segura da chave
privada: os apps instalados verificam com a chave pública embutida. A assinatura
do atualizador não equivale a Authenticode; o workflow atual não configura
Authenticode do executável/instalador Windows.

O diagnóstico informa versão, commit, hash das fontes e capacidades, sem segredos.
O script local gera hashes dos artefatos. Antes de distribuição geral, valide
instalação limpa, update da versão anterior, reinício e desinstalação. O CI
atual não comprova esses fluxos nativos.
