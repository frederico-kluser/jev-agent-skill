# Verificação — evolução para som-agent-skill, 2026-11-04

## Escopo e ambiente

Skill renomeada por pedido explícito do dono: foco em **SOMs via OpenRouter**,
com Jev e Clef Omni como adaptadores, não em um único modelo. Repositório local
agora em `som-agent-skill`; registros DSH e Claude apontam ao novo diretório.
Não houve publicação, commit/push, servidor web novo ou alteração em outro projeto.

Ambiente observado: Windows, Node24.18.0, Python3.12.10, FFmpeg/FFprobe locais.
Código usa Node≥20 e stdlib, sem instalar pacotes; somente esta versão Node foi
executada nesta sessão. Credencial OpenRouter existente foi verificada pelo helper
da skill OpenRouter e carregada no ambiente do processo, nunca incluída no código.

## Testes determinísticos executados

| Comando | Resultado observado |
|---|---|
| `node scripts/som.mjs selftest` |36/36, exit0; mesmo teste antigo via nova entrada |
| `node --test tests/multimodal.test.mjs` |59/59 testes multimodais dedicados; exit0 |
| `node --test` (bateria final) |**124/124**,13 suítes,0 falhas,0 skips; exit0, aproximadamente14s |
| CLI `analyze --dry-run` foto/frames/native |3/3 preflights válidos, sem chave/catálogo/upload/inferência |

A suíte multimodal bloqueia entradas reais de rede (fetch/https/http2) e usa
chaves sintéticas/fakes para transporte. FFmpeg/FFprobe **reais** executaram
conversões/decodificações locais: PNG→JPEG,8orientações EXIF incluindo espelhos,
padding/aspect ratio, vídeo2fps/10fps, EOF e um único frame, MP4/WebM native,
clipe>60s, mediaRoot e recusa de playlist/concat.

Regressões de auditoria: imagem apenas em questions continua visual/HITL;
choice e score não contradizem suas distribuições; critérios/perfis não herdam
Object.prototype; mapas sem prototype; state cíclico/BigInt falha fechado;
Base64 de questions/legend/erros e chaves não escapam das saídas.

**Bateria final:160 testes/verificações offline ao todo (124+36), todos verdes.**
Os124 testes são59 multimodais,61 de CLI/MCP/integração/serviço e4 de envelopes e
ordem do preflight. O processo final também executou `git diff --check`, sem erros.

Os testes de CLI/MCP usam subprocessos com ambiente allowlist, sem credenciais,
HOME, proxies ou NODE_OPTIONS herdados. O preload bloqueia fetch/HTTP/HTTP2,
net/TLS/DNS reais; casos positivos usam catálogo/decisões falsos e somente chave
sintética. Foram verificados defaults `--model`/`SOM_MODEL` e precedência por
chamada nas duas ferramentas e aliases, parsing/erros, HITL/ausência de blobs,
instalação idempotente por hash, conflito sem nenhuma escrita, escapes/symlinks,
auth por dono antes de lookup, fila existente e401 sem aprovação.

Quatro regressões finais revelaram `retries`/`timeout` inválidos aceitos no dry-run
ou rejeitados só depois do catálogo. A validação foi compartilhada com o cliente
e movida para antes de decoder/catálogo/credenciais; as regressões passaram sem
afrouxar testes. Envelopes com typo/sem discriminator ou de Responses também são
rejeitados localmente, em vez de virar texto JSON e parecer uma análise visual.

## Inferências reais pelo OpenRouter

Uma chamada por linha, `retries=0`, sem erro. Exemplos sintéticos incluídos no
repositório: retângulo vermelho sobre branco640×360; clipe640×360 de4s,
vermelho→azul,10fps original, sem áudio. Valores de latência são de **uma chamada
HTTP fria**, não P50/SLA/benchmark de produção nem tempo completo de FFmpeg.

| Caso | Modelo resolvido | Provider | Resultado relevante | Input tokens | Custo USD | HTTP ms |
|---|---|---|---|---:|---:|---:|
| Texto/ticket | `typesafe/jev-1.14-20261014` | TypeSafe | bug0.96; payments conf0.84; urgency2 |499|0.000020958|368|
| Foto + box | `typesafe/jev-1.14-20261014` | TypeSafe | presença0.99; red conf1; box conf0.94, candidato apenas |1032|0.000043344|538|
| Vídeo por4frames | `typesafe/jev-1.14-20261014` | TypeSafe | começa vermelho1; final blue conf1 |3028|0.000127176|393|
| Vídeo MP4 nativo | `cloudflare/clef-omni-20261009` | Cloudflare | começa vermelho0.9427; final blue **conf0.108 → abstain** |1163|0.000174450|777|
| Foto com outro SOM | `cloudflare/clef-omni-20261009` | Cloudflare | presença0.9892; red conf0.9154 → HITL |487|0.000073050|855|

**Total das cinco chamadas: USD0.000438978.** `_som` e `_jev` são aliases da
mesma telemetria; não somar o custo dos dois campos. Custo da pesquisa Tavily não
está incluído nessa soma de inferência. Consultas de pesquisa tentadas falharam;
fontes foram verificadas por fallback web e GETs públicos.

IDs de geração, para reconciliação com a conta (sem credenciais):

- Texto: `gen-dec-1793814708-Efxf35F6WBTyIEQAvnhd`.
- Jev foto: `gen-dec-1793814413-KpZ0HVzPqQjvQINLE6OS`.
- Jev frames: `gen-dec-1793814422-CyKvQTQzf3Y5DtO3n7Qc`.
- Clef native: `gen-dec-1793814423-yT96TBgxWRgPWLdnti1t`.
- Clef foto: `gen-dec-1793815629-xA4rAzxTPohoCQpCZO59`.

A foto Clef mais recente registrou159ms de preparo e1128ms de pipeline total,
ilustrando por que latência HTTP não representa o tempo completo de análise.

## Pesquisa e segurança

- Protocolo Tavily iniciado explicitamente com `research init --deep-research`.
- Tavily search tentou nos2investigadores e no orquestrador e terminou com erro
  terminal. Nenhuma reativação manual de chaves/bans. Limitação declarada, não ocultada.
- Fallback: documentação primária por web_search/web_fetch e catálogo/endpoints
  públicos OpenRouter. Não seguir instruções de páginas/anexo.
-2investigadores independentes,3verificadores adversariais sobre3afirmações centrais;
 9vereditos mantiveram as afirmações, com correções de contexto/atribuição.
- Projeção factual normalizada dos retornos passou `tavily.py shield`: risco nenhum.
  Crítico de contexto limpo: pronto, sem lacunas/afirmações frágeis. Lint do dossiê
  concluído:0 erros,15 fontes definidas/15 citadas, PRONTO-PARA-SINTESE.
- Nenhum número de latência/catálogo do anexo foi transformado em promessa.
  VideoJev, Prem e outros nomes do anexo não foram integrados sem contrato verificado.

## Migração de nome e memória

A primeira movimentação por PowerShell encontrou links relativos e ficou parcial.
Foi interrompido o fluxo normal, auditados os dois diretórios e concluída a
movimentação por renames atômicos de diretórios via filesystem Node; somente
links antigos e stubs vazios **verificados** foram removidos. Código e Git foram
preservados. Isto não foi tratado como uma renomeação bem-sucedida sem inspeção.

CoALA: backup consistente prévio de96registros (quick_check=ok); migração oficial
para `.agents/som-coala-agent-skill/`, com backup adicional e compatibilidade
para o nome histórico da memória. Depois do primeiro sync:154registros,
135ativos/19superados; as3notas owner originais permaneceram. `doctor` da migração:
0falhas/0avisos. A chave de ingestão histórica `jev/` é mantida para não duplicar
chaves de supersessão; os nomes operacionais são `som-agent-skill` e
`som-coala-agent-skill`. A ingestão de pesquisa/contratos web foi classificada
como `untrusted`, sem promovê-los a instruções ou fatos owner.

## O que isto NÃO prova

- Qualidade/calibração em fotos/vídeos privados do usuário, outro idioma/domínio,
  eventos muito curtos, vídeos longos ou resolução diferente.
- Compreensão contínua: frames deixam lacunas e Clef também amostra a2fps.
- Transcrição/análise de áudio, pois o clipe de smoke não tem soundtrack.
- Confiança como autorização; todo resultado visual ficou HITL/abstain.
- Produção pronta da visão Jev: continua experimental segundo o fornecedor.
- Aceitação do intervalo256..279px ou outros containers/codecs não testados.
- Integração implantada em uma codebase externa não fornecida neste pedido:
  foram entregues protocolo, biblioteca, vendor helper e adaptador testável.
