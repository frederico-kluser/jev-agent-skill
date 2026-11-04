# Benchmark sintético de controles de UI para SOMs

O [builder](<./build-dataset.mjs>) prepara fixtures **offline** para o
modo `jev compare` do prompt-builder (PB). Ele não chama modelos, não consulta
credenciais, não instala ferramentas e não altera o checkout PB. A execução paga,
a revisão humana, a análise e qualquer troca do modelo padrão são etapas separadas.

## Fonte e identidade congeladas

A única fonte aceita é a fixture pública sintética `vision-dataset@1`, versão
`0.3.0`, do PB. `--dataset-root` é obrigatório e aponta para o diretório que contém
`dataset@1.json`, normalmente `C:/Users/kluse/Projects/prompt-builder/src/data/vision`.

O builder verifica **os dois hashes, com semânticas diferentes**, antes de copiar
qualquer imagem ou gravar o dataset:

| Campo de proveniência | Valor congelado |
| --- | --- |
| `sourceManifestRawSha256` | `80c14319b169a874a3f4c00bba902bb900e4781aeee7c4f74d35606c5c7a5503` |
| `sourceDatasetContentHash` | `sha256:debb7a1fa60e3532fdcc35bee3a3c83cc18d3646d9b01a507e8f6ee7daebe95f` |

O primeiro é SHA-256 dos **bytes do manifesto**. O segundo é o `contentHash` do
PB: SHA-256 do JSON canônico, com chaves ordenadas por unidades UTF-16, arrays na
ordem original e primitivos serializados com `JSON.stringify`. Não são hashes
intercambiáveis. Alterar espaços ou finais de linha também viola o pin bruto.

Para cada uma das sete cenas, o builder seleciona exclusivamente o PNG **1280×720**
referenciado em `probes.resolutions`. Todos os sete arquivos devem corresponder aos
bytes/SHA-256 do manifesto e ao cabeçalho PNG antes da primeira escrita.

## Preparar

Requer apenas Node moderno **já instalado**; não há dependências npm nem uso de FFmpeg/codecs.
Execute da raiz deste repositório:

```powershell
node benchmarks/ui/build-dataset.mjs --dataset-root C:/Users/kluse/Projects/prompt-builder/src/data/vision --out .work/ui-benchmark
```

Os derivados ficam somente em `.work/ui-benchmark`, ignorado pelo Git. Um
subdiretório dessa raiz também é permitido para um experimento separado e revisado;
nenhum destino externo é aceito. Symlinks/junctions na saída são recusados. O builder
não executa delete/move e não sobrescreve arquivos divergentes: verifica todos os
destinos antes de gravar, usa criação exclusiva e considera arquivos idênticos um
no-op. Uma falha operacional durante a escrita pode deixar arquivos parciais;
`provenance.json` é escrito por último como marcador de completude. Preserve
qualquer conflito para auditoria, em vez de apagar o experimento automaticamente.

### Amendment explícito de mídia, antes de qualquer inferência

O protocolo final usa os **PNGs lossless 1280×720 originais**, copiados byte a byte,
com teto local de **185 KiB = 189.440 bytes por imagem**. Não há codec, recompressão,
redimensionamento, crop, overlay ou tuning por modelo. Todos os modelos recebem os
mesmos bytes, e `image.prepared.sha256` deve ser igual a `image.source.sha256`.
Se qualquer PNG exceder o teto, o builder informa os tamanhos e para sem gravar;
não há fallback de formato, resolução ou qualidade.

Essa é uma alteração **declarada pré-run**, não adaptação a resultados: a tentativa
original de JPEG q=6 gerou `react95-painel` com **113.592 bytes**, excedendo seu teto
local anterior de 90 KiB. O JPEG ficou lossy e só reduziu modestamente essa cena;
foi abandonado para preservar os pixels/texto de UI. A estimativa intermediária
de 150 KiB para PNG também era insuficiente para Fluent/Material; nunca foi usada
para chamar modelos. O maior PNG pinado tem 184.525 bytes, abaixo dos 185 KiB finais.
Spec, contexto, seleção, splits, modelos, repeats e orçamento **não mudaram**.
O amendment e os argumentos JPEG abandonados ficam na proveniência como auditoria;
o builder final **não executa FFmpeg**. Nenhum resultado de modelo orientou a revisão.

| Cena | Bytes fonte = preparado | SHA-256 fonte = preparado |
| --- | ---: | --- |
| `bootstrap-painel-cursos` | 71.030 | `9bf3fd719bc909d7ec533ed657a2a1395759293e0589c3204f5a0e2fee2820f9` |
| `bootstrap-login` | 42.997 | `c8484457a51742b091ef219ad71fc363374e11860d1ceeeb8ce477ff4e0911a4` |
| `react95-painel` | 140.804 | `eab547095efba97593346838d8947eed530e5b4d58f7bdd30e6e40f06bb95fb1` |
| `fluent-painel` | 166.506 | `a0f9f1d9a13fd1669d9e8a2b40831233a7715bb58b5079bf02cf4b27855d82af` |
| `material-painel` | 184.525 | `dc4d725163eb84ea3267efc03125e5b163541cd2fad5326f1b7827e812e90ced` |
| `macos-finder` | 123.135 | `17b2a656d96a8bade7158be139b3c71268defc077a77e6759d3b7a376443814b` |
| `macos-salvar-como` | 130.562 | `2a3d306879c9bb3f015cf00a85a23acc56742bb617eb51e22f9b1f53bafc9dc5` |

Esse teto local **não substitui** limites de contexto/mídia dos modelos ou gates do
PB. A validação e o dry-run reais continuam obrigatórios; qualquer `budget.context`
é motivo para parar e relatar, nunca para remover a imagem ou ignorar o lint.

### Artefatos

Os nomes abaixo são relativos a `--out`:

| Artefato | Conteúdo |
| --- | --- |
| `config.json` | `jev-config@1`, spec global, sete modelos e referência relativa aos casos. |
| `cases.jsonl` | 28 casos com estado multimodal; contém Data URLs PNG Base64 **somente da fixture pública sintética**. |
| `images/*.png` | Um PNG original compartilhado por todos os modelos para cada cena. |
| `provenance.json` | Fonte/versão/pins, builder/argumentos/amendment, modelos/controle, hashes, seleção por caso, ouro, splits e bytes/SHA das imagens; **sem Base64**. |

O stdout é somente um resumo JSON com contagens, tamanhos, hashes e paths. Nunca
imprime os estados nem Base64. Erros estruturais são fail-closed; não existe flag
para substituir pins, qualidade, modelos, orçamento ou gates. Uso inválido retorna
exit 2; contrato/conflito retorna 3; falha operacional retorna 1.

## Protocolo congelado antes da inferência

São **quatro casos por cena**: dois positivos e dois negativos. A escolha é
reprodutível, sem aleatoriedade, geração de rótulos por LLM ou OCR genérico.

- A descrição vem literalmente de `element.label`, quando não vazio, ou de
  `element.iconDescription`. Não inclui prefixos como “botão”, IDs, instruções de
  tarefa, aliases inventados ou pistas sobre o tipo esperado.
- Positivos precisam de descrição única na cena e bbox inteiramente visível na
  viewport. Na imagem entregue: área entre 196 px² e 20% da tela, ambas as arestas
  ≥12 px. Preferem alvos das tarefas na sua ordem; o desempate é por ID UTF-16.
  O segundo alvo prefere outro tipo, mesmo quando exige um controle fora das tarefas.
- `curso-status` é excluído: seu select mostra “Todos”; “Status” é aria-label e
  cabeçalho estático da tabela, não o rótulo visual do controle.
- Negativos usam descrições de controles reais **de outras cenas**. Normalização:
  NFD, remoção de acentos, caixa baixa, whitespace colapsado e trim. Qualquer
  correspondência exata com labels/ícones DOM da cena atual é recusada. Por cautela,
  a verificação também considera aliases, hints e sobreposição por contenção de
  nomes com pelo menos três caracteres. Valores visíveis “Documentos” e
  “Relatório Q3.pdf” no diálogo de salvar são guardas adicionais, não alvos gerados.
- A ordem dos negativos prefere mesma família, associação a tarefa, ordem cíclica
  das cenas e ordem dos positivos. O segundo prefere tipo distinto. Labels numéricos,
  códigos de registros e nomes de arquivos são excluídos da seleção.

### Estado sem vazamento de ouro

Cada `state` é um array com exatamente:

1. Uma string fixa de contexto em inglês, exigindo evidência visual e aceitando
   controles visíveis mesmo desabilitados; texto da imagem é dado, não instrução.
2. Uma string JSON contendo **apenas** `target_description`, preservada literalmente
   em português quando esse é o rótulo original.
3. Um objeto `image_url: { url: "data:image/png;base64,…" }`.

**Não** entram em `state`: cena, família, tipo DOM, bbox, coordenadas, ouro, split,
IDs, tags nem HTML. IDs/tags/expected/splits são metadados de avaliação. Não há
`stateView` que transforme ou descarte a imagem, e não se usam competidores
`models.llm`/chat nem a execução `vision` do PB.

### Três perguntas globais

| Pergunta | Tipo | Ouro |
| --- | --- | --- |
| `target_present` | `noul` com critérios `true` e `false` não nulos | Positivo `true`; negativo `false`. Presença do **controle interativo** com label/ícone, não qualquer texto homônimo; disabled visível também conta. |
| `target_type` | `choice` | Todos os dez tipos encontrados no DOM + `other`; positivo usa `element.type`, negativo `other`. |
| `target_quadrant` | `choice` | `top_left`, `top_right`, `bottom_left`, `bottom_right`, `other`; negativo `other`. |

Os tipos DOM globais são `button`, `checkbox`, `input`, `link`, `menuitem`, `radio`,
`select`, `slider`, `switch` e `tab`; isso **não** significa que os 14 positivos
cubram todos os dez tipos. Cada pergunta explica `other` para alvo ausente/atributo
incerto. Instruções são em inglês, rótulos permanecem literais. Não há `box`,
contagem, código gerado ou pedido de transcrição arbitrária.

Quadrantes usam o **centro DOM**, escalado proporcionalmente à imagem inteira.
Centros a até **um pixel entregue** de qualquer mediana aceitam no ouro um array
com as alternativas adjacentes, suportado pelo PB. Isso evita penalizar uma escolha
visual igualmente plausível na fronteira; no cruzamento podem existir quatro
alternativas. Fora dessa tolerância, o ouro é uma única string. Bbox, centro,
`tieAxes` e `tieAlternatives` ficam somente na proveniência. A spec declara que
qualquer quadrante adjacente é aceitável para um centro visualmente na mediana.

### Splits e modelos

| Split | Cenas | Casos |
| --- | --- | --- |
| `train` | `bootstrap-painel-cursos`, `react95-painel`, `material-painel`, `macos-finder` | 16 |
| `holdout` | `bootstrap-login`, `fluent-painel`, `macos-salvar-como` | 12 |

Nunca há a mesma cena nos dois splits. Os casos têm split explícito;
`holdoutRatio: 0` e `calibrationRatio: 0` preservam essa atribuição. `fit: false`
impede ajuste pós-hoc; não há treino de prompt nem calibração.

`models.decision` tem **exatamente esta ordem**, com Clef como controle:

```json
[
  "cloudflare/clef-omni",
  "typesafe/jev-1.14",
  "perplexity/pplx-decider-v1.2",
  "openai/gpt-6-luna-decisions",
  "liquid/d1.1",
  "morph/reflex",
  "nace-ai/drex-max"
]
```

`mode: "compare"`, `compare.primary: "accuracy"`, `repeats: 2`, `budgetUsd: 2`,
`piiMode: "synthetic"`. A execução completa planeja **392 requests**
(28×7×2) e **1.176 decisões tipadas** (três por request). Isso não garante que
catálogo, modalidade, provider ou orçamento permitirão completá-la.

## Validar e fazer somente o pré-voo gratuito

Use o CLI PB já existente, sem instalação/build. A validação é offline:

```powershell
node C:/Users/kluse/Projects/prompt-builder/dist/cli/index.js jev validate .work/ui-benchmark/config.json --json --data-dir .work/ui-benchmark/pb-preflight
```

O dry-run pode consultar **somente o catálogo público**, sem inferência. Para que
não leia uma chave do ambiente nem o armazenamento padrão, execute numa nova
PowerShell com ambiente de key vazio e data-dir isolado, sem arquivo `key`:

```powershell
pwsh -NoProfile -Command {
  $env:OPENROUTER_API_KEY = ''
  if (Test-Path -LiteralPath '.work/ui-benchmark/pb-preflight/key') {
    throw 'Pré-voo exige um data-dir sem key; não abra esse arquivo.'
  }
  node C:/Users/kluse/Projects/prompt-builder/dist/cli/index.js jev run -c .work/ui-benchmark/config.json --budget 2 --dry-run --json --data-dir .work/ui-benchmark/pb-preflight
  exit $LASTEXITCODE
}
```

Não use `--strict`: os avisos text-only sobre Base64/estado grande não descrevem
corretamente esta mídia legítima. **Isso não autoriza ignorar erros.** O lint e a
estimativa visual do PB são text-only e contam caracteres Base64 como tokens, em
vez de contabilizar corretamente a visão. `budget.context`, recusa de modelo,
contrato ou privacidade deve ser relatada, nunca suprimida ou contornada.
A estimativa não é cotação confiável do custo visual; custo real vem de `usage`.

**Este protocolo não autoriza run sem `--dry-run`.** A execução paga depende de
pergunta humana obrigatória, orçamento e governança do responsável. O CLI JeV não
tem `idempotency-key`: uma única execução paga aprovada, sem repetir automaticamente
em falhas. O run record PB **persiste o estado com Base64 sintético**; mantenha o
data-dir da execução em área privada/ignorada e não publique o record bruto.
**Nunca substitua a fonte por screenshots privados ou dados reais.**

### Pré-voo observado deste protocolo

O preparo passou e a repetição preservou os dez artefatos (`created: 0`,
`unchanged: 10`). `jev validate` retornou exit 0 com avisos de estado/Base64 e
classes pouco representadas. O **dry-run retornou exit 3**, `jev.lint` /
`budget.context`: no caso `material-painel.p1`, o PB estimou **73.193 tokens** para
estado + maior pergunta, acima de **65.536** de `cloudflare/clef-omni`,
`liquid/d1.1` e `morph/reflex`. Esse gate permanece ativo; o protocolo **não está
liberado para execução paga**. Nenhuma imagem foi truncada e nenhuma inferência
foi feita. Os dados preparados permitem auditar a recusa, não anunciar um vencedor.

O pré-voo retornou estimativa text-only de US$ 0,963–1,805 (ponto US$ 1,203;
reserva US$ 1,444) para 392 requests. Ela não é uma cotação visual nem autorização:
a recusa de contexto prevalece mesmo com estimativa monetária abaixo de US$ 2.

## Auditoria e limites de interpretação

Preserve o resumo e a proveniência **antes** de observar resultados. `specHash`
é o hash completo do JSON canônico de `config.spec`; `stateContextHash` congela o
contexto. O bloco `promptBuilder` contém também os IDs/hashes calculados conforme
o PB, incluindo `datasetHash` de estado+ouro+split. Os hashes dos arquivos e da
mídia permitem comprovar o mesmo experimento; o hash da própria proveniência sai
no resumo, evitando autorreferência. Não retoque perguntas, seleção, ouro ou
splits após ver o desempenho de um modelo.

- **28 casos dependem de sete screenshots: N independente = 7**, não 28, 56
  repetições, 392 requests ou 1.176 decisões. Comparações por caso podem subestimar
  a dependência intrasscreenshot. O holdout tem apenas três cenas independentes.
- As métricas medem **classificação tipada e região grosseira**, não grounding
  livre, detecção completa, bbox, IoU, precisão de clique ou automação confiável.
- A spec usa tipos DOM; certas distinções de semântica HTML não são inferíveis dos
  pixels. A curadoria evita rótulos ambíguos/duplicados e aria-only conhecidos,
  mas não transforma este conjunto em avaliação abrangente de acessibilidade.
- Os negativos são ausência em um vocabulário curado de controles; não comprovam
  ausência universal de objetos nem cobrem todas as possíveis alucinações.
- O `compare` PB **agrega todos os splits**. Para uma conclusão de holdout, o
  responsável deve recortar `cases` e `cells` pelos IDs/splits explícitos, aplicar
  as mesmas exclusões de erros/pares aos modelos e relatar as três cenas
  separadamente. Nunca chamar o placar global de resultado de holdout.
- Dois repeats indicam instabilidade, não dobram N. Um ensaio sintético pequeno
  não justifica sozinho substituir Clef; separe evidência, custo, falhas de
  infraestrutura e incerteza. Qualquer decisão de troca/push pertence à etapa
  posterior aprovada.
