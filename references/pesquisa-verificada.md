# TypeSafe "Jev" System One Decision Model — Verified API Research Report

Sources (all fetched live): `docs.typesafe.ai/api.md`, `/primitives.md`, `/primitives/noul.md`, `/primitives/choice.md`, `/primitives/score.md`, `/primitives/advanced.md`, `/concepts/state.md`, `/models.md`, `/model-jaggedness/jev-1.13.md`; `openrouter.ai/docs/guides/community/typesafe-sdk.md`, `/jev-tutorial.md`, `/docs/api/api-reference/alphadecisions/submit-a-decisions-request.md`, `/docs/api/api-reference/systemone/submit-a-system-one-request.md` (OpenAPI schemas).

## 1. Request schema

TypeSafe-native evaluation request — `POST https://api.typesafe.ai/v1/systemone`, headers `Authorization: Bearer <API_KEY>`, `Content-Type: application/json`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `state` | `string \| object \| array` | yes | Content to evaluate. Plain string, JSON object, or array of text values. **Text only** — no image, audio, or video. |
| `model` | `string` | yes | e.g. `"jev-latest"` (see §4). |
| `questions` | `map<string, Question>` | yes | Keys ("question ids") are chosen by the caller; **not sent to the underlying model** — write the full question in `instructions`. Answers come back under the same keys. |

Every `Question` has: `type` (`"noul" | "choice" | "score"`), `instructions` (required for all three), `criteria` (required for choice/score, optional for noul). Per `/primitives/advanced`, the `EntryType` accepted everywhere (`instructions`, Choice criteria values, Score criteria entries, Noul `criteria.true`/`criteria.false`) is `string | object | array | null`. Structured objects put the question in one field (e.g. `question`) and data it references in others (referenced by name in backticks).

**OpenRouter-only extra request fields** (OpenAPI `DecisionsRequest`, both OR surfaces): `provider` (`ProviderPreferences`, routing prefs), `session_id` (string, `maxLength: 256`, observability grouping, "never sent to the provider", body value wins over `x-session-id` header), `user` (string, `maxLength: 256`), `trace` (`TraceConfig` with `trace_id`, `trace_name`, `span_name`). Required per schema: `model`, `state`, `questions` only.

**Response envelope** (TypeSafe native): `model` (string — the versioned model that answered, e.g. `"jev-1.13.0"`), `answers` (map<string, Answer>, keyed by your question ids), `usage` (object, required): `input_tokens` (integer), `output_tokens` (integer).

**Errors (TypeSafe native)**: `401 Unauthorized` (missing/invalid API key), `422 Unprocessable Entity` (validation failure; body details the offending field), `429 Too Many Requests` (rate limit exceeded), `529 Overloaded`. Handling: on `429`/`529` retry with **exponential backoff**; official SDKs do this by default and honor the `retry-after` header when present.

**Errors (OpenRouter, both surfaces)**: `400` (invalid params/malformed), `401` ("Missing Authentication header"), `402` (insufficient credits — "Add more using https://openrouter.ai/credits"), `403`, `404`, `413` (payload too large), `429` ("Rate limit exceeded"), `500`, `502`, `503`, `524` (edge timeout), `529` (provider overloaded). Body: `{"error": {"code": <int>, "message": <str>, "metadata"?: object}, "openrouter_metadata"?: object, "user_id"?: string}`.

## 2. Question type specs

### Noul (yes/no)
- `type`: `"noul"` (required); `instructions`: `string | object | array` (required) — the yes/no question or a statement to judge; `criteria`: **optional** object with keys `true` and `false`, each `string | object | array | null` — "What a yes (value near 1) means" / "What a no (value near 0) means".
- Semantics: returns the probability the answer is yes. One condition per Noul ("Is the customer angry AND asking for a refund?" → split into two Nouls). Phrase so that high = yes (avoid inverted wording). Boundary should be unambiguous ("any Python experience" works; add `criteria` when subtle). No option-count limit documented.

### Choice
- `type`: `"choice"` (required); `instructions`: required; `criteria`: **required** `map<string, string | object | array | null>` — option name → rubric description; `null` allowed when an option needs no detail. **Maximum of 255 options per Choice.**
- Semantics: picks the highest-probability option; full distribution returned. **No-match guidance:** "add an `other` or `none of the above` option when the list might not cover every input, so the model can say none of the others fit." Give the full option list (adding options costs only a few tokens each). For confusing options use object rubrics (`what`, `not_for`, `examples` — these key names are **not reserved**; you choose them). Criteria values may be nested trees for taxonomy walking.

### Score
- `type`: `"score"` (required); `instructions`: required; `criteria`: **required** ordered `array<string | object | array>` of level descriptions, low→high. **"A Score should have at least two levels; the API accepts up to 10."**
- Level number = array index, starting at **0**; `score` runs 0 … `len(criteria)-1` and can fall between levels (probability-weighted mean: Σ level × probability). Each level is judged **independently** — the model "doesn't see a level's number or its neighbours", so comparative wording ("worse than the previous level") and numeric level labels ("0","1","2") do nothing. Describe situations, not degrees ("Broken or degraded feature, but workaround exists", not "Moderately severe"). One dimension per Score; give rare extreme cases their own level.

## 3. Answer type specs

### Noul answer — **no `confidence`**
```json
{ "type": "noul", "noul": 0.95 }
```
`noul`: number 0–1 (probability of yes; ~0.5 = model splits evenly, NOT "medium degree"). Doc is explicit: "There is no separate `confidence` value for a Noul... A Noul's probability distribution has only two outcomes... the single `noul` value describes it completely."

### Choice answer — has `confidence`
```json
{ "type": "choice", "choice": "billing",
  "probabilities": { "billing": 0.88, "technical": 0.12, "sales": 0.0 },
  "confidence": 0.81 }
```
`choice` (string, highest-probability option), `probabilities` (map option→float, sum 1, **every** option present), `confidence` (number 0–1, derived from how peaked `probabilities` is).

### Score answer — has `confidence`
```json
{ "type": "score", "score": 1.05,
  "legend": { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
  "probabilities": { "0": 0.0, "1": 0.95, "2": 0.05 },
  "confidence": 0.92 }
```
`score` (number, probability-weighted position; e.g. 0×0.0 + 1×0.57 + 2×0.43 = 1.43), `legend` (map level-number-as-string → the level description you supplied — echoes the criteria verbatim, and in the Structured-level example the values are the **objects** you passed; API reference types it `map<string, string>` but the docs' own examples show object values, and OpenRouter's OpenAPI allows `string | object | array`), `probabilities` (map level-string→float, sum 1), `confidence` (0–1, derived from spread across levels).

`confidence` (Choice & Score only): "derived from the answer's probability distribution"; 1.0 = all probability on one option/level; flat spread = low. It describes the model's answer, "not a guarantee that the answer is correct". Threshold guidance: 0.5 when both outcomes equally easy to act on; raise when false-yes is expensive; lower when missing a yes is expensive; middle values → human review.

Guarantees: "Every answer is constrained to the options you supplied" (never outside them) and "Every answer is independent" (one question's answer is not context for another; questions in a request are evaluated in parallel).

OpenRouter OpenAPI quirk (verified in `DecisionsChoiceAnswer`/`DecisionsScoreAnswer`/`DecisionsNoulAnswer`): only `type`+`choice`, `type`+`score`, `type`+`noul` are marked `required`; `probabilities`/`confidence`/`legend` are optional in the schema although present in every documented response.

## 4. Model IDs, pricing, rate limits, context budget

**TypeSafe-native IDs** (`GET https://api.typesafe.ai/v1/models` lists names):
- Versioned: `jev-1.13.0` (current model "Jev 1.13"; response `model` echoes this).
- Aliases: `jev-latest` → `jev-1.13.0` ("most recent stable, official release", SDK default); `jev-preview` → `jev-1.13.0` (most recent release incl. previews — **currently identical to `jev-latest`; no preview build exists**). Versioned IDs are accepted even if not listed. Aliases move when a release ships → pin the versioned ID if you tuned thresholds against it.

**OpenRouter model IDs** (System One API maps bare IDs onto the `typesafe/` namespace):
- `jev-1.13` → routed as `typesafe/jev-1.13`
- `jev-latest` → routed as `~typesafe/jev-latest` ("OpenRouter's alias for the newest Jev release")
- IDs already prefixed (e.g. `typesafe/jev-1.13`) used as-is.
- Response `model` = OpenRouter model ID of the model that served, e.g. `typesafe/jev-1.13-20260917` (dated snapshot — expected when you send `typesafe/jev-1.13`). Pin `typesafe/jev-1.13` when thresholds are tuned to one version; `~typesafe/jev-latest` is accepted.

**Pricing** (TypeSafe `/models`): "Price (per Btok / per Mtok) **$42 / $0.042**"; "Charged per input token. **Output tokens are free.**" OpenRouter: "billed based on the number of input tokens, and output tokens are free"; each response reports `usage.cost` in USD. The tutorial's example reconciles exactly with $0.042/Mtok (476 input tokens → `cost: 0.000019992`); the typesafe-sdk guide's example does **not** (275 input tokens → `cost: 0.00003` ≈ $109/Mtok) — treat per-call `usage.cost` as authoritative and this one example as a doc inconsistency. Exact current OpenRouter price lives on the model page (JS-rendered; **UNVERIFIED** from static fetch).

**Rate limits** (TypeSafe): **250,000 tokens per second / 1,200 requests per minute**; exceeding either → `429`. Warning: "Rate limits are adjusting dynamically... can change without notice"; higher limits on custom/enterprise plans (sales@typesafe.ai). OpenRouter-specific rate-limit numbers: **UNVERIFIED** (only generic 429 documented).

**Context budget** (jev-1.13): **64k tokens per request = `state` + all questions combined**; **32k tokens = `state` + the single longest question**. Jev ingests the state once and evaluates every question against it in parallel. Input: text only.

## 5. Endpoints (exact URLs)

| Surface | URL | Auth |
|---|---|---|
| TypeSafe native (System One) | `POST https://api.typesafe.ai/v1/systemone` | `Authorization: Bearer <TYPESAFE_API_KEY>` |
| TypeSafe native model list | `GET https://api.typesafe.ai/v1/models` | same |
| OpenRouter System One API (TypeSafe-SDK-compatible) | `POST https://openrouter.ai/api/v1/systemone` (SDK base URL `https://openrouter.ai/api`, SDK appends `/v1/systemone`) | `Authorization: Bearer <OPENROUTER_API_KEY>` |
| OpenRouter Decisions API (alpha) | `POST https://openrouter.ai/api/alpha/decisions` | same |

SDK config (OpenRouter): `apiKey`/`api_key` option or `TYPESAFE_API_KEY` env; `baseURL`/`base_url` = `https://openrouter.ai/api` or `TYPESAFE_BASE_URL` env. Both OR surfaces use the same `DecisionsRequest`/`DecisionsResponse` schema per OpenAPI. Caveat: the TypeSafe SDK's `client.models.list()` calls `GET /api/v1/models` (OpenRouter shape) and the SDK rejects it — browse openrouter.ai/typesafe or call the Models API directly.

**OpenRouter extra response fields** (confirmed): `id` (e.g. `"gen-dec-1789738314-X5e5eKGQdvR9rblyX250"`), `provider` (`"TypeSafe"`), `usage.cost` (number, USD; `usage` still has `input_tokens`, `output_tokens`). TypeSafe shape (`model`, `answers`, `usage`) is preserved; both TypeSafe SDKs "pass through without error".

## 6. Documented failure modes (jev-1.13 jaggedness, last reviewed 2026-09-17) & question-design best practices

Jev = fast, calibrated, common-sense judgment; "may struggle with tasks that require additional levels of indirection... quite literal... struggles with tasks that require numeric precision." Nine documented failure modes:

1. **Literal reading** — answers the question you wrote, not the one you meant (scoping words, negations, implied conditions read at face value). → State the exact condition; put boundary cases in `criteria`; split ambiguous judgments into two literal questions and combine in code.
2. **Math and Numbers** — "not a calculator"; **counting is unreliable** (characters, term occurrences, list items; error grows with size) — count in code (e.g. one Noul per item, sum in code). Semantic > numeric representations (color names beat hex; high-level languages beat assembly/binary). **Do not interpolate exact magnitudes from Score outputs** — "score levels are weak in numerical calibration"; thresholds OK, interpolation not.
3. **Date and time comparison** — dates read as text, not ordered quantities; worse with mixed formats, relative references, quarter/window boundaries. → Extract date components as **Choice over enumerated options** (with an explicit "not stated" option); do ordering/duration/weekday arithmetic in code.
4. **Indirection** — double negatives, property-of-property, multi-hop reasoning cost accuracy. → Direct instructions; name the relevant state parts.
5. **Large state full of irrelevant detail** — accuracy falls as state grows with unrelated content ("context rot"); distractors also make debugging harder. → Retrieve/filter in code first; or pre-filter with a Noul. Context limit note: bounded window (see §4).
6. **Adversarial content** — "State is data, and `jev-1.13` does not treat it as hostile by default"; injected instructions / misleading framing / self-classifying text can move the answer. → Precise criteria; test edge cases before deploying to many users.
7. **Contradictory instructions and criteria** — e.g. a Noul where `true` maps to no performs worse. → Align criteria with the instruction; plain language.
8. **Common-sense structural invariants** — NOT guaranteed: Noul vs yes/no-Choice disagree on the same question (`noul` 0.22 vs Choice `yes` 0.01/`no` 0.99); `P(question) + P(negated question)` ≠ 1 (0.72 + 0.47 = 1.19). → Don't carry thresholds between Noul and Choice; don't enforce arithmetic identities across separate questions; Choice is *relative* (which option), Noul *absolute* (can be low for all).
9. **Generation** — not trained to generate text; chained choices work poorly and slowly. → Bound the answer space into a Choice (extract candidates via regex or a generative model first).

**Question-design best practices:** one snap judgment per question ("a judgment a knowledgeable person makes in a second"); break multi-factor judgments into separate questions and combine with **code-side weights** (Composite scoring; normalize scores by `len(criteria)-1` before mixing scales); batch many questions per request (parallel, ~11.5x cheaper / 9.6x faster than 13 separate calls in the cookbooks; speculative fan-out — ask questions you might not need); questions in one request are independent — only make a second request when the first answer is needed to *build* the next request (fetch data, choose next options). Choice: add `other`/`none of the above` for uncovered inputs. Score: describe situations not degrees; distinct levels only (up to 10); numbers-only criteria example: `criteria: ["0","1","2"]` on a clear input gave `score 0.55, confidence 0.33` vs `score 0.0, confidence 1.0` with descriptive levels; structured level examples help **only** when they resemble real inputs (matching example: 1.43/0.35 → 1.03/0.96; unrelated example: unchanged). Also avoid: asking code-computable things, hiding several judgments in one question, System-Two tasks, over-large `state` ("Jev suffers from context rot").

## 7. Non-English (pt-BR) input

No pt-BR/Portuguese-specific guidance exists in the docs (**nothing documented — treat as UNVERIFIED for pt-BR specifically**). What IS documented (`/concepts/state` Note + `/models#language-support`):
- "Jev accepts text only... Jev's primary training language is English; other languages, including CJK scripts, are accepted but currently have lower accuracy."
- "English is the primary training language and where accuracy is currently best. Other languages, including CJK scripts, are handled but not equally well; **test on your own content before relying on Jev for a non-English workload, and pay close attention to Confidence when routing.**"

Practical implication for pt-BR: expect degraded accuracy vs English, validate thresholds on labeled pt-BR data, and lean harder on `confidence`-gated human review.
