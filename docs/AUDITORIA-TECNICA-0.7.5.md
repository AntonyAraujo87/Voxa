# Auditoria técnica do Voxa Stream 0.7.5

Data: 28 de setembro de 2026.

## Resultado executivo

O WebView continua restrito ao painel de configuração, aprovação, atualização e diagnóstico. Não existem elementos HTML de vídeo ou áudio, WebRTC, `MediaStream`, `getUserMedia` ou `getDisplayMedia`. A mídia percorre o pipeline nativo DXGI/D3D11, Media Foundation, UDP cifrado e uma swapchain D3D11 ligada ao `HWND` da janela de transmissão.

Não foi encontrada violação de renderização nativa ou passagem de mídia pelo IPC do Tauri. A CSP contém `media-src 'none'`, bloqueia frames e objetos e restringe conexões a IPC, HTTPS/WSS e localhost. Como o endereço de matchmaking é configurável, `https:` e `wss:` permanecem autorizados por esquema; uma lista fixa de origens reduziria a superfície caso essa configuração deixe de ser necessária.

## Correções aplicadas

- O controlador de congestionamento agora retorna uma decisão explícita com bitrate entre 0,8 e 35 Mbps, condição da rede, idade máxima do frame delta e pedido de IDR após recuperação.
- Frames delta atrasados são descartados antes de consumir a fila UDP. O limite cai de 250 ms para 140 ms ou 80 ms sob pressão.
- O limitador de keyframes virou um componente testado e mantém o teto de quatro pedidos por segundo.
- Feedback de rede e métricas de latência foram separados do transporte e agora aceitam apenas os formatos exatos de 8 bytes legado ou 20 bytes atual.
- Fragmentação e FEC XOR de keyframes foram isolados em `transport/packetizer.rs`, com testes para MTU, excesso de tamanho e recuperação de um fragmento.
- A descoberta de rota agora dispara envio direto e relay em paralelo enquanto a rota vencedora ainda é desconhecida.
- Encoders Media Foundation sem `ICodecAPI` ou sem controles exigidos de baixa latência, B-frames zero, GOP curto, LowDelayVBR e bitrate dinâmico deixam de ser anunciados como compatíveis.
- A proteção multithread dos dispositivos D3D11 de captura e reprodução passou a ser obrigatória, com erro claro se o driver a recusar.

## Validação por subsistema

### Tauri e React

- O frontend envia apenas configurações e comandos pequenos pelo IPC.
- A janela de stream é apresentada por D3D11; o WebView não decodifica nem renderiza mídia.
- As capabilities são limitadas a controles de janela, updater e encerramento/reinício.

### Vídeo e áudio nativos

- `capture.rs` usa Desktop Duplication e conserva o frame em `ID3D11Texture2D`.
- `converter.rs` usa D3D11 Video Processor para escala e conversão BGRA/HDR para NV12 sem mapear pixels na CPU.
- `encoder.rs` negocia AV1, H.265 e H.264 nessa ordem e entrega ao Media Foundation uma superfície DXGI. Somente o bitstream comprimido é copiado para RAM.
- `decoder.rs` devolve textura D3D11 e `presenter.rs` converte/apresenta numa swapchain nativa, com resize, letterbox, fullscreen e recriação do pipeline quando o dispositivo é perdido.
- `audio.rs` usa WASAPI loopback geral ou por processo, quando suportado pelo Windows, e Opus estéreo a 48 kHz. O bitrate de áudio acompanha a faixa de vídeo.

### UDP, NAT e relay

- Datagramas cifrados têm no máximo 1.178 bytes, preservando 22 bytes para o envelope VRLY dentro de uma MTU conservadora de 1.200 bytes.
- A remontagem limita cada frame a 4.587.520 bytes e mantém no máximo três frames incompletos.
- FEC XOR é enviado somente para keyframes em grupos de oito fragmentos.
- Frames incompletos ou vencidos são descartados sem retransmissão.
- Hole punching e relay cego competem em paralelo. O relay UDP na porta 3479 autentica o envelope, remove apenas o cabeçalho VRLY e encaminha o datagrama VOXA ainda cifrado.

### Criptografia e confiança

- A senha usa Argon2id com 64 MiB, três iterações, uma via e saída de 32 bytes.
- O pareamento usa SPAKE2 P-256 efêmero com confirmação mútua. O servidor recebe apenas mensagens públicas.
- X25519 gera segredos distintos por espectador; SHA-256 liga o segredo ao resultado do SPAKE2.
- ChaCha20-Poly1305 cifra e autentica cada datagrama, com chaves separadas por direção e janela antirreplay.
- A identidade persistente opcional usa o armazenamento de credenciais do Windows.

## Plano de divisão do transporte

`transport.rs` deve permanecer como fachada pública e orquestrador de sessão. A divisão segura seguinte é:

1. `transport/session.rs`: construção dos estados compartilhados, início e parada das tarefas.
2. `transport/receiver.rs`: autenticação de datagramas, antirreplay, remontagem, expiração e despacho por tipo.
3. `transport/senders/video.rs`: pacotes de configuração, descarte por idade, pacing, fragmentação e FEC.
4. `transport/senders/audio.rs` e `cursor.rs`: filas limitadas e envio prioritário independente.
5. `transport/heartbeat.rs`: ping/pong, relógio, feedback, seleção de rota e decisões de congestionamento.
6. `transport/state.rs`: `TransportControl`, `TransportHandle`, `WakeSignal` e `DatagramHub`.
7. `transport/wire.rs`: selagem, metadados, sequência e relógio monotônico/de parede.

Já foram extraídos `fanout.rs`, `route.rs`, `feedback.rs` e `packetizer.rs`. A próxima divisão deve preservar um único commit compilável por etapa para evitar regressões em tarefas concorrentes.

`native/mod.rs` deve ser dividido depois do transporte em `commands/session.rs`, `commands/security.rs`, `commands/devices.rs`, `peer.rs` e `diagnostics/export.rs`. A fachada deve continuar expondo os mesmos comandos Tauri para não quebrar o React.

## Riscos e próximos passos

- O caminho completo precisa de teste real entre dois computadores e em pelo menos uma rede CGNAT. Os testes automatizados não exercitam drivers específicos de GPU, monitor HDR, firewall doméstico ou suspensão real do Windows.
- A captura de áudio por processo exige Windows 10 build 20348 ou superior; versões anteriores devem usar loopback do sistema.
- O RustSec não encontrou vulnerabilidade conhecida, mas listou sete avisos transitivos: seis crates Unicode sem manutenção vindos de `urlpattern`/Tauri e `glib` com aviso de soundness em alvo não Windows. A correção depende de atualizações upstream do Tauri; Dependabot e o CI continuam acompanhando.
- O teste local do executável Rust completo compila, mas o binário de teste GNU depende do `WebView2Loader.dll`; o script de CI do projeto prepara esse carregador e o job Windows é a fonte definitiva para a etapa de link dos testes Tauri.

## Ações do proprietário

1. Instalar a versão 0.7.5 em dois computadores e testar H.264 primeiro, depois H.265 e AV1 quando ambos anunciarem suporte.
2. Testar conexão direta e relay, áudio do sistema e áudio isolado por processo.
3. Confirmar visualmente aprovação do espectador, código E2E, troca de monitor, fullscreen, reconexão após Wi-Fi e recuperação após suspensão.
4. Enviar o diagnóstico exportável se houver tela branca, ausência de áudio ou encoder recusado; o erro agora identifica o controle de hardware ausente.
5. Manter o relay Oracle e o matchmaking ativos e acompanhar o workflow de release antes de distribuir o instalador.
