# Vision / computer use — "esta tela mostra TODOS estes controles?" (2026-11-04)

Segundo benchmark do dia: em vez de perguntar "o controle X está visível?"
(1 alvo por pedido), cada pedido pergunta por **12 candidatos** — todos os
controles reais da tela + rótulos **provados ausentes** dela. Mede a metade de
**deteção/enumeração** do grounding de UI, que é o que um agente de computer use
precisa antes de clicar.

- Ferramenta: `prompt-builder vision som` (novo, gera um `jev-config@1` a partir
  do `vision-dataset@1` pinado) + `jev run` (motor de decisões nativo).
- 7 telas / 5 famílias (Bootstrap, React95, Fluent, Material 3, macOS), **176
  controles reais + 208 ausentes = 384 candidatos**, 32 casos (24 treino/8
  holdout), 12 perguntas por pedido, 2 repetições.
- Custo real: **US$ 0,095** (onda 1, 8 modelos) + **US$ 0,069** (onda 2, 8
  modelos) — 1024 pedidos no total, 0 erros, **sem teto de gasto** (decisão do dono).

## O que os números significam (e o que NÃO significam)

- **F1 do conjunto aceito**: precisão = aceites corretos / aceites; recall =
  controlos reais aceites / controlos reais.
- **O teto do recall é 1 por construção**: os controlos reais são candidatos (o
  "proposer" é o DOM, não o modelo). Isto mede **decisão sobre candidatos**, não
  descoberta livre — a literatura mostra que escolher entre candidatos infla a
  acurácia face a gerar o alvo (Mind2Web: 26,8 vs 20,2; SeeAct: oráculo de
  grounding ≈ +20–30 p.p.).
- Os negativos vêm de **outras telas** e são provados ausentes no HTML da tela —
  são mais fáceis que texto estático da própria tela (decoys reais). Uma ronda
  futura deve incluir títulos/rodapés da mesma tela.
- **Nenhum SOM tem primitiva de enumeração**; só o Jev tem `box` (uma caixa por
  pergunta, sem "não encontrado"). Isto é o máximo que o contrato de decisões
  permite medir hoje.

## Onda 1 — 8 modelos (controlo: Clef Omni)

| modelo | F1 treino | prec/rec treino | F1 holdout | p50 | custo 48 pedidos |
|---|---:|---|---:|---:|---:|
| Morph Reflex | **0,927** | 0,917 / 0,938 | **0,911** | 1339 ms | $0,0093 |
| Drex Max | 0,919 | 0,909 / 0,930 | **0,911** | 10234 ms | $0,0078 |
| **Perplexity Decider V1.2** | 0,915 | 0,908 / 0,922 | 0,899 | **805 ms** | **$0,0020** |
| Perplexity Decider Flash | 0,892 | 0,885 / 0,899 | 0,879 | 1002 ms | $0,0069 |
| Jev 1.14 | 0,863 | 0,929 / 0,806 | 0,840 | **482 ms** | $0,0079 |
| Liquid d1.1 | 0,863 | 0,899 / 0,830 | 0,894 | 678 ms | $0,0025 |
| GPT-6 Luna Decisions | 0,779 | 0,907 / 0,682 | 0,800 | 1018 ms | $0,0171 |
| Clef Omni | 0,764 | 0,923 / **0,651** | 0,720 | 947 ms | $0,0181 |

## Onda 2 — 8 modelos (controlo: Perplexity Decider)

| modelo | F1 treino | F1 holdout | p50 | nota |
|---|---:|---:|---:|---|
| **Perplexity Decider V1.2** | **0,919** | 0,899 | 762 ms | repetiu 0,915/0,899 da onda 1 |
| Liquid d1-ultra | 0,909 | 0,886 | 1005 ms | contexto 32 K |
| Clef | 0,905 | **0,933** | 1186 ms | irmão grande do Omni |
| Respan Span-02 | 0,897 | 0,923 | 1089 ms | **aceitou imagem** (o guia dizia 400) |
| Baseten Elephant-1 | 0,876 | 0,879 | 743 ms | contexto 16 K |
| Inception Mercury Decide | 0,864 | 0,805 | 1207 ms | melhor precisão (0,953) e pior recall |
| Clef Flash | 0,829 | 0,871 | 1552 ms | contexto 24 K |
| Baseten Joey-1 | 0,536 | 0,644 | 729 ms | aceita quase tudo (FP alto) |

## Leitura

1. **Perplexity Decider V1.2** é o melhor equilíbrio: 1.º no treino da onda 2,
   top-3 nas duas ondas, **custo 4–9× menor** que Morph/Drex/Clef e p50 ~0,7–0,8 s.
   É coerente com a decisão de o tornar o modelo oficial.
2. **Clef Omni tem a pior recall** (0,575 no holdout na primeira tarefa; 0,651 no
   treino aqui): é conservador — rejeita controlos reais. Para "encontrar todos",
   isso é o pior erro possível.
3. **Ranking não é estável no holdout** (n=8 casos): Clef (0,933) e Span-02 (0,923)
   ficam à frente do Perplexity (0,899) por 1–2 controlos. Sem significância.
4. **Latência**: Drex Max teve p50 **10,2 s** (p95 16,7 s) nesta carga — inviável
   para UI interactiva. Clef Flash e Clef ~1,2–1,6 s.
5. **Falsos positivos** (aceitar o que não existe) são raros nos modelos de topo
   (2–12 em ~130 negativos) e explodem no Joey-1 (84).

## Limitações

- 7 telas sintéticas, 3 no holdout; sem apps reais, SO diferentes ou resoluções
  variadas. Não é ScreenSpot/UI-Vision e não é comparável com eles.
- Sem `box`/IoU: não medimos coordenadas; medimos aceitação de candidatos.
- Negativos de outras telas (fáceis); sem decoys de texto estático da mesma tela.
- Sem curva PR/ECE por modelo nesta tarefa (só F1 a 0,5); o `confidence` do
  Perplexity é concentração normalizada, não `p_top`.
- 12 perguntas por pedido **não são independentes** (mesma imagem): intervalos de
  confiança por pergunta seriam demasiado estreitos.

## Reproduzir

```bash
node dist/cli/index.js vision som --out sb.json --slots 12 \
  --models perplexity/pplx-decider-v1.2,cloudflare/clef-omni,typesafe/jev-1.14
node dist/cli/index.js jev run -c sb.json --budget 2 --dry-run --json
node dist/cli/index.js jev run -c sb.json --budget none --output-format ndjson
```

O `--budget none` é “sem teto assumido”: o custo real sai em `usage.cost` e é
somado no relatório. Artefactos desta medição (config/proveniência/record/análise)
ficam em `.work/ui-benchmark/som-elements*/` e **não** vão para o git.
