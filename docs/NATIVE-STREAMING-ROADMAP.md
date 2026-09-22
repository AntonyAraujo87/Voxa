# Motor nativo de streaming

## Entregue na base 0.6

- Exclusão do produto social, Supabase e mídia WebRTC.
- Painel React restrito a hospedar, conectar, encerrar e mostrar telemetria.
- Matchmaking de dois pares com chave aleatória de 256 bits por sala.
- STUN IPv4 e reutilização do mesmo socket para hole punching.
- Cabeçalho binário versionado, MTU de 1200 bytes e ChaCha20-Poly1305.
- Chaves derivadas por direção, `stream_id` aleatório e janela antirreplay.
- Reagrupamento fora de ordem, limite de aproximadamente 4,4 MiB/frame e prazos
  de 250 ms para frames delta e 1,5 s para keyframes.
- Descarte sem retransmissão, pedido de IDR limitado a quatro por segundo.
- AIMD de bitrate entre 0,8 e 35 Mbps com resposta a perda e RTT.
- DXGI Desktop Duplication devolvendo textura D3D11 sem leitura pela CPU.
- Janela nativa separada para o espectador.
- Pacing de pacotes, fila de um frame e descarte do frame antigo sob pressão.
- Conversão BGRA→NV12 pelo D3D11 Video Processor e encoder H.264 Media Foundation.
- Suporte a encoders MFT síncronos e assíncronos com timeout de driver.
- Configuração H.264/dimensões/FPS autenticada e repetida no túnel UDP.
- Decoder H.264 Media Foundation com superfície DXGI e apresentação D3D11
  `flip-discard` na janela nativa.

## Próxima integração obrigatória

1. **Ajuste do encode:** aplicar GOP curto, desativar B-frames e alterar bitrate
   via `ICodecAPI` sem reiniciar o MFT; acrescentar P010/H.265 quando suportado.
2. **Render robusto:** resize sem recriar a sessão, letterbox, fullscreen,
   recuperação de device-lost e seleção correta de GPU/monitor.
3. **Feedback:** atraso interframe, fila do
   socket e tempo encode/decode para dirigir bitrate, resolução e FPS.
4. **Rede hostil:** rendezvous UDP/QUIC e relay cego para NAT simétrico/CGNAT.
5. **Input:** somente API oficial em modo usuário, com consentimento local,
   indicador persistente, lista de teclas bloqueadas e botão de emergência.

## Critério para chamar de transmissão pronta

- Dois PCs físicos, redes distintas, sessões de 30 minutos em 1080p60.
- Movimento rápido, troca de resolução, alt-tab e recuperação do driver gráfico.
- Perfis de 0%, 1%, 3%, 5% e 10% de perda, jitter e limitação de banda.
- Medição P50/P95/P99 de captura→display; nenhuma alocação por pacote no caminho
  estável; nenhum crescimento de memória.
- NVENC, AMF e QuickSync validados separadamente.
- Instalador e atualização assinada exercitados antes da promoção pública.
