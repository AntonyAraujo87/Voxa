# Voxa 0.5.28 — voz e som da transmissão

Correções preparadas em 8 de setembro de 2026 a partir da 0.5.27.

**Atualização de 9 de setembro:** a auditoria posterior encontrou uma falha no AudioWorklet do build minificado (`FilaPCM is not defined`) e outros defeitos de sessão. A correção da DLL permite abrir o programa, mas não valida o som da transmissão. Consulte a [auditoria atual](<C:/Tudão/Projetos/voxa/docs/AUDITORIA-2026-09-09.md>) antes de usar este documento como evidência de estabilidade. Os resultados abaixo são validações parciais.

## Correções

- Ofertas locais e sinais remotos passam pela mesma fila. Eventos simultâneos não criam ofertas concorrentes e operações encerradas não publicam SDP.
- Uma colisão antes de estabelecer mídia é respondida em uma conexão nova, evitando canais abandonados e renegociação contínua observados no Chromium. Conexões já estabelecidas usam rollback implícito; o envio de vídeo é reanexado somente depois de voltar a `stable`.
- Microfone, vídeo e áudio da tela são identificados pelo MID da descrição remota. Candidatos recebidos antes da descrição ficam em uma fila limitada.
- Uma conexão presa em `connecting` registra um timeout e tenta recuperar ICE, com tentativas limitadas. O diagnóstico inclui estados ICE/SDP, tipos de candidatos, presença de TURN e trilha de som da tela.
- A captura WASAPI confirma que o dispositivo abriu antes de retornar sucesso e informa falhas à interface. Silêncio por 500 ms não encerra mais a captura. Cada execução tem seu próprio sinal de cancelamento.
- Start/stop de áudio nativo são serializados; callbacks antigos não alimentam uma captura nova. Sair do canal durante a abertura da tela cancela a operação.
- O seletor de tela mostra a opção de compartilhar o som do computador. A ausência de trilha gera aviso.
- Volume e ensurdecimento são reaplicados quando o stream remoto muda.

## Validação executada

- `npm run verify`: 100 testes passaram, nenhum falhou.
- `npm run build`: passou.
- `npm run test:rtc`: quatro cenários passaram no Chrome 152, com duas execuções de entrada normal e duas de entrada simultânea. Cada cenário valida as três m-lines, pacotes de voz e som da tela nos dois sentidos, vídeo, reinício simultâneo de ICE e troca de trilhas.
- `cargo check`: passou no Windows com toolchain GNU e diretório temporário sem acentos. MSVC está instalado, mas o linker do Visual Studio não está disponível nesta máquina.
- `cargo fmt --check`: passou.
- Instalador NSIS local da 0.5.28 gerado. O primeiro pacote omitiu `WebView2Loader.dll`, exigida pelo executável GNU; esse pacote foi substituído pela revisão `Voxa_0.5.28_x64-setup-corrigido.exe`.
- Na revisão, o script NSIS copia a DLL ao lado de `voxa.exe`. A DLL vem da dependência `webview2-com-sys` fixada pelo Cargo.lock, com assinatura válida da Microsoft. Uma cópia dos arquivos do pacote abriu a janela **Voxa**, carregou a DLL e iniciou `msedgewebview2.exe` em perfil isolado. O teste fechou apenas essa cópia; não instalou nem publicou atualização.

Os testes de navegador usam mídia sintética e conexão local. Não confirmam o microfone físico, o dispositivo WASAPI ou a conectividade entre as duas redes dos usuários.

## Configuração do instalador local

O signaling aponta para `https://voxa-signaling.onrender.com`. O `.env` desta máquina não contém TURN nem configuração do Supabase. Portanto, este instalador é para testar voz/transmissão e **não carrega o histórico do Supabase**. Isso não apaga mensagens no banco. Uma publicação normal deve usar os secrets já referenciados no workflow de release para preservar a configuração de produção.

Nenhum serviço TURN foi provisionado. Se a conexão direta continuar falhando entre as redes, será necessário configurar um relay. Referência: [WebRTC — TURN](https://webrtc.org/getting-started/turn-server).

## Teste nos dois computadores

1. Fechar o Voxa, inclusive na bandeja, e instalar a 0.5.28 nos dois PCs.
2. Entrar no mesmo canal e testar voz nos dois sentidos.
3. Compartilhar a tela com **Compartilhar som do computador** marcado, reproduzir um som e conferir no outro PC. A captura inclui os aplicativos e chamadas que estiverem tocando na saída padrão do Windows.
4. Parar, iniciar novamente e testar alguns segundos de silêncio antes de tocar som.
5. Se falhar, aguardar pelo menos 20 segundos e copiar o diagnóstico de **ambos** os PCs. Os novos campos distinguem captura, negociação, rede e reprodução.

## Executar o teste de navegador

```sh
npm ci
npx playwright install chromium
npm run test:rtc
```

Opcionalmente, definir `VOXA_TEST_BROWSER` com o caminho de um Chrome instalado. O relatório detalhado fica em `test-results/rtc.json`, ignorado pelo Git. O CI agora executa este teste além da suíte padrão.

## Regerar o instalador de teste no Windows x64

```sh
npm run app:build:local
```

Esse comando encontra a DLL na dependência do Cargo, inclui o arquivo na raiz do instalador e verifica a instrução de cópia no script NSIS. `-- --bundle-only` permite reempacotar um executável já compilado sem alterar o código do aplicativo.

SHA-256 do instalador corrigido: `96D759D1E186974D005F8EA533D8E908F3358C4359E6F508CE15B53E501ECFAF`.
