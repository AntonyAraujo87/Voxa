# Voxa Stream

O Voxa 0.6 é um projeto de streaming P2P para Windows. O Tauri/React funciona
somente como painel de conexão. Captura, transporte, telemetria e a janela de
reprodução pertencem ao processo Rust; não existem tags HTML de áudio ou vídeo.

## Arquitetura atual

```text
Painel Tauri ──WSS──> matchmaking Node/Render
     │                        │
     └── comando IPC          └── troca endpoint + chave pública X25519
             │
        Motor Rust
 DXGI texture ─> codec HW ─> fragmentos UDP cifrados ─> decoder HW ─> janela nativa
```

O protocolo usa datagramas internos de até 1178 bytes, ChaCha20-Poly1305, chaves distintas
por direção, contador antirreplay e reagrupamento fora de ordem. Frames delta
incompletos expiram em 250 ms; keyframes recebem até 1,5 s por serem maiores.
Frames atrasados ou incompletos são descartados e geram pedido de keyframe, sem
retransmissão. O bitrate cai rápido com perda/RTT e sobe gradualmente.

O matchmaking aceita um `host` e até quatro `viewers` por sala. O host mantém
faixas de qualidade independentes por resolução e codec e as distribui para
sessões UDP independentes. Cada espectador possui segredo X25519, controle de
congestionamento e alocação de relay próprios. O matchmaking não recebe mídia;
quando necessário, o relay vê somente datagramas cifrados e não conhece a chave.
Para pares no mesmo IP público, anuncia o endpoint LAN; fora da LAN, usa o
mapeamento descoberto por STUN e perfuração UDP.

## Estado funcional

- Painel mínimo de hospedar/conectar e telemetria.
- Matchmaking autenticado, limitado por IP e sem perfis/chat.
- Socket UDP Tokio, fallback entre Cloudflare e dois servidores Google STUN e hole punching.
- X25519 efêmero entre os computadores; o signaling nunca cria nem recebe a chave de mídia.
- Relay UDP cego opcional para NAT simétrico/CGNAT, disputado em paralelo com a rota direta.
- Túnel autenticado, antirreplay, heartbeat/RTT, fragmentação e keyframe request.
- Seleção explícita de monitor/GPU; captura DXGI, conversão BGRA→NV12, escala e entrada no encoder permanecem na GPU.
- O host usa Media Foundation hardware e negocia AV1, H.265 ou H.264 conforme as duas GPUs, sempre com fallback H.264.
- O encoder solicita low-latency, GOP de 1 s, zero B-frames e bitrate dinâmico por `ICodecAPI`.
- O espectador decodifica o codec negociado por hardware para uma textura NV12 e apresenta por
  D3D11 em swapchain `flip-discard`, com resize, letterbox, fullscreen e recriação após device-lost.
- Som do sistema capturado por WASAPI loopback, comprimido em Opus 48 kHz estéreo e reproduzido por WASAPI em uma fila de baixa latência.
- Resolução e FPS adaptam-se ao bitrate (1080p60, 720p60, 720p30 ou 540p30); um espectador lento usa uma faixa própria.
- FEC XOR protege keyframes e recupera um fragmento perdido por grupo sem retransmissão.
- Métricas de rota, RTT, perda e bitrate são mantidas separadamente para cada espectador.
- O painel verifica, baixa e instala updates assinados sem interromper uma transmissão ativa.
- A configuração de codec, dimensões e FPS viaja autenticada e é repetida para
  tolerar perda UDP.
- Até quatro espectadores simultâneos, com saída individual preservada quando
  outro espectador desconecta e pedido automático de IDR para quem entra depois.
- O botão `Abrir outra sessão` permite hospedar em uma instância e assistir por outra ao mesmo tempo.

O host não usa fallback de captura web nem encode por CPU. A cadeia nativa compila,
mas ainda precisa ser validada em dois PCs físicos e GPUs NVENC, AMF e QuickSync.

## Desenvolvimento

```bash
npm ci
npm ci --prefix server
npm run verify
npm run build
npm run test:rust
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

Em Windows GNU, use um `target-dir` sem caracteres Unicode se o `dlltool` antigo
estiver instalado. O teste local executa o núcleo nativo; os testes que ligam o
runtime Tauri rodam no CI com MSVC porque o linker GNU mistura manifests do PE.
O CI usa a imagem fixa `windows-2025` e também valida Rust com Clippy.

Copie `.env.example` para `.env`. A senha da sala é digitada no painel e nunca
deve entrar em uma variável `VITE_*`.

## Limitações de rede

O Render Web Service continua hospedando apenas WSS/HTTP. Para NAT simétrico e
CGNAT, execute `npm run relay --prefix server` numa VM com UDP público e configure
o endpoint no Render. A rota direta continua preferida e não consome banda da VM.
Cada código E2E de seis dígitos exibido no host deve coincidir com o código do
espectador correspondente; isso detecta substituição maliciosa das chaves públicas.

Detalhes de implantação estão em [docs/DEPLOY.md](docs/DEPLOY.md) e a sequência
técnica está em [docs/NATIVE-STREAMING-ROADMAP.md](docs/NATIVE-STREAMING-ROADMAP.md).
