---
name: jev-agent-skill
description: >-
  Decisões tipadas em milissegundos com o modelo Jev (System One da TypeSafe) via
  OpenRouter: state + perguntas tipadas (noul/choice/score) entram, decisões com
  probabilidades calibradas saem — sem geração de texto, com validação pesada de
  requisição e resposta e bandas de ação (auto/hitl/abstain). QUANDO DEVE SER
  USADA: sempre que houver uma decisão discreta de alto volume e baixa
  criatividade — rotear/classificar intenção, triar tickets/dados/logs, aplicar
  guardrails (ex.: detectar prompt injection em conteúdo externo), pontuar
  artefatos numa régua ordenada (prioridade, criticidade, qualidade), responder
  verificações sim/não — MESMO QUE O USUÁRIO NÃO DIGA "Jev": "decida", "classifique",
  "roteie", "triagem", "qual equipe", "é urgente?", "prioridade de 0 a 10" são
  gatilhos. NÃO USE para: gerar texto/código/traduções, raciocínio de múltiplos
  passos, contagens ou aritmética exatas, comparações de datas, ou quando a
  resposta não couber num esquema enumerável pré-definido.
metadata:
  version: 1.0.0
  type: task
---

# Jev — decisões System One via OpenRouter

O Jev não é um LLM: é um **System One model** (não-autorregressivo). Recebe um
`state` (texto/JSON) + um mapa de perguntas tipadas e devolve **decisões**
(`noul` → probabilidade de sim; `choice` → opção + distribuição + confiança;
`score` → posição ponderada numa régua ordenada) — tudo numa passagem, com as
perguntas avaliadas **em paralelo**. Output é **grátis**; cobra-se só o input
(~$0.042/Mtok no OpenRouter). Latência típica de decisão: **~250-350 ms** medidos
a partir desta máquina (ver `references/latencia.md`).

## Quando usar

| Gatilho do pedido | Primitiva | Exemplo de pergunta |
|---|---|---|
| "é X ou Y?", sim/não, guardrail | `noul` | "A mensagem expressa urgência?" |
| "qual equipe/categoria/motivo?", roteamento | `choice` | "Qual equipa deve tratar?" (com opção `other`) |
| "quão urgente/crítico/bom?", régua 2-10 níveis | `score` | "Prioridade?" (níveis = situações concretas) |
| triagem em massa (RAG, logs, fila) | várias em **1 chamada** | 13 perguntas num pedido = ~11,5× mais barato, ~9,6× mais rápido |

**Não usar** (contraindicações documentadas): geração de texto, raciocínio
multi-hop, contagens/contas exatas, ordem de datas, avaliação espacial/multimodal.
Nesses casos: código determinístico (`bash`, editor) ou o LLM principal (Sistema Dois).

## O contrato do script (Nível 2 — o essencial)

Tudo vive em `scripts/jev.mjs` (Node ≥ 20, zero dependências):

```bash
export OPENROUTER_API_KEY="sk-or-v1-..."   # https://openrouter.ai/keys

node scripts/jev.mjs ask --request-file examples/requests/ticket-triage.json
node scripts/jev.mjs validate --request-file pedido.json     # offline, sem gastar tokens
node scripts/jev.mjs batch --requests-file lista.json --concurrency 4
node scripts/jev.mjs eval --evals-file evals/evals.json      # accuracy + ECE
node scripts/jev.mjs status --check
node scripts/jev.mjs selftest                                # verificação offline
node scripts/jev.mjs serve                                   # servidor MCP (stdio)
node scripts/bench.mjs [--live]                              # benchmark antes/depois
```

| Comando | Faz | Saída |
|---|---|---|
| `ask` | 1 decisão validada de ponta a ponta | respostas + `decisions` (bandas) + `_jev` (latência, socket quente, custo) |
| `validate` | validação OFFLINE de requisição (schema + conceitos) | erros/avisos + orçamento de tokens; exit 2 se inválida |
| `batch` | N decisões num processo (socket TCP+TLS reutilizado) | JSON agregado; `sockets_warm` na telemetria |
| `eval` | corre casos rotulados e mede **accuracy + ECE** | relatório de calibração por bin |
| `serve` | servidor **MCP** stdio com a ferramenta `evaluate_with_jev` | keep-alive quente entre decisões |

Formato de uma requisição (`--request-file`):

```json
{
  "model": "typesafe/jev-1.13",
  "state": { "ticket": "Checkout mostra tela branca após clicar em Pagar." },
  "questions": {
    "is_bug": { "type": "noul", "instructions": "O cliente reporta um defeito?",
                "criteria": { "true": "Descreve comportamento partido", "false": "É pergunta/pedido" } },
    "team":   { "type": "choice", "instructions": "Que equipa trata?",
                "criteria": { "frontend": "Rendering", "payments": "Checkout/billing", "other": "Nenhuma" } },
    "urgency":{ "type": "score", "instructions": "Quão urgente?",
                "criteria": ["Pode esperar", "Esta semana", "Bloqueia receita agora"] }
  }
}
```

Opções-chave: `--json` · `--strict` (avisos também falham) · `--auto-threshold` /
`--hitl-threshold` (bandas) · `--retries` · `--timeout`. Exit codes: **0** ok ·
**1** erro de API/execução · **2** requisição inválida.

## Regras de ouro (validação baseada nos conceitos do modelo)

O `validate`/`ask` já verificam tudo isto automaticamente — leia os avisos antes
de confiar numa decisão:

1. **Uma decisão atómica por pergunta.** "É urgente e precisa de reembolso?" são
   DUAS perguntas. Separe-as no mesmo mapa: correm em paralelo, sem custo de latência.
2. **O Jev não gera texto.** Instruções tipo "explique/escreva/resuma" são
   contraproducentes — encaixote a resposta num `choice` de opções enumeradas.
3. **Nunca delegue contas/datas/contagens** (jaggedness documentada). Conte em
   código e envie o resultado no `state`; peça só o julgamento semântico.
4. **`choice` precisa de opção de saída** (`other`/`none`) quando a lista pode não
   cobrir tudo — senão o modelo é forçado a classificar errado. Máx. 255 opções.
5. **`score` = régua ordenada de 2 a 10 níveis**, cada um descrevendo uma SITUAÇÃO
   concreta (níveis numéricos "0/1/2" têm desempenho péssimo). O `score` é
   Σ(nível × probabilidade) e pode cair entre níveis.
6. **`noul` não tem `confidence`** — a incerteza é a distância de 0.5 (0.5 = 50/50,
   NÃO "intensidade média"). `choice`/`score` trazem `confidence` = concentração da
   distribuição; descreve a resposta, **não** garante que esteja certa.
7. **Higiene do `state`**: condensado e correlacionado; ruído/metadata gigante
   degrada a precisão ("context rot"). Orçamento: 64k tokens/pedido;
   `state` + pergunta mais longa ≤ 32k.
8. **Não force invariantes aritméticos** entre perguntas (P(q)+P(¬q) pode ≠ 1) nem
   transporte limiares entre `noul` e `choice` (absoluto vs relativo).
9. **Conteúdo externo no `state` não é confiável** (injeção adversarial move as
   respostas) — para guardrails, use `noul` e trate a resposta como sinal, não permissão.
10. **pt-BR tem precisão inferior ao inglês** (documentado): calibre limiares com
    `eval` sobre casos seus e mantenha o HITL em decisões caras.

### Bandas de ação (configuráveis)

| Banda | Confiança (choice/score) / certeza (noul) | Ação |
|---|---|---|
| `auto` | ≥ 0.90 | executar sem intervenção |
| `hitl` | 0.50–0.89 | confirmar com humano antes de agir |
| `abstain` | < 0.50 | NÃO agir — cair para o Sistema Dois (LLM/raciocínio profundo) |

Ajuste aos riscos: operações destrutivas exigem `auto` mais alto; decisões
reversíveis podem baixar. Confiança em 0.5 é o chão documentado para "não adivinhar".

## Servidor MCP (decisões em loops de agente)

`node scripts/jev.mjs serve` expõe `evaluate_with_jev` via stdio (JSON-RPC 2.0,
MCP). O processo fica **residente**: o primeiro pagamento de DNS+TCP+TLS acontece
uma vez e todas as decisões seguintes usam o socket quente — é a diferença entre
~330 ms e ~260 ms por decisão em rajada (ver `references/latencia.md`).

```bash
# Claude Code
claude mcp add jev -- node /caminho/para/scripts/jev.mjs serve
# Qualquer cliente MCP: comando "node scripts/jev.mjs serve", transporte stdio
```

## Garantias (para confiar sem verificar)

- **Determinístico**: `selftest` valida 36 cenários OFFLINE (schema, conceitos,
  bandas, retries com `Retry-After`, 402 terminal, fallback h2→h1, leak de
  sessão h2 contra servidor local, redação de chave). Corra após qualquer mudança.
- **Calibrado**: `eval` mede accuracy + **ECE** sobre `evals/evals.json`
  (referência desta máquina: 7/7, ECE 0.026 — mas valide com os SEUS casos).
- **Guardrails de injeção**: `evals/injection-evals.json` — 8 cenários de prompt
  injection (limpos vs. injetados a meio do texto): 8/8, conf 0.97. A deteção é
  sinal para banda `hitl`/`abstain`, nunca permissão de execução.
- **Orçamento de contexto**: saída JSON enxuta; validação barata antes de gastar tokens.

## Referências

- `references/api.md` — contrato completo: endpoints, schema, erros, limites, preço.
- `references/validacao.md` — cada regra de validação e o conceito do modelo por trás.
- `references/latencia.md` — física da latência, keep-alive, batching, MCP; medições reais.
- `references/benchmarks.md` — antes/depois medido, estudo h1 vs h2, decisões anti-overenginier.
- `references/pesquisa-verificada.md` — o que foi verificado nas docs oficiais (e o que não).
- Skills relacionadas: `openrouter-agent-skill` (roteamento/providers da API),
  `tavily-agent-skill` (pesquisa web para calibrar casos).

## <evolution>

Tarefa com ciclo de evolução: ao fim de cada uso com surpresa ou correção,
registar o aprendizado em `LEARNINGS.md` (com fonte: usuário > docs > inferência);
se virar padrão estável, destilar no corpo acima e incrementar `metadata.version`.
Mudanças ficam como diff git para revisão humana — nunca auto-merge.
