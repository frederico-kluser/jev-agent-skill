# SOMs para analisar interfaces — pesquisa e protocolo, 2026-11-04

## Estado desta etapa

Pesquisa documental e descoberta pública concluídas. **Ainda não há vencedor
experimental nem inferência desta comparação**. A execução paga será feita pelo
`prompt-builder` somente após dry-run e aprovação do conjunto/orçamento.
O objetivo é escolher um adaptador **para screenshots/UI**, não confundir uma
substituição de imagens com suporte a vídeo nativo.

## Candidatos confirmados no OpenRouter

Todos os sete IDs abaixo foram verificados em2026-11-04: entrada text+image,
saída decisions e endpoint `/api/alpha/decisions`. Snapshot versionado, sem aliases
móveis. Preços são USD/Mtokens de entrada do catálogo, não custo garantido por tela.

| Candidato | Snapshot | Provider observado nos endpoints públicos | Entrada USD/M | Motivo para medir |
|---|---|---|---:|---|
| Clef Omni (controle) | `cloudflare/clef-omni-20261009` | `cloudflare` |0.15|Controle atual e único caminho nativo de vídeo confirmado.|
| Jev1.14 | `typesafe/jev-1.14-20261014` | `typesafe` |0.042|Único com box, mas visual experimental; aqui medir só primitivas comuns.|
| Perplexity DeciderV1.2 | `perplexity/pplx-decider-v1.2-20261016` | `perplexity` |0.02|27B, agrupamento de perguntas e contexto262144.|
| GPT-6 Luna Decisions | `openai/gpt-6-luna-decisions-20261006` | `openai` |0.10|Modelo de decisões, não endpoint de chat; contexto1050000.|
| Liquid d1.1 | `liquid/d1.1-20261027` | `liquid` |0.02|Outro adaptador visual de baixa tarifa; imagem é cobrada por pergunta.|
| Morph Reflex | `morph/reflex-20261103` | `morph/bf16` |0.042|Recente, cache e imagens; sem inferir qualidade pelo marketing.|
| Drex Max | `nace-ai/drex-max-20261016` | `deepinfra/us` |0.06|Fornecedor publica métricas no domínio UI; precisam de confirmação local.|

As métricas de latência/throughput dos endpoints consultados eram null. Não
inventar P50. Catálogo/provider/documentação não substituem smoke ou avaliação.
O catálogo também inclui extractors, como Clairic, com saída decisions mas rota
`/api/alpha/extractions`: não elegíveis para este benchmark.

## Fontes primárias e limites relevantes

- [Catálogo de decisões com imagem](https://openrouter.ai/api/v1/models?output_modalities=decisions&input_modalities=image)
  e [catálogo com vídeo](https://openrouter.ai/api/v1/models?output_modalities=decisions&input_modalities=video).
  O segundo retornou somente Clef Omni; manter esse caminho ao trocar o modelo de UI.
- [Contrato multimodal OpenRouter](https://openrouter.ai/docs/guides/community/multimodal-decisions):
  strings e `image_url` no topo de state; Base64/Data URL; sem download remoto.
- [Jev Images](https://docs.typesafe.ai/images.md) e
  [Box](https://docs.typesafe.ai/primitives/box.md): visual Dreamer-ready; box não
  tem not-found. Mínimo conservador280px/eixo, máximo1568; PNG/JPEG estáticos.
- [Perplexity Decisions](https://docs.perplexity.ai/docs/decisions/quickstart.md):
  agrupamento pode mudar respostas; até8 imagens/pergunta e2048tiles32×32 por
  imagem. Fixar as mesmas perguntas/agrupamento. Não usar web grounding para UI.
- [Liquid d1](https://docs.liquid.ai/lfm/models/d1.md): até8 imagens, JSON4.5MB,
  até10000patches; “Every question is charged for its text and all the images again.”
- [Morph Reflex](https://docs.morphllm.com/models/reflex): cache é computação
  reutilizada, não resposta salva; confiança tem semântica própria. Não transferir
  thresholds de Clef, nem tratar preço de token como custo por screenshot.
- [Drex Max, fornecedor](https://www.nace.ai/blog/introducing-drex-max) e
  [DeepInfra API](https://deepinfra.com/nace-ai/drex-max/api): índices de UI são
  alegações do fabricante, não nossa reprodução. Common contract choice2..52,
  até64 perguntas. Vídeo anunciado no blog não aparece no catálogo OpenRouter.
- [GPT-6 Luna Decisions no OpenRouter](https://openrouter.ai/openai/gpt-6-luna-decisions):
  até128 imagens/200 perguntas no contrato anunciado do gateway. Não transportar
  URLs/remotas/formatos/limites da API nativa OpenAI sem verificação do adaptador.
- [Clef Omni](https://developers.cloudflare.com/workers-ai/models/clef-omni/):
  sem box, até4 imagens; vídeo nativo2fps, até2clipes, cada60s E16MiB,
  AV agregado16MiB decoded.

Não há evidência suficiente aqui para chamar qualquer candidato de melhor universal
para interfaces, OCR, reconstrução de frontend, clique ou UX heurística. São tarefas
com contratos diferentes. Decisões fechadas sobre rótulos conhecidos não equivalem
a OCR/transcrição livre, e quadrante não equivale a coordenada/IoU.

## Ferramenta e desenho congelado antes da medição

O checkout existente do prompt-builder tem dois motores distintos:

- `vision run` usa Chat Completions/JSON gerativo, portanto não será usado
  simplesmente colocando IDs de SOM em `--models`.
- `jev-config@1`, modo compare, aceita até8 modelos em `models.decision` e
  preserva state com partes `image_url`; essa é a via nativa de decisões.
  Somente noul/choice/score; box não é suportado por essa régua.
- `models.llm` no modo JEV serializaria a imagem como texto; não será usado.
  Não há juiz LLM: o ouro é do fixture/DOM, não voto de outro modelo sob teste.
- Fit é `false` (boolean), sem treinar prompt/temperatura no holdout.
- O provider não é fixável nesse runner JEV; registrar a versão/provider que
  estiver disponível no record e interpretar custo/latência como serviço servido.
- CLI JEV não oferece idempotency-key/resume de execução terminada: executar
  uma vez, guardar runId, nunca repetir silenciosamente um gasto.

Dataset: `vision-dataset@1`, v0.3.0,7capturas/5famílias/197controles. O CLI
verificou308arquivos sem erro. Hash semântico JCS:
`debb7a1fa60e3532fdcc35bee3a3c83cc18d3646d9b01a507e8f6ee7daebe95f`.
SHA-256 dos bytes do manifesto desta cópia:
`80c14319b169a874a3f4c00bba902bb900e4781aeee7c4f74d35606c5c7a5503`.
Esses hashes têm semânticas distintas; não comparar o hash JCS aos bytes brutos.

Protocolo revisado **antes de inferir**:7imagens1280×720, **PNGs lossless já
pinados do dataset**, com os mesmos bytes para todos os modelos;4casos/cena (2controles presentes e2rótulos plausíveis ausentes),3perguntas
(presença, tipo, quadrante),7modelos,2repetições:392requests/1176decisões planejadas.
O preparo inicial JPEGq6 foi recusado pelo teto local90KiB: React95 produziu
113592bytes. Não houve run nem resultado de modelo. Em vez de degradar resolução
ou texto para comprimir, a revisão explícita passou aos PNGs1280 originais;
teto local185KiB (189440bytes) mantém a estimativa textual abaixo do menor contexto comum,
ainda sujeito ao lint real do PB. Não é exceção ao limite do provider nem remoção
da imagem para fazer o benchmark passar.

Presence refere-se a controle visível, inclusive disabled, com label/icondescription
observável, não a texto estático nem aria-label invisível. Empates geométricos na
linha média aceitam os quadrantes adjacentes, registrados no ouro/proveniência.

Partição a priori por **cena**, não por pergunta/resolução:

- Desenvolvimento/train: bootstrap-painel-cursos, react95-painel, material-painel,
  macos-finder.
- Holdout: bootstrap-login, fluent-painel, macos-salvar-como.

Compare agrega todos os splits. O pós-processamento deve filtrar **cases e cells**
por split e usar a mesma régua do PB, sem vazar state/Base64. Não ajustar spec/modelos
após ver o holdout.28casos/2reps NÃO são28ou56capturas independentes: Nde telas=7,
com apenas3telas no holdout. A evidência é exploratória e sintética.

### Regra de seleção, registrada antes do gasto

1. Usar acurácia de desenvolvimento como régua principal; distribuições/Brier,
   erros, FPde presença, repetibilidade, custo medido e latência como diagnóstico.
2. Não promover candidato com disponibilidade<95% ou casos/versão inválidos.
3. Escolher o melhor desenvolvimento; empate de acurácia usa Brier, depois custo
   exato/latência. Não selecionar de novo olhando o holdout.
4. Para substituir o controle no papel UI: ganho de pelo menos5p.p. no
   desenvolvimento, sem regressão de acurácia nem aumento de FPde presença no
   holdout. Se falhar, manter o controle/seleção anterior e declarar inconclusivo.
5. Mesmo se qualificar, recomendar só para o escopo medido, manter overrides e
   HITL. Não transplantar thresholds nem remover Clef do vídeo nativo.

## Custo e privacidade

Teto proposto para aprovação: **US$2**, sujeito ao dry-run. A estimativa PB ainda
conta Base64 como texto, portanto não é estimador calibrado de tokens visuais.
Se o lint/contexto recusar, não remover a imagem para passar: corrigir o protocolo
uniformemente e recongelar antes de gastar. Custo final vem de `usage.cost` e
pendências; orçamento local não é garantia universal de cobrança por request.

Config/record JEV persistem state completo: usar apenas fixtures públicos
sintéticos, derivados em `.work/`, nunca screenshots privados. Não publicar
run records crus. Relatórios entregues devem ser sem Base64/headers/chaves.

Tavily foi tentado em pesquisa simples (o pedido atual não tem `--deep-research`)
e terminou em erro terminal; nenhum unban/gestão manual. O fallback usou fontes
primárias por web e GETs públicos. Isso não é apresentado como pesquisa Tavily
bem-sucedida nem como benchmark já executado.
