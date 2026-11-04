# Validação e bandas — SOM/OpenRouter

Validação de requisição/resposta é offline e determinística, em
[validate.mjs](../scripts/lib/validate.mjs) e
[validate-media.mjs](../scripts/lib/validate-media.mjs). O transporte, preparação e
análise têm limites próprios adicionais. Não confundir formato correto com acerto
semântico nem um teste estrutural com calibração empírica.

## Falhas de requisição (não enviar inferência)

| Código/grupo | Contrato |
|---|---|
| `request.type`, `request.serializable` | JSON objeto, sem ciclo/BigInt |
| `state.*` | State do wire obrigatório, textual/JSON, não string vazia |
| `request.local_media` | `media[]` pertence ao analyze, não ao wire |
| `request.images` | `images` de topo não é entrada Decisions |
| `model.type`, `media.profile` | Modelo string; mídia exige perfil conhecido, sem propriedades herdadas |
| `questions.*`, `question.*` | Mapa não vazio, primitiva/instrução válidas; Clef máximo64 perguntas |
| `noul.criteria_pair` | Se criteria presente, exige true e false |
| `choice.criteria/cardinality/option_*` | Mapa de opções próprias, até255 no perfil Jev |
| `score.criteria/levels_max/level_desc` | Régua de descrições, máximo10 níveis |
| `box.model/image/criteria/instructions` | Jev1.14 + imagem válida; sem criteria, instructions obrigatória não-null |
| `budget.state/total` | Texto cabe no perfil de contexto selecionado |
| `media.image/video/unsupported/position` | Base64 canônico, MIME/headers coerentes, dimensões/tipo/posição aceitos |
| `media.body_bytes/image_total_bytes/av_bytes` | Tetos independentes de JSON e bytes/imagens expandidas |
| `assets.*` | Referência usada em VALORES de state/instructions/criteria, não em chaves; sem multipart |

`analyze` valida também caminhos/raiz, ficheiro regular/tamanho, container,
FFprobe/duração, configuração de amostragem e geometria de normalização. A ausência
de FFmpeg necessário é um erro acionável, nunca motivo para enviar bytes como texto.

## Lints que exigem julgamento

- `generative`: perguntar «explique/escreva/resuma» a um SOM não gera prosa.
- `jaggedness`: contagem, aritmética e datas exatas pertencem a código.
- `atomicity`: separar julgamentos compostos em perguntas independentes.
- `choice.no_match`: criar uma saída se as opções não forem exaustivas.
- `score.level_numeric/dup/levels_min`: descrições concretas e distintas, pelo menos2.
- `budget.state_near`: texto perto do teto, ainda sem contar visão.
- `media.experimental`: visão Jev Dreamer-ready e long-context; `--strict` bloqueia.
- `box.presence`: box sempre retorna arestas, mesmo sem alvo; presença separada.
- `state.blob`: Base64 nu em texto é ruído, não uma imagem.
- `budget.visual_unknown` é nota: tokens de mídia dependem do provider e não
  são estimados pelo tamanho do Base64. Um preflight válido não garante contexto.

## Resposta fail-closed

1. Cada answer é objeto não-null do tipo pedido. Números devem ser números
   finitos de verdade; não converter `null`, string ou boolean em probabilidade.
2. Noul está0..1; choice pertence a uma propriedade **própria** de criteria e
   não contradiz o argmax da distribuição; score está na régua e confere com
   Σ(índice×probabilidade), tolerância0.03 para arredondamento.
3. Probabilidades são finitas0..1, cobertura correta e soma aproximadamente1.
   Incerteza estrutural de distribuição implica `abstain`, não AUTO.
4. Box tem arestas0..1 e área positiva; confiança ausente/null é desconhecida.
5. Se há erro estrutural, **todas** as decisões da resposta ficam `abstain`.
   O mapa de resultados não herda Object.prototype.
6. HTTP200 com error, JSON inválido, credencial/crédito inválidos não viram
   resposta boa ou aprovação. Retentativas são limitadas e só para transientes.
7. Legendas/rubricas podem ecoar imagens em Jev; saídas/erros são sanitizados
   sem modificar o payload que realmente vai à inferência.

## Bandas

```text
noul: certeza=max(P(sim),1-P(sim))
choice/score: confidence reportada pelo modelo
>=auto (padrão0.90): auto
>=hitl (padrão0.50): hitl
abaixo disso, ausente, inválida ou resposta incoerente: abstain
```

Limiares exigem **0<=hitl<=auto<=1**. Noul perto0.5 é indecisão, não intensidade.
Entre perguntas não forçamos P(q)+P(negação)=1: isso não é invariante do modelo.

**Mídia:** `analyze` e os caminhos multimodais da CLI/MCP limitam todo AUTO
visual a **HITL**, inclusive imagens somente dentro de instructions/criteria.
Box nunca é autorização; `box_presence` explícito liga a presença e exige
probabilidade positiva suficientemente alta. Ausência/gate/confiança desconhecida
não produz clique; o runtime sequer contém um executor de ações.

`auto` textual continua disponível como sinal para a política do projeto;
operações destrutivas ou dados sensíveis precisam de autorização determinística
independente, não só um threshold probabilístico.

## Testar no projeto

- `node scripts/som.mjs selftest` conserva36 verificações de legado/transportes.
- `node --test` inclui suítes offline de mídia/CLI/MCP/integração.
- `eval` mede accuracy/ECE em casos rotulados de texto. Box exige avaliar presença
  e IoU/erro espacial; não fingir que um score numérico genérico mede isso.
- Calibrar por versão, modelo, idioma, domínio e modalidade. Não reutilizar ECE
  histórico do Jev1.13 textual como garantia de Jev1.14 visual ou Clef Omni.
- Conteúdo de mídia é não confiável: testes de prompt injection continuam
  importantes, mas resultados históricos pequenos não constituem barreira de segurança.
