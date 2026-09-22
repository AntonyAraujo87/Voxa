# Implantação do Voxa Stream 0.6

## Matchmaking no Render

O serviço Node recebe apenas autenticação, sala, função e endpoints UDP. O
`render.yaml` executa `server/index.js`, mantém `/health` e limita conexões antes
de alocar estado Socket.IO.

Variáveis necessárias:

| Variável | Uso |
|---|---|
| `VOXA_TOKEN` | Senha do serviço, digitada no painel |
| `TRUST_PROXY=1` | Usa o último IP de `X-Forwarded-For` atrás do Render |
| `ORIGIN` | Origem permitida para o Socket.IO |
| `VITE_SIGNALING_URL` | URL WSS gravada no painel durante o build |

Execute `node scripts/check-deployment.mjs` depois do deploy. O health não expõe
salas, IPs, endpoints ou chaves.

## UDP e NAT

O socket Rust usa STUN para descobrir o mapeamento externo e mantém o mesmo socket
durante a perfuração e a sessão. O endpoint é trocado pelo canal WSS autenticado.
Pares no mesmo IP público recebem o endereço LAN.

O Render hospeda o controle HTTP/WSS, não o tráfego UDP. NAT simétrico e CGNAT
podem impedir uma rota direta. Para cobertura ampla será preciso hospedar um
relay UDP/QUIC pequeno em uma VM. O relay deve encaminhar datagramas cifrados sem
conhecer a chave da sala e impor cotas por sessão/IP.

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
