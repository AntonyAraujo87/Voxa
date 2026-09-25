# Voxa Stream

O Voxa 0.7 é um projeto de streaming P2P para Windows. O Tauri/React funciona
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
um encoder, resolução, FPS e bitrate independentes para cada espectador. Cada
espectador possui segredo X25519, controle de
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
- O host testa os encoders Media Foundation na GPU do monitor escolhido e negocia AV1, H.265 ou H.264 somente quando a GPU do espectador também aceita o codec.
- O encoder solicita low-latency, GOP de 1 s, zero B-frames e bitrate dinâmico por `ICodecAPI`.
- O espectador decodifica o codec negociado por hardware para uma textura NV12 e apresenta por
  D3D11 em swapchain `flip-discard`, com resize, letterbox, fullscreen e recriação após device-lost.
- Áudio WASAPI do processo do jogo e seus filhos, ou loopback completo como opção, comprimido em Opus 48 kHz estéreo com bitrate adaptativo. Isolar o jogo impede retorno de Discord/Voxa.
- Resolução e FPS adaptam-se ao bitrate (1080p60, 720p60, 720p30 ou 540p30); cada espectador possui um encoder próprio e não reduz a qualidade dos demais.
- FEC XOR protege keyframes e recupera um fragmento perdido por grupo sem retransmissão.
- Métricas de rota, RTT, perda e bitrate são mantidas separadamente para cada espectador.
- O host aprova cada espectador depois de comparar o código E2E; tela e áudio não saem antes dessa aprovação.
- A senha da sala exige 12 caracteres e vira uma prova Argon2id de 64 MiB/3 iterações fora da thread da interface.
- Monitor e origem de áudio podem ser trocados durante a sessão; o espectador pode escolher a GPU de decodificação.
- A rota direta é refeita automaticamente quando a interface de rede ou o endereço público muda.
- Latência captura→tela é estimada com compensação de relógio e exibida em P50/P95/P99.
- O painel verifica, baixa e instala updates assinados sem interromper uma transmissão ativa.
- A configuração de codec, dimensões e FPS viaja autenticada e é repetida para
  tolerar perda UDP.
- Até quatro espectadores simultâneos, com saída individual preservada quando
  outro espectador desconecta e pedido automático de IDR para quem entra depois.
- O botão `Abrir outra sessão` permite hospedar em uma instância e assistir por outra ao mesmo tempo.
- Áudio e vídeo usam o mesmo relógio de captura; o espectador compensa a diferença e exibe a deriva A/V em milissegundos.
- O painel de áudio lista somente processos com sessão ativa no mixer do Windows e pode ser atualizado sem reiniciar o Voxa.
- O limite de encoders é sondado na GPU escolhida. O host reduz o teto de espectadores e mantém a recuperação individual se uma sessão de encode parar.
- Posição e visibilidade do cursor seguem o timestamp do frame; o host pode ocultar o cursor durante a sessão.
- Mudanças de resolução e HDR recriam a captura. Cada encoder possui watchdog de dois segundos e solicita nova configuração/keyframe ao voltar.
- `Exportar diagnóstico` salva em Documentos/Voxa um JSON sem senha ou chaves, contendo GPU/driver, codecs, rotas, relay, perda, latências, estado dos espectadores e erros.

O host não usa fallback de captura web nem encode por CPU. A cadeia nativa compila,
mas ainda precisa ser validada em dois PCs físicos e GPUs NVENC, AMF e QuickSync.

## Desenvolvimento

```bash
npm ci
npm ci --prefix server
npm run verify
npm run build
npm run test:rust
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo clippy --manifest-path src-tauri/native-core/Cargo.toml --all-targets -- -D warnings
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
espectador correspondente. O host precisa aprová-lo antes de liberar a mídia;
isso detecta substituição maliciosa das chaves públicas.

A captura isolada por processo requer Windows 10 build 20348 ou superior. Em
versões anteriores, selecione o loopback completo do sistema. O Voxa não captura
microfone; por isso a prevenção de retorno do Discord é feita excluindo Discord e
o próprio Voxa da origem transmitida, em vez de aplicar cancelamento acústico.

Detalhes de implantação estão em [docs/DEPLOY.md](docs/DEPLOY.md) e a sequência
técnica está em [docs/NATIVE-STREAMING-ROADMAP.md](docs/NATIVE-STREAMING-ROADMAP.md).
