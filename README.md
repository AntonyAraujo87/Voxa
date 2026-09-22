# Voxa Stream

O Voxa 0.6 é um projeto de streaming P2P para Windows. O Tauri/React funciona
somente como painel de conexão. Captura, transporte, telemetria e a janela de
reprodução pertencem ao processo Rust; não existem tags HTML de áudio ou vídeo.

## Arquitetura atual

```text
Painel Tauri ──WSS──> matchmaking Node/Render
     │                        │
     └── comando IPC          └── troca endpoint + chave efêmera
             │
        Motor Rust
 DXGI texture ─> codec HW ─> fragmentos UDP cifrados ─> decoder HW ─> janela nativa
```

O protocolo usa datagramas de até 1200 bytes, ChaCha20-Poly1305, chaves distintas
por direção, contador antirreplay, reagrupamento fora de ordem e prazo de 85 ms.
Frames atrasados ou incompletos são descartados e geram pedido de keyframe, sem
retransmissão. O bitrate cai rápido com perda/RTT e sobe gradualmente.

O matchmaking aceita exatamente um `host` e um `viewer` por sala. Ele não recebe
frames nem input. Para pares no mesmo IP público, anuncia o endpoint LAN; fora da
LAN, usa o mapeamento descoberto por STUN e perfuração UDP simultânea.

## Estado funcional

- Painel mínimo de hospedar/conectar e telemetria.
- Matchmaking autenticado, limitado por IP e sem perfis/chat.
- Socket UDP Tokio, descoberta STUN e hole punching.
- Túnel autenticado, antirreplay, heartbeat/RTT, fragmentação e keyframe request.
- Captura DXGI Desktop Duplication entrega `ID3D11Texture2D` sem mapear para CPU.
- Janela de stream é uma janela Tauri nativa sem WebView.

O backend de encode/decode por hardware ainda precisa ser ligado entre a textura
DXGI e o túnel. Enquanto o painel mostrar `hardware-pending` ou `decoder-pending`,
o app valida a rota nativa, mas não transmite imagem. A decisão é deliberada:
nenhum fallback silencioso para captura web ou encode por CPU será usado.

## Desenvolvimento

```bash
npm ci
npm ci --prefix server
npm run verify
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

Em Windows GNU, use um `target-dir` sem caracteres Unicode se o `dlltool` antigo
estiver instalado. O CI usa `windows-latest` e valida Rust com Clippy.

Copie `.env.example` para `.env`. A senha da sala é digitada no painel e nunca
deve entrar em uma variável `VITE_*`.

## Limitações de rede

STUN não atravessa todo NAT simétrico/CGNAT. O Render Web Service não oferece
uma porta UDP pública para relay. Produção universal exige um rendezvous/relay UDP
em uma VM com quota de banda ou uma rota QUIC/UDP equivalente. Um relay de vídeo
gratuito e ilimitado não existe; o modo direto continua gratuito quando o NAT
permite.

Detalhes de implantação estão em [docs/DEPLOY.md](docs/DEPLOY.md) e a sequência
técnica está em [docs/NATIVE-STREAMING-ROADMAP.md](docs/NATIVE-STREAMING-ROADMAP.md).
