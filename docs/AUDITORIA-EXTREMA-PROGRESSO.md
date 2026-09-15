# Auditoria extrema — checkpoint de execução

Iniciada em 2026-09-09. Trabalho em andamento, não representa certificação de produção.

## Escopo autorizado

Seis fases sequenciais: refatoração; segurança/RLS/signaling; resiliência P2P;
UI/memória; cloud/CI/distribuição; relatório e roadmap. Preservar todas as
funcionalidades e não contratar serviços. Implementar teste de áudio/conexão,
captura de áudio por aplicativo e recuperação após suspensão com renovação TURN.
O usuário fará logins manualmente quando necessários. Nunca publicar segredos.

## Estado inicial confirmado

- GitHub `main` e HEAD local: `e378d82de4b3121fd8c063364760ba0400088120`,
  confirmado via `git ls-remote` em 9/9. Muitas alterações anteriores não commitadas.
- Manifesto local 0.5.29. Relatórios anteriores em `REVISAO-0.5.29.md` e
  `CORRECOES-0.5.29.md`; não presumir que essas correções estejam implantadas.
- GitHub acessível no Chrome autenticado. Demais painéis ainda não auditados.
- Automação `continuar-auditoria-voxa` ativa, verifica a cada hora nesta tarefa.
  Não garante execução no instante do reset; depende de disponibilidade do Codex.
- Recusa anterior de geração de instalador registrada na revisão precedente;
  não repetir automaticamente o comando recusado sem resolver essa condição.

## Progresso

1. Sessão separada em controle de atualizações e atalhos. Download duplicado
   bloqueado; feedback de recuperação de mic respeita mudo/PTT/ensurdecido.
   Baseline em `work/auditoria-extrema-baseline`. Passaram 104 testes unitários,
   14 regressões, 10 SQL, 7 revisão e 7 verificações da UI com duas sessões.
   `tauri dev` encontrou estouro de ordinais ao gerar DLL GNU desnecessária;
   biblioteca desktop alterada para rlib. `npm run app -- --no-watch` compilou e
   iniciou voxa.exe em 10/9, com loader oficial e target temporário ASCII.
   Ainda há aviso de merge de manifests GNU; reprodução física não confirmada.
2. **Em andamento:** Express/rate-limit HTTP, limite pré-autenticação de
   transportes Engine.IO, chaves IP normalizadas e IPv6 por /64, corte de
   metadados extras SDP/ICE, logs do socket sem mensagem arbitrária. Quatro
   testes adicionais passaram, incluindo flood real de transportes sem hello.
   `audit-online.sql` passou em PostgreSQL/PGlite e foi submetido no Supabase
   antes da interrupção. Aplicação CONFIRMADA por leitura em 10/9: helper/política
   de perfil, trigger de rotação e lock de mensagens presentes. Não reaplicar.
   Supabase em produção: todas as seis salas privadas e RLS ativo; bucket
   chat-attachments ainda público. Fechar bucket exige cliente compatível.
   GitHub latest confirmado como 0.5.27, commit e378d82; correções locais não publicadas.
3. Implementados: renovação TURN serializada com retry e descarte de resposta
   atrasada; detecção de suspensão/mudança de rede; ICE restart contínuo com
   intervalo limitado. Quatro verificações de renovação e 14 regressões passaram.
   Captura nativa por processo ou excluindo Voxa implementada, compilada e exposta
   no seletor, sem fallback silencioso para todo o PC. Requer Windows build 20348+;
   não validada fisicamente com jogo. Em 14/9, ampliando testes de resiliência.
4. Painel de testes separados de microfone, saída, conexão e transmissão
   implementado; typecheck passou. Testes de UI/limpeza de recursos em andamento.
   Fronteiras de erro e redução de trabalho em segundo plano já existem; rever
   cobertura antes de afirmar conclusão da fase.
5. Supabase parcialmente auditado e SQL compatível aplicado; bucket público ainda
   requer distribuição coordenada do cliente que usa URLs assinadas. Pendentes:
   Render, Oracle/TURN, Actions, releases e ambiente instalado.
6. Pendente: relatório consolidado, evidências e roadmap sem promessas absolutas.

## Regras para retomada

### Continuação de 14/9

- Usuário fez login no Render e confirmou: **não existe VM/servidor TURN**.
  Render tem somente ORIGIN e VOXA_TOKEN, sem grupos de ambiente. Serviço Free,
  Oregon, rootDir `server`, health `/health`, build ainda `npm install`.
  Deploy vivo `424c70f347e8cc4e9b776a2b041382ef13a49140`; `git diff` mostrou que
  `server/` desse commit é igual ao HEAD publicado e378d82. Hash antigo decorre
  do filtro de diretório, não de falha comprovada no auto-deploy.
- GitHub CI #53 aprovado no e378d82; secrets presentes: assinatura, signaling,
  URL e chave pública Supabase. Sem secrets TURN. **Exigência de SHA completo
  para Actions ativada e salvamento confirmado no painel**; todos os workflows
  publicados já usam SHA. Token padrão read-only, aprovação de PRs por Actions
  desabilitada. Nenhum push/release/instalador novo executado.
- Supabase Auth: login anônimo ligado, limite 30 criações/h/IP e 150 refreshes
  por 5 min/IP, encaminhamento de IP desabilitado. CAPTCHA desabilitado. Ligar
  CAPTCHA agora quebraria o cliente publicado; exige integração coordenada.
- Corrigidos relógio retrocedendo no watcher de retomada, contadores por MID
  negociado e métricas antigas após sumiço de RTP; captura por processo aceita
  jogo minimizado após seleção. Teste de transmissão mostra delta de bytes de
  áudio, distinguindo envio de reprodução audível. Testes de mic liberam clone
  e preservam captura da chamada. Texto de configurações atualizado.
- Chat: evento de rede duplicado não sobrescreve mensagem; histórico RLS tem
  prioridade sobre colisão de ID ao carregar. Apelidos ainda são autodeclarados;
  não confundir essa correção com verificação criptográfica de identidade.
- Passaram 110 unitários, 16 regressões, 10 SQL, 7 revisão, 11 recuperação,
  5 política de captura e 12 UI com duas sessões e mídias sintéticas. RTC real
  Chromium passou 4 cenários, worklet minificado processou 48000 quadros com som.
  UI XSS usa botão Enviar (Enter com autocomplete de menção só completa o nome).
  Novo teste de captura teve erro no harness CommonJS, corrigido e passou.
- `cargo fmt` e `clippy --offline --locked -- -D warnings` passaram. Native dev
  compilou/iniciou em 14/9; permanece warning GNU de manifests duplicados.
  Evidência em `work/extreme-native-app.log`. Não afirmar teste físico nem
  reprodução audível em dois PCs. Captura por processo ainda requer teste real.
- TLS público verificado em 14/9 com `scripts/check-deployment.mjs`: ambos TLS 1.3
  autorizado; Render health 200 ainda expõe contagens/RSS; Supabase auth health
  sem chave retorna 401. Evidência em `test-results/deployment.json`.
- Próximos: terminar
  revisão de distribuição/refatoração pendente, consolidar relatório, resolver
  provisionamento gratuito de TURN e distribuição compatível antes de fechar
  bucket público. Automação deve retomar daqui, sem reaplicar SQL online.

### Continuação em 14/9 — checkpoint para revisão

- Branch local `codex/voxa-auditoria-extrema` criada a partir de e378d82; mudanças
  preparadas para commit. Ainda conferir commit/push antes de afirmar publicação.
- Recuperação da sessão não aguarda drivers de áudio/microfone ou enumeração de
  dispositivos; ICE e eventos futuros continuam funcionando se essas promises
  não terminarem. Regressão real da sessão cobre duas recuperações consecutivas.
- `npm run verify` consolidado passou com 110 unitários, 17 regressões, 10 SQL,
  7 revisão, 11 recuperação e 5 captura; depois passaram 4 novos testes PE
  (total unitário agora 114). Build frontend anterior também passou.
- Manifest duplicado confirmado por leitura PE: dois recursos 24/1/1033.
  GCC instalado inclui default-manifest.o nos specs; referência WinLibs #299.
  `check-native.mjs` agora bloqueia esse executável na distribuição e exige
  `asInvoker`/`longPathAware`. 4 testes com PE controlado passaram, e teste
  negativo contra voxa.exe real confirmou o bloqueio. Não remover manifest
  Tauri nem modificar o toolchain global para esconder o aviso. Correção local
  do toolchain permanece pendente; CI usa MSVC e precisa validar o artefato real.
- Relatório consolidado: `docs/RELATORIO-AUDITORIA-EXTREMA.md`. Usuário ainda não
  respondeu sobre existência de conta Oracle; não existe VM/TURN. Pergunta já
  enviada, não duplicar nem habilitar serviço com cobrança por excedente.
- Commit local confirmado: `bf3a9de`, 97 arquivos, branch
  `codex/voxa-auditoria-extrema`. Suite unitária final confirmou 114/114.
- `git push --set-upstream origin codex/voxa-auditoria-extrema` ficou pendente
  no Git Credential Manager, sem saída. Consulta `git ls-remote` não encontrou
  essa branch; tentativa interrompida via Ctrl+C. Não afirmar push ou PR criado.
  Login no navegador não implica credencial Git válida no terminal.
- Controle do navegador indisponível nesta retomada: `failed to write kernel
  assets: O sistema não pode encontrar o caminho especificado (os error 3)`.
  Reset seguido de `cua.getState()` repetiu o erro. Retomar GitHub/Render somente
  depois que o controle/auth funcionar; não contornar por automação de UI externa.
- O teste PE contra o binário real inicialmente parou no loader ausente no
  diretório temporário; a verificação agora examina primeiro o manifest e
  confirmou a duplicidade. O helper dev repõe o loader ao executar, mas isso
  não prova instalação limpa e não autoriza distribuir o executável de debug.

### Retomada automática em 15/9 — recursos do atualizador

- Identificado vazamento de recursos do plugin updater: `checkForUpdate` criava
  `Update` nativo e expunha somente install; substituir a consulta descartava
  a closure sem chamar `close`. API instalada e documentação confirmam limpeza
  explícita de Resource. Não houve download nem instalação de atualização.
- `UpdateInfo` agora expõe close; `SessionUpdates` mantém o dono do recurso,
  libera ao substituir/remover a oferta, descarta respostas após destroy e
  aguarda instalação ativa antes de fechar. Falhas de consulta/download mantêm
  a tentativa de instalação disponível. Session.destroy encerra o controlador.
- 6 regressões novas cobrem substituição, resposta tardia, falha de consulta,
  instalação concorrente com destroy, retry de download e falha de close.
  Passaram 120 unitários totais, 17 regressões de sessão, TypeScript e build
  frontend (38,88 s). Testes de plugin usam recursos controlados; não equivalem
  a instalação/auto-update real, que permanece pendente.
- GitHub/TURN/instalador permanecem com as pendências já descritas. Não repetir
  push que aguarda credenciais nem a geração de instalador recusada anteriormente.

Ler este arquivo e o diff atual; não reiniciar as auditorias anteriores do zero.
Registrar reprodução, correção e teste antes de declarar uma falha resolvida.
Separar resultado automatizado de teste físico com dois PCs e redes distintas.
Não remover recursos para obter testes verdes, não reduzir segurança para conectar.
Não aplicar migrações destrutivas sem verificar impacto e compatibilidade real.
Atualizar este checkpoint ao concluir cada camada e ao encontrar bloqueios externos.
