# Voxa 0.5.29 — correções e validação

Data: 9 de setembro de 2026. Referência: [auditoria F01–F32](AUDITORIA-2026-09-09.md).

Revisão posterior: [REVISAO-0.5.29.md](REVISAO-0.5.29.md) registra cinco falhas
adicionais reproduzidas e corrigidas, incluindo a confirmação de mensagens que
este relatório inicialmente descreveu como concluída. Consulte também esse registro.

As alterações estão no código local. **Não foi gerado um instalador 0.5.29:**
a geração foi recusada pelo usuário e não foi repetida por outro caminho.
O instalador 0.5.28 disponível anteriormente não contém as mudanças deste relatório.
Também não houve publicação de release, deploy do servidor ou aplicação de SQL
no Supabase hospedado.

## O que mudou para o problema de comunicação

O áudio do sistema agora usa um AudioWorklet compilado como módulo independente,
sem depender de nomes de classes que desaparecem na minificação. O processamento
registra quantos quadros chegaram e quantos contêm som. Falha do processador
desliga a trilha afetada e informa o usuário.

As conexões têm negociação serializada, tratamento de colisões, candidatos ICE
inválidos isolados e recuperação com limite de tentativas. Operações antigas não
podem recriar uma chamada depois da saída. Trocas de qualidade são coordenadas
com o estado da negociação, incluindo quem recebe a resposta. O servidor só
encaminha sinalização entre participantes do mesmo canal de voz.

Sair encerra microfone, câmera, compartilhamento e efeitos. Capturas que terminam
de abrir depois de um cancelamento são descartadas. Mudo, ensurdecimento e PTT
são reaplicados conforme o estado atual após operações assíncronas. A troca de
microfone trata falhas e permite recuperação; o fallback de câmera/microfone
preserva o dispositivo escolhido.

Isso corrige causas reais no cliente e servidor. **Não comprova que a chamada
entre os dois computadores do relato já funcione:** o perfil local segue sem
TURN configurado, e não houve teste físico dos dois PCs ou do loopback Windows.

## Situação de cada achado

“Corrigido no código” descreve o defeito implementado; não significa que todos
os ambientes, serviços ou sugestões de evolução daquele item tenham sido testados.

| Achado | Alteração | Situação e limite |
|---|---|---|
| F01 — worklet de produção | Módulo Vite independente, carregamento por contexto, erro do processador e contadores PCM | Corrigido; teste do bundle minificado com amostras conhecidas |
| F02 — sinalização fora do canal | Autorização no servidor, validação de payload/canal/self e descarte no cliente | Corrigido; integração do servidor e regressão do cliente |
| F03 — câmera após sair | Encerramento unificado de câmera/tela na saída | Corrigido; regressão e teste de interface |
| F04 — entrada tardia reabre chamada | Gerações para entrada, mídia e retorno de ACK | Corrigido; cancelamento e ACK tardio reproduzidos |
| F05 — mudo divergente | Uma aplicação do estado atual de mudo/PTT/ensurdecimento após abertura | Corrigido; regressões de abertura pendente e PTT |
| F06 — captura concorrente | Abertura compartilhada, invalidação e encerramento de resultado antigo | Corrigido; regressões de concorrência e descarte |
| F07 — ACK prende próximas entradas | Timeout de requisição e validação da resposta de canal; leave não fica preso ao limite de join | Corrigido; teste de ACK tardio e integração |
| F08 — PTT no Windows | Restauração da preferência e registro coerente com ativação | Corrigido no código Rust/TS; tecla global física ainda não testada |
| F09 — ausência de TURN | Emissão de credenciais temporárias no servidor, renovação e uso das credenciais atuais no restart | Suporte implementado; provisionamento, configuração e teste relay reais pendentes |
| F10 — senha corrigida sem reconexão | Uma identificação por tentativa, cancelamento de listener antigo e reativação da reconexão | Corrigido; login errado seguido de correto testado |
| F11 — ICE inválido aborta resposta | Falha de candidato não interrompe os seguintes nem a resposta SDP | Corrigido; teste específico |
| F12 — métricas falsas | Soma de todos os RTP de áudio, separação microfone/tela, amostra/rota selecionada e ausência de medição explícita | Corrigido no diagnóstico; overlay evita presumir ping/perda/GPU sem informação. Métricas bidirecionais de vídeo ainda compartilham um resumo |
| F13 — overflow PCM | Contagem da parte restante do bloco e descarte limitado de blocos grandes | Corrigido; testes de fila |
| F14 — fonte salva confundida com ativa | Comando informa a fonte efetiva deste processo; preferência fica para próximo boot | Defeito corrigido. Picker nativo por identificador estável, prévia e seleção individual de monitores não implementados |
| F15 — som desligado ainda enviado | Opção controla captura e trilha enviada; transições câmera/tela compartilham cancelamento | Defeito corrigido. Loopback ainda captura saída padrão inteira, inclusive potencial retorno do Voxa; seleção dinâmica/exclusão por processo pendentes |
| F16 — histórico apaga mensagens | Carregamento separado do array e merge estável por UUID | Corrigido; duas regressões de histórico versus mensagens ao vivo |
| F17 — falha inicial de histórico | Cliente reutilizado, recuperação de mapa de canais, erro distinto de lista vazia, timeout e invalidação por token | Recuperação corrigida; consulta inicial de mensagens deixa de bloquear a entrada. Autenticação/perfil/canais opcionais ainda são aguardados antes da sinalização, com prazo por requisição |
| F18 — identidades/entrega divergentes | UUID compartilhado com banco, ACK/eco, falha visível, reenvio, limite 2000 e cursor composto | Corrigido no fluxo principal. Banco usa relógio próprio; rejeição de persistência permanece visível. Dedupe do servidor é limitado por socket e não é garantia de entrega exatamente uma vez entre reinícios |
| F19 — autores ocultos por RLS | Função restrita para leitura de perfil de membro da mesma sala | SQL preparado e testado com dois membros e um não membro; migração hospedada pendente |
| F20 — anexos públicos | Bucket privado, URL temporária, autorização por sala e quota de objetos | SQL e cliente preparados; migração pendente. Limpeza automática de órfãos/retencão não implementada; quota exige administração |
| F21 — rotação não revoga | Trigger revoga membros na mudança do hash; travas atômicas no login e limite de mensagens | SQL testado localmente. URLs já assinadas duram até expirar; várias identidades anônimas exigem proteção do provedor |
| F22 — troca de atalho destrutiva | Valida/registre novo antes de remover antigo, rollback e remoção real da tecla PTT | Corrigido no código; conflito com outros programas ainda requer teste Windows |
| F23 — overlay oculto/listeners | Detector necessário continua, prontidão após listeners, limpeza de registro tardio e limite visual de participantes | Corrigido; DPI múltiplo, jogo e janelas nativas não exercitados |
| F24 — preferências inconsistentes | Cache validado, identidade estável, enums/intervalos/volumes normalizados e flush ao sair | Corrigido; regressão de preferências |
| F25 — erro de update parece sucesso | Erro explícito e estado ocupado encerrado em finally | Corrigido; update real não executado |
| F26 — WebView/anexos permissivos | CSP, mídia autorizada apenas para origem local, origem dos anexos restrita e URLs assinadas | Corrigido no código. CSP precisa de ajuste se for usado domínio Supabase personalizado |
| F27 — qualidade/tráfego divergentes | Parâmetros serializados/reaplicados após SDP, orçamento dividido e envio só a espectadores atualizados | Corrigido; RTC e interface testados. Desempenho 4/8 usuários e GPU física não medidos |
| F28 — dispositivo real diverge | Evento devicechange, captura encerrada detectada, fallback preserva escolha e troca de mic trata erro | Correções de entrada/saída do player; loopback Windows não acompanha troca de endpoint |
| F29 — chat/acessibilidade | Rascunho por canal, texto preservado em recusa, foco/Tab/Escape em diálogos e volume fora do recorte | Melhorias implementadas; não é auditoria completa de contraste/leitor de tela |
| F30 — soundboard sem limite/limpeza | Limites de duração/PCM/cache/fontes, gravações serializadas e confirmação da transação; botão Parar efeitos | Corrigido no fluxo principal. Sons de interface ainda precisam de revisão uniforme de saída/ensurdecimento |
| F31 — distribuição insuficiente | CI do commit da tag, draft antes de promoção, checagem de imports, manifesto/hash, remoção de --bundle-only e testes de mídia de produção | Barreiras implementadas. Instalador 0.5.29 não gerado; instalação/update/desinstalação em máquina limpa e Authenticode pendentes |
| F32 — operação/documentação | Health agregado, limite global, proxy explícito, restart em exceção, fechamento sem bandeja e trim só ocioso | Corrigido no código/documentação. Servidor segue em memória/instância única; métricas operacionais históricas e carga não implementadas |

## Validação local

| Verificação | Resultado |
|---|---|
| TypeScript e testes unitários | PASS — 104 testes, zero falhas |
| Regressões de ciclo de vida e histórico | PASS — 14 casos |
| PostgreSQL/PGlite | PASS — 10 verificações; scripts anteriores mais audit-3, aplicada duas vezes |
| WebRTC no Chrome 152 | PASS — 4 cenários: entrada normal e colisão inicial, duas repetições, restart simultâneo e substituição de trilhas |
| Interface compilada + servidor local + duas sessões | PASS — 7 verificações: login, áudio RTP com energia recebida, vídeo só ao assistir, reprodução, ocultar, saída e foco/Escape |
| Worklet minificado | PASS — 48.000 quadros estéreo conhecidos, incluindo contagem de som |
| Build Vite | PASS — TypeScript e bundle de produção |
| Rust | PASS — cargo check; cargo fmt --check; Clippy com -D warnings |
| Checagem de dependências PE | PASS — parser no executável 0.5.28 existente; detecta WebView2Loader.dll e exige a DLL ao lado ou no manifesto NSIS |

Os relatórios de execução ficam em `test-results/` e os logs em `work/`, ambos
ignorados pelo Git. A mídia dos testes é gerada por canvas/oscillator. O dispositivo
de câmera falso deste Chrome encerrou a captura até numa página mínima; por isso
o teste usa fonte sintética controlada. Não houve escuta humana nem captura de
hardware durante essa validação. PGlite usa uma estrutura local mínima de Auth e
Storage para testar RLS: não equivale ao serviço hospedado.

## O que falta para validar uma distribuição

1. Configurar TURN no servidor e validar rota relay entre redes diferentes.
2. Distribuir cliente compatível com anexos privados e aplicar audit-3 em
   homologação, incluindo upload/download pela API real; depois planejar produção.
3. Gerar um instalador quando isso for autorizado; validar instalação e update
   com WebView2 numa máquina limpa. O pacote antigo não testa o código novo.
4. Testar WASAPI com jogo, silêncio/som, headset diferente, mudança de saída e
   chamada simultânea, principalmente o possível retorno da voz pelo loopback.
5. Medir CPU/GPU/upload com 4/8 usuários e janela oculta. Evoluções de captura
   por processo, picker nativo, SFU e permissões por pessoa exigem trabalho próprio.

Não há declaração de “zero bugs” ou de eliminação de falhas futuras. Este relatório
separa alterações verificadas localmente das capacidades que precisam de ambiente
externo, hardware ou implementação adicional.
