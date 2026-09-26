# Motor nativo de streaming

## Entregue na base 0.7

- Exclusão do produto social, Supabase e mídia WebRTC.
- Painel React restrito a hospedar, conectar, encerrar e mostrar telemetria.
- Matchmaking de um host com até quatro espectadores que repassa somente chaves públicas X25519.
- Fallback entre múltiplos STUN IPv4 e reutilização do mesmo socket para hole punching.
- Cabeçalho binário versionado, MTU interno de 1178 bytes e ChaCha20-Poly1305.
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
- Relay UDP cego opcional para CGNAT, corrida automática entre rota direta e relay.
- `ICodecAPI` para low-latency, GOP curto, zero B-frames, IDR e bitrate dinâmico.
- Resize, letterbox, fullscreen e reconstrução de device/decoder após falha D3D11.
- Updater assinado verificado e instalado pelo painel.
- Até quatro encoders independentes, um por espectador, cada sessão com chave
  X25519, perfil adaptativo, congestionamento e alocação de relay próprios.
- Seleção explícita de monitor/GPU, perfis adaptativos de 540p30 a 1080p60 e
  qualidade totalmente independente para isolar espectadores lentos.
- Negociação por espectador entre H.264, H.265 e AV1 conforme os MFTs de hardware.
- FEC XOR para recuperar um fragmento perdido por grupo de keyframe.
- Métricas de rota, RTT, perda e bitrate por espectador.
- Captura WASAPI loopback e reprodução Opus 48 kHz estéreo pelo túnel cifrado.
- Segunda instância independente para hospedar e assistir simultaneamente.
- Aprovação local obrigatória por código E2E antes de liberar tela e áudio.
- Senha de pelo menos 12 caracteres derivada com Argon2id (64 MiB, 3 iterações).
- Captura WASAPI isolada no processo do jogo para excluir Discord e Voxa.
- Troca de monitor e áudio durante a sessão; seleção da GPU de decodificação.
- Codec validado no adaptador D3D11 selecionado e proteção multithread explícita.
- Reconstrução do matchmaking após mudança de rede na rota direta.
- Bitrate Opus adaptativo e latência captura→tela P50/P95/P99.
- Testes determinísticos de perda, jitter, FEC e controle de congestionamento.
- RustSec no CI e Dependabot para Cargo, npm e GitHub Actions.

## Melhorias futuras prioritárias

1. **Feedback:** atraso interframe, fila do
   socket e tempo encode/decode para dirigir bitrate, resolução e FPS.
2. **Rede hostil:** medir disponibilidade/custo do relay e adicionar relay regional.
3. **Autenticação formal (concluída):** Argon2id alimenta SPAKE2 P-256 RFC 9382
   com confirmação mútua; o signaling não recebe segredo nem prova reutilizável.
   O pareamento persistente opcional usa o Gerenciador de Credenciais do Windows.
4. **Validação de hardware:** medir limites de sessões simultâneas de NVENC, AMF
   e QuickSync e reduzir o limite de espectadores quando o driver exigir.

Input remoto permanece fora do escopo atual de transmissão. Se voltar ao produto,
deve exigir consentimento local, indicador persistente e botão de emergência.

## Critério para chamar de transmissão pronta

- Dois PCs físicos, redes distintas, sessões de 30 minutos em 1080p60.
- Movimento rápido, troca de resolução, alt-tab e recuperação do driver gráfico.
- Perfis de 0%, 1%, 3%, 5% e 10% de perda, jitter e limitação de banda.
- Medição P50/P95/P99 de captura→display; nenhuma alocação por pacote no caminho
  estável; nenhum crescimento de memória.
- NVENC, AMF e QuickSync validados separadamente.
- Instalador e atualização assinada exercitados antes da promoção pública.
