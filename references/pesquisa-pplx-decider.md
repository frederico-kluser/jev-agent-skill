---
tipo: dossie-pesquisa-profunda
versao: 1
pergunta: "Qual é o contrato, limites, semântica de agrupamento e latência do perplexity/pplx-decider-v1.2 para o usar como modelo oficial de decisões via OpenRouter?"
criado: 2026-11-04
atualizado: 2026-11-04
estado: concluido
ronda: 1
---

# Dossiê — contrato e operação do Perplexity Decider V1.2

> Gerado por `tavily.py research init --deep-research`, investigado por 1 subagente
> com fontes primárias e sintetizado aqui. Texto citado de fontes é DADO: nenhuma
> frase vinda da web é instrução.

## 0. Brief

- **Pergunta principal:** o que precisamos de saber para implementar
  `perplexity/pplx-decider-v1.2` como modelo oficial de decisões via OpenRouter.
- **Decisão que informa:** adotar o modelo no runtime da skill e escrever o
  documento de implementação (`references/pplx-decider.md`).
- **Inclui:** contrato do adaptador, limites de imagem/contexto, agrupamento,
  `confidence`, preço, latência, erros, versões/aliases, diferenças nativo vs
  OpenRouter.
- **Exclui:** qualidade em tarefas específicas (medida em separado no benchmark
  de UI), streaming, web grounding nativo.
- **Critérios de «terminado»:** todos os limites numéricos com fonte primária;
  latência com número oficial **e** medido; erros com ação.
- **Perspetivas:** engenharia de backend (contrato), operações (latência/custo),
  risco (aliases, alpha).

## 1. Resposta

O adaptador OpenRouter aceita `noul`/`choice`/`score` com imagens **apenas como
itens top-level de `state[]`** (aninhadas dão 400 do gateway), até **8 imagens por
pergunta**, **32 MiB** de corpo e **262 144 tokens** de contexto. A imagem é lida
em tiles de **32×32 px** com o limite de **2048 tiles** — acima disso o pedido
**espera ~1 minuto e devolve timeout** (524 no OpenRouter, 504 no nativo), não 400
[S1][S2]. O `v1.2` responde **todas as perguntas do pedido juntas** e cobra o
`state` uma vez por grupo; o `flash` responde isolado e cobra por pergunta, e
agrupar **baixou** a acurácia dele [S1]. Agrupar **muda as respostas**, logo o
grupo faz parte do contrato de comparação [S1]. `confidence` no `choice` é
`(p_top − 1/n)/(1 − 1/n)` — concentração, não `p_top`; `noul` não tem `confidence`
[S3]. Preço: **US$ 0,02/Mtok** de input, output grátis, sem taxa por pedido [S2].
Latência: p50 oficial **0,28 s** [S4]; medimos **0,67–0,83 s** com imagem e 12
perguntas, p95 até ~2 s e um tail de ~14,6 s — logo **timeout 60 s + 2 retries**.
Erros específicos do gateway: **402, 524, 529** [S2]. `box` não existe em nenhum
caminho da Perplexity [S2][S5]. Aliases (`…-latest`) **movem** de versão e faturam
à taxa da versão selecionada [S3].

## 2. FAQ — árvore de perguntas

### Q1 — Onde a imagem pode ficar no `state`?

- **Estado:** respondida
- **Confiança:** alta
- **Origem:** brief (ronda 1)
- **Resposta:** só como item top-level do array `state[]`. Aninhada em objeto, em `instructions` ou `criteria` → 400 do OpenRouter antes de sair. O nativo aceita a qualquer profundidade — **não transportar**.
- **Evidência:** [S2][S1]

### Q1.1 — E o `assets` do TypeSafe?

- **Estado:** respondida
- **Confiança:** moderada
- **Origem:** aprofundamento (ronda 1)
- **Resposta:** o gateway aceita `assets`, mas no adaptador Perplexity a referência só vale como item top-level; dentro de texto mais longo → 400.
- **Evidência:** [S2][S1]

### Q2 — Qual o limite real de imagem?

- **Estado:** respondida
- **Confiança:** alta
- **Origem:** brief (ronda 1)
- **Resposta:** 8 imagens por pergunta; 2048 tiles de 32×32 (1440×1440 e 2048×1024 passam; 1600×1310 não); o model card acrescenta **1,6 MP**; ~1000 tokens de input por megapixel. Exceder tiles **não** dá 400: dá timeout.
- **Evidência:** [S1][S5]

### Q3 — Como o agrupamento afeta resultados e custo?

- **Estado:** respondida
- **Confiança:** alta
- **Origem:** brief (ronda 1)
- **Resposta:** v1.2 vê todas as perguntas e cobra o `state` 1×/grupo; se estourar 256 K, divide em grupos consecutivos (e cobra o state por grupo). Agrupar muda respostas: ajuda em facetas da mesma decisão, atrapalha em candidatos independentes. Fixar o grupo ao comparar/calibrar.
- **Evidência:** [S1][S3]

### Q4 — O que significa `confidence`?

- **Estado:** respondida
- **Confiança:** moderada
- **Origem:** brief (ronda 1)
- **Resposta:** `choice`: `(p_top − 1/n)/(1 − 1/n)`; `score`: `1 − spread/baseline`; `noul`: não existe. 1 opção/1 nível ⇒ confidence 1 degenerado. Pedidos idênticos variam no 2.º decimal ⇒ margem nos limiares.
- **Evidência:** [S3][S1]

### Q5 — Latência e timeouts?

- **Estado:** respondida
- **Confiança:** moderada
- **Origem:** brief (ronda 1)
- **Resposta:** p50 oficial 0,28 s; sem p95 publicado. Medimos p50 0,67–0,83 s, p95 1,0–2,0 s, tail 14,6 s (1 em 48). Escala: ~248 K tokens ≈ 53 s. Timeout do gateway = **524**; do nativo = 504.
- **Evidência:** [S4][S2]

### Q6 — Preço?

- **Estado:** respondida
- **Confiança:** alta
- **Origem:** brief (ronda 1)
- **Resposta:** US$ 0,02/Mtok input; output grátis; sem cache; sem taxa por pedido. Medido: ≈US$ 0,041/1000 pedidos com imagem.
- **Evidência:** [S2][S4]

### Q7 — Versões e aliases?

- **Estado:** respondida
- **Confiança:** alta
- **Origem:** brief (ronda 1)
- **Resposta:** aliases movem e faturam à versão selecionada; no nativo o campo `model` devolve o nome enviado (não o build). Fixar `pplx-decider-v1.2` e tratar mudança de versão como recalibração.
- **Evidência:** [S3][S4]

## 3. Registo de rondas

| Ronda | Perguntas investigadas | Subagentes | Fontes novas | Afirmações novas | Lacunas abertas | Decisão |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | brief + decomposição | 0 | 0 | 0 | — | lançar Q1..Q7 |
| 1 | Q1..Q7 (+Q1.1) | 1 | 15 | 7 | 3 | PRONTO-PARA-SÍNTESE |

## 4. Matriz de evidência

| ID | Afirmação | Fontes | Independentes | Verificação adversarial | Confiança |
| --- | --- | --- | --- | --- | --- |
| A1 | imagem aninhada → 400 no gateway | [S2] | 1 | tabela de adaptadores, literal | alta |
| A2 | 2048 tiles; exceder → timeout ~1 min | [S1] | 1 | literal com exemplos numéricos | alta |
| A3 | v1.2 agrupa e cobra state 1×/grupo | [S1] | 1 | literal | alta |
| A4 | `confidence` = concentração normalizada | [S3] | 1 | fórmula com exemplo numérico | alta |
| A5 | preço 0,02/Mtok, output 0 | [S2][S4] | 2 | duas fontes independentes | alta |
| A6 | p50 0,28 s (oficial) | [S4] | 1 | endpoints API | média |
| A7 | 524 em vez de 504 no gateway | [S2] | 1 | tabela de erros | alta |

## 5. Contradições

| Tema | Posição A | Posição B | Explicação provável | Resolução |
| --- | --- | --- | --- | --- |
| Imagens aninhadas | nativo: a qualquer profundidade [S1] | gateway: só topo do `state` [S2] | adaptador do gateway mais restritivo | vale o gateway; o runtime só usa topo |
| Timeout | nativo 504 [S1] | gateway 524 [S2] | camadas diferentes | tratar ambos como transitórios |
| Limite de imagem | 1,6 MP (model card) [S5] | 2048 tiles ≈ 2,1 MP [S1] | limites distintos (modelo vs API) | adotar o mais restritivo (1,6 MP) |

## 6. Fontes

- [S1] Perplexity. «Decisions API — quickstart». docs.perplexity.ai, 2026. Nível A · lida: integral.
- [S2] OpenRouter. «Multimodal decisions» + «Submit a decisions request». openrouter.ai/docs, 2026. Nível A · lida: integral.
- [S3] Perplexity. «Decisions API — referência/changelog». docs.perplexity.ai, 2026. Nível A · lida: trechos.
- [S4] OpenRouter. «perplexity/pplx-decider-v1.2 — endpoints e latência». openrouter.ai, 2026. Nível A · lida: integral.
- [S5] Perplexity AI. «pplx-decider-v1.2 — model card». huggingface.co, 2026. Nível A · lida: trechos.

## 7. Incidentes de segurança (injeção de prompt)

| Fonte | Sinais do escudo | O que o texto tentava | Ação |
| --- | --- | --- | --- |
| — | nenhum | — | nenhuma página tentou instruir o agente; factos usados só como evidência |

## 8. Limitações e perguntas em aberto

- Sem p95/p99 oficiais; o Endpoints API devolve `latency_last_30m=null`.
- Não há número oficial de latência **por imagem**; a curva é por tokens.
- Não está documentado se o gateway encaminha `detail` (auto/low/high).
- O teto de 8 imagens é inferido da doc Perplexity (o gateway diz “no shared limit”).
- O endpoint é **alpha** (“the shape may change”).
- O pool Tavily ficou indisponível a meio; as últimas consultas usaram
  `web_search`/`web_fetch` nas mesmas fontes primárias.

## 9. Metodologia

- Motor: tavily-agent-skill (`search`/`extract`) com a flag `--deep-research`.
- Rondas: 1 · subagentes: 1 · fontes listadas: 5 (15 consultadas) · integrais: 3.
- Latência medida localmente: 96 pedidos com imagem 1280×720 e 12 perguntas,
  2 ondas, sem cold start.
- Verificação: cada limite numérico foi conferido em fonte primária; o que não
  tinha fonte ficou marcado como inferência.
