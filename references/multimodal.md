# Mídia e adaptadores SOM no OpenRouter

Verificado em **2026-11-04**. Fontes:
[guia multimodal OpenRouter](https://openrouter.ai/docs/guides/community/multimodal-decisions),
[TypeSafe Images](https://docs.typesafe.ai/images.md),
[Box](https://docs.typesafe.ai/primitives/box.md),
[Cloudflare Clef Omni](https://developers.cloudflare.com/workers-ai/models/clef-omni/),
[schema de entrada Cloudflare](https://developers.cloudflare.com/workers-ai/models/clef-omni/schema-input.json) e
[changelog oficial](https://developers.cloudflare.com/changelog/post/2026-10-09-clef-omni-workers-ai/).
O [dossiê](pesquisa-multimodal.md) distingue evidência documental, implementação e smoke real.

## O que é implementado, não apenas anunciado

| Perfil | Imagens | Vídeo nativo | Box | Contexto/preflight |
|---|---|---|---|---|
| `typesafe/jev-1.13` | PNG/JPEG experimentais | Não | Não | Texto64k total/32k por pergunta; imagem262144 |
| `typesafe/jev-1.14` | PNG/JPEG experimentais | Não | Sim, experimental | Igual ao1.13 nos modos acima |
| `cloudflare/clef-omni` | PNG/JPEG no runtime; provider também anuncia WebP | MP4/WebM verificados | Não | 65536 total |

O catálogo tem outras famílias de decisões com imagem. `models --input image`
as lista, mas `implemented_adapter:null` significa que esta versão não implementa
seus limites/conversões. Não trocar apenas `model` e presumir equivalência.

Clef Omni não é um chat VLM com prompt JSON: o fornecedor diz que pontua as
respostas permitidas em uma passagem e **não gera texto**. O backbone e rótulos
genéricos do catálogo não substituem o contrato específico de decisão.

## Fotografia / screenshot

O pipeline [media.mjs](../scripts/lib/media.mjs):

1. Resolve ficheiro regular ou Data URL; não faz download HTTP.
2. Se configurada `mediaRoot`, confere o realpath, incluindo symlinks.
3. Inspeciona bytes PNG/JPEG, rejeita APNG e dimensões inválidas; formatos de
   foto adicionais dependem de conversão suportada pelo FFmpeg instalado.
4. Aplica fisicamente as8 orientações EXIF, inclusive espelhos; elimina metadata
   na reexportação padrão. Não confiar no provider para interpretar EXIF.
5. Faz resize proporcional e, quando necessário, **padding**, não stretch.
   Preserva dimensões originais/orientadas, conteúdo preparado e offsets.
6. Exporta JPEG estático; valida novamente dimensões, MIME e bytes.
7. Coloca parte `image_url` e label string no array `state` de topo.

`--no-preprocess` exige foto PNG/JPEG já válida/orientada/dimensionada; pode manter
metadados. Para dados sensíveis, não desative a reexportação por conveniência.

### Tetos Jev: três verificações diferentes

- PNG/JPEG estático; até16MiB por ficheiro decoded.
- TypeSafe:280..1568px em cada eixo, área78400..2458624px².
- OpenRouter publica256..1568px/eixo com a mesma área mínima. **Não resolvido**
  para256..279: o perfil local usa280 como escolha conservadora, não um novo fato upstream.
- Até32MiB de JSON incluindo expansão Base64,32MiB de imagens processadas e
  32MiB de request expandido. Referências repetidas contam repetidamente.
- O decoder upstream pode reprocessar/aumentar imagens; o validador local só
  conhece bytes disponíveis e não promete que passar no teto de upload basta.
-64 imagens é teto **operacional desta implementação**, não limite oficial Jev.

Visão/box continuam **Dreamer-ready**, separadas da estabilidade do release textual.
A API nativa exige `TypeSafe-Danger-Zone-Images:true`; o contrato OpenRouter
usado/testado não exige esse header do chamador e ativa long-context em imagens.
Não afirmar quais headers internos o gateway injeta sem evidência.

### Tetos Clef Omni

- Até4 imagens,4MiB/16MP por imagem e8MiB decoded total segundo Cloudflare.
- O runtime normaliza conservadoramente para280..1568px por eixo e JPEG,
  também no Clef; isso é escolha local, não limite dimensional geral do fornecedor.
- Sem `box`; `noul/choice/score` e até64 perguntas por request.

## Vídeo por frames: Jev ou outro perfil de imagens suportado

```bash
node scripts/som.mjs analyze --request-file examples/requests/video-frames.json --dry-run --json
```

- FFprobe lê stream/duração/taxa nominal; FFmpeg faz seeks e exporta JPEGs.
- Containers aceitos para frames: MP4/MOV, WebM/MKV e AVI, confirmados por
  assinatura e whitelist de demuxer. Playlists/concat são rejeitados para não
  seguir referências arbitrárias a outros ficheiros locais.
- `fps` é objetivo de lacuna temporal, não FPS original nem processamento de
  todos os frames. Sem teto, o plano inclui início/fim amostrado com lacuna≤1/fps.
- Padrão0.5fps, máximo12 frames; máximo operacional64. O perfil Clef ainda impõe
  no máximo4 imagens somando fotos e frames do mesmo pedido.
- Quando o teto é atingido, distribui amostras por **todo o intervalo**, registra
  `capped`, `requested_frames`, `sampled_frames`, `effective_fps` e `max_gap_seconds`.
- A última amostra respeita uma margem baseada na taxa para não fazer seek
  depois do último PTS. Um único frame observa o início; não representa todo o vídeo.
- Os labels registram **seeks pedidos**, não timestamps de eventos nem PTS exatos.
- `continuous_coverage=false` e `audio_analyzed=false`. Vídeo longo com12 frames
  é uma amostragem esparsa: não pode fundamentar «nenhum evento ocorreu».

A [documentação FFmpeg](https://ffmpeg.org/ffmpeg.html#Main-options) explica
`-ss`, accurate seek e extração de frames. Precisão de seek não elimina perdas
entre amostras nem transforma uma sequência de fotos em análise contínua.

## Vídeo nativo: Clef Omni

```bash
node scripts/som.mjs analyze --request-file examples/requests/video-native.json --json
```

- `video_url.url` deve ser Data URL Base64 no array `state` de topo do OpenRouter.
- Até2 vídeos; **cada um ≤60s E ≤16MiB**, e **todos os áudios+vídeos juntos ≤16MiB decoded**.
  Dois vídeos de16MiB não cabem juntos. O schema nativo resolve a formulação
  ambígua «or» do guia OpenRouter em limites simultâneos, não OU permissivo.
- Aceitamos MP4/WebM verificados. MOV e codecs/container adicionais não viram
  suporte prometido só porque aparecem em um relatório externo.
- Amostragem fixa2fps pelo provider; `processing` é ignorado. A CLI rejeita
  fps/start/end/max_frames em native para não fingir controle que o endpoint não oferece.
- Native não recorta, comprime nem descarta o resto silenciosamente. Se exceder
  o teto, preparar um clipe explicitamente ou escolher frames.
- A Cloudflare diz que a trilha sonora acompanha os frames quando **todos** os
  vídeos do pedido têm trilha. O gateway não garante transcrição/qualidade de áudio;
  o resultado declara isso. Este runtime não implementa áudio isolado `input_audio`.
- API direta Cloudflare usa `videos[]/audio[]/images[]`; **não** copiar esse
  envelope para o OpenRouter, que usa partes em `state`.

## Box: localização não é presença nem autorização

- Sempre retorna quatro arestas, mesmo com alvo ausente. Inclua `noul` de presença.
- `box_presence` precisa mapear explicitamente cada box à sua presença.
- Confiança ausente/null é desconhecida; não há threshold box universal recomendado.
- Padding/EXIF mudam o espaço de coordenadas. Use `geometry` e
  `normalizedBoxToPixels()` para voltar aos pixels **orientados** de origem;
  validar uma caixa em padding não torna um alvo existente.
- Para UI real, DOM/a11y e seletores estáveis podem ser melhores que coordenadas.
  O runtime não captura tela, controla mouse nem autoriza ações.

## Adicionar um novo SOM de imagem/vídeo

1. Consultar catálogo e endpoints; exigir rota de Decisions para este contrato.
2. Confirmar em fonte primária ausência de geração/decisão tipada. VLM em JSON
   pode ser opção separada, mas não é promovido silenciosamente a SOM.
3. Ler o adaptador do provider: primitives, posições, assets, formatos, contagens,
   bytes/contexto e limitações. Catálogo não descreve tudo isso.
4. Adicionar perfil em [capabilities.mjs](../scripts/lib/capabilities.mjs) e
   conversões/validações específicas; não supor que todos suportam box.
5. Testar offline mídia, erros, segurança, fakes de transporte e contrato de saída.
6. Fazer smoke autenticado pequeno autorizado; registrar modelo resolvido/provider,
   custo e falhas. Avaliar dataset do domínio antes de calibrar limiares.

Não habilitar um alias móvel para box/visão sem revalidar sua versão efetiva.
Não copiar ECE, preço ou latência de outro modelo/idioma/modalidade.
