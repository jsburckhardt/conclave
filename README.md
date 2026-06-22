# Conclave

> A programmable orchestration layer that composes multiple Copilot-powered, repo-grounded agent sessions into a structured, auditable council that produces durable artifacts.

[![APS version](https://img.shields.io/badge/APS-v1.2.2-blue?logo=github)](https://github.com/chris-buckley/agnostic-prompt-standard/releases/tag/v1.2.2)

Conclave is a **council runtime** built on the GitHub Copilot SDK. Each council member is a persistent Copilot session bound to its own repository/working directory; an orchestrator routes structured prompts between members, records decisions, and writes durable, file-based artifacts (transcript, backlog, decisions). It replaces fragile terminal automation with a programmable, observable agent runtime.

## Status

**v0 scaffold.** Foundational runtime, configuration, stores, logging, permissions, and the `council` CLI surface are in place. Concrete council phases are implemented through the issue pipeline. See [`prd.md`](prd.md) for the full v0–v2 roadmap.

## Tech Stack

- **TypeScript** on **Node.js** (>=20, ESM)
- [`@github/copilot-sdk`](https://www.npmjs.com/package/@github/copilot-sdk) — Copilot agent runtime (one session per member)
- `commander` (CLI) · `yaml` (council.yaml)
- `vitest`, ESLint, Prettier, `tsc`

## Getting Started

```bash
npm install
npm run build
npm test
node dist/cli.js --help
```

## CLI (v0 surface)

- `council init <name>` — scaffold a council directory and `council.yaml`
- `council add-member <council> <memberId> --cwd <path> --role <role> [--agent <agent>] [--tools read-only|read-write]` — add a validated member to an existing `council/<council>/council.yaml` (`--tools` defaults to `read-only`)
- `council run <council>` — run council phases to produce artifacts
- `council continue <council>` — resume a persisted council

Commands currently report their plan; orchestration logic lands incrementally via the pipeline.

## Limitations

- **Single-writer council edits.** `council add-member` applies an atomic,
  last-writer-wins edit to `council/<council>/council.yaml` (it writes to a
  uniquely named temp file in the same directory, then `rename`s it over the
  original). Concurrent writers therefore cannot corrupt or truncate the file
  and never leave a stray temp file behind, but there is **no** cross-process
  locking: if two `add-member` invocations race, one member may be silently
  overwritten by the other. Run council edits from a single writer.
- **`run`/`continue` config path reconciliation (follow-up).** `council run` and
  `council continue` still default `--config` to a flat `council.yaml` in the
  current directory, whereas `init` and `add-member` operate on
  `council/<council>/council.yaml`. Reconciling these path conventions is
  tracked as a follow-up and is out of scope for this change.


## Documentation

- [`prd.md`](prd.md) — product brief and roadmap
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — pipeline workflow, how to contribute via GitHub Issues, and where artifacts belong
- [`AGENTS.md`](AGENTS.md) — agent definitions, guardrails, and pipeline specification
- [`docs/`](docs/) — application-specific documentation (CLI usage, council.yaml reference)
- [`project/`](project/) — architecture decisions, core-components, and per-issue pipeline artifacts
- Architecture: [ADR-0002](project/architecture/ADR/ADR-0002-typescript-copilot-sdk-runtime.md) and core-components [0003–0009](project/architecture/core-components/)
