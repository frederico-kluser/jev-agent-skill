# Comparação de SOMs para interfaces — resultado (2026-11-04)

Execução paga **autorizada pelo dono** (teto US$ 2), uma única vez, pelo
`prompt-builder` **adaptado** para decisões com mídia. Nada foi repetido.

- Run: `0afebb8f-b089-4ca4-9327-d7efdb1403fa` · status `finished` · **custo real US$ 0,047212** (pendente 0)
- 28 casos (16 treino / 12 holdout) × 3 perguntas × **2 repetições** × 7 SOMs = **392 pedidos**, 0 erros, 0 células inválidas
- Dataset: `vision-dataset@1` v0.3.0 do prompt-builder, hash JCS `sha256:debb7a1f…e95f`,
  bytes `80c14319…5503`; imagens **1280×720 JPEG q6** idênticas para todos os modelos
  (PNG lossless foi recusado antes por orçamento textual — corrigido no motor, ver abaixo)
- Partição **a priori por cena** (nunca a mesma tela nos dois lados); spec congelado antes do gasto
  (`sha256:d64b92a274fb3bb25098ddcaa774999e8fc9abb27e34ec41cf0b7f415e589a09`)
- Juiz: **nenhum** — o ouro vem do DOM do fixture (presença, tipo e quadrante do centro)
- Gabarito: presença = controle **visível** (inclusive `disabled`) com `label`/`iconDescription`
  literal; quadrante com alternativa adjacente quando o centro cai na mediana

## Resultado por split

### Treino (4 cenas, 16 casos) — usado para escolher

| SOM | acurácia | macro-F1 | ECE | presença (FP/FN) | tipo | quadrante | p50 |
|---|---:|---:|---:|---|---:|---:|---:|
| **Perplexity Decider V1.2** | **0,958** | 0,862 | 0,082 | **1,000 (0/0)** | 0,875 | 1,000 | 628 ms |
| Liquid d1.1 | 0,938 | 0,915 | 0,092 | 1,000 (0/0) | 0,875 | 0,938 | 482 ms |
| Drex Max | 0,938 | 0,909 | 0,077 | 1,000 (0/0) | 0,875 | 0,938 | 1479 ms |
| Morph Reflex | 0,917 | 0,851 | 0,063 | 1,000 (0/0) | 0,813 | 0,938 | 1029 ms |
| GPT-6 Luna Decisions | 0,917 | 0,838 | 0,104 | 0,938 (0/1) | 0,875 | 0,938 | 733 ms |
| Jev 1.14 | 0,896 | 0,867 | 0,077 | 1,000 (0/0) | 0,750 | 0,938 | 418 ms |
| Clef Omni (controle) | 0,813 | 0,728 | 0,153 | 0,875 (0/2) | 0,813 | 0,750 | 1121 ms |

### Holdout (3 cenas, 12 casos) — só confirmação, não reescolha

| SOM | acurácia | macro-F1 | presença (FP/FN) | tipo | quadrante | p50 |
|---|---:|---:|---|---:|---:|---:|
| Jev 1.14 | 0,944 | 0,950 | 1,000 (0/0) | 1,000 | 0,833 | 380 ms |
| **Perplexity Decider V1.2** | **0,944** | 0,887 | **1,000 (0/0)** | 1,000 | 0,833 | 629 ms |
| Liquid d1.1 | 0,889 | 0,867 | 0,917 (0/1) | 0,833 | 0,917 | 517 ms |
| Drex Max | 0,889 | 0,785 | 0,917 (0/1) | 1,000 | 0,750 | 1414 ms |
| GPT-6 Luna Decisions | 0,861 | 0,779 | 1,000 (0/0) | 0,917 | 0,667 | 735 ms |
| Morph Reflex | 0,861 | 0,758 | 0,917 (0/1) | 0,917 | 0,750 | 903 ms |
| Clef Omni (controle) | 0,778 | 0,742 | **0,750 (1/2)** | 0,833 | 0,750 | 945 ms |

Custo real por 1000 células (mesmas tarefas): Perplexity **US$ 0,031**, Liquid 0,039,
Morph 0,084, Drex 0,100, Jev 0,144, GPT-6 Luna 0,180, **Clef 0,265** (~8,6× o Perplexity).

Comparações pareadas vs Clef (acurácia): +8,3 p.p. (Jev) a +14,6 p.p. (Perplexity) no
treino e +8,3 a +16,7 p.p. no holdout, **todas com McNemar p ≥ 0,12** — direção
consistente, **sem significância estatística** com 16/12 casos.

## Decisão (regra registada antes do gasto)

A regra exigia ≥5 p.p. no treino, sem regressão de acurácia no holdout e sem aumento
de falso-positivo de presença. **Perplexity Decider V1.2** cumpre: melhor acurácia no
treino, empate no topo do holdout, presença perfeita nos dois splits, custo e latência
menores que o controle.

- **Adotado como recomendação para screenshots/UI** (`UI_SCREENSHOT_MODEL`), atrás de
  política do projeto e com revisão humana.
- **Clef Omni NÃO foi removido**: continua o único SOM do catálogo com **vídeo nativo**
  (`input_modalities=video`) e o adaptador implementado para MP4/WebM.
- Jev 1.14 continua a única opção de **`box`** (experimental) e o mais rápido.

## Limitações (não generalizar)

- 7 capturas sintéticas (3 no holdout) e 5 famílias: **sinal exploratório**, não um
  benchmark de indústria; ECE/rankings não são estáveis a essa amostra.
- Tarefa = classificação tipada (presença/tipo/quadrante). **Não** mede grounding
  livre, IoU de caixa, OCR arbitrário, clique nem geração de código.
- Entradas JPEG q6 idênticas para todos; artefactos de compressão afetam a todos.
- Sem `box` nessa régua; a superioridade de localização do Jev não foi testada aqui.
- Custo/tokens vêm de `usage.cost` desta run; preço de catálogo pode mudar.
- Provider por endpoint observado (Cloudflare/OpenAI/TypeSafe/DeepInfra/Morph/Liquid/Perplexity);
  não dá para fixar provider no runner JEV, então o número é do serviço servido.

## Adaptação do prompt-builder que tornou isto possível

O motor JEV contava o Data URL Base64 como **texto** (chars/4): um screenshot 1280×720
virava ~10 mil tokens e o `budget.context` recusava a run (73.193 > 65.536). A correção
(`src/engine/jev/media.ts` + lint/estimativa):

- mídia tipada sai da conta de texto e entra **estimativa visual por área** (~área/750,
  máx. 4096; 1800 sem dimensões; vídeo 12 000) — declarada, nunca fatura;
- validação por **perfil de adaptador** (TypeSafe 280..1568 px, 16 MiB, 64 imagens,
  aninhado; Clef 4 MiB, 4 imagens, topo; genérico para as demais famílias) com
  `state.media_axis|size|mime|count|position|invalid|unsupported`;
- `state.blob`/`state.large` deixam de acusar um Data URL legítimo; base64 fora da
  mídia continua a ser avisado;
- 12 testes novos em `test/jev-media.test.ts`; 106 testes JEV existentes continuam verdes.

Efeito no pré-voo desta run: estimativa caiu de US$ 0,38–0,71 (7,58 M "tokens") para
US$ 0,046–0,087 (930 mil tokens); custo real US$ 0,047.

## Artefatos

- Config/casos/proveniência: `.work/ui-benchmark/jpeg1280-q6/` (gitignored; **contém Base64
  sintético**, não publicar).
- Record da run: `.work/ui-benchmark/pb-som-run/jev-runs/0afebb8f-b089-4ca4-9327-d7efdb1403fa.json`.
- Análise por split e telemetria: `analysis.json` / `telemetry.json` na mesma pasta.
- Gerador dos casos: [benchmarks/ui/build-dataset.mjs](../benchmarks/ui/build-dataset.mjs)
  (28 casos, 7 cenas, ouro do DOM, splits por cena, sem rede).
