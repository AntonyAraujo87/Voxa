# Voxa — Auditoria de segurança, bugs e arquitetura

Versão auditada: **v0.4.0** → correções publicadas em **v0.4.1**
Escopo: frontend React, signaling Node.js, backend Rust/Tauri, schema Supabase, pipeline GitHub Actions.

---

## Resumo em uma linha

O Voxa estava **melhor do que a média** em segurança (rate limit por evento, comparação de segredo em tempo constante, sanitização até de marcas bidirecionais Unicode, actions do CI presas por SHA de commit). Encontrei **1 vazamento sério**, **2 furos médios**, **3 bugs reais** e **1 risco arquitetural** que exige decisão sua.

---

## 🔴 Achado 1 — Chat vazava para quem não sabia a senha (CORRIGIDO)

**Onde:** `server/lib/handlers.js`
**Gravidade:** alta — confidencialidade quebrada

`socket.join(GUILD)` acontecia na **conexão**, não no `hello`. Estar nessa sala é o que faz um socket receber `roster` e `chat:new`.

Consequência: qualquer pessoa que abrisse a conexão e **ficasse calada** recebia o chat inteiro e a lista de quem está online por até 20 segundos (o timeout de identificação) — **sem nunca provar que sabe a senha da sala**. Reconectando em loop, a escuta virava contínua e indetectável.

**Correção:** a entrada na sala passou para depois da conferência do token.

**Teste de regressão:** adicionado, e validado do jeito certo — reintroduzi o bug e confirmei que o teste **falha**, depois restaurei e confirmei que passa. Teste que nunca viu vermelho não prova nada.

---

## 🟠 Achado 2 — Limite por IP era contornável (CORRIGIDO)

**Onde:** `server/lib/security.js`

`x-forwarded-for` era lido **sempre**. Esse header é texto que o cliente manda: quem alcançasse o processo por fora do proxy forjava um IP diferente a cada conexão, e o limite por IP simplesmente deixava de existir.

**Correção:** o header agora só é aceito quando a conexão chega de **endereço privado** (como todo PaaS entrega — o proxy fala com o processo por rede interna). Vindo de IP público, a conexão é direta e o header é chute do próprio cliente.

Escolhi detecção automática em vez de variável de ambiente de propósito: `TRUST_PROXY` esquecido no Render faria todos os usuários contarem como um único IP e o limitador derrubaria a sala inteira.

---

## 🟠 Achado 3 — Candidatos ICE eram perdidos em rede ruim (CORRIGIDO)

**Onde:** `src/lib/rtc/mesh.ts`

Sinais do mesmo par eram processados **concorrentemente**: quem chama não espera (`void handleSignal`) e o ICE chega em rajada. Um `addIceCandidate` podia começar antes do `setRemoteDescription` anterior terminar, e o candidato morria com *"remote description is null"*.

Cada candidato perdido é um caminho de conexão a menos. Em rede boa não se nota; em rede ruim **é a diferença entre conectar e não conectar** — exatamente o cenário da Fase 3.

**Correção:** fila **por par**. Pares diferentes seguem em paralelo, o que mantém rápida a entrada em sala cheia.

---

## 🟡 Bugs menores corrigidos

| Onde | Problema |
|---|---|
| `rtc/mesh.ts` | Quem estava falando quando a janela sumiu ficava marcado como falando **para sempre** — o anel voltava aceso ao reabrir |
| `ColorWheel.tsx` | `pointercancel` não era ouvido: gesto cancelado pelo sistema nunca dispara `pointerup`, então o par de listeners ficava preso — mais um par a cada arrasto interrompido |
| `ColorWheel.tsx` | `setPointerCapture` lança em alguns estados e abortava o resto do arrasto — agora protegido |
| `supabase/hardening.sql` | Função de trigger `enforce_message_rate` estava exposta como RPC pública sem motivo |

---

## ⚠️ Achado 4 — O histórico do chat é legível por qualquer um (NÃO corrigido: exige sua decisão)

**Este é o risco mais sério que sobrou, e não corrigi sozinho de propósito.**

As salas padrão são `is_private = false`. O sign-in é anônimo e livre. E a `anon key` está **dentro do binário distribuído** — ela é pública por definição, qualquer um extrai do instalador.

Resultado: extrair a chave → `signInAnonymously` → **baixar o histórico inteiro do chat**. O token do servidor de sinalização não protege nada disso, porque o Supabase nunca o vê.

**A correção está pronta e comentada em `supabase/hardening.sql` (PARTE 2):** guarda um *hash* do token no banco (nunca o token), numa tabela que cliente nenhum lê, e só inscreve em `room_members` quem provar que conhece o token. Inclui limite de 1 tentativa/segundo por usuário para inviabilizar força bruta pela API.

**Por que não apliquei:** exige mudança coordenada no cliente (`supabase.ts` precisa chamar `join_guild(token)` logo após o sign-in). Aplicar o SQL sozinho **deixaria o chat vazio para todo mundo**. Feito pela metade é pior que não feito.

---

## ✅ O que auditei e estava correto

- **XSS:** zero `innerHTML`, zero `dangerouslySetInnerHTML`, zero `eval` em todo o código. React escapa por padrão e o projeto não fura isso em lugar nenhum.
- **Logs:** nenhum log de token, senha, chave ou IP. Os logs do servidor são pobres deliberadamente.
- **RLS:** `revoke all ... from anon`, políticas por `auth.uid()`, sem `UPDATE`/`DELETE` para o cliente, view com `security_invoker`, trigger de rate limit no próprio banco.
- **Servidor:** limite por evento e por IP, `safeEqual` em tempo constante, `maxHttpBufferSize` de 256 KB, sanitização de caracteres de controle **e de marcas bidirecionais** (as que permitem forjar visualmente a autoria de uma mensagem), varredura periódica do limitador, shutdown limpo.
- **GitHub Actions:** actions presas por **SHA de commit** (proteção real contra supply chain — tag `@v4` é mutável e quem controla a action poderia rodar código próprio junto da sua chave de assinatura), `permissions: contents: write` mínimo, `npm ci`.
- **Performance React:** **zero** seletores Zustand criando objeto novo a cada render (causa clássica de re-render em loop). Os 3 componentes sem `memo` não renderizam durante transmissão.
- **RAM:** `EmptyWorkingSet` aplicado ao processo **e aos filhos do WebView2** (que são a maior parte do consumo), com debounce. Histórico de chat limitado a 300 mensagens por canal em memória.
- **Resiliência WebRTC:** ICE restart com backoff exponencial + jitter, reação a troca de rede (`online` / `connection.change`), fallback de codec, degradação adaptativa preservando framerate.

---

## 🔧 Refatoração aplicada

`session.ts` coordenava voz, tela, webcam, atalhos, atualização, ciclo de vida **e** chat — 823 linhas.

O chat era a fatia mais fácil de soltar (não depende de mídia nenhuma). Agora vive em `lib/chat.ts`, 159 linhas, testável sozinho. `session.ts` caiu para **704 linhas**. Os métodos públicos ficaram como fachada — a UI já chama `session.sendChat(...)` em vários lugares, e trocar isso seria churn sem ganho.

**Ainda grande, e o próximo alvo natural:** `SettingsModal.tsx` (581 linhas — dá para quebrar por seção) e a parte de voz/tela do `session.ts`.

---

## 🚀 Fase 6 — Roadmap, por impacto real

### 1. TURN próprio — *o maior ganho disponível hoje*
Hoje só há STUN público. Sem TURN, **10–15% das conexões simplesmente não fecham**: NAT simétrico e CGNAT (internet móvel, algumas operadoras) bloqueiam P2P direto. O código **já suporta** (`VITE_TURN_URLS` existe no pipeline) — falta o servidor.
Grátis: `coturn` numa VM Always Free da Oracle Cloud, ou Cloudflare Calls no free tier.
**Isso não é otimização, é a diferença entre o app funcionar ou não para parte dos seus amigos.**

### 2. Fechar o histórico do chat
A PARTE 2 do `hardening.sql`. Ver Achado 4.

### 3. Áudio do sistema via WASAPI loopback (Rust)
Hoje o áudio da transmissão vem do `getDisplayMedia`, que no WebView2 frequentemente entrega **nada**. Captura nativa por WASAPI loopback no Rust daria áudio de sistema confiável e independente do que o Chromium decide expor.

### 4. Teto de participantes em vídeo
Full mesh não escala: com N pessoas, cada um envia N−1 cópias. O `budgetPerPeer` já divide o teto de banda, mas isso significa que a qualidade despenca com 5+ transmitindo. Melhor **limitar e avisar** do que degradar silenciosamente. Um SFU resolveria de verdade, mas custa dinheiro e quebra o "100% P2P".

### 5. Overlay: posição salva e ajustável
Nasce fixo em (40,40) e não pode ser movido (o clique atravessa por design). Um "modo posicionar" que liga os cliques temporariamente e grava a posição.

### 6. Relatório de erro do app instalado
Se o app quebrar na casa de alguém, hoje ninguém fica sabendo. Um envio opt-in de `panic` do Rust e de erro do ErrorBoundary já daria visibilidade.

### 7. @menção e reação a mensagem
Social básico que falta. A menção também justifica notificação nativa, que hoje só pisca a barra de tarefas.

### 8. Teste E2E do fluxo de voz
Os 32 testes cobrem o servidor. O cliente WebRTC não tem nenhum teste automatizado — toda validação de voz nesta sessão foi manual.

---

## O que NÃO consegui verificar (honestidade sobre limites)

- **App Tauri empacotado:** não roda aqui. A janela nativa do overlay (transparência, always-on-top, clique-através) só se confirma instalando.
- **Supabase de produção:** não tenho acesso ao projeto do Antony. Auditei o `schema.sql` do repositório, que é o que o produção deveria refletir.
- **`hardening.sql` PARTE 1:** escrito e revisado, mas o projeto descartável de teste ainda estava subindo quando fechei este relatório. Rode primeiro num ambiente de teste.
- **Render / firewall / SSL:** sem acesso ao painel. O `wss://` é garantido pelo Render por padrão (ele termina TLS); o servidor em si não fala TLS diretamente, o que é o correto nesse arranjo.
