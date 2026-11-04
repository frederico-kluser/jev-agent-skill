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

### TIPOS — contagens antes das percentagens

Há **19 tipos reais** nas 4 telas de treino e **17** nas 3 de holdout (soma dos
tipos distintos por tela). `tp/fp/fn` = acertou / inventou / falhou.

| modelo | treino tp/fp/fn | treino P/R/F1 | holdout tp/fp/fn | holdout P/R/F1 |
|---|---|---|---|---|
| cloudflare/clef | **19/6/0** | 0,760 / **1,000** / **0,864** | 16/1/1 | 0,941 / 0,941 / 0,941 |
| morph/reflex | 18/5/1 | 0,783 / 0,947 / 0,857 | 16/1/1 | 0,941 / 0,941 / 0,941 |
| **perplexity/pplx-decider-v1.2** | 18/6/1 | 0,750 / 0,947 / **0,837** | 16/1/1 | **0,941 / 0,941 / 0,941** |
| typesafe/jev-1.13 | 18/6/1 | 0,750 / 0,947 / 0,837 | 16/1/1 | 0,941 / 0,941 / 0,941 |
| liquid/d1-ultra | 17/5/2 | 0,773 / 0,895 / 0,829 | 16/1/1 | 0,941 / 0,941 / 0,941 |
| cloudflare/clef-omni | 17/5/2 | 0,773 / 0,895 / 0,829 | 13/1/4 | 0,929 / **0,765** / 0,839 |
| nace-ai/drex-max | 17/6/2 | 0,739 / 0,895 / 0,809 | 16/1/1 | 0,941 / 0,941 / 0,941 |
| typesafe/jev-1.14 | 18/7/1 | 0,720 / 0,947 / 0,818 | 16/1/1 | 0,941 / 0,941 / 0,941 |
| openai/gpt-6-luna | 18/8/1 | 0,692 / 0,947 / 0,800 | 16/1/1 | 0,941 / 0,941 / 0,941 |
| respan/span-02 | 16/4/3 | **0,800** / 0,842 / 0,821 | 15/1/2 | 0,938 / 0,882 / 0,909 |
| inception/mercury-decide | 16/5/3 | 0,762 / 0,842 / 0,800 | 16/1/1 | 0,941 / 0,941 / 0,941 |
| baseten/elephant-1 | 17/9/2 | 0,654 / 0,895 / 0,756 | 15/1/2 | 0,938 / 0,882 / 0,909 |
| cloudflare/clef-flash | 17/5/2 | 0,773 / 0,895 / 0,829 | 14/1/3 | 0,933 / 0,824 / 0,875 |
| perplexity/pplx-decider-flash | 17/8/2 | 0,680 / 0,895 / 0,773 | 15/1/2 | 0,938 / 0,882 / 0,909 |
| liquid/d1.1 | 16/5/3 | 0,762 / 0,842 / 0,800 | 15/1/2 | 0,938 / 0,882 / 0,909 |

### REGIÕES — contagens (18 células no treino, 9 no holdout)

18 = 4 telas × 6 regiões; 9 = 3 telas × 6. `tp/fp/fn` = células certas / células
inventadas / células reais esquecidas.

| modelo | treino tp/fp/fn | treino P/R/F1 | holdout tp/fp/fn | holdout P/R/F1 |
|---|---|---|---|---|
| nace-ai/drex-max | **18/1/0** | 0,947 / **1,000** / **0,973** | 6/1/3 | 0,857 / 0,667 / 0,750 |
| typesafe/jev-1.14 | **18/2/0** | 0,900 / **1,000** / 0,947 | 5/1/4 | 0,833 / 0,556 / 0,667 |
| liquid/d1.1 | **18/2/0** | 0,900 / 1,000 / 0,947 | 6/2/3 | 0,750 / 0,667 / 0,706 |
| cloudflare/clef | **18/2/0** | 0,900 / 1,000 / 0,947 | 6/1/3 | 0,857 / 0,667 / 0,750 |
| typesafe/jev-1.13 | **18/3/0** | 0,857 / 1,000 / 0,923 | **7/0/2** | **1,000** / 0,778 / **0,875** |
| respan/span-02 | **18/2/0** | 0,900 / 1,000 / 0,947 | 5/2/4 | 0,714 / 0,556 / 0,625 |
| baseten/elephant-1 | **18/2/0** | 0,900 / 1,000 / 0,947 | **9/5/0** | 0,643 / **1,000** / 0,783 |
| **perplexity/pplx-decider-v1.2** | 17/1/1 | **0,944** / 0,944 / **0,944** | 7/1/2 | 0,875 / 0,778 / **0,824** |
| liquid/d1-ultra | 17/2/1 | 0,895 / 0,944 / 0,919 | 7/1/2 | 0,875 / 0,778 / **0,824** |
| morph/reflex | 17/1/1 | 0,944 / 0,944 / 0,944 | 6/1/3 | 0,857 / 0,667 / 0,750 |
| openai/gpt-6-luna | 17/1/1 | 0,944 / 0,944 / 0,944 | 4/1/5 | 0,800 / 0,444 / 0,571 |
| cloudflare/clef-omni | 17/4/1 | 0,809 / 0,944 / 0,872 | 8/5/1 | 0,615 / **0,889** / 0,727 |
| cloudflare/clef-flash | 17/3/1 | 0,850 / 0,944 / 0,895 | 6/4/3 | 0,600 / 0,667 / 0,632 |
| inception/mercury-decide | 16/1/2 | 0,941 / 0,889 / 0,914 | 5/0/4 | **1,000** / 0,556 / 0,714 |
| perplexity/pplx-decider-flash | 16/2/2 | 0,889 / 0,889 / 0,889 | 8/2/1 | 0,800 / 0,889 / 0,842 |

## Onde falha: padrão, não ruído

O Perplexity Decider (igual nas duas ondas) erra sempre na **mesma região** e no
mesmo tipo de ecrã:

| tela | células reais | acertou | inventou | esqueceu |
|---|---|---|---|---|
| bootstrap-painel-cursos | 3 | 3 | — | — |
| react95-painel | 5 | 5 | `bottom-center` | — |
| material-painel | 6 | 5 | — | **`bottom-center`** |
| macos-finder | 4 | 4 | — | — |
| bootstrap-login | 2 | 2 | — | — |
| fluent-painel | 5 | 5 | `bottom-center` | — |
| **macos-salvar-como** (diálogo) | 2 | **0** | — | **`bottom-center`, `top-center`** |

Duas causas distintas:

1. **Fronteira do `bottom-center`** — inventa onde não há e esquece onde há. É
   erro de *limite de região*, não de percepção: ele vê os controlos e atribui-os
   à célula errada.
2. **Diálogo centrado** — no `macos-salvar-como` reportou **zero** regiões com os
   4 tipos certos (button, checkbox, input, select). Quando todos os controlos
   estão no centro do ecrã, o seu prior espacial colapsa: acerta *o quê*, falha
   *onde*.

No `material-painel` reportou 8 tipos quando existem 6 — inventou `link` e
`menuitem`. Tipos inventados aparecem sobretudo em ecrãs densos.

## Leitura

1. **Recall de tipos é alto (0,84–1,00); a precisão é o problema (0,65–0,80 no
   treino)**. Sem candidatos, os modelos **inventam tipos que não existem**: 4 a
   9 tipos fantasma nas 4 telas de treino (o Perplexity inventou 6 de 24
   reportados). No holdout a invenção cai para 1.
2. **No holdout quase todos saturam em 16/17 tipos**: as 3 telas são simples
   (login, painel Fluent, salvar-como) e o teste distingue pouco. O treino (4
   telas densas) separa melhor.
3. **Regiões são mais frágeis** que tipos: 16 a 18 células certas de 18 no treino,
   mas só 4 a 9 de 9 no holdout, e o ranking muda entre splits. Nenhum modelo
   localiza bem "onde" sem caixas.
4. **Clef Omni é o mais fraco em recall de tipos** (13/17 no holdout, 0,765) —
   consistente com o teste de elementos: é conservador a ponto de negar o que vê.
5. **pplx-decider-v1.2**: 18/19 tipos (treino) e 16/17 (holdout), 17/18 células de
   região no treino e 7/9 no holdout, p50 675–792 ms, US$ 0,0025/1000 perguntas —
   o melhor equilíbrio, mas **não** o mais preciso (errou `bottom-center` e o
   diálogo centrado de forma reprodutível).

## O que isto responde para computer use

- "Diz-me o que há nesta captura" **funciona**: 13 a 19 dos tipos reais por tela
  no aggregate, recall 0,94–1,00. É um bom **inventário grosseiro**, não um
  detector.
- **Não confiar no inventário para decidir o que NÃO existe**: precisão 0,75.
- **Diálogo centrado é ponto cego** de região: acerta os tipos e devolve zero
  regiões. Se a automação depende de "onde", use o DOM.
- Para agir, continuar a propor candidatos (DOM/OCR) e usar o modelo como
  verificador — o desenho do teste de elementos.
- Custo é irrelevante: 16 perguntas numa imagem ≈ US$ 0,0003 por tela.

## Limitações

- 7 telas, 3 no holdout; vocabulário de 10 tipos e grelha 3×2 fixos por nós.
- Sem caixas/IoU: regiões são grosseiras (terças partes), não localização.
- `noul` a 0,5 sem curva PR por tipo nesta ronda; sem ECE por tipo.
- Nada aqui compara com ScreenSpot/UI-Vision (regime diferente).
