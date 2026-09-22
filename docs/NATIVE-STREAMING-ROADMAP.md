# Motor nativo de streaming

## Entregue na base 0.6

- Exclusão do produto social, Supabase e mídia WebRTC.
- Painel React restrito a hospedar, conectar, encerrar e mostrar telemetria.
- Matchmaking de dois pares com chave aleatória de 256 bits por sala.
- STUN IPv4 e reutilização do mesmo socket para hole punching.
- Cabeçalho binário versionado, MTU de 1200 bytes e ChaCha20-Poly1305.
- Chaves derivadas por direção, `stream_id` aleatório e janela antirreplay.
- Reagrupamento fora de ordem, limite de 24 MiB/frame e prazo de 85 ms.
- Descarte sem retransmissão, pedido de IDR limitado a quatro por segundo.
- AIMD de bitrate entre 0,8 e 35 Mbps com resposta a perda e RTT.
- DXGI Desktop Duplication devolvendo textura D3D11 sem leitura pela CPU.
- Janela nativa separada para o espectador.

## Próxima integração obrigatória

1. **Encode:** registrar `ID3D11Texture2D` diretamente no NVENC; converter BGRA
   para NV12/P010 em compute shader; configurar H.264 low-latency, GOP curto,
   sem B-frames e reconfiguração de bitrate sem reiniciar a sessão.
2. **Fallbacks:** AMF e QuickSync/Media Foundation com a mesma interface de
   textura. Falha explícita se não existir codec por hardware.
3. **Envio:** fragmentar cada access unit H.264/H.265 no `transport`, marcar IDR
   e usar pacing por deadline em vez de despejar um frame inteiro no socket.
4. **Decode/render:** decoder D3D11 hardware e swap chain flip-discard na janela
   nativa; fila de um frame, descarte do mais antigo e apresentação imediata.
5. **Feedback:** número de sequência recebido/perdido, atraso interframe, fila do
   socket e tempo encode/decode para dirigir bitrate, resolução e FPS.
6. **Rede hostil:** rendezvous UDP/QUIC e relay cego para NAT simétrico/CGNAT.
7. **Input:** somente API oficial em modo usuário, com consentimento local,
   indicador persistente, lista de teclas bloqueadas e botão de emergência.

## Critério para chamar de transmissão pronta

- Dois PCs físicos, redes distintas, sessões de 30 minutos em 1080p60.
- Movimento rápido, troca de resolução, alt-tab e recuperação do driver gráfico.
- Perfis de 0%, 1%, 3%, 5% e 10% de perda, jitter e limitação de banda.
- Medição P50/P95/P99 de captura→display; nenhuma alocação por pacote no caminho
  estável; nenhum crescimento de memória.
- NVENC, AMF e QuickSync validados separadamente.
- Instalador e atualização assinada exercitados antes da promoção pública.
