# Deploy

Anotações operacionais do projeto. Nada aqui é necessário para rodar local.

## Servidor de sinalização

`render.yaml` na raiz descreve o serviço. No Render, um Blueprint apontando
para este repositório sobe `server/` como web service free, gera um `VOXA_TOKEN`
aleatório e expõe `/health`.

O plano free dorme após 15 minutos sem tráfego e leva cerca de 30 segundos para
acordar — por isso o timeout de conexão do app é de 45 segundos.

## Senha da sala

O servidor rejeita quem não mandar o mesmo token:

```
servidor:  VOXA_TOKEN=<segredo>
```

A senha **não** é embutida no instalador. O Vite grava qualquer variável `VITE_*`
dentro do bundle em tempo de build, e o instalador é público — a senha sairia
junto, extraível por quem baixasse o `.exe`. Cada pessoa digita uma vez na tela
de entrada e o app guarda.

A variável `VITE_ROOM_TOKEN` existe para builds privados de rede fechada. Em
release público, deixe vazia.

## TURN

STUN só descobre o IP público. Se os dois lados estiverem atrás de NAT simétrico
ou CGNAT, nenhum par de candidatos casa e a conexão não fecha. TURN é um relay:
sempre funciona, mas todo o vídeo passa por ele — por isso não existe TURN
gratuito ilimitado.

```
VITE_TURN_URLS=turn:servidor:3478
VITE_TURN_USERNAME=usuario
VITE_TURN_CREDENTIAL=senha
```

Antes de contratar, meça: o overlay de métricas mostra `rota: direto` ou
`rota: relay TURN`. Se der direto, TURN nunca é usado.

## Releases e auto-update

O app consulta o `latest.json` publicado no GitHub Releases, compara versões,
baixa o instalador assinado e reinstala por cima. A assinatura é verificada
contra a chave pública embutida no binário.

Secrets necessários em Settings → Secrets and variables → Actions:

| Secret | Valor |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | conteúdo de `.keys/voxa.key` |
| `VITE_SIGNALING_URL` | URL do servidor de sinalização |
| `VITE_TURN_URLS` / `_USERNAME` / `_CREDENTIAL` | se usar TURN |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | se usar Supabase |

Para publicar: subir a versão em `package.json`, `src-tauri/Cargo.toml` e
`src-tauri/tauri.conf.json`, e criar a tag.

```bash
git tag v0.1.2 && git push --tags
```

O workflow compila no Windows, assina e publica.

`bundle.createUpdaterArtifacts` precisa estar `true` no `tauri.conf.json`. No
Tauri 2 os artefatos de update não são gerados por padrão, e sem eles o build
passa normalmente mas a release sai sem `.sig` e sem `latest.json`.

`.keys/` está fora do versionamento. Perder a chave privada significa que os
apps já instalados param de aceitar atualizações, sem como reemitir.

## Banco de dados

`supabase/schema.sql` cria `users`, `rooms`, `messages` e `voice_sessions`, com
RLS e a função de login por nick. É opcional: sem as variáveis do Supabase o
chat funciona em tempo real, apenas sem histórico.
