# Contributing to som-agent-skill

The local skill is named `som-agent-skill`; the existing GitHub repository remains
[`frederico-kluser/jev-agent-skill`](https://github.com/frederico-kluser/jev-agent-skill).
Its default branch is **master**. Follow the [Code of Conduct](CODE_OF_CONDUCT.md)
and report vulnerabilities privately via [SECURITY.md](SECURITY.md).

## Toolchain and baseline

- Node >=20.11 (CI also checks22 and24).
- FFmpeg and FFprobe for real local media tests. No model key is needed for tests.
- Python3 for the vendored CoALA memory, if you work with that component.
- No runtime packages, package manager, lockfile or `npm ci` is required.

```bash
node scripts/som.mjs selftest
node --test
git diff --check
```

The tests use synthetic fixtures, fake catalog/decision transports and network
blockers. Never replace them with live API calls or inherited credentials.
Paid benchmarks are separate: freeze the dataset/spec, run a cost estimate and
obtain approval for the model set and budget before inference.

## Branches and synchronization

Create a short-lived branch such as `feat/ui-model-selection` or
`fix/media-validation`. Never commit/push directly to `master`, `main`, `develop`
or `release/**`.

```bash
git fetch origin
git switch -c feat/ui-model-selection origin/master
# Later, synchronize by merge, never rebase:
git fetch origin && git merge origin/master
```

Branch names follow `<type>/<kebab-case-slug>`; allowed types are `feat`, `fix`,
`docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`,
`hotfix` and `release`. Automation prefixes are reserved for their tools.
Do not rewrite historical shared commits when adding new governance rules.

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/), for example:

```text
feat(ui): select a validated screenshot model
fix(media): reject malformed image envelopes
feat(som)!: rename the skill and expose multimodal analysis
```

Keep the subject at most72 characters. A `!` or `BREAKING CHANGE:` footer marks
a breaking change; release versions/changelogs are calculated from commits,
not selected ad hoc. Git hooks and the required `build` check enforce the policy.
Never bypass hooks with `--no-verify` and never force-push/rebase shared history.

Open a PR against **master**, with a Conventional Commit title and the
[pull request template](.github/PULL_REQUEST_TEMPLATE.md). Include:

- motivation and code paths reused;
- offline tests and relevant regression cases;
- benchmark dataset/spec hashes and provider/model versions, if applicable;
- measured cost, limitations and whether holdout results support the change.

Repository rules require code-owner review, two approvals, resolved discussions
and passing checks. [CODEOWNERS](CODEOWNERS) lists the actual maintainer; there
are no invented organization teams. Maintainers integrate through an approved
squash merge, never rebase-merge. A request to commit/push is not permission to
merge, create a release or publish a package.

## Security and data

Never commit real API keys, `.env`, raw run records, prepared Base64 payloads or
private screenshots/videos. Only public synthetic fixtures may be used for
reproducible benchmarks. A model result is evidence, not authorization: preserve
HITL/abstention, deterministic policy and local project privacy constraints.

New adapters need primary-source limits, honest modality/endpoint validation,
offline contract tests and a small explicitly authorized live smoke. Listing a
model in the catalog alone does not prove adapter compatibility or quality.
