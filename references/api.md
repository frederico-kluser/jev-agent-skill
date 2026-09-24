# API do Jev via OpenRouter — contrato completo

Fontes verificadas (2026-09-24): OpenAPI oficial da Decisions API e System One API
do OpenRouter, `docs.typesafe.ai` (/api, /models, /primitives/*, /confidence,
/concepts/state, /model-jaggedness/jev-1.13). O que não foi verificável está
marcado em `references/pesquisa-verificada.md`.

## Superfícies e endpoints

| Superfície | Endpoint | Chave | Quando usar |
|---|---|---|---|
| `decisions` (padrão da skill) | `POST https://openrouter.ai/api/alpha/decisions` | `OPENROUTER_API_KEY` | HTTP direto (esta skill) |
| `systemone` | `POST https://openrouter.ai/api/v1/systemone` | `OPENROUTER_API_KEY` | compatível com os SDKs TypeSafe (`@typesafe-ai/sdk`, `typesafe_sdk`) |
| `typesafe` (nativa) | `POST https://api.typesafe.ai/v1/systemone` | `TYPESAFE_API_KEY` | só se tiver conta TypeSafe |

As duas superfícies do OpenRouter usam o MESMO schema (`DecisionsRequest`/`DecisionsResponse`)
e a mesma faturação (conta OpenRouter). Seleção: env `JEV_SURFACE=decisions|systemone|typesafe`
ou `JEV_BASE_URL` para um endpoint custom.

Autenticação: `Authorization: Bearer <OPENROUTER_API_KEY>`.

## Request (`DecisionsRequest`)

| Campo | Tipo | Obrig. | Notas |
|---|---|---|---|
| `model` | string | sim | `typesafe/jev-1.13` (fixo) ou `~typesafe/jev-latest` (alias). IDs soltos `jev-1.13`/`jev-latest` são mapeados para o namespace `typesafe/`. |
| `state` | string \| object \| array | sim | Conteúdo a avaliar. **Só texto** (sem imagem/áudio/vídeo/binários). |
| `questions` | map<string, Question> | sim | Chave = ID seu (NÃO vai para o modelo; escreva a pergunta completa em `instructions`). |
| `provider` | ProviderPreferences | não | Roteamento OpenRouter (ex.: `{"only":["…"]}`) — raramente necessário aqui. |
| `session_id` | string ≤256 | não | Agrupamento de observabilidade; nunca vai para o provider. |
| `user` | string ≤256 | não | ID do utilizador final (observabilidade). |
| `trace` | TraceConfig | não | trace_id/trace_name/span_name. |

### Question (discriminado por `type`)

Comum: `instructions` (obrigatório — string | object | array | null; em objeto,
coloque a pergunta num campo e dados referenciáveis em `backticks` nos outros).

**`noul`** — probabilidade de SIM (0..1).
```json
{ "type": "noul", "instructions": "O cliente reporta um defeito?",
  "criteria": { "true": "…perto de 1 significa isto", "false": "…perto de 0 significa isto" } }
```
`criteria` é OPCIONAL; se presente, exige AMBAS as chaves `"true"`/`"false"`.

**`choice`** — uma opção de N (máx. **255**).
```json
{ "type": "choice", "instructions": "Que equipa trata?",
  "criteria": { "frontend": "…", "payments": "…", "other": "Nenhuma das anteriores" } }
```
`criteria` OBRIGATÓRIO: map opção → rubrica (string | object | array | `null` para
opções autoexplicativas). Rubricas-objeto ajudam opções confundíveis (ex.:
`{"what":"…","not_for":"…","examples":["…"]}` — nomes de chave livres).
Inclua `other`/`none` quando a lista puder não cobrir o input.

**`score`** — posição ponderada numa régua ordenada (2..10 níveis; API aceita até 10).
```json
{ "type": "score", "instructions": "Quão urgente?",
  "criteria": ["Pode esperar", "Esta semana", "Bloqueia receita agora"] }
```
`criteria` OBRIGATÓRIO: array ordenado baixo→alto. Índice do array = número do nível
(a partir de 0). Cada nível é julgado de forma INDEPENDENTE (o modelo não vê os
vizinhos nem os números): descreva SITUAÇÕES concretas — `["0","1","2"]` tem
desempenho documentado como péssimo. `score` = Σ(nível × probabilidade), pode cair
entre níveis. Uma dimensão por `score`.

## Response (`DecisionsResponse`)

| Campo | Tipo | Notas |
|---|---|---|
| `answers` | map<id, Answer> | Mesmas chaves do request. |
| `model` | string | Versão que respondeu (ex.: `typesafe/jev-1.13-20260917`) — registe se calibrar limiares. |
| `id` | string | `gen-dec-…` (só OpenRouter). |
| `provider` | string | Ex.: `"TypeSafe"` (só OpenRouter). |
| `usage` | `{input_tokens, output_tokens, cost?}` | `cost` em USD (só OpenRouter). **Output é grátis**; `cost` ≈ input_tokens × $0.042/Mtok. |

### Answer por tipo

```json
{ "type": "noul",  "noul": 0.96 }
{ "type": "choice", "choice": "payments",
  "probabilities": { "frontend": 0.02, "payments": 0.96, "other": 0.02 },
  "confidence": 0.78 }
{ "type": "score", "score": 1.99,
  "legend": { "0": "Pode esperar", "1": "Esta semana", "2": "Bloqueia receita agora" },
  "probabilities": { "0": 0.0, "1": 0.01, "2": 0.99 },
  "confidence": 1.0 }
```

- **`noul` NÃO tem `confidence`** — a distribuição binária é o próprio número.
  ~0.5 = 50/50 (indeciso), não "intensidade média".
- `confidence` (choice/score) = concentração da distribuição (1.0 = tudo numa
  opção). "Descreve a resposta do modelo, não garante que esteja correta".
- `probabilities` cobre todas as opções/níveis e soma ≈ 1.
- Respostas são SEMPRE restritas às suas opções/níveis — formato nunca alucina.
- Perguntas do mesmo request são independentes e avaliadas em paralelo.

## Erros

| HTTP | Significado | Ação da skill |
|---|---|---|
| 400 / 422 | Pedido malformado / falha de validação (a mensagem nomeia o campo) | terminal — corrigir request |
| 401 | Chave em falta/inválida | terminal — verificar `OPENROUTER_API_KEY` |
| 402 | Créditos insuficientes | terminal — https://openrouter.ai/credits |
| 403 / 404 / 413 | Permissão / recurso ou modelo inexistente / payload enorme | terminal |
| 429 | Rate limit | retry com backoff + `Retry-After` |
| 500/502/503/504/524/529 | Sobrecarga/timeout transitórios | retry com backoff |

Corpo de erro OpenRouter: `{"error":{"code":402,"message":"…"}}`.

## Limites e preço (Jev 1.13)

- **Contexto**: 64k tokens por request (`state` + todas as perguntas);
  `state` + pergunta mais longa ≤ 32k. O `state` é ingerido UMA vez.
- **Rate limits (TypeSafe)**: 250k tokens/s E 1.200 req/min (qualquer excedido →
  429; "ajustam dinamicamente"). Limites do lado OpenRouter: não publicados.
- **Preço**: $42/Btok = **$0.042/Mtok de input**; output grátis. Uma decisão de
  ~500 tokens custa ≈ $0.00002.
- **Modelos**: `jev-1.13.0` (versionado); aliases `jev-latest` → 1.13.0 e
  `jev-preview` → 1.13.0 (sem preview neste momento). Fixe a versão se calibrar
  limiares — o alias move quando sai release nova.
- **Línguas**: inglês é primário; pt-BR aceite com menor precisão — calibrar.

## Validação por resposta da API

Exemplos reais capturados ao vivo com esta skill (2026-09-24):

```
ask ticket-triage.json → is_bug 0.96 [AUTO] · team "payments" [HITL conf 0.78]
                         · urgency 2 [AUTO conf 1.0] · 499 tok entrada · $0.000021 · 330 ms
eval evals.json        → 7/7 corretas · accuracy 1.00 · confiança média 0.974 · ECE 0.026
batch 5 pedidos        → 4/5 sockets reutilizados (warm) · máx 361 ms
```
