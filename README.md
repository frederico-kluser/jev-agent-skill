# som-agent-skill

[![Last commit](https://img.shields.io/github/last-commit/frederico-kluser/jev-agent-skill)](https://github.com/frederico-kluser/jev-agent-skill/commits/master)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**System One Models reais via OpenRouter** para decisões sobre **texto, fotos,
screenshots e vídeos**, com biblioteca de backend, CLI, MCP e integração em
projetos existentes. Evolução da antiga `jev-agent-skill`.

| Adaptador implementado | Texto | Fotos | Vídeo | Primitivas |
|---|---|---|---|---|
| **Perplexity Decider V1.2** (oficial) | Sim | Sim, no topo do `state` (≤1,6 MP) | Frames (via preset) | `noul`, `choice`, `score` |
| Jev 1.14 | Sim | Sim, experimental | Frames JPEG extraídos localmente | `noul`, `choice`, `score`, `box` |
| Jev 1.13 (compatibilidade) | Sim | Sim, experimental | Frames JPEG | `noul`, `choice`, `score` |
| Cloudflare Clef Omni | Sim | Sim | MP4/WebM nativo, 2fps | `noul`, `choice`, `score` |

**Modelo oficial de decisões: Perplexity Decider V1.2** (`perplexity/pplx-decider-v1.2`,
default do runtime desde 2026-11-04). Contrato, limites (1,6 MP / 2048 tiles),
agrupamento, confiança, preço e **latência** em
[references/pplx-decider.md](references/pplx-decider.md).

Medido contra outros 15 candidatos: melhor acurácia na tarefa de presença/tipo
(0,958 treino / 0,944 holdout) e top-3 em **encontrar todos os controlos**
(F1 0,919 treino / 0,899 holdout), com o menor custo do grupo de topo
(~US$ 0,041/1000 pedidos) e p50 ~0,8 s. Limitações declaradas (7 telas
sintéticas, sem significância). Clef continua o único com vídeo nativo e Jev o
único com `box`. [Resultados](references/comparativo-ui-elementos-2026-11-04.md).

O SOM devolve decisões/probabilidades, **não prosa livre**. A skill entrega JSON e
relatório legível por templates; o agente explica os resultados com incertezas
explícitas. Um VLM de chat forçado a JSON não é anunciado como SOM equivalente.

## Começar sem gastar tokens

Requisitos: **Node ≥20**. Para mídia preparada: **FFmpeg e FFprobe** no PATH
(ou `FFMPEG_PATH`/`FFPROBE_PATH`). Não há pacote para instalar.

```bash
node scripts/som.mjs selftest
node --test
node scripts/som.mjs analyze --request-file examples/requests/photo-analysis.json --dry-run --json
node scripts/som.mjs analyze --request-file examples/requests/video-frames.json --dry-run --json
node scripts/som.mjs analyze --request-file examples/requests/video-native.json --dry-run --json
```

A [foto](examples/media/photo.png) e o [clipe](examples/media/clip.mp4) incluídos são
sintéticos, pequenos e reproduzíveis: retângulo vermelho e vídeo vermelho→azul,
sem áudio ou dados pessoais. `--dry-run` não acessa catálogo, chave ou inferência.

## Análise real pelo OpenRouter

Exporte `OPENROUTER_API_KEY` no processo usando seu secret manager; nunca a
coloque no código, em flags ou no frontend. Confira credenciais existentes com
`openrouter-agent-skill` antes de pedir uma nova.

```bash
node scripts/som.mjs models --input image
node scripts/som.mjs models --input video
node scripts/som.mjs analyze --request-file examples/requests/photo-analysis.json --json
node scripts/som.mjs analyze --request-file examples/requests/clef-photo.json --json
node scripts/som.mjs analyze --request-file examples/requests/video-frames.json --json
node scripts/som.mjs analyze --request-file examples/requests/video-native.json --json
node scripts/som.mjs ask --request-file examples/requests/ticket-triage.json --model typesafe/jev-1.14
```

Com mídia própria, o agente prepara perguntas para o seu objetivo:

```bash
node scripts/som.mjs analyze --image foto.jpg --questions-file perguntas.json --json
node scripts/som.mjs analyze --video clip.mp4 --video-mode frames --max-frames 12 --questions-file perguntas.json
node scripts/som.mjs analyze --video clip.mp4 --video-mode native --questions-file perguntas.json
```

- JSON: `answers`, `decisions`, `analysis`, `media`, `validation`, `usage` e `_som`.
- `--out novo.md` salva relatório; com `--json`, salva JSON. Sem sobrescrever arquivo.
- `SOM_MODEL` fixa um default; sem default explícito, native seleciona Clef Omni.
- Frames mostram lacunas/taxa efetiva e **não** analisam áudio.
- `box` exige Jev1.14 e gate de presença explícito; não aciona cliques.
- Todo `auto` visual é limitado a HITL; erro não vira autorização.

## Integrar no projeto que já existe

A skill **audita primeiro** uploads, auth, rotas, filas, env, políticas e testes
reais do projeto. Não substitui essa arquitetura nem sobe um servidor paralelo.
Leia o [guia de integração](references/integracao-projetos.md).

```bash
node scripts/integrate.mjs --project /projeto/existente --dest server/ai/som --dry-run
node scripts/integrate.mjs --project /projeto/existente --dest server/ai/som
```

O helper vendoriza somente o runtime, por hashes SHA-256. Repetição é NO-OP;
conflito local bloqueia antes de escrever. Não muda dependências, auth, rotas,
filas ou credenciais. O [adaptador de serviço](examples/integration/upload-service.mjs)
demonstra como ligar à infraestrutura existente; copiar arquivos não conclui a integração.

## MCP e API de backend

```bash
node scripts/som.mjs serve --media-root /projeto/uploads
```

Ferramentas: `evaluate_with_som` e `analyze_media_with_som`. `--model`/`SOM_MODEL`
valem nas duas. API pública: [analyze](scripts/lib/analyze.mjs) e seus
[tipos TypeScript](scripts/lib/analyze.d.mts). Pools persistem entre requests;
`closeAgents()` no shutdown. `mediaRoot` restringe caminhos/symlinks, não substitui
isolamento do decoder, autorização por dono e quotas do backend.

## Verificado nesta evolução

- **124/124 testes offline** em13 suítes, mais **36/36 verificações legadas**,
  sem falhas ou skips. Incluem mídia, CLI, MCP, instalação/integração, FFmpeg real,
  oito orientações EXIF, EOF, limites, redação de blobs e erros de API simulados.
- Inferência real: Jev texto/foto/frames e Clef Omni foto/vídeo nativo.
  O Clef escolheu azul no fim do clipe, mas com confiança0.108: o resultado
  corretamente ficou `abstain`, não aprovação automática.
- Medições e escopo exatos em [verificação](references/verificacao-2026-11-04.md).
  Smoke sintético **não** prova qualidade/calibração no seu domínio.

## Documentação e compatibilidade

[Skill operacional](SKILL.md) · [API](references/api.md) ·
[Mídia e modelos](references/multimodal.md) · [Validação](references/validacao.md) ·
[Pesquisa profunda e fontes](references/pesquisa-multimodal.md).

`scripts/jev.mjs`, `JEV_*` e nomes MCP antigos continuam como aliases de runtime;
`_jev` é alias da mesma telemetria `_som` (não some custos duas vezes).
O nome registrado da skill agora é **som-agent-skill**. A memória foi migrada
para **som-coala-agent-skill** com backup e histórico preservados.

As medições de [latência](references/latencia.md) e
[benchmarks](references/benchmarks.md) anteriores são históricas do Jev textual,
não uma promessa de desempenho multimodal ou do runtime2.0.

Licença [MIT](LICENSE).
