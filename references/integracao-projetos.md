# Integrar SOMs no código que o projeto já tem

**Obrigatório quando a skill for chamada para integrar Jev, Clef ou outro SOM.**
O resultado deve ser um patch na arquitetura real, não um boilerplate isolado.
Não é necessário um servidor web novo, SDK de chat, banco ou framework adicional.

## 1. Auditoria antes de escrever

1. Recupere a memória/AGENTS/contratos do projeto, sem abrir dumps de bases.
2. Mapeie com glob/grep e leia os arquivos relevantes:
   - runtime/linguagem e fronteira backend/client;
   - rotas/controllers e camada de serviço já existentes;
   - upload/storage: quem é dono, como resolve uploadId, limites MIME/bytes;
   - auth/autorização, políticas, guardrails/fallbacks determinísticos;
   - fila/worker/semaforo, quotas, orçamento e cancelamento;
   - configuração de env/secret manager e observabilidade;
   - testes/fixtures/CI já usados pelo projeto.
3. Escreva um mapa curto **capacidade → ponto existente de integração → teste**.
   Se houver um cliente OpenRouter/SOM já centralizado, reutilize-o em vez de
   espalhar novas chaves, pools, retries ou métricas.
4. Preserve políticas locais. Uma biblioteca ganhar visão não autoriza um
   projeto a analisar fotos que antes proibia, nem muda regras sobre dados sensíveis.

## 2. Escolha de adaptador e análise

- Discreto e textual: Jev1.14;1.13 continua útil se o projeto já calibrava essa versão.
- Imagens sem box: Jev ou Clef Omni; declare experimentalidade/limites de cada um.
- Localização: somente Jev1.14 nesta implementação, com gate de presença e revisão.
- Vídeo: frames para Jev, native para Clef; duração, cobertura e áudio explícitos.
- Relatório textual: templates da biblioteca ou interpretação do agente. Nunca
  atribuir texto livre a um SOM discriminativo nem inventar fatos não avaliados.

A troca de modelo/versionamento exige teste no domínio e limiares novos, não só
substituir uma string. O catálogo/rota confirma contrato anunciado, não qualidade.

## 3. Reutilização do runtime

Node≥20: importe [analyze.mjs](../scripts/lib/analyze.mjs), com
[tipos](../scripts/lib/analyze.d.mts), ou vendorize sem dependências após escolher
um destino que faça sentido **na codebase lida**:

```bash
node scripts/integrate.mjs --project /repo/existente --dest server/ai/som --dry-run
node scripts/integrate.mjs --project /repo/existente --dest server/ai/som
```

`server/ai/som` é exemplo de escolha explícita, não diretório a impor ao projeto.
O instalador exige raiz existente e destino relativo; rejeita escapes/symlinks
fora do projeto. Copia módulos/tipos/README, a licença MIT com atribuição e manifesto de hashes, nunca chaves,
banco CoALA, mídia privada, package.json ou arquivos de auth/rotas.

Atualização é idempotente. Arquivo novo divergente ou alteração local não
reconhecida gera conflito **antes** de escrever. Não existe `--force`: faça merge
no adaptador do projeto. O manifesto `.som-integration.json` registra proveniência.
A cópia sozinha não integra rotas, uploads ou política; termine o patch.

Projetos Python/Go/etc. podem usar a Decisions API com seu cliente HTTP existente
ou chamar a CLI via argv/subprocess sem shell, consumindo JSON e exit code.
Para muitos pedidos, um worker/MCP residente evita pagar DNS/TCP/TLS por processo.
Não introduza Node no frontend nem uma API key no navegador para evitar um adaptador.

## 4. Conectar às camadas reais

Fluxo recomendado, adaptado à infraestrutura existente:

```text
rota/controller existente
  -> autorizar actor + uploadId
  -> resolver ficheiro no storage do dono
  -> validar limites/MIME + quota/orçamento
  -> fila/worker/semaforo existente
  -> analyze (mediaRoot, modelo e perguntas do servidor)
  -> resposta tipada + cobertura + custo + review_required
  -> política determinística/HITL existente (se houver ação separada)
```

O [serviço de exemplo completo](../examples/integration/upload-service.mjs)
recebe `authorizeUpload`, `resolveUpload` e `runLimited` do projeto. Não contém
um servidor paralelo nem placeholders de autenticação: o contrato obriga a ligar
os serviços reais. Questions/policy/model são configuração do servidor, não
campos arbitrários controlados pelo upload ou por texto dentro da imagem.

**Não aceitar paths do usuário final** em uma rota pública. Receber uploadId e
resolver o path por dono no backend. `mediaRoot` limita realpaths e symlinks,
mas não substitui auth, sandbox do decoder nem armazenamento por tenant.

## 5. Credenciais, rede e privacidade

- Carregue `openrouter-agent-skill`; verifique fontes de chave já existentes
  antes de pedir uma nova. Biblioteca lê ambiente/configuração explícita, não
  varre secrets do usuário nem arquivos de outros projetos.
- `OPENROUTER_API_KEY` só no servidor. Chaves TypeSafe e OpenRouter não se misturam.
- Nenhum upload público/URL remoto implícito. Se o projeto baixa URLs, ele deve
  aplicar sua política SSRF, auth, bytes/timeouts e redirecionamentos antes da análise.
- Não logar `prepareAnalysis().request`, Base64, conteúdo de mídia, headers de
  autorização ou `.env`. Logar IDs opacos, modelo/provider, custo e tempos.
- Aplicar retenção e eliminação de originais/derivados segundo política local.
- FFmpeg/FFprobe devem rodar com timeout, privilégios mínimos, limites de CPU/memória
  e acesso apenas ao storage necessário. Whitelists locais não são sandbox do sistema.
- Preserve restrições OpenRouter de provider/dados/região/ZDR já existentes;
  não relaxá-las silenciosamente para fazer um modelo responder.

## 6. Falhas e custo

| Situação | Comportamento que o adaptador do projeto deve preservar |
|---|---|
| Sem chave/401 | Revisão/fallback determinístico local já definido; nunca allow implícito |
| 402 | Sem inferência por falta de crédito; não trocar fornecedor para esconder o erro |
| 429/5xx/rede | Retry limitado + Retry-After e fila; depois sinalizar indisponibilidade |
| Mídia inválida/grande |4xx de uso, sem enviar como texto/base64 nu |
| Probabilidade ambígua ou confiança baixa | HITL/abstain; obter evidência adicional se necessário |
| Box ausente/sem gate/confiança | Não agir; preferir DOM/a11y ou revisão |
| Resposta inválida/HTTP200+error | Falhar fechado, não converter erro em resultado positivo |

A biblioteca não cria fallback de negócio universal: alguns projetos exigem
regra local quando não há modelo, outros exigem revisão. Reutilize a política
lida no código/memória do projeto e teste-a explicitamente.

Custo vem de `usage.cost`, não de estimar Base64. Defina cap de crédito por chave
e orçamento no serviço existente. Native2fps também pode perder eventos curtos;
mais confiança reportada não compra cobertura contínua.

## 7. Testes necessários para dizer «integrado»

- Unitários do domínio com `decideFn`/catálogo injetados, sem rede ou credencial real.
- Contrato rota/serviço: dono correto, upload alheio403, MIME/bytes/duração,
  root/symlink e política server-side.
- Erros401/402/429/5xx/timeout e resposta inválida; nunca acionar execução por padrão.
- Foto e vídeo sintéticos, EXIF/padding/EOF e amostragem temporal verificáveis.
- Resultado sem Base64/chaves; logs e persistência privados sanitizados.
- Consumidor respeita `ok`, bandas, cobertura/áudio e `review_required`.
- Baseline dos testes existentes do projeto continua verde.
- Smoke autenticado pequeno autorizado e registrado separadamente de testes offline.
- Para produção: dataset rotulado próprio, recall/precision/calibração por tarefa,
  thresholds/versão fixados e revisão humana nas decisões de alto impacto.

## 8. Entrega do agente

Mostre ao usuário: pontos da codebase reutilizados, arquivos alterados, adaptador
selecionado e por quê, comandos executados/resultados, custo do smoke, limitações
e qualquer trabalho real que permaneça. Não afirmar integração de um projeto
não fornecido; nesta skill estão runtime, protocolo e serviço de exemplo prontos
para usar na próxima invocação sobre uma codebase concreta.

Registre em CoALA só decisões duráveis novas: motivo da escolha do ponto de
integração, restrições do dono e armadilhas verificadas, não duplicação dos guias.
