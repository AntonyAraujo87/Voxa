# Voxa — auditoria técnica de 9 de setembro de 2026

**Estado avaliado:** código local da 0.5.28, incluindo as alterações ainda não commitadas, servidor, SQL, instalador local e automações de build. Referência anterior do repositório: `e378d82`.

**Parecer:** o projeto tem uma base útil, mas ainda precisa de estabilização antes de ser tratado como uma versão confiável para chamadas privadas. Há defeitos reproduzidos em áudio, privacidade da captura, entrada/saída de canais, histórico e reconexão. Adicionar recursos agora ampliaria a área de falha.

Esta auditoria não certifica ausência de outros bugs. Diferencio abaixo reprodução automática, conclusão por leitura do código e risco dependente do ambiente. Nenhum teste usou conversas reais ou tentou interceptar usuários do servidor público. Não alterei o banco, o deploy nem publiquei uma atualização nesta etapa de análise.

## O que muda em relação à avaliação anterior

O instalador `Voxa_0.5.28_x64-setup-corrigido.exe` resolve a ausência da DLL que impedia abrir o programa. **Isso não significa que o som da transmissão esteja resolvido.** A auditoria encontrou no JavaScript de produção desse build uma falha adicional:

```text
ReferenceError: FilaPCM is not defined
```

O minificador renomeou a classe para `a2`, mas o texto executado dentro do AudioWorklet continua usando `new FilaPCM()`. A confirmação veio do arquivo efetivamente gerado em `dist`, e não apenas de uma hipótese sobre minificação.

Os testes de WebRTC anteriores validaram a negociação e o transporte de trilhas sintéticas. Eles não passavam pelo processador que recebe o PCM do Windows. Essa lacuna permitiu que os testes passassem com esse defeito presente. O pacote atual não deve ser apresentado como uma solução já validada para o som da transmissão.

## Evidências e abrangência

| Verificação | Resultado e limite |
|---|---|
| TypeScript + suíte padrão | 100 testes aprovados na validação desta sessão; abrangem servidor, negociação, SDP, adaptação, PCM e menções. Não abrangem todos os fluxos da Session/UI. |
| Build Vite | Compilou na preparação da 0.5.28. O código produzido contém o defeito do worklet descrito em F01. Compilar não prova funcionamento. |
| WebRTC em navegador real | Quatro cenários aprovados no Chrome 152 na validação desta sessão: entrada normal/simultânea, restart de ICE e substituição de trilhas. Mídia sintética e conexão local. |
| Novas reproduções | 17 verificações de comportamentos problemáticos no script de auditoria, mais uma reprodução do worklet no bundle de produção. Não são 18 vulnerabilidades independentes: alguns testes demonstram partes do mesmo problema. |
| Rust | `cargo check`, `cargo fmt --check` e `cargo clippy … -- -D warnings` aprovados; compilação local Windows GNU. |
| Dependências npm | `npm audit --json` na raiz e no servidor: zero vulnerabilidades conhecidas reportadas na consulta. Isso não avalia erros do código próprio. |
| Dependências Rust | Compiladas/analisadas pelo Clippy. Base de avisos RustSec não consultada; `cargo-audit` não estava disponível. Não declaro ausência de vulnerabilidades Rust. |
| Empacotamento Windows | DLL Microsoft incluída e carregada no teste de abertura em perfil separado; o instalador local é `NotSigned` para Authenticode. A assinatura do updater é um mecanismo distinto. |
| Banco | Revisão dos cinco scripts e do cliente. Não executei RLS contra o banco de produção nem confirmei quais migrações estão aplicadas. |
| Hardware e redes reais | Microfone físico, WASAPI, Bluetooth, dois computadores, NATs diferentes, máquinas Windows limpas e sessões longas continuam sem validação integral. |

Reproduções: [script principal](<C:/Tudão/Projetos/voxa/work/audit/reproduce.mjs>), [resultados](<C:/Tudão/Projetos/voxa/work/audit/results.json>), [inspeção executável do worklet](<C:/Tudão/Projetos/voxa/work/audit/production-worklet.mjs>) e [resultado do bundle](<C:/Tudão/Projetos/voxa/work/audit/production-worklet.json>).

Esses scripts usam os módulos reais com dependências controladas onde indicado. O teste de signaling sobe o servidor real apenas em localhost, com token inventado. **As asserções esperam o comportamento defeituoso atual: passar significa reproduzir o bug.** Não devem ser colocadas na suíte de aprovação sem inverter as expectativas após as correções.

## Prioridade imediata — áudio, privacidade e chamada

### F01 — P1 — Som do sistema quebra no build de produção

**Reproduzido a partir do bundle.** [sysaudio.ts:28](<C:/Tudão/Projetos/voxa/src/lib/sysaudio.ts:28>) monta código com `FilaPCM.toString()`, mas a string usa o nome original da classe. A renomeação feita pelo build deixa uma referência inexistente. [vite.config.ts](<C:/Tudão/Projetos/voxa/vite.config.ts>) habilita minificação.

**Efeito:** o processador não consegue construir a fila de áudio. Além disso, o `AudioWorkletNode` não tem tratamento de `processorerror`; contar blocos recebidos do Rust não prova que eles foram processados ou enviados como som.

**Correção:** gerar o worklet como arquivo independente empacotado, ou vincular explicitamente a classe serializada a um nome estável. Tratar falha do processador e validar amostras não nulas na saída do worklet do build minificado. Um teste apenas de `FilaPCM.push/pull` não cobre esse contrato.

### F02 — P1 — Falta autorização de canal na sinalização

**Reproduzido no servidor local e no tratamento da Session.** [handlers.js:161](<C:/Tudão/Projetos/voxa/server/lib/handlers.js:161>) confere identificação e existência do destinatário, mas não exige que os dois estejam no mesmo canal de voz. [session.ts:60](<C:/Tudão/Projetos/voxa/src/lib/session.ts:60>) aceita o sinal de qualquer remetente enquanto o usuário local estiver em voz. [mesh.ts](<C:/Tudão/Projetos/voxa/src/lib/rtc/mesh.ts>) cria o peer desconhecido e entrega as trilhas locais à negociação.

**Efeito:** um membro que conhece o token da sala pode negociar com alguém de outro canal, inclusive sem entrar em voz. A lista visível e o player remoto filtram por canal, mas isso não impede o envio das trilhas locais ao peer. Há um caminho de escuta/captura indevida; não reproduzi interceptação de conversa real.

**Correção:** autorização no servidor para cada sinal, validação defensiva no cliente e associação da negociação à geração da sessão/canal. Rejeitar sinal para si mesmo e remover peers que deixem de estar autorizados. Não depender apenas da ordem de chegada do roster; usar associação validada pelo servidor.

### F03 — P1 — Sair do canal não desliga a webcam

**Reproduzido com Session e Transmissao reais e dispositivo simulado.** [session.ts:354](<C:/Tudão/Projetos/voxa/src/lib/session.ts:354>) chama `stopShare()`, que chega a [transmissao.ts:97](<C:/Tudão/Projetos/voxa/src/lib/transmissao.ts:97>). `pararTela()` retorna quando não existe captura de tela, mesmo com webcam ligada.

**Observado:** `activeVoice=null`, câmera ainda aberta, `sharing=true` e referência da câmera ainda no estado de trilhas da malha. Os peers existentes são fechados, portanto isso não significa que a transmissão anterior continue para eles; porém a captura permanece ativa e a trilha fica disponível para peers criados depois.

**Correção:** uma operação única de encerramento de toda a mídia de vídeo, usada por sair, trocar de canal e destruir sessão. Deve desligar câmera, tela, som do sistema, preview e trilhas da malha, inclusive durante uma abertura pendente.

### F04 — P1 — Entrada pendente pode desfazer a saída do usuário

**Duas reproduções.** A fila de [session.ts:303](<C:/Tudão/Projetos/voxa/src/lib/session.ts:303>) serializa entradas, mas `leaveVoice()` não cancela a operação que aguarda microfone ou resposta do servidor.

**Observado:** sair enquanto o microfone abre é seguido por reentrada automática em `lounge`; sair enquanto o ACK está pendente é seguido por criação de um peer do canal abandonado. `onReconnected()` tem o mesmo tipo de continuação sem verificar a geração após o `await`. A câmera também não possui o cancelamento por geração acrescentado à tela.

**Correção:** intenção atual de canal + contador de geração/cancelamento em todas as operações assíncronas. Cada continuação precisa conferir que ainda pertence à sessão vigente. Uma fila sozinha não expressa cancelamento.

### F05 — P1 — O estado de mudo pode divergir do microfone real

**Reproduzido.** [session.ts:375](<C:/Tudão/Projetos/voxa/src/lib/session.ts:375>) lê `muted` antes de aguardar `openMic()`. Se o usuário silencia nesse intervalo, a continuação usa o valor antigo. Resultado observado: interface muda e ganho do microfone habilitado.

Também reproduzi ensurdecer e depois ativar o microfone: [toggleMute](<C:/Tudão/Projetos/voxa/src/lib/session.ts:397>) não respeita `deafened`. Desligar PTT força abertura mesmo ensurdecido; o botão de mute da interface ainda permite abrir o mic com PTT ligado. Restaurar o estado anterior ao ensurdecer pode conflitar com a tecla de falar já solta.

**Correção:** centralizar a regra de emissão efetiva: canal válido, captura pronta, ausência de ensurdecimento, intenção de mute e tecla PTT. Aplicá-la lendo o estado atual após cada operação assíncrona. O soundboard, que intencionalmente passa após o ganho do mic, deve ter uma regra própria explícita.

### F06 — P1 — Aberturas concorrentes vazam captura de microfone

**Reproduzido com LocalMedia real e duas capturas simuladas.** Em [localMedia.ts:103](<C:/Tudão/Projetos/voxa/src/lib/localMedia.ts:103>), `micStream` só é atribuído depois do `await`. Duas chamadas iniciadas antes disso abrem dois streams; a segunda sobrescreve a referência da primeira. `closeMic()` encerra apenas a última.

**Gatilhos:** trocar dispositivo, preset, supressão de ruído ou tentar novamente enquanto outra abertura está pendente. O retry periódico também não impede uma tentativa anterior ainda em andamento. `closeMic()` não invalida uma captura ainda pendente em `getUserMedia`.

**Correção:** dono único da captura, promessa compartilhada/serialização e geração. Ao cancelar ou perder a corrida, parar explicitamente todos os tracks obtidos e desmontar o grafo daquela execução. Encerrar também o track do destino de mixagem descartado.

### F07 — P1 — Um ACK ausente pode travar todas as entradas seguintes

**Reproduzido no servidor real local:** 16 pedidos em sequência, 15 respostas. [handlers.js:107](<C:/Tudão/Projetos/voxa/server/lib/handlers.js:107>) retorna sem ACK ao atingir o limite. [signaling.ts:185](<C:/Tudão/Projetos/voxa/src/lib/signaling.ts:185>) espera indefinidamente e a Session mantém as entradas seguintes atrás dessa promessa.

A resposta `{error: ...}` de canal inválido também não é validada pelo cliente. A entrada idempotente devolve o próprio socket entre os peers — reproduzido — e falta defesa contra um peer de si mesmo. O rate limit de saída pode ainda deixar a presença do servidor divergente da interface.

**Correção:** timeout e resposta tipada de sucesso/erro em toda operação de voz; restauração de estado na recusa; saída idempotente garantida; ACK sem o próprio usuário. O teste atual denominado “sempre responde” não exercita o limite de taxa.

### F08 — P1 — Push-to-talk salvo não é restaurado no Windows

**Reproduzido no fluxo de inicialização com ponte nativa instrumentada.** [hydrate](<C:/Tudão/Projetos/voxa/src/lib/session.ts:168>) restaura `pushToTalk=true` e `muted=true`. [initHotkeys](<C:/Tudão/Projetos/voxa/src/lib/session.ts:622>) restaura combinações e escuta eventos, mas não liga o registro nativo do PTT. O Rust inicia apenas com o rótulo da tecla; o registro ocorre em `set_push_to_talk`.

**Efeito:** ao reabrir com PTT salvo, a interface exige segurar uma tecla que não está registrada. Erros ao registrar a tecla são convertidos em `null` pela ponte, enquanto o estado visual já mudou.

**Correção:** restaurar e confirmar o estado nativo no boot; só anunciar PTT funcional depois do registro. Mostrar erro e manter um estado coerente se houver conflito com outro programa.

### F09 — P1 para uso entre redes — O build local continua sem TURN

**Configuração confirmada no ambiente local; necessidade em cada rede não medida.** [config.ts](<C:/Tudão/Projetos/voxa/src/lib/config.ts>) suporta TURN, mas o `.env` usado no instalador local não o configura. STUN não oferece relay quando o caminho direto não funciona. Um relay é necessário em situações em que os pares não conseguem estabelecer conexão direta. [Documentação WebRTC](https://webrtc.org/getting-started/turn-server).

**Relação com o relato:** `connecting` sem mídia é compatível com falha de ICE, mas o diagnóstico antigo não identifica a causa conclusivamente. Não atribuo o problema de vocês exclusivamente ao NAT. Os valores de secrets do release público não foram inspecionados nesta auditoria.

**Correção:** prover TURN com credenciais temporárias, testar alocação e tráfego forçado por relay, incluindo alternativa TCP/TLS apropriada. Não embutir uma senha permanente de infraestrutura em `VITE_*`: esses valores entram no aplicativo distribuído. Limitar quota/expiração e informar falha de relay sem mostrar credenciais.

## Outros defeitos de funcionamento

### F10 — P2 — Corrigir a senha não reativa a reconexão automática

**Reproduzido com Signaling real e socket controlado.** [signaling.ts:177](<C:/Tudão/Projetos/voxa/src/lib/signaling.ts:177>) desliga `reconnection` após senha errada; a próxima tentativa não volta a ligá-la. Observado: login correto, socket conectado, reconexão automática ainda desabilitada. Os listeners persistentes também capturam dados da primeira tentativa e o timeout não remove o listener `once("connect")` que sobrou.

**Correção:** separar listeners permanentes dos callbacks de cada tentativa; guardar identidade/token atuais; limpar callbacks e timers vencidos; restaurar a política de reconexão numa nova tentativa válida.

### F11 — P2 — ICE inválido na fila pode interromper a resposta inteira

**Leitura de código; não reproduzido em rede externa.** [peer.ts](<C:/Tudão/Projetos/voxa/src/lib/rtc/peer.ts>) esvazia `pendingCandidates` antes de aplicar cada candidato. Se um deles falhar, a operação termina antes de `adopt/createAnswer`; os demais já foram retirados. Um candidato antigo de outra geração pode causar uma falha maior que apenas perder aquele caminho.

O watchdog começa em `connecting`; uma negociação que fica em `new`, esperando SDP que nunca chegou, não recebe o mesmo prazo. Após esgotar as tentativas, a interface não oferece um estado terminal claro.

**Correção:** isolar erro por candidato, associá-lo à geração ICE, estabelecer prazo também para a negociação inicial e expor uma tentativa manual de recuperação. Validar formato/tipo de sinais e versão do protocolo.

### F12 — P2 — Diagnóstico pode dizer “NADA” quando há áudio

**Reproduzido com relatório de stats controlado:** mic com 5.000 bytes e som da tela com zero resultam em `audioOutBytes=0`. [stats.ts:45](<C:/Tudão/Projetos/voxa/src/lib/rtc/stats.ts:45>) sobrescreve o contador a cada stream de áudio. O sentido de recepção tem o mesmo padrão.

`lossPct` é calculado apenas para vídeo recebido; não mede a perda de uma chamada só de voz. Zero ou ausência de amostra vira `0ms/0%`, o que parece medição saudável. `micLigado` verifica o track de mixagem, que fica habilitado mesmo quando o ganho do mic está zerado. `collectStats()` pode publicar um snapshot antigo após remoção do peer.

**Correção:** separar voz/tela e envio/recepção por MID/SSRC; usar deltas e indicar “sem amostra”. Identificar o candidate pair selecionado, descartar respostas de gerações anteriores e medir ganho/energia nos pontos certos do pipeline. Isso é necessário para confiar no próximo diagnóstico.

### F13 — P2 — A fila PCM perde posição e contagem ao descartar excesso

**Reproduzido.** Em [filaPcm.ts:46](<C:/Tudão/Projetos/voxa/src/lib/filaPcm.ts:46>), após remover o primeiro bloco, a condição `blocos.length===0` é impossível naquele laço, pois ele exige mais de um bloco. Assim, a posição parcial não é descontada corretamente nem zerada.

**Observado:** após consumo parcial e descarte, deveriam restar 8 quadros; o contador mostra 6 e a leitura continua deslocada no bloco seguinte. Pode produzir cortes em situações de acúmulo. Um bloco único acima do teto também não é limitado pelo laço.

**Correção:** subtrair apenas a parte não consumida do bloco retirado, zerar a posição ao mudar a cabeça e definir comportamento para um bloco grande. Cobrir fragmentação, overflow após consumo parcial e muitas horas de operação.

### F14 — P2 — Fonte “ativa” pode ser apenas a fonte salva para depois

**Leitura de código.** [SharePicker](<C:/Tudão/Projetos/voxa/src/components/SharePicker.tsx>) usa `getCaptureSource()` como fonte ativa. [capture.rs](<C:/Tudão/Projetos/voxa/src-tauri/src/capture.rs>) devolve o arquivo salvo, embora as flags do processo continuem com a escolha do boot.

**Gatilho:** escolher outra janela, clicar “Depois”, reabrir o seletor e selecionar a mesma janela salva. A UI considera a escolha ativa e inicia captura usando o processo antigo. Títulos variáveis/duplicados e seleção por trecho do título acrescentam ambiguidade; a lista só oferece um monitor genérico.

**Correção:** distinguir fonte vigente no processo e preferência para o próximo boot. Antes de transmitir, apresentar prévia e confirmação da fonte efetiva. Evoluir a captura para um identificador estável e seleção nativa por janela/monitor.

### F15 — P2 — A opção de som não é um verdadeiro liga/desliga

**Leitura de código.** [transmissao.ts:67](<C:/Tudão/Projetos/voxa/src/lib/transmissao.ts:67>) começa com o áudio de `getDisplayMedia`; desmarcar “Compartilhar som do computador” apenas evita o WASAPI. Se o navegador entregar áudio, ele ainda é enviado. O texto de Settings explica troca de fonte, mas o checkbox do seletor comunica desligamento.

O WASAPI captura a saída padrão escolhida ao abrir, não necessariamente o dispositivo onde o jogo está tocando. Não há acompanhamento da mudança do dispositivo padrão nem recuperação automática de remoção. Capturar todas as aplicações inclui o próprio Voxa e pode devolver a fala dos participantes. A exclusão entre tela e câmera também usa travas separadas e verificações anteriores ao `await`, permitindo aberturas concorrentes.

**Correção:** separar “enviar som” de “fonte do som”; desativado deve anexar `null`. Expor a saída efetivamente capturada, acompanhar mudanças e preferir captura por processo com exclusão do próprio aplicativo quando disponível. Unificar a transição tela/câmera. A extensão de eco e problemas de dispositivo depende de teste físico.

### F16 — P2 — Carregar histórico pode apagar mensagens recebidas ao vivo

**Duas reproduções.** [chat.ts:31](<C:/Tudão/Projetos/voxa/src/lib/chat.ts:31>) substitui a lista quando a consulta termina; [store.ts:210](<C:/Tudão/Projetos/voxa/src/store/store.ts:210>) não faz merge. A mensagem recebida durante a espera desaparece da lista. Se uma mensagem de outro canal já chegou antes de abri-lo, a existência da lista faz o histórico nem ser consultado.

**Correção:** estado de carregamento independente da lista, merge por identidade persistente e ordenação estável. Cachear sucesso, não simplesmente “existe array”. Evitar resposta tardia alterar uma navegação posterior.

### F17 — P2 — Histórico não se recupera completamente após falha inicial

**Leitura de código.** [supabase.ts:224](<C:/Tudão/Projetos/voxa/src/lib/supabase.ts:224>) preenche o mapa slug→UUID apenas em `loadChannels()`, chamado no login. Se essa chamada falha, o retry do cliente após 30 segundos não repopula automaticamente o mapa. Salvar/carregar mensagens continua retornando sem ação por UUID ausente.

Erros de leitura devolvem `[]`, indistinguível de canal vazio; `loadOlder` pode registrar “fim do histórico” após uma falha temporária. O indicador “ok” depende do ingresso na guilda, não de consultas e gravações posteriores. O login ainda espera consultas opcionais ao Supabase antes de conectar ao signaling, sem prazo próprio nessa etapa.

**Correção:** retorno com sucesso/erro explícito, retry coordenado de autenticação + canais + histórico, feedback de persistência real e isolamento do histórico opcional do ingresso na chamada. Ao trocar token, invalidar a tentativa de autorização anterior.

### F18 — P2 — Chat ao vivo e banco não compartilham identidade e confirmação

**Leitura de código.** [saveMessage](<C:/Tudão/Projetos/voxa/src/lib/supabase.ts:307>) não salva `msg.id`; o banco cria outro UUID. `prependMessages` só deduplica por ID. Paginar uma conversa que mistura mensagens ao vivo e persistidas pode repetir conteúdo. O horário local difere do horário do banco; paginação apenas por `created_at < cursor` pode perder empates.

O cliente mostra a mensagem e dispara signaling/persistência independentemente, sem ACK de entrega. O servidor corta texto em 2.000 caracteres; o composer não limita o tamanho e o banco rejeita o original grande. Como o eco com o mesmo ID é descartado, o autor pode ver um texto diferente do recebido pelos outros. Os limites de taxa do banco (15/10s) e do chat (8/5s) também divergem.

**Correção:** UUID único de ponta a ponta, timestamp autoritativo, confirmação/erro/reenvio idempotente e um limite compartilhado. Paginação com `(created_at,id)`. Distinguir “mostrada localmente”, “aceita pelo servidor” e “salva no histórico”.

### F19 — P2 — A política de perfis pode esconder os demais autores

**Conclusão da leitura dos scripts; depende de `hardening-2.sql` estar aplicado.** [hardening-2.sql:70](<C:/Tudão/Projetos/voxa/supabase/hardening-2.sql:70>) tenta comprovar sala compartilhada fazendo join entre duas referências de `room_members`. A política dessa tabela só permite ler a própria associação. Assim, o alias `outro` também fica limitado ao usuário atual e não comprova o perfil de outra pessoa.

Como a view usa `security_invoker` e `left join`, a mensagem pode continuar visível com autor “desconhecido”. Esta conclusão segue o comportamento documentado de execução das expressões de policy com os privilégios do consulente; não é resultado de consulta ao banco implantado. [PostgreSQL — Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

**Correção:** função pequena e restrita para verificar associação compartilhada, com contexto apropriado, `search_path` fixo e grants mínimos; teste com dois usuários normais e um não membro. Consultar como administrador não valida RLS.

### F20 — P2 — Token da sala não protege os anexos como protege o histórico

**Confirmado nos scripts; aplicação em produção não verificada.** [attachments.sql:64](<C:/Tudão/Projetos/voxa/supabase/attachments.sql:64>) cria bucket público; a policy de SELECT é pública e permite também listar metadados via API conforme os grants do Storage. Upload exige autenticação e pasta própria, mas não associação à guilda. Autenticação anônima não equivale a conhecer o token do Voxa.

**Efeito:** conhecer a URL basta para ler um anexo. Uma sessão anônima sem convite pode satisfazer a policy de upload. O limite de 8 MB por arquivo não limita o consumo total. Arquivos enviados cujo chat falhou podem virar órfãos, sem limpeza/retensão prevista.

**Correção:** bucket privado se anexos forem parte da conversa privada; URL temporária ou download autenticado; autorização por sala no upload/leitura; quota por usuário e limpeza de órfãos. A necessidade de exibir uma imagem não exige bucket público.

### F21 — P2 — Rotacionar o token não revoga membros antigos do banco

**Leitura de código.** [fechar-historico.sql:109](<C:/Tudão/Projetos/voxa/supabase/fechar-historico.sql:109>) inscreve permanentemente o usuário nas salas. Uma tentativa posterior com token errado retorna falso, mas não revoga associação prévia. A identidade persistida pode continuar autorizada pelas policies.

O limite de tentativas é por usuário anônimo e não resolve múltiplas identidades; a leitura e atualização do timestamp não são uma trava atômica. O rate limit de mensagens no banco também é uma contagem sem serialização, sujeita a concorrência. Esses controles devem ser descritos como redução de abuso, não como impedimento absoluto.

**Correção:** modelo explícito de convite/revogação, sessão/associação com validade quando apropriado e limite atômico. Se todos são amigos com a mesma senha, documentar esse modelo; salas reservadas a subconjuntos exigem autorização adicional também no signaling/chat ao vivo.

### F22 — P2 — Falha ao trocar atalho remove a combinação anterior

**Leitura de código.** [hotkeys.rs:238](<C:/Tudão/Projetos/voxa/src-tauri/src/hotkeys.rs:238>) remove e desregistra o atalho antes de validar/registrar o novo. Se o novo for inválido ou estiver ocupado, retorna erro sem restaurar o anterior; o status pode continuar exibindo o rótulo antigo. A UI promete justamente que ele será mantido.

Remover o atalho de falar não limpa `talk_code`; ligar PTT pode recriar a tecla antiga. O registro do PTT também não verifica conflito com outra ação antes de desregistrar a combinação.

**Correção:** transação de troca com rollback, estado único para tecla configurada/registrada e teste de conflito entre ações. Durante troca, soltar qualquer estado de PTT pressionado. No navegador, atalhos locais fixos também devem respeitar a configuração escolhida.

### F23 — P2 — Overlay perde indicação remota quando o app fica escondido

**Leitura de código.** [mesh.ts](<C:/Tudão/Projetos/voxa/src/lib/rtc/mesh.ts>) para a detecção remota de fala com `document.hidden`. O overlay depende desse estado e existe justamente para uso com o jogo em primeiro plano. O microfone local segue outro detector, de modo que o indicador pode funcionar para si e falhar para os demais.

[Overlay.tsx](<C:/Tudão/Projetos/voxa/src/components/Overlay.tsx>) emite “pronto” sem aguardar as promessas dos listeners. Há também listeners assíncronos cuja limpeza pode ocorrer antes de o registro terminar. `hydrate()` não é idempotente e o StrictMode de desenvolvimento pode repetir registros.

**Correção:** manter detector necessário ao overlay enquanto ele estiver ativo; handshake de prontidão após listeners instalados e limpeza que trate desmontagem durante o `await`. Validar desligar/religar, minimizar, jogo em borderless e monitores com DPI diferente. A janela fixa de 360 px pode cortar listas maiores.

### F24 — P2 — Preferências inválidas e debounce comprometem coerência

**Corrida de identidade reproduzida; demais pontos por leitura.** [prefs.ts:72](<C:/Tudão/Projetos/voxa/src/lib/prefs.ts:72>) gera IDs distintos a cada leitura sem armazenamento existente. Se o primeiro login acontece antes dos 400 ms da gravação do perfil, a Session usa um ID diferente do que será salvo. Isso afeta identificação/volume na próxima abertura; não acontece necessariamente em todo primeiro login.

JSON corrompido retorna defaults com `userId` vazio. Não há validação de enums, tipos, limites de volume ou migração de versão. Um preset desconhecido pode levar a acesso de propriedade de `undefined`. Leituras de hotkeys usam `loadPrefs` mesmo durante a janela de debounce e podem sobrescrever uma alteração recente.

**Correção:** hidratar/gerar identidade uma vez, usar cache atual, validar e migrar o objeto persistido, recuperar defaults por campo e garantir gravação final das preferências essenciais. Não tratar casts TypeScript como validação de JSON.

### F25 — P2 — Falha de atualização aparece como “última versão”

**Leitura de código.** [desktop.ts](<C:/Tudão/Projetos/voxa/src/lib/desktop.ts>) retorna `null` tanto sem versão nova quanto com erro de rede, endpoint ou assinatura. [session.ts:642](<C:/Tudão/Projetos/voxa/src/lib/session.ts:642>) informa “Você já está na última versão” na consulta manual em todos esses casos.

O workflow de release publica sem executar/aguardar os testes do CI para o mesmo commit. O ajuste de `latest` consulta o rótulo depois de publicar; se a própria publicação já alterou o rótulo, a comparação pode não recuperar a maior versão. Falta serialização entre releases e verificação tag↔versão. `workflow_dispatch` também usa o nome da referência como tag.

**Correção:** estados distintos de atualização, erros visíveis na consulta manual e diagnóstico; release condicionado à validação exata do commit; validar versões, controlar concorrência e promover explicitamente apenas a release aprovada. Testar atualização real de uma versão anterior e instalação em Windows limpo.

### F26 — P2 — Proteções do WebView e anexos precisam ser estreitadas

**Risco de defesa em profundidade; não encontrei XSS executável no renderer de texto.** [tauri.conf.json](<C:/Tudão/Projetos/voxa/src-tauri/tauri.conf.json>) desliga CSP. [webview.rs](<C:/Tudão/Projetos/voxa/src-tauri/src/webview.rs>) concede câmera/microfone sem checar a origem solicitante. A justificativa no comentário (“é a origem local”) não é uma verificação.

O signaling aceita URL HTTPS arbitrária de anexo e o cliente carrega imagens automaticamente. O caminho de histórico confia nos campos do banco sem repetir validação de URL/MIME; o schema não impõe a mesma regra HTTPS do signaling. Isso amplia risco de rastreamento por imagem e links indesejados, sem provar execução de código.

**Correção:** CSP compatível com WASM/worklets, origens de mídia/conexão restritas, validação de origem antes de conceder permissões, navegação externa controlada e validação comum de anexos no servidor/banco/renderer. Não dar ao overlay comandos além dos necessários; revisar também comandos customizados, não apenas a lista de plugins.

### F27 — P2 — Qualidade e custo de transmissão podem divergir da UI

**Leitura de código.** [tuning.ts](<C:/Tudão/Projetos/voxa/src/lib/rtc/tuning.ts>) engole erros de `setParameters`; o `catch` externo do Peer não os verá. Não há retry garantido daquela configuração. A adaptação usa perda do vídeo recebido para decisões sobre o vídeo enviado, e os campos FPS/codec misturam sentidos. Decoder por hardware também pode fazer o indicador concluir “GPU” para encoder por software.

Todos os peers recebem vídeo e áudio de transmissão, mesmo sem clicar “Assistir”. O piso de bitrate impede manter o teto total para muitos pares: no preset Alta, 10 receptores permitem 10 × 2,5 = 25 Mbps de vídeo, acima dos 15 Mbps anunciados. Falta teto de participantes e orçamento que reserve voz e margem da rede.

**Correção:** aplicar e confirmar parâmetros, métricas separadas por direção e testes de adaptação. Assinatura explícita de transmissão por espectador, teto real de upload e resolução adequada. Preservar full mesh para grupos pequenos; avaliar SFU quando medidas de carga e tamanho das salas justificarem a mudança.

### F28 — P2 — Dispositivo real pode mudar sem a interface perceber

**Leitura de código.** [media.ts](<C:/Tudão/Projetos/voxa/src/lib/media.ts>) tenta o dispositivo solicitado e, diante de qualquer erro, volta a `audio:true` ou `video:true`. Pode abrir outro dispositivo padrão enquanto Settings mostra a escolha anterior. O microfone não possui tratamento equivalente ao `onended` da câmera para remoção do aparelho.

**Correção:** distinguir erro de constraints, permissão e dispositivo; fallback explícito e atualizar o dispositivo efetivo. Tratar `devicechange/ended`, seleção de saída indisponível, Bluetooth, sleep/resume e falha de `AudioContext`. A UI deve exibir o dispositivo capturado/reproduzido, não apenas o selecionado.

## Acabamento, operação e riscos de crescimento

### F29 — P3 — Chat e acessibilidade ainda perdem ações do usuário

**Leitura de código.** [ChatPanel](<C:/Tudão/Projetos/voxa/src/components/ChatPanel.tsx>) apaga o rascunho após `sendChat` mesmo quando o Chat recusa por flood; também limpa a legenda antes de saber se o upload funcionou. Falta estado de entrega e limite de caracteres. A lista reutilizada entre canais conserva estado de scroll; uma consulta antiga pode mexer no scroller do canal novo.

`prependMessages` cresce sem teto, embora o comentário prometa 300 mensagens; uma nova mensagem depois pode cortar páginas antigas de uma vez. O mapa de digitação não expira entradas, mantendo seu timer após a primeira atividade e crescendo com nomes/canais. Imagens não têm carregamento preguiçoso nem tratamento visível de falha.

Modais não têm foco preso/restaurado e semântica completa de diálogo; vários controles só de ícone carecem de nome acessível. O status “Voz conectada” depende da escolha de canal, não de mídia conectada. A lista com rolagem e imagens deve ser testada em 940×620 e escala 125–200%.

**Correção:** preservar rascunho até aceitação, rascunho por canal, paginação com cache limitado/virtualização e estados de conexão reais. Revisão de teclado, leitor de tela, foco, contraste e áreas clicáveis.

### F30 — P3 — Soundboard precisa de limite de duração e encerramento

**Leitura de código.** [soundboardCustom.ts](<C:/Tudão/Projetos/voxa/src/lib/soundboardCustom.ts>) limita bytes e número de sons, mas não duração decodificada, memória PCM ou sobreposição de reprodução. Um arquivo pequeno comprimido pode virar muitos minutos de áudio em memória. Não existe comando para parar todos os efeitos.

O limite de quantidade é verificado fora da transação de gravação; duas importações concorrentes podem ultrapassá-lo. A promessa do IndexedDB resolve no sucesso da requisição, antes da confirmação da transação, sem tratar adequadamente abort/close em erro.

**Correção:** limite de duração e simultaneidade, botão “parar efeitos”, parar fontes ao sair da sessão, cache de áudio limitado e confirmação em `tx.oncomplete` com limpeza em erro/abort. Avaliar se sons de interface devem respeitar a saída escolhida e o ensurdecimento.

### F31 — P2 — Validação de distribuição ainda não é uma barreira suficiente

**Constatação de processo e configuração.** O script local resolve a DLL para o caminho NSIS GNU, mas não substitui teste de instalação/update/desinstalação em máquina limpa. `--bundle-only` pressupõe um executável previamente compilado compatível; não confirma conteúdo/configuração do binário. O comando padrão `app:build` continua distinto do caminho local que acrescenta a DLL.

Builds locais e releases usam configurações diferentes de Supabase/TURN e a mesma versão pode identificar artefatos diferentes. O instalador local não possui Authenticode. Falta manifesto de build com commit, hash e capacidades — sem segredos — para identificar exatamente o que foi instalado.

**Correção:** caminho único ou perfis explicitamente identificados, teste do bundle minificado/worklets, inspeção de dependências nativas e smoke test do pacote instalado. Release de teste com identidade distinta evita confusão com release pública de mesma versão. Validar os testes de frontend em Windows e manter lockfiles, inclusive `npm ci` no deploy do servidor.

### F32 — P2/P3 — Operação e documentação têm garantias maiores que a evidência

**Leitura de código e documentos.** O servidor mantém estado só em memória; múltiplas instâncias não compartilham Registry/rooms. O limite por IP depende de confiar em proxy privado e no primeiro `X-Forwarded-For`, sem lista de proxies confiáveis. Há limites por conexão, mas sem teto global de participantes/memória. O endpoint público de health inclui nomes de canais de voz do `summary`; não contém apenas indicadores agregados.

`uncaughtException` mantém o processo em execução após erro desconhecido, sem avaliar se o estado foi comprometido. Na camada desktop, fechar a janela sempre esconde: se criar a bandeja falhar, não há caminho equivalente de saída pela bandeja. `EmptyWorkingSet` exige avaliação de latência/page faults, pois baixar o número de memória residente não demonstra menor custo durante o jogo; a varredura atual alcança apenas filhos imediatos.

Documentos antigos tratam correções parciais como completas, sugerem copiar o token para `VITE_ROOM_TOKEN` em comentário do `render.yaml` e fazem afirmações como “TURN funciona sempre”, “GPU/CPU perto de zero”, “nunca trava” e percentuais de falha sem medição do projeto. Essas promessas não devem orientar decisão de arquitetura ou suporte.

**Correção:** health agregado, métricas de sucesso/tempo para conectar e término de chamada, política de restart supervisionado, teste de limites reais e configuração explícita de proxy. Revisar documentação, remover instrução de embutir senha e publicar apenas capacidades medidas. Não há necessidade imediata de distribuir o servidor entre várias instâncias para um grupo pequeno, mas o deploy precisa declarar essa limitação.

## O que eu manteria

- Separação de transporte, Peer, Mesh, captura e UI; facilita testar regras isoladamente e corrigir sem reescrever tudo.
- Áudio remoto independente dos tiles de vídeo, com volumes separados de voz e transmissão.
- Renderização de texto pelo React, sem montagem de HTML de mensagens.
- Autenticação antes de entrar na sala de broadcast, limites de payload/evento e logs que evitam registrar SDP/conteúdo.
- Testes de negociação em Chromium real, particularmente colisão de ofertas e restart simultâneo. Devem ser ampliados, não descartados.
- Lockfiles, ações presas por SHA, assinatura configurada para o updater e diagnóstico local copiável.
- Supabase opcional e um servidor de signaling pequeno. Não reescreveria tudo nem mudaria de framework como resposta a esses bugs.

## O que eu adicionaria, em ordem

| Ordem | Entrega | Critério verificável |
|---|---|---|
| 1 | Máquina de estados da sessão e dono único das capturas | Sair/cancelar impede qualquer continuação antiga; câmera e mic encerram; mudo nunca diverge do ganho efetivo. |
| 2 | Autorização de canal e contrato de signaling | Outro canal, peer próprio, mensagem antiga e payload inválido não criam uma conexão autorizada. Toda operação conclui ou expira com erro visível. |
| 3 | Worklet de produção validado e relay utilizável | Amostras de som atravessam o caminho PCM real; teste forçado por TURN envia e recebe áudio. |
| 4 | “Testar áudio” antes da chamada | Medidor de captura, reprodução de um som de teste, identificação da saída e resultado por etapa: captura → processamento → envio → recepção → reprodução. Sem gravar conversas. |
| 5 | Diagnóstico confiável de chamada | Eventos por geração, métricas separadas por trilha, erro de worklet/encoder e tempo sem mídia. Exportação com remoção de tokens, IPs e conteúdo. |
| 6 | Chat com confirmação e histórico consistente | Mesmo ID em tempo real/banco, retry sem duplicar, rascunho preservado e recuperação após banco temporariamente indisponível. |
| 7 | Distribuição reproduzível | Identificador do build, testes obrigatórios do commit publicado, instalação/upgrade em Windows limpo e um canal de teste separado. |
| 8 | Captura por janela/processo e audiência explícita | Prévia da fonte, seleção sem confusão entre salvo/ativo, som do jogo sem devolver a chamada, tráfego de vídeo apenas para quem solicitou. |
| 9 | Acabamento acessível | Fluxos principais completos por teclado, foco correto em modais, rascunhos e status de erro persistentes. |
| 10 | Escala orientada por medidas | Ensaios com 2/4/8 participantes e sessões de horas; decidir sobre SFU depois de medir CPU, upload, qualidade e custo do relay. |

Eu adiaria gravação de chamadas, bots, integrações, novos efeitos, múltiplos servidores e recursos de administração extensos até as três primeiras entregas estarem cobertas. O ganho mais importante agora é conseguir entrar, falar, ouvir, compartilhar e sair com previsibilidade.

## Plano de correção e validação

**Lote A — bloquear falhas de privacidade:** F02–F06 e regras de mudo/PTT. Testar início/cancelamento em cada `await`, troca rápida de canal, duas aberturas simultâneas, saída com câmera e operações de geração anterior. Todos os tracks descartados devem terminar e nenhum peer não autorizado deve receber mídia.

**Lote B — fechar o caminho de áudio:** F01, F07–F15 e F28. Usar o build final minificado, amostras conhecidas no worklet, deteção de erro do processador, rede local e relay, silêncio seguido de som e troca de dispositivos. Manter testes de glare/restart existentes.

**Lote C — recuperar consistência:** F16–F24, F29–F30. Testar chat concorrente com carregamento, offline/reconexão, persistência recusada, duas identidades em RLS, anexo sem legenda, upload de não membro, preferências corrompidas e falha de registro de atalho.

**Lote D — tornar release verificável:** F25–F27 e F31–F32. Gate do commit exato, smoke do aplicativo instalado e migração da versão anterior, build identificável, teste de 2/4/8 participantes e desempenho com a janela escondida. Dados reais e serviços externos somente em ambiente autorizado para validação.

## Limites para interpretar o problema original

O erro da DLL era um problema de empacotamento e foi tratado no instalador de teste. A falha do worklet agora é uma causa concreta adicional do som de sistema ausente nesse build. A comunicação de voz entre você e seu amigo ainda não tem uma causa única comprovada: o código contém falhas de negociação/estado e o build local não tem relay, mas não há coleta equivalente das duas pontas na rede real.

Portanto, o resultado desta etapa é **um diagnóstico técnico com defeitos reproduzidos e plano de correção**, não uma declaração de que a chamada já funciona. As alterações criadas nesta auditoria são o relatório e ferramentas de reprodução; as novas correções de produto listadas acima continuam pendentes.
