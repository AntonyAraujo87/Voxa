# Voxa — revisão completa

Da v0.4.0 até a **v0.5.5**. Doze versões publicadas.

---

## O que você precisa fazer

### 1. Rodar dois SQL no Supabase (nesta ordem)

Os dois **foram testados de verdade** num projeto Supabase descartável, com o mesmo schema da produção — não são mais "revisados no papel". O teste achou um erro que teria sido grave; está descrito embaixo.

**Agora — `supabase/hardening.sql`.** Não muda comportamento nenhum. Contém uma correção importante: hoje **imagem enviada sem legenda some do histórico** (o banco exige texto com pelo menos 1 caractere e recusa em silêncio).

*Verificado:* o bug foi reproduzido antes e sumiu depois. Mensagem só-anexo passa a ser aceita, vazia sem anexo continua recusada, e o teto de 2000 caracteres continua valendo — 6 casos, 6 corretos.

**Depois que todo mundo estiver na v0.5.5 — `supabase/fechar-historico.sql`.** Troque `COLE-AQUI-O-VOXA-TOKEN` pelo token real do Render antes de rodar. Quem estiver desatualizado nesse momento perde só o *histórico* (o chat ao vivo continua) e recupera ao atualizar. Nada é apagado.

*Verificado:* `join_guild` acerta os 8 casos (token certo, errado, freio de força bruta, sessão ausente, chamada repetida). Lendo como o app lê — role `authenticated`, JWT real, RLS ligada — quem não é membro vê **0 salas e 0 mensagens**, e passa a ver as 6 salas depois de entrar com a senha certa. Tentar ler o hash da senha por fora dá `permission denied`.

### 2. Apagar o projeto `voxa-teste-migration` no Supabase
Ele voltou a responder e serviu para validar os dois SQL acima. Já está limpo e pausado — pode apagar pelo painel quando quiser, para liberar 1 dos 2 slots grátis.

### 3. Testar no app instalado o que só o app instalado confirma
- **Overlay** — ligue, abra um jogo em borderless. E teste desligar e religar (era justamente o que estava quebrado).
- **Áudio do sistema** — `Configurações → Fonte de captura → Áudio do sistema`, compartilhe um jogo e pergunte se te ouvem.
- **Copiar diagnóstico** — o botão em Configurações; deve copiar um texto com versão, sistema e erros.

### 4. Decidir sobre o TURN
Continua sendo **a maior melhoria disponível** e não depende de código: 10–15% das conexões não fecham sem ele (NAT simétrico, internet móvel). `coturn` numa VM Always Free da Oracle resolve de graça. O app já suporta — falta o servidor.

---

## Bugs encontrados e corrigidos

### Segurança

**Chat vazava para quem não sabia a senha.** `socket.join(GUILD)` acontecia na *conexão*, não no `hello`. Qualquer um abria o socket, ficava calado, e recebia o chat inteiro e a lista de online por até 20s — sem nunca provar que sabia o token. Reconectando em loop, escuta contínua. *(v0.4.1)*

**Limite por IP era contornável.** `x-forwarded-for` era lido sempre; quem alcançasse o processo fora do proxy forjava um IP a cada conexão. Agora só vale vindo de endereço privado, sem variável de ambiente para alguém esquecer. *(v0.4.1)*

**Histórico do chat legível por qualquer um** que extraia a `anon key` do instalador — ela é pública por definição. As duas pontas implementadas: o banco guarda só o *hash* da senha e `join_guild` inscreve quem provar conhecê-la. *(v0.4.3, falta rodar o SQL)*

### Conexão e áudio

**Candidatos ICE morriam em rede ruim.** Sinais do mesmo par eram processados concorrentes — `addIceCandidate` podia rodar antes do `setRemoteDescription` anterior terminar. Cada candidato perdido é um caminho a menos: em rede boa não se nota, em rede ruim é *conectar ou não conectar*. *(v0.4.1)*

**Cada som deixava um node no grafo de áudio, para sempre.** O oscilador some sozinho, mas o ganho ligado ao destino não é coletado. Pior nos avisos (tocam a cada pessoa entrando/saindo) e no soundboard (4 a 14 nodes por efeito). Medido: dois efeitos acumulavam 18 nodes; agora voltam a zero. *(v0.5.2)*

**Imagem sem legenda sumia do histórico.** Aparecia ao vivo e desaparecia depois — o insert batia num check do banco e falhava sem deixar rastro, porque o supabase-js devolve `error` em vez de lançar, e o código não olhava. *(v0.5.3)*

### Interface e estado

**Religar o overlay não funcionava.** O handler de janela roda para *todas* as janelas e chamava `prevent_close` no overlay também: ao desligar, a janela só sumia sem deixar de existir, e religar caía num early-return. Ficava quebrado até reiniciar o app. *(v0.5.2)*

**Microfone abria sozinho depois de sair do canal com push-to-talk.** O keyup se perde quando a janela perde foco — que é exatamente o que acontece ao voltar pro jogo. `talking` ficava preso e no canal seguinte a pessoa era ouvida sem saber. *(v0.5.4)*

**Câmera sem imagem travava o botão.** Driver que aceita o pedido e não entrega vídeo deixava a câmera "ligada" por dentro e desligada na tela — o clique seguinte desligava em vez de ligar. *(v0.4.2)*

**Transmissão perdia o tipo ao reconectar** — câmera virava ícone de monitor. *(v0.4.2)*

**Anel de "falando" ficava aceso para sempre** se a janela sumisse na hora certa. *(v0.4.1)*

**Leak de listener no seletor de cor** — `pointercancel` não era tratado, e gesto cancelado pelo sistema nunca dispara `pointerup`. *(v0.4.1)*

### Infraestrutura

**Ninguém estava recebendo a v0.5.4.** O auto-update lê `/releases/latest/download/latest.json`, e quem decide o que é "latest" é o GitHub: por padrão a **última release publicada**, não a de maior versão. As tags v0.5.3 e v0.5.4 subiram quase juntas, a v0.5.3 terminou de compilar 2 minutos depois e ficou com o rótulo. Todo mundo travado na 0.5.3 — justamente sem o fix do microfone que abria sozinho — e sem nenhum sinal de erro em lugar nenhum. O workflow agora promove a release no fim, comparando versões para não rebaixar uma mais nova. *(v0.5.5)*

**`join_guild` estouraria a cada chamada, calado.** `fechar-historico.sql` usava `digest()` do pgcrypto dentro de uma função com `set search_path = public` — e no Supabase o pgcrypto mora no schema `extensions`, então ali dentro a função não existe. Pior: a mensagem de erro (`function digest(text, unknown) does not exist`) casava com o filtro do cliente para "a função ainda não foi criada", e o cliente só olhava a mensagem. Ninguém entraria em `room_members` e o histórico de todo mundo sumiria sem uma linha de aviso. Agora usa `sha256()`, que é do próprio Postgres e não depende de `search_path`, e o cliente só ignora o erro quando ele é de fato `PGRST202`. *(v0.5.5)*

**CI estava quebrado** e passou despercebido porque o workflow de release não roda testes: faltou `cargo fmt`, e os testes em TypeScript não rodavam no Node 20 do CI. Ambos os workflows foram para Node 24. *(v0.5.1)*

---

## O que foi adicionado

**Áudio do sistema (WASAPI loopback).** O áudio da transmissão vinha do `getDisplayMedia`, que no WebView2 com jogo em tela cheia normalmente entrega **nada**. Agora dá para capturar direto o que a placa está tocando. Thread própria no Rust → blocos de 20 ms → Channel do Tauri em bytes crus → AudioWorklet → track normal na malha. Opcional e desligado por padrão; falhar não cancela a transmissão. *(v0.5.0)*

**Diagnóstico copiável.** Antes, "deu erro aqui" era toda a informação disponível quando algo quebrava na máquina de outra pessoa — o console do WebView2 fica atrás de um menu escondido e panic do Rust morria com o processo. Agora há buffer de erros, hook de panic gravando em arquivo, e um botão que junta tudo num texto. Nada é enviado a lugar nenhum. *(v0.4.5)*

**58 testes** (eram 32). Cobrem o que quebra **calado**: SDP mal montado não lança nada — o navegador ignora o que não entendeu e a chamada só fica ruim. Também a fila de áudio, onde erro vira estalo ou atraso que ninguém sabe explicar.

Um teste já se pagou: recusou `parameter properties` no construtor da fila, que o Vite aceitaria e o AudioWorklet não.

---

## Refatoração

| Arquivo | Antes | Depois |
|---|---|---|
| `session.ts` | 823 | ~700 |
| `SettingsModal.tsx` | 581 | 359 |

Saíram: `lib/chat.ts` (regra de chat, não depende de mídia nenhuma), `settings/HotkeysSection.tsx` (única seção com máquina de estado própria), `settings/Primitives.tsx`, `lib/filaPcm.ts` (fila de áudio, agora testável).

A fila de PCM merece nota: o AudioWorklet não aceita `import`, então o código vai por `toString()`. Antes vivia dentro de uma string — impossível de testar. Agora é uma classe normal, com um teste que garante que o `toString()` continua gerando JavaScript válido: se ela passasse a depender de um helper do compilador, o worklet quebraria em runtime sem nenhum erro de tipo.

---

## Auditado e correto (não mexi)

- **XSS**: zero `innerHTML`, zero `dangerouslySetInnerHTML`, zero `eval`.
- **Logs**: nenhum log de token, senha, chave ou IP.
- **Servidor**: limite por evento e por IP, `safeEqual` em tempo constante, teto de payload, sanitização de caracteres de controle **e de marcas bidirecionais** (as que permitem forjar visualmente a autoria de uma mensagem).
- **GitHub Actions**: actions presas por SHA de commit — proteção real contra supply chain, já que tag `@v4` é mutável e quem controla a action rodaria código junto da sua chave de assinatura.
- **React**: zero seletores Zustand criando objeto novo a cada render.
- **Dependências**: `npm audit` → 0 vulnerabilidades.
- **RAM**: `EmptyWorkingSet` cobrindo também os processos do WebView2, que são a maior parte do consumo.

---

## Próximos passos, por impacto

1. **TURN** — ver acima. Não é otimização, é conectar ou não.
2. **Teto de gente em vídeo** — full mesh: cada um envia N−1 cópias. Com 5+ transmitindo a qualidade despenca em silêncio. Melhor limitar e avisar.
3. **Posição do overlay ajustável** — nasce fixo em (40,40) e não pode ser movido, porque o clique atravessa por design. Precisa de um "modo posicionar".
4. **@menção e reação a mensagem** — social básico que falta; menção justifica notificação nativa, que hoje só pisca a barra de tarefas.
5. **Teste E2E de voz** — os 58 testes cobrem servidor e lógica pura. Dois navegadores com mídia real exigiria Playwright, infra que o projeto não tem; hoje isso é sempre manual.

---

## Limites desta revisão

Coisas que **não** consegui verificar daqui, e que só o app instalado ou o ambiente real confirmam:

- **WASAPI loopback** — precisa de placa de som tocando de verdade. Rust compila e passa clippy, a fila de áudio tem 8 testes, mas o caminho completo é seu para testar.
- **Janela do overlay** — transparência, always-on-top e clique-através são nativos.
- **Copiar diagnóstico** — exige foco de janela real; no navegador automatizado o clipboard recusa.
- **Supabase de produção** — sem acesso ao projeto do Antony; auditei o `schema.sql` do repositório.
- **Render / firewall** — sem acesso ao painel. O `wss://` é garantido pelo Render, que termina TLS.
