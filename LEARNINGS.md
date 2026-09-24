# LEARNINGS — jev-agent-skill

Aprendizados em probação ou consolidados. Fonte: `usuário` > `docs oficiais` > `inferência`.
Padrões estáveis sobem para o corpo do `SKILL.md` e `metadata.version` incrementa.

## 2026-09-24 — criação da skill (fonte: docs oficiais + medições ao vivo)

- **`sock.reused` não existe em `TLSSocket`** (Node 24) — sempre `undefined`. O
  sinal correto de socket reutilizado é **`req.reusedSocket`** no `ClientRequest`.
  Também `res.socket` é `null` no evento `end`. Resultado: telemetria de warm
  socket estava sempre falsa antes da correção. (tipo: gotcha; verificado ao vivo)
- **Níveis de `score` = 2 mín., API aceita até 10** (não "2-10 recomendado") —
  acima de 10 a API rejeita. (docs: /primitives/score)
- **`criteria` aceita `null`** em opções/níveis autoexplicativos (EntryType oficial:
  string | object | array | null). (docs: /primitives/advanced)
- **`noul` não tem `confidence`** — incerteza vive na distância de 0.5; a
  tentação de ler `answer.confidence` em noul é um erro clássico. (docs: /confidence)
- **Score com níveis só numéricos ("0","1","2") tem desempenho péssimo** medido
  (score 0.55/conf 0.33 vs 0.0/conf 1.0 com descrições) — validar sempre.
  (docs: jaggedness jev-1.13)
- **Invariantes aritméticos não se aplicam**: P(q)+P(¬q) pode dar 1.19 e
  `noul` 0.22 vs `choice` sim=0.01 no mesmo input — não transportar limiares
  entre primitivas. (docs: jaggedness #8)
- **OpenRouter expõe DUAS superfícies**: Decisions `POST /api/alpha/decisions` e
  System One `POST /api/v1/systemone` (compatível SDK TypeSafe). Mesmo schema,
  mesma faturação. IDs soltos (`jev-latest`) mapeiam para `typesafe/`/`~typesafe/`.
  (docs: openrouter.ai OpenAPI)
- **Tutorial de origem do usuário tinha detalhes imprecisos**: SDKs oficiais são
  `@typesafe-ai/sdk`/`typesafe_sdk` (não um `typesafe_sdk` com `TypeSafeClient`
  genérico), preço é $0.042/Mtok de input com output grátis, e o schema real tem
  `noul` sem `confidence` (o tutorial pedia avaliar `confidence` em tudo).
  Decisão: seguir SEMPRE a doc oficial; o tutorial serviu de arquitetura
  (keep-alive/MCP/bandas). (fonte: usuário = tutorial; contrariado por docs)
- **Medições**: ask isolado ~330 ms; batch sequencial reutiliza socket (4/5 warm);
  eval 7/7 com ECE 0.026 (en+pt-BR) — pt-BR não mostrou degradação nos casos
  triviais, mas a doc avisa que precisa de calibração própria.
