# Voxa — auditoria e implementação

Atualizado em 16/09/2026. Versão de trabalho: 0.5.30. **Em andamento; não é uma
certificação de ausência de falhas. Signaling implantado em 15/9; cliente desktop ainda pendente.**

## Achados que afetam o uso agora

1. **Não existe TURN configurado.** Confirmado pelos nomes das variáveis do
   Render/GitHub e pelo usuário. STUN não resolve todas as combinações de NAT.
   Isso pode manter dois participantes em `connecting`, sem áudio ou vídeo,
   mesmo com microfone e player funcionando. O código aceita credenciais
   temporárias; falta provisionar o relay e validar em redes distintas.
2. **Signaling corrigido em produção; cliente ainda não distribuído.** Render
   executa 84cc21ac1b87bd5f1eddd2beeda41ffe53d94eb4 desde 15/9 às 21:00 BRT.
   GitHub latest continua em 0.5.27. As alterações desktop foram integradas na
   `main`; os pacotes 0.5.29 foram gerados mas bloqueados antes da publicação.
3. **Anexos ainda estão em bucket público.** O banco tem RLS e seis salas
   privadas, mas isso não protege URLs públicas dos arquivos. O cliente novo
   resolve URLs assinadas; fechar o bucket exige distribuir esse cliente antes,
   validar anexos antigos/novos e executar a migração correspondente.

## Mudanças implementadas

| Área | Correção ou melhoria | Evidência |
|---|---|---|
| Organização | Atualizações e atalhos extraídos da sessão; concorrência de atualização controlada | Regressões de sessão |
| Signaling | Express, rate limit HTTP, reserva de transporte antes do hello, teto por IP/total, IPv6 normalizado | Teste com 10 conexões WebSocket cruas e recusa da 11ª |
| Handshake | SDP/ICE limitados aos campos necessários; sinais somente entre pares no mesmo canal | Integração Socket.IO local |
| Entradas malformadas | Objetos JSON no token legado e no tamanho de anexo não causam exceção por coerção | Queda reproduzida localmente e regressão Socket.IO após correção |
| Banco | Leitura de perfis compartilhados, lock de entrada/mensagens, revogação em futura rotação do hash, índice de histórico | PGlite/PostgreSQL e leitura do catálogo de produção |
| Reconexão | Retry contínuo com backoff, renovação TURN serializada, cancelamento de resposta antiga | Testes de ICE/TURN e recuperação após oito tentativas |
| Retry do login | Hello repetido devolve TURN mesmo após perda da primeira resposta, preservando identidade/canal | 2 regressões dos handlers e HMAC das credenciais |
| Suspensão | Detecção de pausa, mudança de rede e relógio retrocedendo; liberação do estado de PTT | Testes com relógio e eventos controlados |
| Drivers após suspensão | Promises pendentes de áudio/microfone não bloqueiam novas recuperações de rede | Regressão com dispositivos indefinidamente pendentes |
| Áudio por aplicativo | WASAPI inclui árvore de um processo ou exclui Voxa; falha não muda para captura de todo o PC | Compilação Rust e 5 verificações da política de captura |
| Diagnóstico | Testes independentes de mic/saída/conexão/transmissão; clone temporário preserva chamada; delta RTP | UI com áudio sintético e teste de limpeza ao fechar |
| Métricas | MIDs realmente negociados, descarte de taxas antigas, proteção contra contador reiniciado | Testes da classe Peer real |
| Chat | XSS exibido como texto; evento duplicado não reescreve mensagem; histórico RLS prevalece em colisão | Testes de UI e regressões |
| Desktop | Loader oficial no desenvolvimento GNU, target ASCII e rlib para evitar estouro de ordinais | Compilação e início de voxa.exe |
| Publicação nativa | Rejeita manifest ausente/duplicado ou pedido de administrador no executável final | 4 testes PE e recusa do binário GNU local com duplicidade |
| Atualizador | Libera recursos nativos substituídos/descartados e respostas tardias; preserva instalação ativa e retry | 6 testes do controlador real com plugin controlado |
| GitHub | Exigência de SHA completo para ações habilitada em produção | Painel confirmou salvamento |

Correções das rodadas anteriores estão detalhadas em `REVISAO-0.5.29.md` e
`CORRECOES-0.5.29.md`, incluindo lifecycle de mídia, renegociação simultânea,
PCM/AudioWorklet, URLs assinadas, histórico, atalhos e proteções de release.

Correções até 84cc21a enviadas ao GitHub e integradas na `main`.
O usuário pediu commit/push após cada alteração validada. Controle do navegador
restabelecido e checks do commit f7bb18b confirmados com sucesso. Render foi
implantado manualmente nesse SHA, sem merge na main. Auto-Deploy ficou desligado
para evitar a substituição pelo código antigo da main. Próximas publicações do
servidor exigem selecionar explicitamente o SHA validado até reconciliar a main.

## Validação realizada

- 128 testes unitários/integração (última rodada com `npm test`), 17 regressões de ciclo de vida/chat,
  10 verificações SQL, 7 de revisão, 11 de renovação/retomada e 5 da política
  de captura passaram. Comando consolidado: `npm run verify`.
- 12 verificações da interface com duas sessões e dispositivos sintéticos:
  voz RTP bidirecional, vídeo ao assistir, desligamento ao sair, XSS como texto,
  diagnóstico de mic/saída e encerramento do clone sem encerrar a chamada.
- 4 cenários WebRTC em Chromium passaram; worklet minificado processou 48000
  quadros com sinal. O teste RTC local usou Chrome instalado via VOXA_TEST_BROWSER.
- TypeScript, Rust fmt e clippy com warnings como erros passaram.
- Desenvolvimento Tauri compilou e iniciou. A leitura dos recursos PE confirmou
  dois manifests com identificador 24/1/1033: Common Controls e o manifest Tauri
  com `asInvoker`/`longPathAware`. O GCC 16 instalado acrescenta `default-manifest.o`
  em seus specs; há relato correspondente no WinLibs. A validação de distribuição
  agora recusa esse binário. Correção do toolchain local ainda pendente; não foi
  removido o manifest de segurança nem alterada a instalação global do compilador.

Os testes sintéticos **não comprovam** som audível nos fones, captura de um jogo
real, comportamento de drivers, duas redes com NAT restritivo ou instalação/update
limpos. Não houve teste de DDoS contra serviços públicos; testes de abuso foram locais.

## Produção: o que foi confirmado

- **Supabase:** `audit-online.sql` aplicado e confirmado em 10/9. RLS ativo nas
  seis tabelas examinadas; correção de perfis e triggers presentes. Bucket de
  anexos permanece público. Não reaplicar SQL por presumir que a interrupção
  cancelou a execução.
- **Auth:** login anônimo habilitado; 30 novos anônimos/h/IP; 150 renovações
  por 5 min/IP; CAPTCHA desabilitado. Ligar CAPTCHA exige primeiro implementar
  o desafio no cliente. Não há modelo de contas/cargos individuais: senha
  compartilhada concede acesso ao grupo e apelidos são autodeclarados.
- **Render:** plano Free, Oregon, health `/health`, root `server`, build
  `npm ci --omit=dev`, start `node index.js`, TRUST_PROXY=1 salvo; ORIGIN e
  VOXA_TOKEN preservados. Deploy `dep-dako0mad0e5s73a4fltg` confirmado Live,
  commit f7bb18b, 31,5 s, logs confirmam proteção por token. Sem erros de build
  ou inicialização; npm informou zero vulnerabilidades nas dependências instaladas.
  O provedor selecionou Node 26.8.2 pelo intervalo aberto >=18. Configuração do
  código agora limitada a 24.x, alinhada ao CI; ainda exige novo deploy para
  alterar produção. Auto-Deploy desativado pelo deploy por SHA.
  A configuração usa o último IP do X-Forwarded-For somente com peer privado;
  distribuição real das chaves por IP entre redes diferentes não foi medida.
  Não considerar a topologia de múltiplos proxies homologada por este smoke test.
- **GitHub:** CI publicado #53 aprovado; chave de assinatura e variáveis de
  signaling/Supabase presentes por nome. Valores não foram expostos. Permissões
  padrão do token somente leitura; Actions não pode aprovar PRs. Regra SHA ativada.
- **Oracle:** usuário confirmou que não há VM/TURN existente; não há firewall
  desse ambiente para auditar. Provisionamento depende de conta gratuita disponível.
- **TLS público:** após implantação, signaling negociou TLS 1.3 com certificado
  validado e `/health` respondeu 200, corpo exato `{ok:true}`, sem contagens/RSS.
  Uma conexão WSS confirmou handshake Engine.IO e maxPayload=262144; encerrada
  sem autenticar, publicar presença, entrar em salas ou transmitir mídia.
  Supabase também negociou TLS 1.3 validado;
  `/auth/v1/health` sem chave respondeu 401. Isso verifica transporte, não login.
  Verificador corrigido para rejeitar HTTP inesperado, JSON inválido, health
  negativo, corpo excessivo/truncado e prazo excedido, além de falha TLS.
  Cinco testes locais novos passaram; leitura pública repetida passou também.

## Atualização de implantação — 16/9/2026

Main integrada até 84cc21a e CI aprovado. Render recebeu esse SHA em
dep-daktnvvf3r2c738lctk0, Live desde 15/9 às 21:00:29 BRT, com Node 24.21.0.
Health HTTPS e handshake WSS passaram. Auto-Deploy segue desligado e não há TURN.

A publicação v0.5.29 foi bloqueada corretamente pelo gate do executável: o
manifesto padrão do Tauri contém só Common Controls. Preparada a 0.5.30 com
manifesto explícito (asInvoker, longPathAware e Common Controls) sem afrouxar
o gate nem mover a tag existente. Testes de instalação limpa e upgrade NSIS/MSI
na VM Windows são obrigatórios antes da promoção da release. Ainda pendentes
nesta entrada. O bucket permanece público até distribuição compatível do cliente.

## Próximas melhorias de maior impacto

1. TURN operacional com limites de banda, credenciais temporárias, TLS e teste
   forçado por relay. A Oracle documenta recursos Always Free e 10 TB/mês de
   saída; disponibilidade deve ser conferida na conta. Evitar tratar trial ou
   cobrança por excedente como gratuidade garantida.
2. Distribuição coordenada do cliente e dos anexos privados, incluindo backup,
   teste de permissões pela API Storage e abertura de arquivos da versão antiga.
3. Vincular identidade de signaling à identidade autenticada e criar convites
   individuais revogáveis/cargos, mantendo o acesso atual durante a migração.
   Isso reduz impersonação por apelido e permite salas realmente privadas por pessoa.
4. Homologação de áudio em Windows 10/11, GPU integrada/dedicada, fones USB/Bluetooth,
   suspensão, troca de saída e redes distintas; instalar e atualizar em VM limpa.
5. Captura seletiva de tela sem reiniciar o WebView2, após prova de compatibilidade;
   a limitação atual de troca de fonte continua explícita.
6. Logs locais estruturados com exportação redigida, indicação de origem da falha
   no diagnóstico e testes prolongados para medir vazamentos e consumo real de RAM.

Overlay, RNNoise, push-to-talk e captura do som do sistema já existem. As melhorias
devem aperfeiçoar esses recursos, sem apresentá-los como funcionalidades ausentes.

## Referências técnicas consultadas

- [Microsoft: captura de áudio por processo](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)
  — requer Windows build 20348 ou posterior.
- [Oracle: recursos Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
  — limites gratuitos e disponibilidade da conta.
- [Cloudflare: TURN e cobrança](https://developers.cloudflare.com/realtime/turn/faq/)
  — franquia seguida de cobrança; não adotado como solução de custo garantidamente zero.
- [WinLibs: duplicidade de manifests no GCC 16](https://github.com/brechtsanders/winlibs_mingw/issues/299)
  — compatível com o problema reproduzido no desenvolvimento GNU local.
- [Tauri: ciclo de vida de Update.close](https://v2.tauri.app/reference/javascript/updater/#close)
  — recurso nativo liberado quando a consulta é substituída ou a sessão é encerrada.

TLS/WSS protege o transporte da sinalização; não equivale a identidade verificada
entre participantes. WebRTC cifra a mídia, mas segurança depende também da
autenticação do handshake, autorização e integridade dos clientes.
