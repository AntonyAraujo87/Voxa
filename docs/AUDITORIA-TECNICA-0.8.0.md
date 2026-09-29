# Voxa Stream 0.8.0 - Auditoria técnica e relatório de implementação

Data da revisão: 29 de setembro de 2026.

## Resultado executivo

O Voxa 0.8.0 é um motor de streaming remoto P2P para Windows x86-64. O painel React/Tauri controla a sessão, mas nenhum frame de vídeo ou áudio atravessa o WebView. Captura, conversão, encode, transporte, decode, áudio e apresentação pertencem ao processo Rust e às APIs nativas do Windows.

Esta versão altera o protocolo nativo para v2 e é incompatível com clientes 0.7.5. A incompatibilidade é detectada antes da abertura do túnel, com mensagem para atualizar os dois computadores. O release só deve ser promovido quando o signaling v2 estiver implantado e o workflow Windows/MSVC estiver verde.

## Arquitetura validada

1. O painel usa IPC somente para comandos, aprovação, configuração, update e diagnóstico. A CSP bloqueia `media-src`, objetos e frames; conexões remotas ficam limitadas a HTTPS/WSS.
2. O host captura uma textura por DXGI Desktop Duplication. O D3D11 Video Processor escala e converte a textura para NV12 em SDR ou P010 em HDR10 sem mapear pixels na CPU.
3. Media Foundation negocia AV1, H.265 ou H.264 conforme host e espectador. O encoder exige modo de baixa latência, GOP de um segundo, zero B-frames e bitrate mutável por `ICodecAPI`.
4. O espectador decodifica em superfície D3D11 e apresenta em janela nativa separada, com swapchain flip-discard, letterbox, resize, fullscreen e recuperação após `device lost`.
5. Áudio usa WASAPI loopback a 48 kHz estéreo e Opus de baixa latência. O usuário pode capturar todo o sistema ou somente uma aplicação com sessão ativa; o modo por processo evita devolver Discord e o próprio Voxa ao espectador.
6. A mídia usa UDP assíncrono. Datagramas cifrados respeitam MTU interno de 1.178 bytes, remontagem limitada, antirreplay, expiração de frames e pedido de keyframe limitado.
7. Uma identidade X25519 protegida pelo Windows, combinada ao resultado SPAKE2 aleatório da sessão, cria chaves de mídia novas e independentes por par. SPAKE2 P-256 e Argon2id vinculam a senha da sala sem enviar senha, hash ou prova reutilizável ao servidor. ChaCha20-Poly1305 cifra e autentica cada datagrama.
8. A corrida de rota tenta hole punching direto e relay VRLY cego. IPv4 e IPv6 são aceitos; o relay encaminha bytes cifrados sem conhecer a chave.

## Implementações concluídas desde 0.7.5

- Relógio monotônico de processo compartilhado por áudio e vídeo, resistente a ajuste do relógio civil e reinício de dispositivo.
- Telemetria de captura, encode, rede, decode e apresentação em P50/P95/P99, com fila de aplicação e métricas individuais por espectador.
- FEC XOR adaptativo apenas em keyframes, reduzindo redundância em rede saudável e aumentando proteção conforme a perda.
- Máquina de estados formal: `idle`, `authenticating`, `awaiting-approval`, `connecting`, `streaming`, `recovering`, `closed` e `failed`.
- Reconexão após mudança de rede, nova descoberta STUN, renovação de endpoints e corrida entre rota direta e até quatro relays.
- Relay Node dual stack, bind configurável e testes reais de loopback IPv4/IPv6.
- Aprovação e revogação de teclado/mouse por espectador. Input só é capturado com a janela nativa em foco, via túnel autenticado, e só é injetado após consentimento visível do host.
- Capacidade de HDR10 fim a fim: BGRA/FP16 para P010, BT.2020/PQ, metadata SMPTE ST 2086, MaxCLL e MaxFALL, H.265/AV1 e swapchain R10G10B10A2. A negociação é individual e faz fallback SDR quando qualquer etapa não aceita HDR.
- Protocolo nativo v2 com rejeição explícita de pares antigos.
- Preflight de monitor, encoder, áudio, decoder, STUN, HTTPS do signaling e presença de relay. O app não inicia uma sessão que ficaria sem cobertura para CGNAT.
- Diagnóstico circular local de 60 segundos e exportação JSON sem senha, chaves ou conteúdo.
- Testes gerados para parser, limites, antirreplay e remontagem, alvos de fuzz para protocolo/FEC, simulação de perda/jitter, roteiro HIL e script de soak de duas horas.
- RustSec, npm audit, Dependabot para npm/Cargo/Actions e actions fixadas por SHA.

## Qualidade, segurança e validações executadas

- Frontend TypeScript e bundle Vite: aprovados.
- Servidor, segurança, matchmaking, relay e scripts: 39 de 39 testes aprovados.
- Núcleo Rust: 31 de 31 testes aprovados.
- `cargo check --locked`: aprovado para o backend Windows completo.
- Clippy em todos os alvos com `-D warnings`: aprovado.
- `npm audit --omit=dev` no app e no servidor: zero vulnerabilidades conhecidas.
- RustSec: zero vulnerabilidades; sete avisos transitivos. `glib` pertence ao alvo Linux do Tauri e não entra no executável Windows. `unic-*` e `proc-macro-error` são dependências indiretas do ecossistema Tauri e devem ser removidas por atualização upstream, não por override local arriscado.
- O teste local do crate Tauri não liga sob o toolchain GNU porque o linker não encontra `WebView2Loader.dll`. O código compila; o CI oficial usa MSVC e executa os testes do runtime.

## Riscos e bugs futuros encontrados

1. O pipeline HDR10 depende do comportamento dos MFTs de AMD, NVIDIA e Intel. Alguns drivers aceitam P010 no probe e falham apenas sob carga ou troca de modo; o fallback SDR reduz o impacto, mas HIL físico continua obrigatório.
2. O controle de gamepad exige um driver virtual assinado. Injetar teclado/mouse com APIs de usuário é possível; emular controle Xbox de forma confiável não deve ser feito com driver próprio sem assinatura. O recurso não será desenvolvido enquanto depender de componente pago ou driver sem manutenção confiável.
3. A segunda região de relay não pode ser criada na conta Oracle atual sem sair do Always Free: as duas instâncias E2 Micro gratuitas já são usadas por Voxa e Guará. O protocolo mantém suporte a vários relays, mas nenhuma infraestrutura paga será criada.
4. O teste real entre dois PCs, CGNAT, suspensão, firewall doméstico, WASAPI por processo e troca Wi-Fi/cabo não pode ser certificado por mocks ou por uma única máquina.
5. Quatro encodes independentes podem ultrapassar o limite de sessões de certas GPUs. O Voxa mede capacidade e reduz o máximo; GPUs/driver novos ainda precisam alimentar a matriz HIL.
6. O relay configurado é confirmado pelo health do signaling, mas o preflight não envia mídia antes do pareamento. A disponibilidade UDP efetiva é confirmada durante a corrida autenticada de rotas.

## Melhorias recomendadas após 0.8.0

- Manter gamepad fora do produto enquanto depender de driver pago ou não confiável.
- Manter apenas o relay atual enquanto não existir capacidade gratuita legítima.
- Alimentar uma base local de compatibilidade com resultados HIL assinados por versão de driver, além do probe já executado em tempo real.
- Adicionar telemetria de tempo na fila interna do encoder quando o fabricante expuser essa métrica sem cópia da textura.
- Automatizar um laboratório com duas máquinas físicas e controle de perda/jitter para executar o soak em AMD, NVIDIA e Intel.
- Depois de validar HDR em hardware diverso, permitir preferência manual entre HDR10 nativo e tone mapping SDR.

## Ações exigidas do proprietário

1. Instalar o release em dois computadores e seguir `docs/VALIDACAO-HIL-E-REDE.md`, começando por H.264 e depois H.265/AV1.
2. Testar pelo menos uma conexão em CGNAT e confirmar no diagnóstico uma rota `relay://`.
3. Testar áudio por processo com jogo e Discord simultâneos, confirmando que o espectador não ouve retorno da chamada.
4. Executar o soak de duas horas com `scripts/soak-voxa.ps1`, incluindo duas mudanças de interface de rede.
5. Guardar os dois diagnósticos JSON e o CSV do soak para comparar latência, perda, memória, handles e reinícios.
6. Não criar nova VM Oracle até haver cota Always Free disponível. As VMs Voxa e Guará já ocupam a capacidade gratuita observada.

## Critério de publicação

O release 0.8.0 já foi publicado depois de o workflow concluir build, assinatura,
inspeção do PE, instalação, update e desinstalação na VM Windows. Correções desta
reauditoria seguem para o código principal e para o deploy do signaling, mas uma
nova tag só deve ser criada depois do resumo e da autorização do proprietário. A
validação física descrita acima continua sendo o critério para declarar
compatibilidade de GPU/rede, não um requisito que possa ser falsamente
substituído por testes automatizados.

## Reauditoria pós-release de 29/09/2026

A revisão integral da versão publicada encontrou e corrigiu sete defeitos que os
testes anteriores não reproduziam:

1. Uma confirmação SPAKE2 podia chegar antes do `share` remoto e ser descartada,
   deixando a sessão presa em autenticação. Confirmações antecipadas agora são
   armazenadas por par e consumidas depois que a chave compartilhada existe.
2. Revogar um espectador liberava todas as teclas do Windows, inclusive entradas
   de outro espectador. O host agora registra somente teclas e botões efetivamente
   injetados por cada par e libera apenas os pertencentes ao par revogado. A
   autorização, a chamada a `SendInput` e o registro foram tornados atômicos para
   impedir que um pacote concorrente pressione a tecla depois da revogação.
3. A injeção usava `keybd_event` e `mouse_event`, APIs substituídas pela Microsoft.
   O caminho passou a usar `SendInput`.
4. Datagramas com o magic correto vindos de qualquer IP chegavam ao ChaCha20 de
   todos os pares. Origens não anunciadas pelo signaling agora são descartadas
   antes da autenticação criptográfica, reduzindo amplificação de flood UDP.
5. Uma rota com relay configurado nunca pedia novo matchmaking se todas as rotas
   ficassem oito segundos sem autenticar. O espectador agora renova endpoint,
   segredo da sessão e alocação de relay também nesse cenário; uma falha isolada
   não muda o estado global dos demais espectadores do host.
6. Uma falha rara entre `AcquireNextFrame` e o cast da textura podia deixar o
   frame DXGI preso. Um lease RAII garante exatamente um `ReleaseFrame` em todos
   os retornos.
7. A descoberta STUN usava somente o primeiro endereço DNS e a rota LAN local
   era exclusivamente IPv4. Agora todos os endereços resolvidos são tentados e
   existe fallback de interface local IPv6.

O signaling também passou a validar a origem no próprio `allowRequest` do
WebSocket, pois cabeçalhos CORS não protegem upgrade WebSocket. Configurações
legadas `ORIGIN=*` são convertidas para `http://tauri.localhost` e o localhost
de desenvolvimento, preservando o auto-deploy sem manter acesso de qualquer site.

Após as correções: build TypeScript/Vite aprovado; 39/39 testes Node aprovados;
31/31 testes do núcleo Rust aprovados; formatação e `git diff --check` aprovados;
Clippy de todos os alvos com `-D warnings` aprovado; npm audit do app e servidor
com zero vulnerabilidades; RustSec sem vulnerabilidades exploráveis. O release
0.8.0 e seu `latest.json` possuem EXE/MSI e assinaturas, e o deploy respondeu
HTTP 200 por TLS 1.3 com relay anunciado.

### Pendências que exigem hardware ou mudança arquitetural

- Validar dois PCs, CGNAT, suspensão e troca Wi-Fi/cabo. Mocks não certificam
  driver, firewall, NAT doméstico, áudio do jogo nem relay público sob carga.
- O cursor transmite posição, visibilidade e formas DXGI monocromáticas ou ARGB
  de até 64 pixels. Formas `MASKED_COLOR`, que exigem XOR com o desktop, e
  cursores de acessibilidade maiores usam a seta segura até existir composição
  por shader.
- O controle de mouse usa deltas da posição do cursor. Jogos que prendem o mouse
  ou usam Raw Input precisam de captura relativa nativa e tratamento de teclas
  estendidas; gamepad continua dependendo de driver virtual assinado.
- Os MFTs assíncronos usam consulta limitada com espera adaptativa de 1–5 ms e
  timeout de 500 ms. `BeginGetEvent` continua sendo uma evolução possível, mas
  precisa de HIL para garantir cancelamento seguro em drivers AMD/NVIDIA/Intel.
- O relay único em São Paulo continua sendo ponto único de falha. O protocolo já
  aceita até quatro candidatos; a conta Oracle não possui outra capacidade
  Always Free sem risco de cobrança.
- O ponteiro é composto após a apresentação por GDI. A composição definitiva
  deve ocorrer no backbuffer D3D11 antes do `Present` para eliminar flicker.

## Otimizações gratuitas posteriores à reauditoria

- A espera de eventos Media Foundation foi centralizada em `mf_events.rs`.
  Respostas imediatas continuam sem atraso artificial; drivers lentos passam a
  usar backoff progressivo, preservando o timeout contra travamentos e reduzindo
  despertares de CPU.
- O runtime do socket e os sinais de despertar saíram de `transport.rs` para
  `transport/runtime.rs`. Atualização de métricas, estado e FEC saiu para
  `transport/state.rs`, reduzindo acoplamento sem alterar o protocolo.
- O parser de controle remoto agora rejeita combinações inválidas de tipo,
  botão, tecla e deltas antes de chamar a API do Windows.
- Teclas estendidas, como setas, Insert/Delete, Windows e modificadores direitos,
  são injetadas com `KEYEVENTF_EXTENDEDKEY`.
- Movimentos consecutivos do mouse são agregados na fila. Sob pressão, o Voxa
  descarta movimento antigo antes de qualquer transição de tecla ou botão,
  reduzindo o risco de entrada presa sem aumentar banda ou memória.
- A abertura do socket dual stack deixou de conter `unwrap` em código de
  produção e agora devolve um erro diagnosticável.
- Captura e reprodução WASAPI agora usam `AUDCLNT_STREAMFLAGS_EVENTCALLBACK` e
  eventos nativos do Windows. O caminho de áudio deixa de acordar a thread a
  cada 2 ms quando não há pacote ou espaço no dispositivo, mantendo timeouts
  curtos para encerramento e recuperação.
- A captura consulta `GetFramePointerShape` apenas quando o DXGI informa uma
  mudança. A forma fica limitada a 32 KiB, é fragmentada e cifrada pelo mesmo
  túnel UDP, reenviada periodicamente e armazenada em cache no espectador. O
  renderer cria o cursor Win32 real para formas monocromáticas e ARGB e mantém
  fallback para tipos que exigem XOR.
