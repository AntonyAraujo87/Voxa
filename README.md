# Voxa

Aplicativo Windows para conversar por voz, compartilhar tela/câmera e trocar
mensagens com amigos. Usa Tauri 2, React, WebView2 e WebRTC. O servidor Node com
Socket.IO cuida da identificação, sinalização e chat ao vivo; o Supabase opcional
guarda histórico e anexos.

O código está na versão **0.5.29**. O estado das correções e dos testes está em
[CORRECOES-0.5.29.md](docs/CORRECOES-0.5.29.md). Isso não significa que exista
um instalador publicado dessa versão.

## Voz e transmissão

Cada par negocia microfone, vídeo e som da transmissão separadamente. Os volumes
de voz e compartilhamento são independentes, com ganho até 200%; ganhos elevados
podem distorcer. Há mudo, ensurdecimento, push-to-talk e efeitos de soundboard.

Os presets definem resolução, framerate e orçamento de upload. Jogo prefere
conservar framerate; Leitura prefere resolução. Codec e aceleração dependem do
runtime, dispositivo e rede: selecionar um preset não garante FPS nem uso de GPU.

Clientes atualizados recebem vídeo e som da transmissão ao escolher **Assistir**.
A voz continua independente da grade. O orçamento de vídeo é dividido pelos
espectadores. Clientes antigos sem esse controle mantêm o envio compatível.

## Rede e custos

A mídia tenta viajar diretamente entre os computadores. Quando a rede impede
isso, um TURN configurado pode retransmiti-la. A sinalização não transporta
áudio/vídeo, mas o TURN transporta e pode gerar custos de tráfego. Usar apenas
STUN não garante conexão entre redes.

A arquitetura full mesh aumenta conexões, upload e processamento conforme o
grupo cresce. Os limites de 12 participantes por canal de voz e 128 sockets são
proteções, não uma certificação de desempenho. O servidor usa memória local e
deve operar em uma instância. Grupos maiores precisam de medições e, possivelmente,
de uma arquitetura com servidor de mídia (SFU).

## Desenvolvimento e validação

```bash
npm ci
npm ci --prefix server
npm run dev:all
```

Copie `.env.example` para `.env` e configure a sinalização. A senha é digitada
no login; não a coloque em variáveis `VITE_*`.

```bash
npm run verify
npm run build
npm run test:worklet
npm run test:rtc
npm run test:ui
```

Os testes de navegador usam Playwright. Instale seu Chromium com
`npx playwright install chromium` ou indique um navegador disponível por
`VOXA_TEST_BROWSER`. A mídia é sintética: os testes exercitam negociação, players
e interface, sem provar o comportamento de dispositivos físicos. Os testes SQL
usam PostgreSQL local com PGlite e não acessam o banco hospedado.

## Empacotamento e operação

`npm run app:build` usa o fluxo Tauri. No Windows x64 com toolchain GNU,
`npm run app:build:local` inclui a WebView2Loader.dll exigida pelo executável,
inspeciona dependências e gera hashes dos artefatos. O perfil local não usa a
assinatura do atualizador de produção. Compilar não comprova instalação/update.

Consulte [DEPLOY.md](docs/DEPLOY.md) para servidor, TURN, banco e releases.

## Limitações atuais

- TURN precisa ser provisionado/configurado e validado entre redes.
- A captura do WebView2 usa a fonte definida no início do processo; trocar exige
  reiniciar. Títulos repetidos ou variáveis podem tornar a seleção ambígua.
- O áudio nativo captura a saída padrão do Windows. Pode incluir o Voxa e outras
  aplicações. Não há captura por processo ou troca dinâmica do dispositivo de loopback.
- Testes locais não substituem dois PCs, jogos, instalação/update em Windows
  limpo ou medição de carga com vários usuários.
