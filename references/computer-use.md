# Computer use com o Perplexity Decider V1.2 — só com imagem, sem HTML

Resposta curta: **sim, trabalha só com a imagem** — e as medições desta skill já
foram feitas assim. No benchmark de elementos o modelo **nunca recebeu HTML**: a
imagem foi o único `state` visual e os rótulos dos candidatos viajaram como texto
nas perguntas. O DOM serviu para **gerar o ouro**, não como entrada do modelo.

O que muda é o que se pede: sem HTML ele **não enumera** nem devolve coordenadas;
ele **julga candidatos** que alguém (DOM, OCR ou um parser visual) tem de propor.

## O que ele faz só com a imagem

| Capacidade | Evidência medida |
|---|---|
| **Inventariar que tipos de controlo existem** ("há botão? campo? aba?") | recall 0,84–1,00 · precisão 0,65–0,80 (treino) e 0,941 (holdout) |
| **Dizer em que terça parte há controlos** | F1 0,57–0,97; pplx 0,824 no holdout |
| "Este controlo está na tela e é interactivo?" | precisão 0,91–0,95 · recall 0,85–0,92 (F1 0,899 holdout) |
| "Qual destes candidatos corresponde ao pedido?" | `choice` até 255 opções, `confidence` = `(p_top−1/n)/(1−1/n)` |
| "Que ecrã/fluxo é este?" | 0,958 treino / 0,944 holdout (tarefa tipada de UI) |
| "Há erro / aviso / estado de carregamento?" | `noul` por pergunta, mesma imagem, custo marginal ~0 |

Os números de inventário vêm do teste de **descoberta** (só imagem, 16 perguntas
fixas, ouro do DOM): [comparativo-ui-descoberta-2026-11-04.md](comparativo-ui-descoberta-2026-11-04.md).
Os de aceitação vêm do teste de candidatos: [comparativo-ui-elementos-2026-11-04.md](comparativo-ui-elementos-2026-11-04.md).

**O que isso significa na prática:** ele consegue dizer "nesta captura há botões,
campos e uma aba" sem HTML — com recall alto — mas **inventa 1 a 2 tipos
fantasma** por tela (precisão 0,75). Inventário serve para orientar; não serve
para decidir o que *não* existe.

Números de referência: 0,915–0,919 F1 (treino) e 0,899 (holdout) na tarefa
"encontra todos os controlos" — a melhor razão custo/qualidade entre 16 modelos,
com p50 762–828 ms. [Comparação completa](comparativo-ui-elementos-2026-11-04.md).

## O que NÃO se obtém sem HTML

- **Coordenadas / clique**: o adaptador não tem `box`. Para clicar, use
  `typesafe/jev-1.14` (`box`, uma caixa por pergunta) ou seletores do DOM.
- **Enumeração**: não gera a lista do que é clicável; só aceita/rejeita candidatos.
- **Elementos escondidos, fora da dobra ou sob overlays**: não estão na imagem.
- **Estado (`disabled`, `aria-*`, foco)**: a imagem não o mostra de forma fiável;
  usar o DOM/ARIA como fonte de verdade.
- **Texto pequeno**: acima de 1,6 MP a imagem é reduzida e o texto perde-se.

Regra de ouro: tratar o "não" dele como **sinal fraco** (recall 0,85) e o "sim"
como **sinal forte** (precisão 0,95). Nunca declarar "este botão não existe" só
com a resposta dele.

## Como operar (3 padrões que funcionam)

1. **Gate antes do clique** — candidato do DOM/OCR → `noul` "existe e é
   interactivo?" → se ≥ limiar calibrado, clicar; senão HITL. Cada clique custa
   1 pedido (~0,8 s).
2. **Ranking de candidatos** — N candidatos independentes → **um pedido por
   candidato** (recomendação do fornecedor: candidatos que competem entre si não
   devem ser agrupados) → escolher o de maior probabilidade.
3. **Pós-checagem** — depois de agir, `noul` "a acção teve efeito?" / "apareceu
   erro?" na captura seguinte; é o guardrail mais barato que existe aqui.

## Custos (medidos, com 1 imagem 1280×720)

| Operação | Custo | Latência p50 |
|---|---|---|
| 1 pergunta por pedido (gate de clique) | ≈US$ 0,03–0,04 / 1000 pedidos | ~0,2–0,8 s |
| 12 perguntas no mesmo pedido | **US$ 0,041 / 1000 pedidos** (medido) | 762–828 ms |
| 1000 ciclos de agente = 1 gate + 1 pós-checagem | ≈US$ 0,08 | ~1,6 s de inferência |

A imagem domina o custo (~1000 tokens/Mpx a US$ 0,02/Mtok); perguntas extra no
mesmo `state` custam quase nada porque o `state` é cobrado **uma vez por grupo**.
Reutilizar a mesma captura para 10 perguntas é ~10× mais barato que 10 pedidos.

## Limites que mudam a implementação

- **1,6 MP** por imagem e `(w/32)·(h/32) ≤ 2048` tiles; acima disso **pendura
  ~1 min e dá timeout** (não é 400). 1920×1080 excede → reduzir para 1280×720.
- **Imagem só no topo de `state[]`** (aninhada → 400).
- **Timeout 60 s + 2 retries** (tail observado 14,6 s); `524` é transitório.
- **Agrupamento fixo** ao comparar runs ou calibrar limiares.
- `confidence` do `choice` é concentração, não probabilidade calibrada: calibrar
  por domínio antes de automatizar.
