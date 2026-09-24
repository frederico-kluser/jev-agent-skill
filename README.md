# jev-agent-skill

Agent Skill de **decisão rápida** com o modelo **Jev** (System One da TypeSafe)
via **OpenRouter**. State + perguntas tipadas (`noul`/`choice`/`score`) entram;
decisões com probabilidades calibradas e bandas de ação saem — em milissegundos,
sem geração de texto.

- **Zero dependências** — Node ≥ 20 puro (`node:https` com keep-alive).
- **Validação pesada** antes e depois de cada chamada, baseada nos conceitos do
  modelo (atomicidade, jaggedness, cardinalidade, orçamento, calibração).
- **Modo MCP** (`serve`) para loops de agente com socket TCP+TLS quente.
- **Calibração mensurável**: `eval` calcula accuracy + ECE sobre casos rotulados.

## Começar

```bash
export OPENROUTER_API_KEY="sk-or-v1-..."   # https://openrouter.ai/keys
node scripts/jev.mjs selftest                       # 29 verificações offline
node scripts/jev.mjs ask --request-file examples/requests/ticket-triage.json
```

Documentação operacional em [`SKILL.md`](SKILL.md); contrato completo em
[`references/api.md`](references/api.md); regras de validação em
[`references/validacao.md`](references/validacao.md); latência em
[`references/latencia.md`](references/latencia.md).

## Estrutura

```
SKILL.md                    camada semântica (quando/como usar)
scripts/jev.mjs             CLI (ask/validate/batch/eval/status/selftest/serve)
scripts/lib/validate.mjs    validação de requisição/resposta + bandas
scripts/lib/client.mjs      transporte keep-alive + retries + telemetria
references/                 contrato, validação, latência, fontes verificadas
examples/requests/          exemplos (en + pt-BR)
evals/evals.json            casos rotulados para calibração (accuracy + ECE)
```

Licença: MIT.
