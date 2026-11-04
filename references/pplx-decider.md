# Perplexity Decider V1.2 — modelo OFICIAL de decisões (via OpenRouter)

Adotado pelo dono em **2026-11-04** como default da skill. Este documento reúne o
contrato do adaptador, os limites que **mudam a implementação**, a semântica de
agrupamento/confiança, o preço e a **latência medida**. Fontes primárias:
[model card](https://huggingface.co/perplexity-ai/pplx-decider-v1.2),
[guia multimodal do OpenRouter](https://openrouter.ai/docs/guides/community/multimodal-decisions),
[OpenAPI da Decisions](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request.md)
e os endpoints públicos do catálogo. Pesquisa completa em
[pesquisa-pplx-decider.md](pesquisa-pplx-decider.md).

## Porque é o default

- **UI/decisões**: melhor acurácia no treino do benchmark de interfaces (0,958) e
  top-3 no holdout (0,944), presença 0 FP/0 FN nos dois splits.
- **Enumeração de elementos**: F1 de conjunto 0,915 (treino) / 0,899 (holdout),
  no topo da primeira onda; na segunda onda ficou em 1.º no treino e 3.º no
  holdout (Clef 0,933 e Span-02 0,923, com n=8 casos — diferença não significativa).
- **Custo**: ≈US$ 0,041 por 1000 pedidos com imagem (medido), o mais barato do
  grupo de topo; `$0.02/Mtok` de entrada, saída grátis, sem cache.
- **Latência**: p50 **0,67–0,83 s** (medido em 96 pedidos com imagem); p50
  oficial no OpenRouter **0,28 s** (sem p95 publicado). O tail existe: p95
  observado 2,0 s no holdout e até 14,6 s num caso da primeira onda.

## Contrato do adaptador (OpenRouter)

| Aspeto | Regra |
|---|---|
| Endpoint | `POST https://openrouter.ai/api/alpha/decisions` |
| Modelo | `perplexity/pplx-decider-v1.2` (fixe a versão; `~…latest` move sozinho) |
| Imagens | `{type:'image_url', image_url:{url:'data:image/png;base64,…'}}` **apenas como item TOP-LEVEL do array `state`** |
| Aninhadas | `image_url` dentro de objeto do state, em `instructions` ou `criteria` → **400 do OpenRouter antes de sair** |
| Formatos | PNG/JPEG (o adaptador aceita também WebP; o runtime normaliza para JPEG) |
| Teto de imagem | **1,6 MP** (model card). 1920×1080 (2,07 MP) excede → normalizar |
| Teto de tiles | `(w/32)*(h/32) ≤ 2048`; acima disso o pedido **pendura ~1 min e dá timeout**, não 400 |
| Corpo | até 32 MiB; até 8 imagens por pergunta |
| Contexto | 262 144 tokens; `state` + pergunta < 256 K |
| Primitivas | `noul`, `choice` (até 255 opções), `score` — **sem `box`** |
| `mode: web_grounding` | **não existe no OpenRouter** (é nativo); `search_results` não vem por esta rota |

> Regra prática do runtime desta skill: normalizamos por **eixo (280..1568)** *e*
> por **área (1,6 MP)**. 1568×1568 = 2,46 MP passaria no eixo e falharia na área
> (ou nos tiles); 1560×1024 = 1,6 MP e 1560 tiles passa em ambos.

## Agrupamento (o detalhe que muda resultados)

- **v1.2**: todas as perguntas do pedido são respondidas **juntas, numa passada**;
  cada pergunta vê o `state` e **as outras perguntas**, e o `state` é cobrado
  **uma vez**. Se o pedido exceder 256 K, a API **divide em grupos consecutivos**
  e cobra o `state` por grupo (mais lento; pode chegar ao timeout).
- **flash v1.2**: **não** agrupa — cada pergunta é respondida isolada e o `state`
  é enviado/cobrado **por pergunta**. Responder em conjunto **baixou a acurácia**
  no modelo de 4B (declarado pelo fornecedor).

Consequências práticas:

1. Agrupar **muda as respostas** (“the same question can score differently
   depending on what it's grouped with”). Ajuda quando as perguntas são facetas
   da MESMA decisão; atrapalha quando são **candidatos independentes** a competir
   pelo mesmo julgamento (aí: um candidato por pedido).
2. **Fixe o grupo e a ordem** ao comparar runs, calibrar limiares ou medir
   latência; mudar o agrupamento invalida thresholds calibrados.
3. Em dúvida: um candidato por pedido — “a wrong grouping costs more than a
   missed one”.
4. Não compare 3 perguntas num pedido contra três pedidos de 1 pergunta: além da
   acurácia, o **custo** muda (v1.2 fatura o state 1×/grupo; flash 1×/pergunta).

## Confiança e calibração

`confidence` **não é `p_top`**:

- `choice`: `(p_top − 1/n) / (1 − 1/n)` — concentração normalizada de uniforme (0)
  a certeza (1). Ex.: `p_top=0,95` com 3 opções → 0,93.
- `score`: `1 − spread/baseline`, com piso 0 (spread = Σ pᵢ·|i−top|).
- `noul`: **não tem `confidence`** — a incerteza é a distância a 0,5.

Armadilhas: (a) `choice` com 1 opção ou `score` com 1 nível dá **confidence 1**
degenerado — não é certeza; (b) pedidos idênticos às vezes diferem no **segundo
decimal** → limiares com margem; (c) **revalide thresholds** quando o modelo
mudar de versão. Não transporte limiares do Jev/Clef nem de outra versão.

## Erros e o que fazer

| Código | Situação | Ação |
|---|---|---|
| 400 | parte de mídia aninhada / fora do top-level; schema inválido; `noul` sem criteria nem instructions; URL `http(s)` em vez de data URL | mover para `state[]`, corrigir o pedido |
| 401/403 | chave inválida / sem permissão | terminal |
| 402 | créditos insuficientes | terminal; verificar a conta |
| 413 | corpo acima de **32 MiB** (33 554 432 bytes) | reduzir imagens/resolução ou dividir o pedido |
| 429 | rate limit (nativo: **10 req/s por organização**, TPM/TPH do modelo) | honrar `Retry-After` e repetir |
| **524** | **timeout de borda do OpenRouter** (o nativo devolve 504) | retry com backoff **e** verificar tiles/1,6 MP |
| 529 | provider sobrecarregado | retry com backoff |
| timeout ~60 s | imagem com **>2048 tiles** | **redimensionar antes**; não é erro de schema |

Regra de imagem: `(ceil(w/32) × ceil(h/32)) ≤ 2048`. Passam 1440×1440 e
2048×1024; **não** passa 1600×1310. O runtime desta skill corta em **1,6 MP** e
1568 px/eixo, o que satisfaz os dois limites.

## Latência — o que esperar e como configurar

Medições nossas (pedidos com **1 imagem 1280×720 + 12 perguntas**, 8 modelos em
paralelo, sem cold start):

| Métrica | Valor |
|---|---|
| p50 (2 ondas) | **671–828 ms** |
| p95 (holdout) | 987–2002 ms |
| pior caso observado | ~14,6 s (1 célula em 48) |
| p50 oficial OpenRouter | 0,28 s (sem p95) |

Recomendação de implementação: **`--timeout 60`** e `--retries 2` para lotes com
imagem; nunca usar o default de 15 s em produção com imagens grandes. Para UI
com muitas perguntas por pedido, medir de novo: o custo por pedido cresce com o
número de perguntas e o agrupamento.

Latência **escala com o input** (dados do fornecedor, modelo anterior): ~90 K
tokens ≈ 5 s, ~190 K ≈ 14 s, perto do limite ≈ 23 s; e um pedido de ~248 K
tokens levou **53 s** no v1.2 (16 s no flash). Imagens somam ~1000 tokens/Mpx.
Isto continua a ser o mesmo modelo — só o volume muda o tempo.

## Versões e aliases

- `pplx-decider-v1.2` (27B) — **fixe este slug**. `pplx-decider-flash-v1.2`
  (4B) tem o mesmo contrato, custa metade por token, mas **não agrupa** e
  respondeu pior e mais caro nas nossas runs.
- Aliases (`pplx-decider-latest`, `~perplexity/…-latest`) **movem** de versão e
  faturam à taxa da versão que selecionarem. No nativo o campo `model` devolve o
  nome enviado, não o build; no OpenRouter traz o build quando o provider reporta.
- Tratar **qualquer** mudança de versão como evento de recalibração de limiares.

## Nativo vs OpenRouter (não transportar o nativo)

| Recurso | Nativo | OpenRouter |
|---|---|---|
| Imagens aninhadas no `state` | sim, a qualquer profundidade | **não** (400; só topo do `state[]`) |
| `mode: "web_grounding"` + `search_results` | sim (US$ 0,001/busca) | **não existe** |
| `assets` (TypeSafe) | — | aceite; no adaptador Perplexity só como item de topo |
| Timeout | 504 | **524** |
| Erros extra | — | 402, 529 |
| `usage.cost`, `provider`, `session_id`/`trace` | — | sim |

O endpoint é **alpha** (“the shape may change”): fixar versão, validar contrato e
ter testes de fumaça.

## Preço

- Entrada **US$ 0,02 / Mtok**; saída **grátis**; sem cache de prompt.
- Custo **medido** com imagem: ≈**US$ 0,041 / 1000 pedidos** (12 perguntas,
  1280×720) — inclui tokens de imagem.
- `pplx-decider-flash-v1.2`: US$ 0,01/Mtok e mesmo contrato, mas **mediu mais
  caro** que o v1.2 nas nossas runs (US$ 0,0068 vs 0,0020 por 48 pedidos) e teve
  F1 menor; não é default.

## Checklist de implementação (backend)

1. Ler a chave do ambiente; nunca no frontend.
2. Preparar a imagem: EXIF físico, resize por eixo **e** área, JPEG com metadados
   removidos (o runtime faz isto em `analyze`).
3. Colocar a parte `image_url` **no topo** de `state[]`; texto como strings.
4. Fixar o **agrupamento** de perguntas e o **modelo versionado**.
5. Timeout 60 s + 2 retries com `Retry-After`; tratar 524 como transitório.
6. Validar a resposta e **falhar fechado** (`abstain`), nunca converter erro em
   aprovação; `auto` visual continua limitado a `hitl` nesta skill.
7. Registar `usage.cost`, `id` de geração e o modelo resolvido.
8. Para localização (`box`) usar `typesafe/jev-1.14` explicitamente.
