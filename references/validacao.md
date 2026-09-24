# Validação — cada regra e o conceito do modelo por trás

O `scripts/jev.mjs` valida **antes** de gastar tokens (`validate`, e
automaticamente no `ask`/`batch`/`serve`) e **depois** da resposta
(`validateResponse`). Códigos de diagnóstico são estáveis (aparecem na saída e
são assertáveis no `selftest`). Regras derivadas da documentação oficial
(`docs.typesafe.ai`, jaggedness de 2026-09-17) — ver `pesquisa-verificada.md`.

## Erros (bloqueiam a chamada — exit 2)

| Código | Regra | Conceito por trás |
|---|---|---|
| `state.missing`/`state.type`/`state.empty` | `state` obrigatório: string, objeto ou array não vazio | O modelo avalia um estado; sem estado não há julgamento |
| `questions.empty`/`questions.type` | mapa `questions` com ≥1 pergunta tipada | Toda resposta nasce de uma pergunta tipada |
| `question.primitive` | `type` ∈ `noul`\|`choice`\|`score` | Só existem 3 primitivas — não há "texto livre" |
| `question.instructions` | `instructions` presente e não vazio | O ID da pergunta NÃO vai para o modelo; o julgamento vive em `instructions` |
| `noul.criteria_pair` | `criteria` de noul exige `true` E `false` | Define o significado dos polos da probabilidade |
| `choice.criteria`/`choice.cardinality` | choice exige `criteria` map; **≤ 255 opções** | Cardinalidade máxima documentada; acima → hierarquizar em 2 estágios |
| `choice.option_empty`/`choice.option_desc` | opções com chave/descrição válidas (ou `null` autoexplicativo) | O modelo só escolhe entre o que você enumerou |
| `score.criteria`/`score.levels_max` | score exige array ordenado; **API aceita até 10 níveis** | Cada nível é julgado independentemente; régua enorme fica indistinguível |
| `score.level_desc` | níveis não vazios | Nível sem descrição não é uma situação |
| `budget.state`/`budget.total` | `state`+pergunta mais longa ≤ 32k tokens; total ≤ 64k (estimativa chars/4) | Orçamento de contexto do Jev 1.13 |
| `session_id.len`/`user.len` | ≤ 256 caracteres | Limite do schema OpenRouter |
| resposta: `answer.*`/`choice.not_in_criteria`/`*.range` | coerência tipada da resposta | Formato nunca alucina — incoerência ⇒ problema de transporte/parse |

## Avisos (código continua; `--strict` transforma em erro)

| Código | Regra | Conceito por trás |
|---|---|---|
| `generative` | instruções tipo "explique/escreva/resuma/traduza" | Jev não gera texto (jaggedness #9): encaixe a resposta num `choice` |
| `jaggedness` | contagens, somas, percentagens, datas ("quantos", "how many", "qual data") | Falhas documentadas (#2/#3): conte/ordene em código; mande o resultado no `state` |
| `atomicity` | >1 "?" ou conectores ("e precisa", "and also") | Um julgamento por pergunta; multi-fator → perguntas separadas + combinar em código |
| `choice.no_match` | sem opção `other`/`none`/`outro`… | Regra oficial: opção de saída evita classificação forçada |
| `choice.criteria_single` | choice com 1 opção | Use `noul` |
| `score.levels_min` | régua com <2 níveis | "A Score should have at least two levels" |
| `score.level_numeric` | níveis puramente numéricos ("0","1","2") | Desempenho documentado péssimo (0.55/conf 0.33 vs 0.0/conf 1.0 com descrições) |
| `score.level_dup` | níveis duplicados | Níveis são julgados independentemente; duplicados confundem a régua |
| `budget.state_near` | >80% do orçamento | Estado grande com detalhe irrelevante degrada precisão ("context rot", #5) |
| `state.binary`/`state.blob` | binários/base64 no state | Jev só ingere texto; ruído consome orçamento |
| `model.unknown` | modelo fora da lista conhecida | Evitar IDs errados silenciosos |
| `probabilities.sum`/`probabilities.coverage` | distribuição soma ≈1; cobre as opções | Coerência da distribuição calibrada |
| `score.out_of_scale`/`score.legend_*` | score dentro de [0, níveis-1]; legend coerente | Régua enviada delimita a resposta |

## Notas (contexto, não falha)

| Código | Significado |
|---|---|
| `language.non_english` | state majoritariamente não-inglês → precisão inferior documentada; calibrar com `eval` e usar bandas |
| `noul.ambiguous` | noul ∈ (0.4, 0.6) → 50/50 honesto; nunca agir automaticamente |
| `answer.extra` | resposta para pergunta não pedida (ignorar) |

## Bandas de decisão (`decideBand`)

```
choice/score:  confidence ≥ 0.90 → auto · ≥ 0.50 → hitl · < 0.50 → abstain
noul:          certeza = max(p, 1-p) → mesmas bandas; |p−0.5|<0.1 marca `ambiguous`
```

- 0.5 é o **chão** documentado ("não adivinhar"); acima, o limiar de ação sobe com
  o risco (destrutivo ⇒ `auto` mais alto).
- `abstain` = cair para o Sistema Dois: LLM principal, raciocínio profundo ou humano.
- Thresholds NÃO são universais: ajuste com `eval` sobre os seus casos rotulados
  (pt-BR especialmente) e por tipo de ação (reversível vs destrutiva).

## Armadilhas que a validação NÃO apanha (conceitos)

1. **P(q) + P(¬q) ≠ 1** entre `noul` e `choice` sobre o mesmo conteúdo —
   invariante aritmética não garantida (#8). Não force consistência em código.
2. **Não transporte limiares** entre `noul` (absoluto) e `choice` (relativo "qual").
3. **Adversário no state** move respostas (#6): guardrails via `noul` são sinal,
   não permissão de execução.
4. **Instruções contradizendo `criteria`** degradam o modelo (#7): mantenha alinhados.
5. **Indireção/multi-hop** (#4): aponte o estado relevante pelo nome
   (ex.: `` `ticket.messages[0].text` ``) em vez de contar com inferência longa.
