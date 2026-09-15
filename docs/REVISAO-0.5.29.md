# Segunda revisão da 0.5.29

9 de setembro de 2026. Revisão das alterações locais, com reprodução de falhas
e correções adicionais. Complementa [CORRECOES-0.5.29.md](CORRECOES-0.5.29.md).

O projeto está mais protegido por testes, mas ainda não está validado para uma
distribuição geral. Cinco defeitos adicionais foram encontrados e corrigidos nesta
rodada. As correções continuam locais; não foi gerado outro instalador nem aplicado
deploy ou migração de banco. A recusa anterior de geração do instalador foi mantida.

## Cinco defeitos encontrados e corrigidos

### R01 — P2 — Confirmação e falha de mensagem eram descartadas

Em `src/store/store.ts`, `pushMessage` retornava sem fazer nada quando já existia
um ID. O chat insere primeiro um eco com `pending=true` e depois envia o resultado
do ACK ou da persistência com o mesmo ID. Esses resultados não chegavam à tela:
“Enviando...” podia permanecer, e uma falha não habilitava o reenvio.

Reprodução com o store real: inserir pendente e depois falha resultou em
`pending=true, failed=false`. Agora a linha existente é atualizada, preservando
um único item e os contadores de não lidas. Um ID coincidente de outro autor não
substitui a mensagem. Reenvio também limpa a indicação antiga de falha de histórico.

Esta descoberta corrige uma avaliação otimista do relatório anterior sobre F18:
o fluxo de ACK havia sido implementado, mas faltava o suporte correspondente no
store real. Os testes anteriores de chat com dependências controladas não detectavam
essa integração. O novo teste carrega o store usado pelo produto.

### R02 — P2 — Pedido para parar envio podia perder para troca pendente

Em `src/lib/rtc/peer.ts`, havia chamadas concorrentes a `replaceTrack`. Durante
uma primeira troca de `null` para vídeo, `sender.track` ainda podia ser `null`.
Se chegasse um pedido de voltar a `null`, a comparação concluía que já estava
correto e o descartava; a primeira operação terminava anexando o vídeo.

Foi reproduzido com a classe Peer e RTCPeerConnection reais no Chrome 152:
antes da correção, `trackAttachedAfterRequestingNull=true`; depois, `false`.
Agora as substituições aguardam a operação anterior e consultam o estado mais
recente. Isso protege transições rápidas de assistir/ocultar e troca de trilhas.
Também foi incluída a limpeza do timer de repetição de parâmetros ao fechar o peer.

A natureza assíncrona e o comportamento de `null` constam da
[documentação de replaceTrack](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/replaceTrack).
Parar uma captura continua encerrando os tracks físicos; o defeito reproduzido
aqui era a aplicação da escolha de envio ao sender.

### R03 — P2 — Timeout de identificação desativava reconexão

Em `src/lib/signaling.ts`, toda falha de `hello` passava por `failLogin`, que
chamava `socket.disconnect()`. Depois de um retorno de rede, um ACK atrasado
podia deixar a sessão offline sem continuar tentando.

Reprodução com o Socket.IO real e resposta de identificação controlada: após
timeout, `socket.active` virava `false`. Agora erros transitórios são separados
de recusa de autenticação: mantêm o socket ativo e programam nova identificação.
A entrada inicial continua limitada pelo prazo total de 45 segundos; senha
inválida continua encerrando a tentativa. Sucesso e encerramento limpam os timers.

O comportamento de desligamento manual é descrito na
[API oficial do Socket.IO](https://socket.io/docs/v4/client-api/#socketdisconnect).

### R04 — P2 — Paginação perdia precisão do horário

O cursor em `src/lib/supabase.ts` passava por `Date.toISOString`, reduzindo a
precisão do PostgreSQL. Por exemplo, `.123500` virava `.123`; uma mensagem
anterior em `.123100` podia ficar fora da página seguinte.

A reprodução em PostgreSQL/PGlite encontrou uma linha com o cursor original e
zero com o truncado. O helper `src/lib/historyCursor.ts` agora valida e preserva
os microssegundos, mantendo o desempate por UUID. O teste usa a fronteira gerada
pelo helper numa consulta SQL real.

### R05 — P2 — Mensagem nova descartava histórico já carregado

Depois de paginar centenas de mensagens, `pushMessage` aplicava novamente o
limite fixo de 300. A reprodução com 700 mensagens caiu para 300 ao receber apenas
uma mensagem nova, descartando centenas de linhas que o usuário acabara de buscar.

Agora a janela ampliada pela paginação é preservada, com teto de 1000 e descarte
gradual. Isso não torna o histórico ilimitado: melhora a continuidade da leitura
sem permitir crescimento sem controle.

## Validação

Resultado final: todas as verificações abaixo passaram. O build de produção e
o teste do AudioWorklet minificado também passaram após as correções.

- A suíte anterior passou antes das reproduções, mostrando as lacunas de cobertura.
- Foram adicionadas sete verificações em `scripts/check-review-regressions.mjs`,
  chamadas por `npm run verify` e, portanto, pelo CI.
- As verificações cobrem atualização/deduplicação do store, preservação da janela
  paginada, substituição assíncrona de trilha, timeout de identificação, recuperação,
  recusa de autenticação e cursor com microssegundos.
- Foram repetidos TypeScript, 104 testes unitários, 14 regressões anteriores,
  10 verificações SQL, quatro cenários WebRTC e sete verificações de interface.
- O teste adicional de Peer usa o Chrome real. O teste de interface usa duas sessões,
  servidor local e mídia sintética. Não representa escuta humana ou WASAPI físico.
- Não houve mudança no Rust nesta rodada; a validação nativa registrada na rodada
  anterior continua sendo a evidência disponível, sem nova instalação/update.

Reproduções anteriores às correções e logs ficam em `work/`; testes permanentes
geram resultado em `test-results/review-regressions.json`. Ambos os diretórios são
ignorados pelo Git.

## Riscos restantes que merecem prioridade

1. **Rede real ainda depende de configuração e teste.** No `.env` local, TURN e
   Supabase estão vazios. O servidor atualizado pode fornecer TURN temporário,
   mas o ambiente hospedado não foi inspecionado nesta revisão. Não se deve
   presumir que as alterações locais já estejam disponíveis para os amigos.
2. **Loopback inclui a saída inteira.** O som do próprio Voxa pode voltar junto
   com o jogo. A captura usa o dispositivo padrão ao iniciar e não acompanha sua
   troca automaticamente. Captura por processo é uma evolução de maior prioridade
   que novos recursos sociais.
3. **Retorno de suspensão e renovação TURN.** A renovação usa intervalo de 45
   minutos e ignora a falha daquela solicitação; uma falha ou suspensão prolongada
   pode deixar credenciais antigas até outra renovação. Falta validar expiração,
   retorno do sistema e tentar renovar com atraso crescente após erro.
4. **Persistência pode falhar depois da entrega ao vivo.** Agora o erro aparece,
   mas não há fila durável de gravação nem garantia de deduplicação entre reinícios
   do servidor. A limpeza de anexos órfãos ainda é administrativa.
5. **Recuperação do microfone e indicadores.** Quando a entrada inicial falha,
   o app marca mudo. Ao recuperar o dispositivo, os avisos ainda podem dizer que
   os outros já ouvem, embora o estado de mudo/PTT continue impedindo voz. O próximo
   ajuste deve tornar o aviso fiel ao estado, preservando a escolha de privacidade.
6. **Desempenho e distribuição.** Ainda faltam carga de 4/8 pessoas, dispositivos
   físicos, jogo em tela cheia, instalação limpa, atualização e desinstalação.

## Melhorias que eu adicionaria, em ordem

| Prioridade | Melhoria | Resultado esperado |
|---|---|---|
| 1 | Assistente “Testar áudio e conexão” | Testar mic, tocar amostra no fone escolhido, indicar mudo/PTT e separar captura, envio, recepção e reprodução |
| 1 | Captura de áudio por aplicativo | Compartilhar o jogo e reduzir retorno da própria chamada; oferecer fallback explícito conforme suporte do Windows |
| 1 | Recuperação após suspensão e expiração de TURN | Renovar credenciais no retorno do sistema e explicar o estado da reconexão |
| 2 | Testes automáticos de falhas no CI | Injetar desconexão, atraso de ACK, troca rápida de dispositivos e início/fim concorrentes |
| 2 | Fila durável de mensagens e persistência | Recuperar pendências após reinício e permitir repetir só a gravação, sem reenviar ao grupo |
| 2 | Prévia confiável da captura | Mostrar o conteúdo efetivo antes de transmitir; evoluir a escolha por título para uma fonte estável |
| 3 | Rotina de retenção de anexos e histórico | Evitar quota cheia e permitir limpeza previsível |
| 3 | Busca no histórico e favoritos | Melhorar uso cotidiano depois de estabilizar comunicação |

A Microsoft oferece um exemplo de
[captura de áudio por processo](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/).
A implementação precisa conferir a versão do Windows e manter um caminho compatível;
a existência da API não comprova que ela já esteja integrada ao Voxa.

Não priorizaria agora SFU, contas/cargos ou uma grande expansão visual. Primeiro
vale estabilizar a chamada real e medir o uso do grupo; esses dados orientam se
a arquitetura precisa crescer.

## O que depende de você

- Quando estiver disponível, testar com seu amigo usando **o mesmo instalador
  novo**, primeiro voz, depois compartilhamento com som. Anotar a etapa que falhou
  e copiar o diagnóstico dos dois lados.
- Para disponibilizar as mudanças, será necessário gerar o pacote e atualizar o
  servidor. A geração do instalador segue pendente da autorização recusada antes.
- Para configurar TURN e o histórico, precisamos de acesso aos ambientes em que
  esses serviços serão operados. O procedimento está em [DEPLOY.md](DEPLOY.md).
  Configurar um endereço de sinalização não provisiona TURN automaticamente.
- Se usar histórico/anexos, distribuir o cliente compatível antes de tornar o
  bucket privado com `audit-3.sql`, validando primeiro em homologação.

Você não precisa editar código para esses ajustes. A participação indispensável
é o acesso aos serviços e o teste físico posterior; o desenvolvimento e os testes
locais podem continuar enquanto você não consegue testar.
