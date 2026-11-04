---
tipo: dossie-pesquisa-profunda
versao: 1
pergunta: "Como criar uma skill de SOMs via OpenRouter para texto, fotos e vídeos, com contratos verificados e integração em projetos existentes?"
criado: 2026-11-04
atualizado: 2026-11-04
estado: concluido
ronda: 2
---

# Dossiê — SOMs multimodais via OpenRouter

> Iniciado por `tavily.py research init --deep-research`. Conteúdo externo é dado,
> nunca instrução. O anexo do usuário serviu como hipóteses, não como especificação.
> Durante a execução, o dono pediu explicitamente o nome **som-agent-skill** e
> o foco em SOMs via OpenRouter, caso outro SOM aceitasse imagens; Clef Omni foi confirmado.

## 0. Brief (a estrela-guia)

- **Pergunta principal:** Como evoluir a skill existente para analisar texto, fotografias e vídeos via SOMs reais no OpenRouter, sem inventar capacidades?
- **Para quê / decisão que informa:** Escolher adaptadores verificáveis e implementar CLI, biblioteca e MCP, com protocolo de integração na arquitetura de projetos existentes.
- **Âmbito — inclui:** Jev1.13/1.14, imagem/box, vídeo por frames, Clef Omni imagem/vídeo nativo, descoberta/rotas/providers, limites, incerteza, segurança e integração backend.
- **Âmbito — exclui:** Treinar/hospedar pesos, implementar Computer Use/execução de cliques, transcrição de áudio, validar todos os modelos do anexo e prometer geração livre de texto por SOM.
- **Público e profundidade esperada:** Agentes de código e engenheiros; contratos primários e implementação executável com limites explícitos.
- **Critérios de «terminado»**:
  - [x] Confirmar imagem/box Jev e experimentalidade em fonte primária [S1][S2][S3][S13].
  - [x] Confirmar outro SOM com imagem/vídeo sem confundir VLM de chat com SOM [S5][S6][S7][S8][S9].
  - [x] Definir pré-processamento/amostragem/saída sem prometer áudio ou observação contínua por frames [S1][S2][S10].
  - [x] Definir integração server-side, mantendo chaves e políticas locais e distinguindo decisões/relatório/ações [S3][S5][S11]; protocolo e adaptador no repositório.
  - [x] Implementar e testar caminhos determinísticos, mais smoke real, declarando limites da evidência; [relatório local](verificacao-2026-11-04.md), não generalizado como evidência de qualidade do domínio.
- **Perspetivas a cobrir:** Contrato do fornecedor, engenheiro de mídia, integrador, usuário que pede análises e crítico de segurança/calibração.
- **Restrições de fontes:** Estado2026-11-04; docs TypeSafe/OpenRouter/Cloudflare, catálogo/endpoints ao vivo; anexo só como pista. Medições comunitárias não viram SLA.

## 1. Resposta (síntese executiva)

**É possível entregar a skill de SOMs solicitada sem disfarçar um LLM de chat como System One.** Jev1.13/1.14 têm imagens experimentais;1.14 acrescenta Box, mas Jev não ingere vídeo nativo [S1][S2][S3][S4]. Clef Omni é descrito como modelo de decisões sem geração livre de texto e aceita imagem/vídeo no OpenRouter [S5][S6][S8][S9].

O caminho adotado é Jev para texto/fotos/frames e Clef Omni como alternativa real para fotos e vídeo nativo; o envelope de mídia e os limites são específicos de cada adaptador [S1][S2][S6][S7]. Vídeo nativo continua amostrado a2fps e limitado a2clipes,60s e16MiB por clipe,16MiB AV agregado; isto não é visão contínua nem garantia de transcrição [S2][S7]. A descoberta confere rota além da modalidade porque há extractors anunciando saída decisions [S8][S13].

**Confiança:** moderada no conjunto das alegações Jev por divergências documentais explícitas; alta no contrato Clef e no contraexemplo de descoberta, sem extrapolar qualidade/calibração [S1][S2][S5][S7][S8][S12]. A estabilidade de um release textual não promove suas funcionalidades experimentais à produção [S1][S4].

A implementação local foi renomeada para **som-agent-skill**, mantém relatórios determinísticos, exige revisão nas decisões visuais e oferece runtime/protocolo para integrar a arquitetura existente. Os cinco smokes reais e as suítes offline estão separados neste [relatório local](verificacao-2026-11-04.md); não são evidência web nem estudo de generalização. O crítico de contexto limpo não identificou lacunas, as3afirmações centrais sobreviveram a9vereditos e as limitações restantes estão declaradas.

## 2. FAQ — árvore de perguntas

### Q1 — Qual é o contrato verificável de imagens e box do Jev via OpenRouter?

- **Estado:** respondida
- **Prioridade:** alta
- **Confiança:** moderada
- **Origem:** brief (ronda0)
- **Resposta:** A documentação especializada afirma que Jev1.13/1.14 aceitam imagens e Box exige1.14, mas ambas as capacidades permanecem Dreamer-ready, não prontas para produção [S1][S2][S3]. Jev não recebe áudio/vídeo nativos; frames estáticos são o caminho visual documentado [S1][S4]. No OpenRouter, usa-se image_url com Data URL PNG/JPEG, com imagens no state e, no adaptador Jev, também em perguntas; a API nativa usa assets e headers próprios, não um envelope chat universal [S1][S2][S13]. Box não tem not-found, precisa de presença separada e não oferece um threshold universal; confiança ausente/null não é certeza [S3][S13][S15]. A discrepância mínima280px nativa versus256px gateway é preservada; escolheu-se280 no cliente por conservadorismo [S1][S2].
- **Evidência:** Literal especializada: “Jev 1.13 and Jev 1.14 both accept images.” [S1]. Literal Box: “There is no \"not found\" answer, so a Box question about something absent still returns four edges.” [S3]. OpenRouter corrobora as capacidades do adaptador [S2][S13].
- **Lacunas → sub-perguntas:** Q1.1 registra a contradição da documentação genérica.

#### Q1.1 — A documentação que ainda diz «texto apenas» invalida o suporte experimental?

- **Estado:** respondida
- **Prioridade:** alta
- **Confiança:** moderada
- **Origem:** contradicao (ronda2)
- **Resposta:** Existe contra-evidência documental real: uma página conceitual afirma que imagens ainda não são suportadas, e a tabela Models ainda mostra Input=Text [S12][S4]. Não se demonstrou a data/revisão que explique isso; portanto não se declara essa contradição inexistente. A página especializada Images documenta explicitamente o opt-in experimental e o OpenRouter anuncia imagem para as duas versões [S1][S2][S8]. O smoke local Jev1.14 com foto/box funcionou, reforçando o suporte operacional dessa versão sem promover a visão a produção;1.13 não teve inferência visual própria nesta sessão.
- **Evidência:** Comparação de fontes primárias [S1][S2][S4][S12] e [relatório local](verificacao-2026-11-04.md), separado de fonte web.
- **Lacunas → sub-perguntas:** Nenhum bloqueio de implementação; intervalo256..279px e causa editorial continuam não demonstrados, declarados como limitações.

### Q2 — Que SOM alternativo aceita imagem/vídeo nativo e como confirmar disponibilidade?

- **Estado:** respondida
- **Prioridade:** alta
- **Confiança:** alta
- **Origem:** brief (ronda0)
- **Resposta:** Clef Omni é descrito pela Cloudflare como modelo que não gera texto e pontua respostas permitidas em uma passagem; o catálogo OpenRouter anuncia text+image+audio+video→decisions e uma rota de Decisions [S5][S6][S8][S9]. No gateway, vídeo é video_url com Data URL Base64 no array state de topo; até2clipes, cada um≤60s E≤16MiB e soma AV≤16MiB decoded, com amostragem fixa2fps [S2][S6][S7]. MP4/WebM são os formatos explícitos incorporados; áudio de trilhas tem condições próprias, não é promessa de transcrição [S5][S6][S7]. Catálogo e endpoints são evidência de contrato/disponibilidade anunciada, não de sucesso autenticado ou qualidade [S8][S9]; o smoke local confirmou foto e MP4, sem avaliar áudio ou generalização.
- **Evidência:** Literal atribuída ao changelog correto: “Like the rest of the Clef family, it does not generate text. It scores every allowed answer in a single pass” [S5]. Literal gateway: “Clef Omni samples every video at 2 frames per second regardless.” [S2].
- **Lacunas → sub-perguntas:** Q2.1 esclarece contagem, rotas e compatibilidade; MOV e qualidade do domínio ficam fora do suporte prometido.

#### Q2.1 — Basta filtrar output_modalities=decisions para recomendar um modelo?

- **Estado:** respondida
- **Prioridade:** alta
- **Confiança:** alta
- **Origem:** lacuna (ronda1)
- **Resposta:** Não: o snapshot do catálogo inclui cloudflare/clairic com saída decisions, mas somente /api/alpha/extractions em endpoints [S8]. A descoberta desta skill exige também /api/alpha/decisions, modalidades compatíveis e um perfil de adaptador implementado; catálogos de imagem não garantem box, posição de mídia ou mesmos limites [S2][S8][S13]. A contagem35 observada inclui aliases/variantes e extractor, portanto não é total permanente de modelos distintos testados;22 no anexo é uma referência editorial datada do guia, não inventário atual [S8][S14].
- **Evidência:** GET público contendo o contraexemplo Clairic [S8]; tabela de adaptadores do guia [S2].
- **Lacunas → sub-perguntas:** Sem auditoria completa de todas as famílias do catálogo; novos adaptadores exigem contrato/testes antes de executar mídia.

### Q3 — Como transformar fotografias e vídeos em pedidos limitados e reproduzíveis?

- **Estado:** respondida
- **Prioridade:** alta
- **Confiança:** alta
- **Origem:** brief (ronda0)
- **Resposta:** Para Jev, normalizar PNG/JPEG estáticos, aplicar EXIF fisicamente e respeitar dimensões/bytes antes de enviar: o provider rejeita em vez de redimensionar automaticamente [S1][S2]. Extração FFmpeg por seek/frames permite preparar a sequência de imagens, mas não observa eventos entre amostras nem leva áudio junto do JPEG [S10][S1]. Implementou-se uma escolha de engenharia explícita: resize proporcional+padding, geometria registrada, amostras distribuídas no intervalo com teto e lacunas/taxa efetiva reportadas; timestamps são seeks solicitados, não PTS exatos. Native usa o contrato separado Clef, também amostrado a2fps, com limites cumulativos e sem fingir que processing ajusta a taxa [S2][S7]. Tokens visuais dependem do provider; Base64 não deve ser contado como texto como se previsse faturação [S2].
- **Evidência:** Limites e orientação no guia Images [S1]; seek/extração no FFmpeg [S10]; gateway/Cloudflare [S2][S7]. Implementação e testes locais no [relatório](verificacao-2026-11-04.md).
- **Lacunas → sub-perguntas:** Fórmula oficial Jev de tokens de imagem não encontrada; não se promete orçamento visual exato offline. VFR/codecs não testados podem exigir reexportação.

### Q4 — Como integrar na codebase existente sem confundir decisão, explicação e autorização?

- **Estado:** respondida
- **Prioridade:** alta
- **Confiança:** moderada
- **Origem:** brief (ronda0)
- **Resposta:** A ausência de prosa livre no SOM e a Box que retorna mesmo sem alvo impedem tratar sua saída como explicação causal ou autorização automática [S3][S5]. A recomendação deste trabalho é auditar a arquitetura e conectar um serviço de análise aos uploads/auth/filas/políticas já existentes; chaves ficam no ambiente do backend, não em código/frontend [S11]. O agente produz perguntas tipadas e explica resultados em português distinguindo probabilidade/evidência/limites; o runtime produz relatório por templates, não atribuído ao modelo [S5][S13]. Foram entregues biblioteca, CLI/MCP e helper de vendor idempotente, sem alegar integração implantada em projeto externo não fornecido; políticas locais prevalecem sobre a nova capacidade visual.
- **Evidência:** Contratos de decisão/presença e segurança de chave [S3][S5][S11][S13]; recomendações são decisões de engenharia, não resultados de estudo clínico/benchmark. Guia e serviço local em [integração](integracao-projetos.md).
- **Lacunas → sub-perguntas:** Calibração de domínio, isolamento do decoder e autorização de negócio pertencem ao projeto que chamar a skill; não há dados desse projeto externo para validar agora.

## 3. Registo de rondas

| Ronda | Perguntas investigadas | Subagentes | Fontes novas | Afirmações novas | Lacunas abertas | Decisão |
| --- | --- | --- | --- | --- | --- | --- |
|0|Brief Q1–Q4|0|0|0|4|Decompor e lançar investigação.|
|1|Q1/Q2 investigadores; Q3/Q4 orquestrador|2|12|3 centrais|2 contextuais|Contratos suficientes; verificar rotas, confiança e discrepâncias.|
|2|Q1.1/Q2.1 e tentativa de refutar C1–C3|3 verificadores +1 crítico|3|0 que mudem a escolha central|0 bloqueios documentais|9 vereditos mantêm; contexto/AND/atribuição corrigidos; crítico pronto e lint sem erros.|

Saturação: a última ronda não trouxe modelo/contrato que altere a escolha Jev-frames/Clef-native; novas fontes trouxeram objeções contextuais incorporadas, não prova de produção/qualidade universal. A mudança de nome é decisão direta do dono, não conclusão da web.

## 4. Matriz de evidência (afirmações centrais)

| ID | Afirmação | Fontes | Independentes | Verificação adversarial | Confiança |
| --- | --- | --- | --- | --- | --- |
|C1|Jev suporta imagem experimental e1.14box; vídeo visual via frames, não MP4 nativo|[S1][S2][S3][S4][S8]|TypeSafe e OpenRouter; contradição[S12]mantida|3-0 mantém;2apontam contexto parcial; confiança reduzida|moderada|
|C2|Clef Omni é SOM sem texto livre, com imagem/vídeo nativo sob limites e2fps|[S2][S5][S6][S7][S9]|Cloudflare e OpenRouter, não duplicar changelog/model page como fontes independentes|3-0 mantém; atribuição corrigida ao changelog e tetos AND|alta|
|C3|Saída decisions sozinha não garante a rota Decisions; verificar endpoints/perfil|[S2][S8][S13]|API primária A + guia; não são2fontes independentes|3-0 mantém, contraexemplo literal confirmado|alta|

## 5. Contradições

| Tema | Posição A | Posição B | Explicação provável | Resolução |
| --- | --- | --- | --- | --- |
|Jev texto apenas|Conceitos e tabela genérica dizem texto[S12][S4]|Images/gateway/catálogo dizem imagem experimental[S1][S2][S8]|Documentação genérica versus funcionalidade opt-in, revisão não demonstrada|Declarada; suporte experimental implementado/testado em1.14, não negar nem chamar produção.|
|Mínimo de imagem|TypeSafe280px[S1]|Gateway256px+área mínima[S2]|Contratos diferentes ou documentação divergente|Não resolvida256..279; normalização conservadora280.|
|Box instructions/confidence|API nativa aceita instructions opcional/null e confidence nullable[S15]|OpenRouter exige instructions e confidence é número opcional[S13]|Schemas de superfícies diferentes|Usar contrato gateway; tratar ausência/null de confiança como desconhecida.|
|Limite vídeo|Guia usa “or”[S2]|Schema Cloudflare diz16MiB AND60s[S7]|Redação ambígua|Limites simultâneos e teto AV agregado no cliente.|
|Mídia não suportada|Uma seção diz JSON textual[S2]|Tabela diz rejeição400[S2]|Inconsistência do guia|Rejeitar localmente combinações não suportadas, sem depender do servidor.|
|Catálogo de SOMs|Contagem22 no anexo|Snapshot35entradas incluindo aliases/extractor[S8]|Data/unidades distintas|Descoberta dinâmica e rota; não fixar contagem permanente.|
|Latência do anexo|Números P50 precisos|Endpoints consultados retornaram null nas métricas[S9]|Medida/data indisponível|Não confirmar/promover SLA; smoke local separado e amostra única.|

## 6. Fontes

- [S1] TypeSafe. «Images».2026. https://docs.typesafe.ai/images.md · tipo:documentacao · nível:A · lida:integral · acesso:2026-11-04
- [S2] OpenRouter. «Multimodal Decisions».2026. https://openrouter.ai/docs/guides/community/multimodal-decisions.md · tipo:documentacao · nível:A · lida:integral · acesso:2026-11-04
- [S3] TypeSafe. «Box».2026. https://docs.typesafe.ai/primitives/box.md · tipo:documentacao · nível:A · lida:integral · acesso:2026-11-04
- [S4] TypeSafe. «Models».2026. https://docs.typesafe.ai/models.md · tipo:documentacao · nível:A · lida:integral · acesso:2026-11-04
- [S5] Cloudflare. «Clef-omni adds audio and video input».2026-10-09. https://developers.cloudflare.com/changelog/post/2026-10-09-clef-omni-workers-ai/ · tipo:oficial · nível:A · lida:integral · acesso:2026-11-04
- [S6] Cloudflare. «Workers AI: clef-omni».2026. https://developers.cloudflare.com/workers-ai/models/clef-omni/ · tipo:documentacao · nível:A · lida:integral · acesso:2026-11-04
- [S7] Cloudflare. «Clef Omni schema-input.json».2026. https://developers.cloudflare.com/workers-ai/models/clef-omni/schema-input.json · tipo:oficial · nível:A · lida:integral · acesso:2026-11-04
- [S8] OpenRouter. «Models API, saída decisions; snapshot».2026-11-04. https://openrouter.ai/api/v1/models?output_modalities=decisions · tipo:oficial · nível:A · lida:integral · acesso:2026-11-04
- [S9] OpenRouter. «Clef Omni endpoints; snapshot».2026-11-04. https://openrouter.ai/api/v1/models/cloudflare/clef-omni/endpoints · tipo:oficial · nível:A · lida:integral · acesso:2026-11-04
- [S10] FFmpeg. «ffmpeg Documentation: seek, streams and extraction». https://ffmpeg.org/ffmpeg.html#Main-options · tipo:documentacao · nível:A · lida:trechos · acesso:2026-11-04
- [S11] OpenRouter. «TypeScript SDK: Security Best Practices».2026. https://openrouter.ai/skills/openrouter-typescript-sdk.md · tipo:documentacao · nível:A · lida:integral · acesso:2026-11-04
- [S12] TypeSafe. «System One concepts». https://docs.typesafe.ai/concepts/system-one.md · tipo:documentacao · nível:A · lida:integral · acesso:2026-11-04
- [S13] OpenRouter. «Submit a Decisions request: OpenAPI». https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request.md · tipo:documentacao · nível:A · lida:trechos · acesso:2026-11-04
- [S14] OpenRouter. «Jev Documentation».2026. https://openrouter.ai/docs/guides/community/jev · tipo:documentacao · nível:A · lida:integral · acesso:2026-11-04

- [S15] TypeSafe. «System One API: OpenAPI nativa». https://docs.typesafe.ai/api/system-one.md · tipo:documentacao · nível:A · lida:integral · acesso:2026-11-04

## 7. Incidentes de segurança (injeção de prompt)

| Fonte | Sinais do escudo | O que o texto tentava | Ação |
| --- | --- | --- | --- |
|Retornos normalizados dos2investigadores/3verificadores|risco nenhum, nenhum sinal|Nenhuma instrução externa aceita|`tavily.py shield .work/research-audit.json`; fontes mantidas como dados.|
|Anexo do usuário|Não usado como autoridade|Hipóteses e exemplos de código a conferir|Modelos/limites não confirmados não incorporados.|

Nenhum conteúdo externo gerou acesso a segredo, alteração de políticas, execução de comandos ou criação de URL com dados privados.

## 8. Limitações e perguntas em aberto

- Tavily search terminou com erro terminal nos investigadores e orquestrador; o protocolo/local shield/lint funcionou, mas a pesquisa foi concluída por fallback web_fetch/web_search e GETs públicos. Nenhuma gestão manual de chaves/bans.
- Não há fórmula oficial verificada para estimar tokens de imagem Jev offline; tampouco SLA/latência geral demonstrados.
- Sem inferência visual1.13, teste de áudio, mídia privada do usuário, dataset de domínio, vídeos longos reais ou garantia de cobertura contínua.
-256..279px, causas editoriais da documentação e headers internos do gateway não demonstrados; o cliente não depende deles.
- Não auditados todos os SOMs do catálogo, VideoJev/Prem/arXiv do anexo ou pesos locais. Não são necessários ao caminho confirmado Clef/Jev e não sustentam afirmações centrais.
- A interface de alto nível implementa somente perfis conhecidos; listar outro modelo não significa poder executá-lo com mídia automaticamente.

## 9. Metodologia

- Modo profundo ativado por flag explícita; Tavily init/shield/lint locais.3tentativas search terminaram com erro; fallback web registrado, não atribuído falsamente ao Tavily.
-2investigadores Q1/Q2,3verificadores independentes tentando refutar3afirmações (9vereditos), orquestrador Q3/Q4 e redator único.
- Consulta exata dos investigadores: TypeSafe Jev1.14 images box experimental OpenRouter; Clef Omni Decisions API native video limits; variações e contra-evidência nos domínios oficiais. Verificadores releram fontes e encontraram[S12],tetos AND e atribuição do changelog.3tentativas Tavily e mais de20buscas web/GETs registrados na sessão, sem afirmar contagem exata além do inventariado.
-15 fontes primárias inventariadas,13 lidas integralmente por pelo menos um investigador/verificador;2 em trechos. Não há fonte acadêmica central/DOI a certificar: o problema é de contrato/API corrente; arXiv do anexo foi excluído do escopo, não validado ficticiamente.
- Implementação e smoke são evidência **local** separada: [verificação](verificacao-2026-11-04.md), não substituem avaliação de qualidade/calibração no domínio.
- Crítico de contexto limpo: `lacunas=[]`, `afirmacoes_frageis=[]`, `veredito=pronto`. Foram6 subagentes na pesquisa (2 investigadores,3 verificadores e1 crítico), além do orquestrador. A projeção factual dos retornos e do crítico passou pelo escudo; porta final `research lint --deep-research`: sem erros, PRONTO-PARA-SINTESE.
