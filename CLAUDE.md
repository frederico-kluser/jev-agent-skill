# CLAUDE.md — contrato operacional da som-agent-skill

## Contexto específico deste repositório

O ramo predefinido do remoto é **`master`**, confirmado pela API do GitHub. Nos
exemplos genéricos abaixo, sincronize com `origin/master` e abra PR para `master`
(em vez de `main`). O projeto local chama-se `som-agent-skill`; o remoto ainda é
`frederico-kluser/jev-agent-skill`, sem renomeação remota implícita. Não reescrever
commits históricos para adaptar convenções novas: validar o intervalo novo do PR.


> Este projeto é governado pela skill **opensource-project**. Estas instruções são
> **automáticas e obrigatórias**: qualquer agente de código que abra este repositório
> segue-as SEM precisar de invocar a skill. Os comandos abaixo vivem na instalação da
> skill (`C:/Users/kluse/.dsh/skills/opensource-project`) e são suficientes para todo o ciclo de vida.

<!-- oss:merge-policy:begin -->
## Política de integração: merge, nunca rebase

A integração é **merge**; rebase é proibido. Merge commit e squash merge são
merges — rebase não é.

- **Sincronizar a ramificação**: `git fetch origin && git merge origin/main` (ou
  `git pull`, que faz merge). **Nunca** `git rebase`, `git pull --rebase` nem
  `git rebase origin/main`.
- **Integrar o PR**: `gh pr merge --squash --delete-branch` no cofre (`main` é
  squash-only por ruleset; squash é merge e mantém o histórico linear). Onde o
  ruleset permitir, `gh pr merge --merge` também é merge; **rebase-merge nunca**.
- **PR desatualizado**: `gh pr update-branch` (merge) ou merge de `origin/main` na
  ramificação; depois `gh pr checks --watch`. Sem rebase e sem force-push.
- **Configuração imposta**: `oss-enforce.sh` deteta rebase no projeto
  (`pull.rebase`, `branch.*.rebase`, `allow_rebase_merge`, `allowed_merge_methods`)
  e corrige — `[CONFIGURADO]` — sem perguntar. Diagnóstico dedicado:
  `oss-merge-policy.sh check` (na instalação da skill).
<!-- oss:merge-policy:end -->

## Regras obrigatórias em TODO o desenvolvimento

1. **Nunca escrever diretamente em ramos protegidos** — o ramo predefinido
   (`main`) e `master`, `develop`, `release/**` — ramificação efémera
   (`feat/*`, `fix/*`, `chore/*`, `docs/*`) → PR com título Convencional → checks
   verdes → **squash merge** → delete branch. O GitHub **recusa commits diretos**
   nesses ramos (ruleset), não é só convenção.
2. **Nomes de ramificação SEM DÓ**: `<tipo>/<slug>` com tipos fechados
   `feat fix docs style refactor perf test build ci revert hotfix release` e slug
   curto em kebab-case (`feat/refresh-token`). Exceções: apenas prefixos de
   automação (`dependabot/*`, `renovate/*`, `release-please--*`,
   `gh-readonly-queue/*`). Fora disso o GitHub **rejeita a branch** (ruleset
   "Convenção de Nomes de Ramificação") e o hook **`pre-push` local bloqueia o push**
   antes de ele existir — valide com
   `bash C:/Users/kluse/.dsh/skills/opensource-project/scripts/oss-gate.sh branch <nome>`.
3. **Commits Convencionais**: `tipo(escopo)!: descrição` — imperativo, ≤ 72 chars.
   Tipos: `feat fix docs style refactor perf test build ci chore revert`.
   `!` ou rodapé `BREAKING CHANGE:` → versão MAJOR. Imposto também **no servidor**:
   o status check obrigatório `build` valida as mensagens (e, em planos Enterprise,
   o ruleset "Convenção de Mensagens de Commit").
4. **A versão é cálculo, nunca digitação**:
   `python3 C:/Users/kluse/.dsh/skills/opensource-project/scripts/oss-version.py next` (`feat`→MINOR, `fix`→PATCH,
   `!`→MAJOR). Bump manual só com justificação explícita do utilizador.
5. **CHANGELOG gerado, nunca reescrito**:
   `python3 C:/Users/kluse/.dsh/skills/opensource-project/scripts/oss-changelog.py --write`.
6. **Zero segredos** no código ou no histórico:
   `bash C:/Users/kluse/.dsh/skills/opensource-project/scripts/oss-gate.sh push --scan-only` antes de submeter;
   credenciais entram apenas via `echo "$X" | gh secret set --env production`.
7. **Workflows seguros**: actions fixadas por SHA
   (`bash C:/Users/kluse/.dsh/skills/opensource-project/scripts/oss-pin-actions.sh`), `permissions` mínimos e
   `timeout-minutes` em todos os jobs; o `context` do ruleset é o **nome do job**.
8. **Nunca contornar um gate**: se `oss-gate.sh` bloquear, corrija a CAUSA e repita.
   Nunca `--no-verify`, nunca force-push, nunca rebase, nunca reescrever histórico
   partilhado.

## Regra de reentry (vale para QUALQUER pedido, sempre)

> **Toda a entrada neste projeto — mesmo que ele já use a skill — começa por
> verificar o que existe e colocar o que falta. Nada é assumido.**

```bash
bash C:/Users/kluse/.dsh/skills/opensource-project/scripts/oss-enforce.sh
```

O `oss-enforce.sh` é idempotente e não-destrutivo: cria a fundação em falta
(ficheiros, hooks), **cria** os rulesets ausentes e **reconcilia** os divergentes no
GitHub, ativa o Push Protection, **desativa qualquer rebase** (política de merge) e
audita nomes de branch. Corre **sem pedir nada**, no início de qualquer tarefa de
governança e antes de fechar qualquer trabalho.

As regras também vivem **localmente** (sem GitHub): os hooks `pre-push` + `commit-msg`
instalados por `bash C:/Users/kluse/.dsh/skills/opensource-project/scripts/oss-hooks.sh install` impõem nomes
`<tipo>/<slug>`, proíbem push direto para ramos protegidos e validam Commits
Convencionais nesta máquina — qualquer projeto, qualquer remoto.

## Procedimento por pedido do utilizador (executar sem pedir estes passos)

| Pedido | Procedimento |
|---|---|
| (sempre, 1.º passo) | `bash C:/Users/kluse/.dsh/skills/opensource-project/scripts/oss-enforce.sh` — reverifica tudo e aplica o que faltar |
| "commita" / "faz commit" | `bash C:/Users/kluse/.dsh/skills/opensource-project/scripts/oss-gate.sh commit-msg "<msg>"` → `git commit` (o hook `commit-msg` revalida) |
| "push" / "sobe" | branch ≠ ramos protegidos e nome `<tipo>/<slug>` → `oss-gate.sh push` → `git push -u origin <branch>` |
| "atualiza/sincroniza a branch" | `git fetch origin && git merge origin/main` (ou `git pull`) — **nunca rebase** |
| "abre PR" / "faz merge" | título Convencional = mensagem do squash → `gh pr create --base main` → `gh pr checks --watch` → `gh pr merge --squash --delete-branch` (**squash é merge; rebase nunca**) |
| "muda/sobe a versão" | `oss-version.py next` → aplicar o valor nos manifestos → `oss-changelog.py --write` |
| "faz release" / "publica" | `oss-gate.sh release --version X.Y.Z` → commit de release → `git tag -a vX.Y.Z` → `gh release create vX.Y.Z --verify-tag --notes-file` → publicação via CI com secrets em Environment |
| "muda CI/workflows" | editar `.github/workflows/` → `oss-pin-actions.sh` → confirmar que o nome do job bate certo com o `context` do ruleset |
| "adiciona/atualiza dependências" | lockfile atualizado + testes + `oss-gate.sh push --scan-only` (sem segredos, sem pins quebrados) |

## Antes de fechar qualquer tarefa

- `bash C:/Users/kluse/.dsh/skills/opensource-project/scripts/oss-enforce.sh` sem nenhuma linha `[FALTA]` e
  `bash C:/Users/kluse/.dsh/skills/opensource-project/scripts/oss-doctor.sh` sem nenhuma linha `[FALTA]` (avisos
  aceitáveis; faltas não — corrigir antes de submeter).
- Commits Convencionais; versão e changelog coerentes com o que mudou.
- Reportar ao utilizador: o que mudou, gates cumpridos e URLs criadas (PR/release).
- Qualquer erro no formato `Erro: <o quê> — Solução: <o que fazer>`.

## Cofre desta versão

`main` (e `master`, `develop`, `release/**`) é cofre por
ruleset: PR obrigatório, squash-only, status checks strict, histórico linear, sem
force-push, sem delete — **commits diretos são recusados pelo GitHub**. Os nomes de
branch seguem `<tipo>/<slug>` — **o GitHub rejeita os restantes** — e as mensagens
Convencionais são impostas também no servidor (status check `build`). O **rebase está
desativado** (sync por merge; PR por squash merge; rebase-merge fora). Tags `v*` são
imutáveis. Releases nunca retrocedem: reverter um `BREAKING CHANGE` publicado exige
um novo MAJOR.

## Semântica de erro

Formato obrigatório: `Erro: <o quê aconteceu> — Solução: <o que fazer a seguir>`.
Exit codes dos gates: `0` pass · `1` bloqueado (corrigir causa) · `2` uso inválido ·
`3` ferramenta em falta · `4` não é repositório git.
