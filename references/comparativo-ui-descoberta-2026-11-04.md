# Descoberta: "o que existe nesta tela?" — só imagem, sem candidatos (2026-11-04)

Terceiro benchmark do dia e o que responde à pergunta certa: **sem HTML, sem lista
de candidatos, sem rótulos**. O modelo recebe **apenas a imagem** e responde 16
perguntas fixas: 10 tipos genéricos de controlo ("há algum botão?") + 6 regiões
("esta terça parte tem algum controlo interactivo?"). O ouro (que tipos e regiões
a tela realmente tem) vem do DOM e **nunca** entra no pedido.

- 7 telas / 5 famílias, 1 caso por tela (4 treino / 3 holdout), 16 perguntas.
- 16 modelos, 2 ondas, 2 repetições, **US$ 0,041 reais**, 0 erros, sem teto.
- Ferramenta: `prompt-builder vision som --task discovery` (novo) + `jev run`.

## Porque este desenho é diferente do anterior

O banco de *elementos* injetava os candidatos (rótulos do DOM) nas perguntas: media
aceitação, com recall de teto 1. Este **não injeta nada** — mede o que o modelo
**reporta existir** por conta própria, num vocabulário genérico. É o mais próximo
de "diz-me o que está aí" que um modelo de decisão permite.

Limite honesto: o vocabulário (10 tipos) e a grelha (3×2) são fixos por nós. Um
SOM não gera lista livre nem coordenadas — isto é o máximo sem injetar candidatos.

## Resultados

### Precisão/recall de TIPOS (o modelo diz que tipo existe)

| modelo | treino P/R/F1 | holdout P/R/F1 |
|---|---|---|
| cloudflare/clef | **0,760 / 1,000 / 0,864** | 0,941 / 0,941 / 0,941 |
| **perplexity/pplx-decider-v1.2** | 0,750 / 0,947 / **0,837** | **0,941 / 0,941 / 0,941** |
| typesafe/jev-1.13 | 0,750 / 0,947 / 0,837 | 0,941 / 0,941 / **0,941** |
| morph/reflex | 0,783 / 0,947 / 0,857 | 0,941 / 0,941 / 0,941 |
| liquid/d1-ultra | 0,773 / 0,895 / 0,829 | 0,941 / 0,941 / 0,941 |
| nace-ai/drex-max | 0,739 / 0,895 / 0,809 | 0,941 / 0,941 / 0,941 |
| typesafe/jev-1.14 | 0,720 / 0,947 / 0,818 | 0,941 / 0,941 / 0,941 |
| cloudflare/clef-omni | 0,773 / 0,895 / 0,829 | 0,929 / **0,765** / 0,839 |
| openai/gpt-6-luna | 0,692 / 0,947 / 0,800 | 0,941 / 0,941 / 0,941 |
| respan/span-02 | 0,800 / 0,842 / 0,821 | 0,938 / 0,882 / 0,909 |
| inception/mercury-decide | 0,762 / 0,842 / 0,800 | 0,941 / 0,941 / 0,941 |
| baseten/elephant-1 | 0,654 / 0,895 / 0,756 | 0,938 / 0,882 / 0,909 |
| cloudflare/clef-flash | 0,773 / 0,895 / 0,829 | 0,933 / 0,824 / 0,875 |
| perplexity/pplx-decider-flash | 0,680 / 0,895 / 0,773 | 0,938 / 0,882 / 0,909 |
| liquid/d1.1 | 0,762 / 0,842 / 0,800 | 0,938 / 0,882 / 0,909 |


### Precisão/recall de REGIÕES (onde há controlos)

| modelo | treino F1 | holdout F1 |
|---|---|---|
| nace-ai/drex-max | **0,973** | 0,750 |
| typesafe/jev-1.14 | 0,947 | 0,667 |
| liquid/d1.1 · d1-ultra · clef · span-02 · elephant-1 | 0,947 · 0,919 · 0,947 · 0,947 · 0,947 | 0,706 · 0,824 · 0,750 · 0,625 · 0,783 |
| **perplexity/pplx-decider-v1.2** | 0,944 | **0,824** |
| typesafe/jev-1.13 | 0,923 | **0,875** |
| morph/reflex · gpt-6-luna | 0,944 · 0,944 | 0,750 · 0,571 |
| cloudflare/clef-omni | 0,872 | 0,727 |

## Leitura

1. **Recall de tipos é alto (0,84–1,00); a precisão é o problema (0,65–0,80 no
   treino)**. Sem candidatos, os modelos **inventam tipos que não existem** — em
   média 1 a 2 tipos fantasma por tela. O Perplexity é dos menos inventores no
   treino (0,750) e sobe a 0,941 no holdout.
2. **No holdout quase todos saturam em 0,941**: as 3 telas são simples (login,
   painel Fluent, salvar-como) e o teste distingue pouco. O treino (4 telas
   densas) separa melhor.
3. **Regiões são mais frágeis** que tipos: F1 0,57–0,97, e o ranking muda entre
   splits. Nenhum modelo localiza bem "onde" sem caixas.
4. **Clef Omni volta a ser o mais fraco em recall de tipos** (0,765 no holdout) —
   consistente com o teste de elementos: é conservador a ponto de negar o que vê.
5. **pplx-decider-v1.2**: 0,837 treino / 0,941 holdout em tipos, 0,824 holdout em
   regiões, p50 675–792 ms, US$ 0,0025/1000 perguntas — o melhor equilíbrio do
   grupo, mas **não** o mais preciso.

## O que isto responde para computer use

- "Diz-me o que há nesta captura" **funciona**: ele acerta os tipos presentes com
  recall 0,94–1,00. É um bom **inventário grosseiro**, não um detector.
- **Não confiar no inventário para decidir o que NÃO existe**: precisão 0,75.
- Para agir, continuar a propor candidatos (DOM/OCR) e usar o modelo como
  verificador — o desenho do teste de elementos.
- Custo é irrelevante: 16 perguntas numa imagem ≈ US$ 0,0003 por tela.

## Limitações

- 7 telas, 3 no holdout; vocabulário de 10 tipos e grelha 3×2 fixos por nós.
- Sem caixas/IoU: regiões são grosseiras (terças partes), não localização.
- `noul` a 0,5 sem curva PR por tipo nesta ronda; sem ECE por tipo.
- Nada aqui compara com ScreenSpot/UI-Vision (regime diferente).
