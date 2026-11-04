# Security Policy

This policy covers **som-agent-skill**, hosted in the existing repository
[`frederico-kluser/jev-agent-skill`](https://github.com/frederico-kluser/jev-agent-skill).
The maintained development branch is **master**; upgrade to the latest reviewed
revision before reporting a problem already fixed there.

## Report privately

**Do not disclose vulnerabilities, credentials or private screenshots in public
issues, discussions or pull requests.** GitHub Private Vulnerability Reporting
is enabled for this repository:

[Report a vulnerability privately](https://github.com/frederico-kluser/jev-agent-skill/security/advisories/new)

Include affected commit/version, impact, reproducible steps with synthetic data,
and any suggested mitigation. Do not send production API keys or real user media.
This volunteer project does not promise an unapproved response-time SLA. Coordinate
disclosure and credit with the maintainer in the private advisory thread.

## Scope

In scope: request/response validation, local media handling, root/symlink checks,
secret/media redaction, integration scripts, MCP, and this repository's CI.
Provider-side issues belong to the relevant vendor. Benchmark quality alone is
not a security boundary: models and untrusted screen content can be wrong or
adversarial even when a probability is high.

## Required safeguards

- Keys stay in the backend environment/secret manager, not flags, source or frontend.
- Private media and prepared payloads/run records are not committed or logged.
- Decoder isolation, ownership/auth, quotas and retention remain project duties.
- Visual results require HITL/abstention and never execute clicks or commands.
- New commits pass secret scans; GitHub Push Protection is used only when the
  account/repository actually exposes it, not claimed as enabled by assumption.
- Protected branches require review and the `build` status check; no direct push,
  force-push or rebase. Workflow actions are fixed to immutable commits.
- Normal CI tests are offline, with no real model credentials or paid requests.

Non-security questions may use normal GitHub issues. Never substitute a fictitious
email address or public issue for the private reporting channel above.
