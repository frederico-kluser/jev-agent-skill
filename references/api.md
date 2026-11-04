# SOMs via OpenRouter — contratos de análise e transporte

Atualizado em **2026-11-04**. Fontes primárias:
[Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request.md),
[Multimodal Decisions](https://openrouter.ai/docs/guides/community/multimodal-decisions),
[Jev](https://openrouter.ai/docs/guides/community/jev) e
[Clef Omni](https://developers.cloudflare.com/workers-ai/models/clef-omni/).
Divergências e verificações: [dossiê](pesquisa-multimodal.md).

## 1. Duas camadas diferentes

### Análise local (`analyze`)

É a API de alto nível da skill, em [analyze.mjs](../scripts/lib/analyze.mjs):

```js
import { analyze, closeAgents } from "./scripts/lib/analyze.mjs";

try {
  const result = await analyze({
    model: "cloudflare/clef-omni",
    state: "Inspeção de uma foto de teste; não autoriza nenhuma ação.",
    media: [{ id: "photo", type: "image", path: "examples/media/photo.png" }],
    questions: {
      red: { type: "noul", instructions: "Is a red rectangle clearly visible in photo?" },
    },
  }, { dryRun: true, mediaRoot: process.cwd() });
  console.log(JSON.stringify(result, null, 2));
} finally {
  closeAgents(); // num serviço residente, só no shutdown, não por request
}
```

- `state` é opcional aqui: contexto textual/JSON, não bytes binários.
- `media[]`: exatamente um `path` local ou `data_url`; `id` único opcional;
  `type=image|video` obrigatório. Não descarrega URLs HTTP nem publica uploads.
- `video`: `mode=frames|native`, `fps`, `max_frames`, `start_seconds`, `end_seconds`.
  As quatro opções finais pertencem somente ao modo frames.
- `box_presence`: mapa id da pergunta box → id de noul de presença.
- `model`, `provider`, `session_id`, `user`, `trace` são opcionais.
- Options: `apiKey`/ambiente, `baseDir`, `mediaRoot`, `dryRun`, `preprocess`,
  `thresholds`, `retries`, `timeoutMs`, paths/timeouts do FFmpeg e `checkModel`.
- Sem modelo explícito: Jev1.14; vídeo native seleciona Clef Omni. Não há
  fallback silencioso para modelo de chat ou outro fornecedor.
- No CLI, os paths internos de um pedido são relativos ao seu diretório; na
  biblioteca, ao `baseDir` (ou cwd).

Antes de inferir, o runtime prepara mídia, valida perguntas/limites e confirma
modalidades **e rota** no catálogo público. `dryRun:true` não faz rede. Pular o
catálogo exige `checkModel:false` / `--skip-model-check` explícito e fica registrado.
O modelo ainda precisa de perfil de adaptador implementado.

### Payload de transporte (`ask` / `decide`)

Já deve estar preparado no schema OpenRouter. `media`, `video`, `box_presence`
não são campos do wire: a camada de análise os converte/remove.

| Campo | Obrigatório | Significado |
|---|---|---|
| `model` | Sim | ID OpenRouter, por exemplo `typesafe/jev-1.14` ou `cloudflare/clef-omni` |
| `state` | Sim | String/JSON ou array de strings e partes `image_url`/`video_url` |
| `questions` | Sim | Mapa id → pergunta tipada; IDs não substituem `instructions` |
| `provider` | Não | Preferências de roteamento do OpenRouter |
| `session_id`, `user` | Não | Observabilidade; até256 caracteres |
| `trace` | Não | Metadados de trace; não colocar segredos |
| `assets` | Não | Referências de imagens; o validador local aceita o caminho Jev documentado |

Para inspeção offline do wire: `validate`. Para ficheiros: **analyze --dry-run**,
não enviar caminhos locais no payload esperando que o provider os abra.

## 2. Endpoints, autenticação e descoberta

- Principal: `POST https://openrouter.ai/api/alpha/decisions` (**alpha**).
- Compatibilidade SDK TypeSafe: `POST https://openrouter.ai/api/v1/systemone`.
- Header: `Authorization: Bearer OPENROUTER_API_KEY`; JSON UTF-8.
- Descoberta: `GET /api/v1/models?output_modalities=decisions`, seguido de
  filtro `model.endpoints.includes('/api/alpha/decisions')` e modalidades.
- Providers: `GET /api/v1/models/{author}/{slug}/endpoints`; roteamento usa
  `tag` (`typesafe`, `cloudflare`), não nome de exibição.
- Conta: `GET /api/v1/key`. Não inferir saldo/qualidade por presença de chave.

A API nativa `api.typesafe.ai` é um contrato separado de assets/multipart e
headers Danger Zone, não o foco desta skill. O cliente baixo nível mantém essa
compatibilidade legada com `TYPESAFE_API_KEY`, mas **nunca** envia essa chave ao
OpenRouter; `analyze` aceita só as duas superfícies OpenRouter verificadas.

## 3. Perguntas e respostas

| Tipo | Pergunta | Resposta | Validação adicional |
|---|---|---|---|
| `noul` | `instructions`; criteria opcional com `true` e `false` | `{type:'noul',noul:0..1}` | Probabilidade finita, sem confidence separado |
| `choice` | criteria mapa, até255 opções Jev; inclua `other` quando necessário | choice + probabilities + confidence | Opção própria e argmax compatível; distribuição coberta e coerente |
| `score` | criteria array ordenado2..10 de situações concretas | score + probabilities + confidence + legend | Régua e média ponderada coerentes (tolerância0.03 de arredondamento) |
| `box` | instructions string/objeto/array, sem criteria; só Jev1.14 | box com top/bottom/left/right e confidence opcional | Arestas finitas0..1, left<right/top<bottom; presença separada |

`instructions` de box no OpenRouter é obrigatória e não-null; na API nativa
TypeSafe é opcional/null. Confidence box nativa pode ser null; no schema
OpenRouter é número opcional. A integração trata ausência/null como desconhecida,
sem converter para certeza, e jamais promove box a autorização.

Exemplo de pedido textual completo:

```json
{
  "model": "typesafe/jev-1.14",
  "state": { "ticket": "Checkout indisponível para todos os clientes." },
  "questions": {
    "bug": { "type": "noul", "instructions": "Does the ticket report broken software?" },
    "team": {
      "type": "choice", "instructions": "Which team should handle the ticket?",
      "criteria": { "payments": "Checkout/payment problem.", "other": "Another team or unclear." }
    }
  }
}
```

Partes inline usam `image_url.url=data:image/png;base64,...` ou
`video_url.url=data:video/mp4;base64,...` em `state[]`, não `messages` de chat.
Para gerar bytes válidos, use os exemplos de análise; reticências documentais
não são mídia executável. Só Jev lê imagens em objetos aninhados e perguntas.
O pipeline usa partes no topo e labels como strings para ser portátil.

## 4. Resultado de análise

- `ok`: coerência estrutural, não prova de que o modelo acertou.
- `answers`: respostas tipadas; blobs em legendas ecoadas são redigidos.
- `decisions`: value/band/confiança; resposta inválida implica `abstain`.
- `analysis`: findings/rubricas/limitações; `narrative_source=deterministic_local_templates`.
- `media`: geometria, nomes sem paths absolutos, bytes preparados, duração,
  plano/frames/timestamps e lacunas; sem Base64.
- `usage`: input_tokens/output_tokens/cost reportados pelo OpenRouter.
- `_som`: modelo pedido/resolvido, provider, generation_id, custo, attempts,
  socket_reused, latency_ms HTTP, preprocessing_ms e pipeline_total_ms.
- `_jev`: alias legado da mesma telemetria; não é segunda inferência/cobrança.

## 5. Limites, preços e erros

Limites de mídia por adaptador em [multimodal.md](multimodal.md). O cliente mantém
estimativa de **texto**; tokens visuais são desconhecidos até o provider calcular.
Jev textual conserva preflight64k/request e32k/state+pergunta; imagens usam262144.
O gateway pode selecionar long-context antes disso (aproximadamente32000bytes
de texto), com custo de precisão/latência documentado.

Snapshot de entrada USD/Mtok em 2026-11-04: Jev0.042, Clef Omni0.15; saída0 nos
endpoints consultados. **Não é preço fixo**: confirme catálogo/provider e leia
`usage.cost`. Contexto, latência e calibração não se transferem entre modelos.
Limites de taxa são por organização/conta; números históricos não são universais.

| HTTP/condição | Conduta |
|---|---|
| 400/422 | Pedido/envelope inválido: terminal, corrigir |
| 401/402/403 | Credencial/crédito/permissão: terminal, sem tentar outro modelo escondido |
| 404/413 | Modelo/rota ou payload: terminal, descobrir capacidades/reduzir mídia |
| 429/500/502/503/504/524/529 | Retry limitado com backoff/jitter e Retry-After/cap |
| 200 com `error` | Tratar como erro, nunca sucesso |
| JSON malformado/resposta incoerente | Falhar fechado, sem AUTO |

O transporte não registra chaves ou payloads em erros/telemetria. A aplicação
continua responsável por redigir seus próprios logs e não expor a chave ao cliente.
