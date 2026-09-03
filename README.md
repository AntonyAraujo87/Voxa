# Voxa

App de desktop para conversar por voz e compartilhar tela com amigos enquanto
joga. Interface no estilo Discord, transmissão pensada para segurar framerate
como o Parsec, e infraestrutura de custo zero.

O áudio e o vídeo vão direto de um computador para o outro. O único servidor que
existe apresenta um PC ao outro e sai do caminho — nenhum byte de mídia passa
por ele, então não há custo que cresça com o uso.

```
Tauri (Rust) + React + Tailwind    app desktop, usando o WebView2 do sistema
WebRTC puro, full mesh             áudio e vídeo direto entre os pares
Node + socket.io                   só o handshake e o chat em tempo real
STUN público do Google             descoberta de IP para a conexão direta
Supabase (opcional)                histórico das mensagens de texto
```

## O que faz a transmissão ficar boa

O que separa "compartilhar tela numa videochamada" de "assistir alguém jogar"
são quatro decisões, todas em `src/lib/`:

**Bitrate inicial no SDP.** A API do WebRTC deixa configurar o teto de bitrate,
mas não o ponto de partida. Sem isso o encoder abre em ~300 kbps e leva de 10 a
20 segundos subindo até a imagem ficar nítida. O `x-google-start-bitrate` é
injetado direto no SDP antes da negociação, então a imagem já nasce afiada.

**`maintain-framerate`.** Quando a rede aperta, o encoder escolhe entre derrubar
resolução ou derrubar FPS. No modo Jogo ele derruba resolução e segura os 60
quadros; no modo Leitura faz o contrário, para texto continuar legível.

**H264 no topo da lista de codecs.** Faz o WebView2 usar o MediaFoundation, ou
seja o encoder da própria GPU (NVENC, QuickSync, AMF). Encode e decode saem da
CPU.

**Windows Graphics Capture.** A captura acontece na GPU em vez do GDI antigo, o
que custa uma fração da CPU e funciona com janelas aceleradas por hardware.

O app tem um overlay de métricas mostrando FPS, bitrate, ping, perda, codec, se
o encoder está na GPU ou na CPU, e se a conexão está direta ou passando por
relay.

Seis presets, do 1080p60 a 40 Mbps ao 720p30 a 3 Mbps. Dois deles dividem o
mesmo orçamento de 8 Mbps por caminhos opostos: **Nítida** (1080p30) troca
quadros por pixels para ler texto; **Fluida** (720p60) troca pixels por quadros
para jogo rápido.

## Interface

**Entrada em duas etapas.** Nome e cor são escolhidos uma vez só, na primeira
abertura — isso é identidade, não muda a cada uso. Da segunda vez em diante a
tela pede só o código do servidor, com o perfil já pronto ao lado e um link
para trocar nome ou cor quando quiser.

**Transmissão não invasiva.** A maior parte de uma chamada não tem ninguém
compartilhando tela, então por padrão a área de vídeo não existe — chat e voz
ocupam o espaço todo. Quando alguém começa a transmitir, aparece só uma faixa
fina avisando; quem quiser assiste, clicando em "Assistir". A grade que abre
mostra apenas quem está transmitindo, não a chamada inteira — quem só está de
voz já tem seu lugar na lista ao lado. Clicar numa miniatura amplia com tela
cheia e picture-in-picture. Começar a própria transmissão abre a grade sozinho,
pela mesma lógica de conveniência.

**Dois volumes, dois lugares.** O volume da voz de alguém fica ao lado da
pessoa, no canal de voz — como no Discord. O volume da transmissão de tela é
outro controle, independente, no próprio vídeo: uma pessoa pode estar alta na
voz e baixa no jogo, ou o contrário.

O áudio de voz nunca depende da UI de transmissão — continua tocando mesmo com
a grade fechada, minimizada ou em erro.

**Escolher o que compartilhar.** Clicar em "Compartilhar tela" abre um seletor
com o monitor e as janelas abertas, em vez de compartilhar a fonte configurada
sem perguntar. O WebView2 não tem o seletor nativo do Chrome — a fonte captu-
rada é um argumento de linha de comando do Chromium, lido uma vez só quando o
processo nasce. Escolher a mesma fonte que já está ativa começa a transmitir
na hora; escolher outra salva a preferência e propõe reiniciar o app para
aplicar, deixando claro o porquê em vez de fingir que é instantâneo.

## A malha P2P

Cada participante abre uma conexão com cada outro. Latência de um salto só e
custo de servidor zero; em troca, o upload cresce com o número de espectadores —
por isso o teto de bitrate é dividido pelo número de pessoas na sala.

Toda conexão negocia sempre três fluxos, na mesma ordem: microfone, tela e som
do sistema. Ordem fixa nos dois lados deixa a negociação simétrica e permite
ligar e desligar o compartilhamento trocando a faixa de vídeo, sem renegociar
nada — a conexão não pisca.

Quem entra na sala é quem faz a oferta; quem já estava responde. O lado que
responde não cria nada até a oferta chegar, o que elimina colisão de negociação
por construção.

## Rodando local

```bash
npm install
npm run dev:all
```

Sobe o servidor de sinalização e o app juntos. Para gerar o instalador:

```bash
npm run app:build
```

Binário de 8,7 MB, instalador de 3 MB, bundle JS de 223 KB.

Notas de produção — servidor, senha de sala, TURN e auto-update — em
[docs/DEPLOY.md](docs/DEPLOY.md).

## Limitações

- **NAT simétrico ou CGNAT dos dois lados**: só STUN não fecha a conexão, seria
  preciso um servidor TURN. Em fibra residencial comum a conexão fecha direto.
- **Seletor de tela**: o WebView2 não tem o seletor do Chrome. A fonte é
  escolhida nas configurações e vira argumento de linha de comando, lido uma vez
  no boot — trocar exige reiniciar o app.
- **Acima de ~5 pessoas numa sala**: o upload não acompanha. Para mais gente o
  caminho seria um SFU, que exige servidor e sai do custo zero.

---

Desenvolvido com apoio de ferramentas de IA para escrever o código. Meu papel foi
definir como o app deveria se comportar e testar em máquina real até parar de
quebrar.
