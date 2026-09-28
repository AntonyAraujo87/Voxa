# Validação HIL e de rede do Voxa

Este roteiro cobre o que testes simulados não conseguem certificar: drivers reais, firewall, áudio por processo, troca de interface, CGNAT e relay.

## Matriz mínima

Execute host e espectador alternadamente em AMD, NVIDIA e Intel. Registre modelo, versão do driver, codec negociado, resolução/FPS, HDR, encoder/decoder e resultado de `device lost`. Cada par deve testar H.264; H.265 e AV1 entram quando ambos os adaptadores os aceitarem no pré-teste.

## Dois computadores e CGNAT

1. Use redes diferentes. Em pelo menos um cenário, conecte um computador por 4G/5G ou provedor com CGNAT.
2. Confirme no diagnóstico se a rota direta venceu. No cenário CGNAT, confirme `relay://`.
3. Durante a transmissão, alterne Wi-Fi para cabo, suspenda/retome um computador e reinicie o roteador.
4. A captura deve continuar viva; o estado passa por `recovering`, refaz matchmaking e volta a `streaming`.
5. Verifique imagem, áudio isolado, sincronismo, cursor e revogação imediata do controle remoto.

## Falhas de GPU

Troque resolução, HDR e fullscreen durante movimento intenso. Atualize/reinicie o driver ou force suspensão para provocar recriação de DXGI. O Voxa deve solicitar keyframe e recriar captura, encoder, decoder ou swapchain sem fechar o painel.

## Soak de duas horas

Com uma sessão ativa, execute:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/soak-voxa.ps1 -DurationMinutes 120
```

O script registra memória privada, working set, handles e CPU em `work/voxa-soak.csv`, falhando se o crescimento ultrapassar os limites. Durante o teste, varie perda/jitter no roteador ou numa ferramenta de laboratório e execute pelo menos duas mudanças de interface. Exporte o diagnóstico do Voxa ao final para correlacionar P50/P95/P99, fila UDP, perda e reinícios de captura.

## Aprovação

Uma combinação só pode ser marcada como compatível depois de 30 minutos sem tela branca, corrupção, dessincronização ou crescimento contínuo de recursos. O resultado deve incluir os dois JSONs de diagnóstico e o CSV do soak.
