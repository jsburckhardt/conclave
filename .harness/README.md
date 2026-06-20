# Engineering Harness — Conclave

The `./harness` CLI is the supported operating surface for humans and agents working in this repository. It wraps existing npm scripts and project commands into a unified interface with consistent verdicts and evidence recording.

## Quick start

```bash
./harness boot      # Install dependencies (npm ci)
./harness doctor    # Check environment health
./harness verify    # Run full verification (lint + test + build)
```

## Commands

| Command | Description |
|---------|-------------|
| `./harness help` | Show available commands |
| `./harness orient` | Project orientation info |
| `./harness doctor` | Check dev environment health |
| `./harness lint` | Run ESLint + Prettier + TypeScript checks |
| `./harness test` | Run test suite (vitest) |
| `./harness build` | Build the project (tsc) |
| `./harness boot` | Install dependencies (npm ci) |
| `./harness verify` | Full verification pipeline |
| `./harness status` | Project status summary |
| `./harness clean` | Remove dist/ and node_modules/ |
| `./harness friction add <msg>` | Record a friction entry |
| `./harness friction list` | List friction entries |

## JSON output

Most commands support `--json` for machine-readable output:

```bash
./harness verify --json
./harness doctor --json
```

## Verdicts

Every command returns one of: `pass`, `fail`, `degraded`, `unknown`.

## Evidence

The `verify` command writes evidence files to `.harness/evidence/` as timestamped JSON.

## Friction

Friction records answer: **"What did the agent have to infer that the harness should have proved?"**

Records are stored in `.harness/friction.jsonl`.
