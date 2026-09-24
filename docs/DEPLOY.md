# Implantação do Voxa Stream 0.6

## Matchmaking no Render

O serviço Node recebe apenas autenticação, sala, função e endpoints UDP. O
`render.yaml` executa `server/index.js`, mantém `/health` e limita conexões antes
de alocar estado Socket.IO.

Variáveis necessárias:

| Variável | Uso |
|---|---|
| `TRUST_PROXY=1` | Usa o último IP de `X-Forwarded-For` atrás do Render |
| `ORIGIN` | Origem permitida para o Socket.IO |
| `VITE_SIGNALING_URL` | URL WSS gravada no painel durante o build |
| `VOXA_RELAY_PUBLIC_ENDPOINT` | `IP:3479` da VM UDP; vazio desativa o fallback |
| `VOXA_RELAY_SECRET` | Segredo aleatório de 32+ caracteres, idêntico no Render e na VM |

Execute `node scripts/check-deployment.mjs` depois do deploy. O health não expõe
salas, IPs, endpoints ou chaves.

A senha escolhida no aplicativo pertence somente à sala. O cliente envia um
proof SHA-256 vinculado ao ID da sala e o processo do Render o mantém apenas em
memória enquanto houver participantes. Não configure nem distribua uma senha
global do signaling.

## UDP e NAT

O socket Rust usa STUN para descobrir o mapeamento externo e mantém o mesmo socket
durante a perfuração e a sessão. O endpoint é trocado pelo canal WSS autenticado.
Pares no mesmo IP público recebem o endereço LAN.

O Render hospeda o controle HTTP/WSS, não recebe UDP. Para NAT simétrico e CGNAT,
use uma VM Oracle Cloud Ampere A1 Always Free (sujeita à disponibilidade e aos
limites da conta) ou qualquer Linux com IP público:

```bash
git clone https://github.com/AntonyAraujo87/Voxa.git
cd Voxa
npm ci --prefix server
VOXA_RELAY_PORT=3479 VOXA_RELAY_SECRET='gere-um-segredo-aleatorio-longo' npm run relay --prefix server
```

Abra somente UDP/3479 no firewall da VCN e no firewall do sistema. No Render,
configure `VOXA_RELAY_PUBLIC_ENDPOINT=IP_PUBLICO:3479`, sem configurar
`VOXA_RELAY_PORT`, e use o mesmo `VOXA_RELAY_SECRET`. O relay encaminha apenas
datagramas ChaCha20-Poly1305, entrega credenciais diferentes ao host e ao
espectador, expira sessões inativas, limita tráfego e não conhece a chave X25519.

## Release

As versões devem coincidir em `package.json`, `package-lock.json`,
`src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` e `src-tauri/tauri.conf.json`.
O workflow cria uma release draft, compila EXE/MSI, valida manifesto e dependências,
instala/atualiza/desinstala em uma VM limpa e só então publica.

Secrets do GitHub:

| Secret | Uso |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Assinatura do atualizador |
| `VITE_SIGNALING_URL` | Matchmaking WSS |

Supabase, TURN, perfis, voz, chat e anexos não fazem parte do produto 0.6.
