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
  push que aguarda credenciais sem resposta do usuário nem a geração de instalador recusada anteriormente.

### Revisão solicitada em 15/9 — GitHub e entradas malformadas

- **Preferência permanente do usuário:** depois de alterações validadas, fazer
  commit e push ao GitHub nesta branch e confirmar o SHA remoto. Se auth/rede
  impedir o envio, avisar claramente; não tratar commit local como publicação.
  Enviar código não significa gerar instalador ou liberar versão em produção.
- Usuário concluiu login Git Credential Manager. Push dos três commits anteriores
  confirmado: remoto `codex/voxa-auditoria-extrema` em fb94cd0. Browser CUA ainda
  falha ao inicializar; não há PR criado. CI agora inclui pushes `codex/**` para
  validar mudanças da branch mesmo antes de abrir PR.
- Encontrada queda do signaling por coerção de objeto JSON: `String(token)` no
  hello legado podia lançar TypeError antes de autenticar; `Number(attachmentSize)`
  tinha a mesma falha em anexos. Teste contra servidor local reproduziu desconexão
  antes da correção. Token agora exige string; tamanho só converte número/string,
  preservando compatibilidade com tamanho textual e rejeitando objetos.
- Novo teste com Socket.IO real garante recusa de token malformado, sobrevivência
  de cliente válido e servidor, descarte de tamanho malformado e anexos válidos.
  Nunca enviar esses probes ao Render público. Alteração precisa de rollout do
  servidor, com TRUST_PROXY/topologia conferidos, para proteger produção.
- `npm run verify` completo passou (121 unitários/integração, 17 regressões,
  10 SQL, 7 revisão, 11 recuperação, 5 captura). Correção enviada no commit
  f27e030. O teste usa caminho absoluto calculado pelo próprio arquivo para
  permitir execução também de dentro de server/. Confirmação do CI hospedado
  ainda pendente: browser indisponível e leitura web de Actions retornou erro.
- Automação atualizada para incluir commit/push após mudanças validadas e aviso
  explícito se o envio falhar. A preferência persiste nas próximas retomadas.
- Teste novo também executado em `server/`: primeira tentativa excedeu a janela
  curta de inicialização (3 s). Ampliada para 10 s com timeout de fetch, diagnóstico
  de stderr/exit e limpeza de processo. Passou na repetição (8,9 s no total).
  Ajuste de teste também deve ser enviado; não confundir essa falha do harness
  com regressão da validação de payloads, já aprovada no verify completo.
- CI confirmado pela API pública do GitHub (acesso de rede precisou de escalada):
  run 34925516824 do commit f27e030 terminou com success. Run 34925661111 de
  07bb779 estava em andamento. API REST permite acompanhar sem o browser CUA;
  consultar o run do SHA final antes de afirmar sucesso do checkpoint mais novo.

### Retomada automática em 15/9 — retry da identificação e TURN

- Depois de uma primeira resposta hello perdida, o servidor já tinha registrado
  o cliente, mas o retry devolvia apenas selfId/roster. Sem iceServers, o cliente
  podia concluir login sem receber TURN nem iniciar sua renovação de credenciais.
- Resposta de hello centralizada e completa também para clientes já identificados.
  Não recria identidade, não sai do canal e não repete o broadcast de presença.
- Dois testes com os handlers/Registry/RateLimiter reais reproduziram ausência
  de ICE antes da correção. Agora verificam assinatura HMAC, validade, identidade,
  canal e ausência de broadcast duplicado. 123 testes da suíte npm passaram,
  incluindo integração Socket.IO com servidor local. Não foi contatado relay real.
- Esta correção prepara o comportamento quando TURN estiver configurado; não
  provisiona TURN nem altera Render. Manter pendências de cloud e teste físico.

### Implantação autorizada no Render em 15/9

- Usuário pediu explicitamente implantar as correções. Browser CUA voltou a
  funcionar, sessão Render autenticada. Commit f7bb18b com checks success no
  GitHub; escolhido por SHA completo no Manual Deploy, sem merge na main.
- TRUST_PROXY=1 adicionado via Save only, preservando ORIGIN/VOXA_TOKEN.
  Build alterado para npm ci --omit=dev. Essa alteração disparou deploy da
  main e378d82 (`dep-dako042fngtc73esuet0`); cancelamento solicitado antes de
  selecionar a revisão correta. Publicação final verificada é f7bb18b.
- Deploy `dep-dako0mad0e5s73a4fltg`: iniciado 14:28:57 BRT, Live às 14:29:29,
  duração 31,5 s. SHA f7bb18b04541e6865b44460b3c7f65e0b8cfde51. Logs de
  build/start sem falhas; proteção por token ativa e zero vulnerabilidades npm.
- Health público HTTP 200, corpo exato {"ok":true}, TLS 1.3 e certificado válido.
  Smoke WSS abriu um único transporte Engine.IO, maxPayload=262144 e fechou;
  não autenticou nem publicou presença/chat/mídia. Scripts em work e test-results.
- Painel confirma Auto-Deploy desabilitado pelo deploy específico. A branch
  configurada continua main (e378d82), mas o SHA servido é o da auditoria.
  Não usar Deploy latest commit nem reativar Auto-Deploy antes de reconciliar
  a main: poderia restaurar o servidor antigo. Blueprint continua gerenciado;
  conferir diferenças antes de futuras sincronizações de configuração.
- Runtime selecionado pelo Render: Node 26.8.2 (engines >=18). Próxima revisão:
  fixar linha compatível com CI e medir chaves de rate limit entre redes reais;
  TRUST_PROXY=1 habilita último XFF com peer privado, mas não houve inspeção dos
  hops reais. Não afirmar topologia homologada nem teste de carga em produção.
- TURN ainda inexistente; implantação não resolve todos os casos de NAT.
  Não houve release desktop, instalador, novo SQL nem mudança no bucket público.
  Atualizar/push deste registro conforme preferência permanente do usuário.

### Continuação — runtime e validação de implantação

- `server/package.json` e lockfile agora limitam Node a 24.x, mesma linha do CI
  e dos testes locais. O intervalo >=18 permitiu selecionar 26.8.2 no Render.
  Conferida documentação oficial do Render sobre precedência e limite superior.
  Não alterado runtime em produção: segue o deploy f7bb18b até novo rollout.
- `check-deployment.mjs` antes só fazia o comando falhar por transporte/TLS;
  HTTP 500 com certificado válido podia terminar com exit 0. Agora exige status
  e JSON esperados: signaling 200/{ok:true}; Auth público sem chave 401/erro JSON.
  Esse segundo resultado não comprova autenticação, banco ou RLS.
- Prazo absoluto de 90 s, teto de 16 KiB, tratamento de resposta interrompida
  e conexão TLS reutilizada. Nenhum corpo de resposta ou segredo é impresso.
- Cinco regressões usando servidor HTTP local real: respostas inválidas/status,
  Auth sem chave, limite de corpo, interrupção e servidor enviando bytes devagar.
  Entraram no npm test/CI. 128 testes passaram. Health público repetido passou:
  Render 200 e Supabase 401 esperado, ambos TLS 1.3 com certificado validado.
- Ferramenta de controle do navegador não está exposta nesta rodada, portanto
  não foi iniciado outro deploy pelo painel. Não supor que o push muda o Render:
  Auto-Deploy continua desligado. Sem nova release/instalador/SQL/TURN.

### Continuação em 16/9 — main, Render e gate de release

- Usuário autorizou os itens 2, 3 e 5: atualizar Render, testar instalação/upgrade,
  integrar main e publicar cliente antes da migração dos anexos. Essa autorização
  substitui a restrição anterior de não gerar instalador.
- Main integrada por fast-forward até 84cc21a, enviada e conferida no GitHub.
  CI da main 35037912946 e da branch 35037864453: success.
- Render: deploy dep-daktnvvf3r2c738lctk0, SHA 84cc21a, Live em 15/9 às
  21:00:29 BRT. Node 24.21.0, npm ci --omit=dev. Health 200/{ok:true}, TLS 1.3
  e handshake WSS conferidos. Auto-Deploy continua desligado; TURN inexistente.
- Tag v0.5.29 criada. Run 35037954809 passou validações frontend/Rust e gerou
  pacotes, mas o gate check-native bloqueou a publicação: manifesto continha
  apenas Common Controls. O padrão de tauri-build 2.6.3 não declara asInvoker
  nem longPathAware. O teste não foi relaxado; build.rs agora inclui manifesto
  próprio com essas propriedades e preserva Common Controls.
- Preparada 0.5.30 sem mover a tag anterior. Três regressões novas cobrem o
  manifesto incompleto e a política do arquivo versionado. Validação do PE real
  no runner MSVC e smoke dos instaladores ainda pendentes nesta entrada.
- check-installer.ps1 roda apenas no runner Windows descartável: instalação,
  startup WebView2, upgrade da 0.5.27, preservação de boot.json e desinstalação
  para NSIS/MSI. Esse passo não executou na 0.5.29 devido ao gate anterior.
- Não houve SQL novo, privacidade do bucket nem teste físico de voz nesta etapa.
- Validação local da correção: npm run verify passou (131 testes principais,
  17 regressões, 12 SQL, 8 revisão, 11 recuperação, 5 captura). cargo fmt --check
  e cargo check --offline --locked passaram. O XML também foi parseado como XML.
- Correção enviada à main: 738a2e38f9d5214e5f8e7da1e0f8ef0c4c2de12a, mesmo SHA
  da tag v0.5.30, ambos conferidos via ls-remote. CI 35110443630 e validação da
  release 35110484493 passaram; job build 104843187120 em andamento.
- Preflight read-only do Supabase em 16/9: bucket público, zero objetos/legados,
  apenas as duas políticas esperadas e funções can_read_profile/can_read_room
  existentes. Criada attachments-private.sql (somente Storage, com preflight).
  Teste confere equivalência com audit-3.sql, idempotência, legado e bloqueio
  de leitura anônima: 12 verificações SQL passaram. Migração ainda não aplicada.

### Falha do smoke 0.5.30 e correção

- O log integral do job 104843187120 confirmou: build, upload do draft e
  check-native passaram. O NSIS instalou; o gate falhou somente ao comparar o
  executável instalado com target/release/voxa.exe.
- Essa comparação era inválida: o bundler Tauri remenda o PE com o tipo do
  pacote antes de cada bundle. O arquivo final de target estava na variante MSI,
  enquanto o NSIS continha a variante NSIS do mesmo código.
- O gate agora exige versão exata, manifesto/dependências válidos, startup com
  WebView2 e SHA-256 idêntico entre duas instalações do mesmo NSIS ou MSI.
  Mantém a detecção de pacote inconsistente sem comparar variantes legítimas.
- Run 35617897233 da 0.5.31: validação, build, check-native e smoke completo dos
  instaladores passaram. A etapa final falhou porque /releases/tags/v0.5.31
  devolveu 404 para o draft criado no mesmo job. A 0.5.32 passa a localizar o
  draft pela listagem autenticada, validando unicidade, assets e ordem semântica.

Ler este arquivo e o diff atual; não reiniciar as auditorias anteriores do zero.
Registrar reprodução, correção e teste antes de declarar uma falha resolvida.
Separar resultado automatizado de teste físico com dois PCs e redes distintas.
Não remover recursos para obter testes verdes, não reduzir segurança para conectar.
Não aplicar migrações destrutivas sem verificar impacto e compatibilidade real.
Atualizar este checkpoint ao concluir cada camada e ao encontrar bloqueios externos.
