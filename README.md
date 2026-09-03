# Voxa

Voz, texto e compartilhamento de tela P2P. Interface estilo Discord, transmissão
com prioridade de framerate estilo Parsec, custo de infraestrutura zero.

```
Tauri (Rust) + React 19 + Tailwind v4   ← app desktop, WebView2 do sistema
WebRTC puro, full mesh                  ← áudio e vídeo vão direto de PC para PC
Node + socket.io                        ← só handshake SDP/ICE e chat em tempo real
Supabase Free Tier                      ← opcional: usuários, canais, histórico
STUN público do Google                  ← NAT traversal sem TURN pago
```

Nenhum byte de mídia passa por servidor. O signaling só troca as chaves e sai da frente.

### Números medidos nesta máquina (build release, app ocioso)

| | |
|---|---|
| `voxa.exe` (host Rust) | **27 MB** |
| WebView2 (6 processos) | 353 MB |
| **Total do app** | **380 MB** |
| Servidor de signaling | 55 MB RSS |
| Binário | 8,7 MB |
| Instalador NSIS / MSI | 2,0 MB / 3,0 MB |
| Bundle JS inicial | 223 KB (59 KB gzip) |

O ganho do Tauri sobre Electron aqui é disco e processo host: 8,7 MB de binário
contra ~120 MB, e um host de 27 MB contra os ~90 MB do processo main do Electron.
A RAM do WebView2 é comparável à do Chromium embutido — quem promete "50 MB de
RAM com Tauri" está medindo só o processo Rust.

---

## Rodando local

```bash
cd voxa
npm install
npm run dev:all
```

`dev:all` sobe o signaling (porta 3001) e o app Tauri juntos. Para separar:

```bash
npm run server   # terminal 1 — signaling
npm run app      # terminal 2 — app desktop
```

Build do instalador (`.exe` NSIS e `.msi` em `src-tauri/target/release/bundle`):

```bash
npm run app:build
```

---

## Colocando no ar (fora da LAN)

Três peças, todas em plano gratuito.

### 1. Signaling público

O repositório traz um `render.yaml`. No Render: **New → Blueprint → aponte para
o repositório**. Ele sobe `server/` como web service free, gera um `VOXA_TOKEN`
aleatório e expõe `/health`.

Limitação do plano free: o serviço dorme após 15 min sem tráfego e leva ~30 s
para acordar. Quem entrar primeiro espera; os demais não.

Anote a URL (`https://voxa-signaling.onrender.com`) e o `VOXA_TOKEN` gerado.

### 2. Senha da sala

O servidor só aceita clientes que mandem o mesmo token. Sem isso, qualquer um
que descubra o endereço entra e escuta a conversa.

```
servidor:  VOXA_TOKEN=<segredo>
```

**A senha não é embutida no instalador de propósito.** O Vite grava qualquer
`VITE_*` dentro do bundle na hora de compilar, e o instalador é público — quem
baixasse o `.exe` conseguiria extrair a senha dele. Então cada pessoa digita a
senha uma vez, na tela de entrada; o app guarda e não pergunta de novo. Você
distribui a senha por outro canal.

Existe a variável `VITE_ROOM_TOKEN` para builds privados (uso interno, rede
fechada). Em release público, deixe-a vazia.

### 3. TURN — o ponto que decide se funciona

STUN só descobre o IP público. Se **os dois lados** estiverem atrás de NAT
simétrico ou CGNAT (padrão de várias operadoras brasileiras), nenhum par de
candidatos casa e a conexão nunca fecha. Em fibra residencial comum costuma
fechar direto; no 4G/5G ou CGNAT, quase nunca.

TURN é um relay: sempre funciona, mas todo o vídeo passa por ele — por isso não
existe TURN gratuito ilimitado.

```
VITE_TURN_URLS=turn:openrelay.metered.ca:80,turn:openrelay.metered.ca:443
VITE_TURN_USERNAME=openrelayproject
VITE_TURN_CREDENTIAL=openrelayproject
```

O Open Relay tem franquia mensal e o vídeo passa pelos servidores deles. Para
algo privado ou de uso pesado, um coturn num VPS de ~US$4/mês resolve.

**Antes de gastar com TURN, meça.** O overlay de métricas mostra `rota: direto`
ou `rota: relay TURN`. Se der `direto` entre você e seu amigo, TURN nunca é
usado e não precisa de nenhum.

---

## Auto-update

Seu amigo baixa o instalador **uma vez**. Depois disso o app se atualiza sozinho.

Como funciona: o app consulta o `latest.json` publicado no GitHub Releases,
compara versões, baixa o instalador assinado e reinstala por cima. A assinatura
é verificada com a chave pública embutida no binário — um `latest.json` forjado
não é aceito.

### Configuração (uma vez)

1. **Crie o repositório** e suba o projeto:

   ```bash
   git init && git add . && git commit -m "feat: voxa"
   git remote add origin https://github.com/AntonyAraujo87/Voxa.git
   git push -u origin main
   ```

2. **Cadastre os secrets** em Settings → Secrets and variables → Actions:

   | Secret | Valor |
   |---|---|
   | `TAURI_SIGNING_PRIVATE_KEY` | conteúdo de `.keys/voxa.key` |
   | `VITE_SIGNALING_URL` | URL do Render |
   | `VITE_TURN_URLS` / `_USERNAME` / `_CREDENTIAL` | se usar TURN |
   | `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | se usar Supabase |

3. **Publique uma versão:**

   ```bash
   git tag v0.1.0 && git push --tags
   ```

   O workflow `.github/workflows/release.yml` compila no Windows, assina, cria a
   release e gera o `latest.json`. Para atualizar depois: suba a versão no
   `package.json` e no `src-tauri/Cargo.toml`, e crie a tag nova.

> `.keys/` está no `.gitignore`. Se perder essa chave privada, os apps já
> instalados param de aceitar atualizações — não há como reemitir.

---

## Como a qualidade é obtida

Quatro coisas separam "compartilhamento de tela de videochamada" de
"streaming de jogo". Todas estão em `src/lib/`:

**1. Bitrate inicial no SDP** (`sdp.ts`)
`setParameters()` controla o teto de bitrate, mas não o ponto de partida. Sem
`x-google-start-bitrate` o encoder abre em ~300 kbps e leva 10–20 s subindo até
1080p60 ficar nítido. Injetamos start/min/max direto no `a=fmtp` antes do
`setLocalDescription`, então a imagem já nasce afiada.

**2. `degradationPreference: maintain-framerate`** (`rtc.ts`)
Quando a rede aperta, o encoder escolhe entre derrubar resolução ou FPS. Modo
**Jogo** derruba resolução e segura os 60 FPS; modo **Leitura** faz o contrário,
para texto e código continuarem legíveis.

**3. `contentHint = "motion"`** (`media.ts`)
Diz ao encoder que a fonte é movimento rápido, não uma apresentação. Muda a
alocação de bits entre keyframes e delta frames.

**4. H264 primeiro + WGC** (`config.ts`, `src-tauri/src/lib.rs`)
H264 no topo da lista de codecs faz o WebView2 usar MediaFoundation, ou seja
NVENC/QuickSync/AMF: encode e decode na GPU, CPU perto de zero. O Rust liga as
flags `WebRtcAllowWgc*Capturer` para a captura usar Windows Graphics Capture
(composição na GPU) em vez de GDI BitBlt.

### Orçamento de upload

Numa malha, a mesma tela é codificada e enviada **uma vez por espectador**.
15 Mbps para 3 pessoas seriam 45 Mbps de upload, que quase ninguém tem. O teto
por conexão é dividido pelo número de peers, respeitando o piso do preset:

```
2 pessoas na sala → 15 Mbps ÷ 1 = 15 Mbps
3 pessoas na sala → 15 Mbps ÷ 2 = 7,5 Mbps por conexão
```

### Áudio

- **Voz** — AEC, supressão de ruído e AGC ligados, 48 kbps mono, DTX.
- **Estúdio** — todo o DSP desligado, 256 kbps estéreo, frames de 10 ms. Use fone,
  senão volta eco para os outros.

O som do sistema capturado junto com a tela vai numa m-line separada, sempre
estéreo a 192 kbps e sem DSP — o áudio do jogo não passa por supressor de ruído.

Cada pessoa tem controle de volume próprio na lista de membros, salvo em disco
e vinculado a um id estável — continua valendo depois de reiniciar.

---

## Arquitetura

```
src/
  lib/
    config.ts      presets de vídeo/áudio, ICE servers, TURN, ordem de codecs
    media.ts       getUserMedia / getDisplayMedia com os constraints certos
    sdp.ts         munging: start/min/max bitrate, opus stereo, ptime
    rtc.ts         malha P2P: perfect negotiation, codec prefs, encoding, stats
    signaling.ts   cliente socket.io + senha da sala
    supabase.ts    persistência opcional (import dinâmico, fora do bundle inicial)
    prefs.ts       preferências em localStorage
    desktop.ts     ponte com o Rust (captura, atalhos, updater)
    session.ts     orquestrador — une tudo, vive fora do React
  store/
    store.ts       zustand: estado da UI
    mediaStore.ts  MediaStreams fora do React, um listener por peer
  components/      UI (todos memo, seletores estreitos)
server/index.js    signaling: http nativo + socket.io, sem Express
supabase/schema.sql
render.yaml        deploy do signaling no Render
.github/workflows/release.yml
```

### Por que full mesh

Cada peer abre uma `RTCPeerConnection` com cada outro. Latência de 1 hop e custo
de servidor zero. O preço é o upload linear descrito acima. Acima de ~5 pessoas
numa sala com tela compartilhada, o caminho seria um SFU (mediasoup/LiveKit) —
que precisa de servidor e sai do requisito de custo zero.

### Três m-lines fixas

Toda conexão negocia sempre, na mesma ordem: `audio` (microfone), `video` (tela),
`audio` (som do sistema). Ordem fixa nos dois lados torna o SDP simétrico e
permite rotear o `ontrack` pela posição da m-line. Ligar e desligar a tela é
`replaceTrack()` — sem renegociação, sem a conexão piscar.

### Perfect negotiation

Quem entra na sala oferta; quem já estava responde. O lado que responde não cria
transceiver nenhum até a oferta chegar, o que elimina glare por construção. O
padrão polite/impolite (`selfId > peerId`) cobre o resto.

---

## Atalhos

Registrados no sistema inteiro (funcionam com o jogo em primeiro plano).

| Atalho | Ação |
|---|---|
| `Ctrl+Shift+M` | microfone |
| `Ctrl+Shift+D` | ensurdecer |
| `Ctrl+Shift+E` | compartilhar tela |
| `F8` (segurar) | push-to-talk, só quando ligado nas configurações |
| duplo clique no tile | destacar/restaurar |

---

## Limitações conhecidas

- **NAT simétrico sem TURN**: a conexão não fecha. Ver a seção de TURN.
- **Seletor de tela**: o WebView2 não tem o picker do Chrome. A fonte é escolhida
  nas configurações e vira argumento de linha de comando, lido uma única vez no
  boot — por isso trocar a fonte exige reiniciar o app.
- **Mesh acima de ~5 pessoas**: o upload não acompanha.
- **Plano free do Render dorme**: ~30 s de espera no primeiro acesso do dia.
