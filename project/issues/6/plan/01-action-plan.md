# Action Plan: feat(cli) — implement `council init` to scaffold a new council workspace

## Feature
- **ID:** 6
- **Research Brief:** `project/issues/6/research/00-research.md`

## Decision Point Q1 (the planner's call)

> **Question (from research Q1):** Should the generated `council.yaml` use the existing
> CORE-COMPONENT-0003 schema as-is (emit `members[]` + **camelCase** orchestrator policy,
> requiring NO change to `validateCouncilConfig`), OR extend CORE-COMPONENT-0003 to also
> normalize the PRD's snake_case / members-mapping forms?

**Decision: camelCase-no-change (the recommended path).**

`council init` is implemented as a **pure consumer** of CORE-COMPONENT-0003. The generated
`council.yaml` emits:

- `members` as an **array**, each entry carrying an explicit `id` (the shape
  `validateCouncilConfig` actually accepts — verified in the research brief), and
- `orchestrator.policy` in **camelCase** (`maxRounds`, `requireProjectValidation`,
  `writeArtifacts`) — the only casing that populates the typed `OrchestratorPolicy` fields
  (`src/config/council-config.ts:15-19, 92-95`).

The binding contract for the generated file is therefore *"round-trips through
`loadCouncilConfig` **AND** populates the typed policy fields"*, not merely "does not throw".

### Architecture conclusion (explicit)

**No ADR is required. No core-component is created or modified. `DECISION-LOG.md` is NOT touched.**

Justification:

1. **No new architectural decision.** ADR-0002 already ratifies every technology choice this
   work consumes: TypeScript + ESM/NodeNext, the `commander` CLI, `node:fs/promises`, and the
   "keep logic behind a unit-testable function seam" philosophy (used for `SessionFactory`).
   `council init` introduces no new technology, runtime topology, or revision of ADR-0002.
2. **No new cross-cutting behavioral contract.** The scaffolder composes existing contracts
   — CORE-COMPONENT-0003 (config validation), 0005 (logging), 0006 (mkdir-p + `resolve`/
   `relative` traversal pattern), 0007 (read-only member default), 0008 (typed `ConfigError`),
   0009 (standards). It defines no reusable behavior of its own.
3. **CORE-COMPONENT-0003 already names `council init` as an in-scope consumer** and already
   specifies `members[]`; emitting members-as-array + camelCase policy is *aligned with the
   existing contract*, so no contract edit is needed.
4. **The rejected alternative (extend the validator to accept snake_case/mapping) is a
   CORE-COMPONENT-0003 contract change** and was explicitly declined here. Were it chosen, it
   would have required copying the core-component template, authoring the change, adding a
   decision record, and updating `DECISION-LOG.md`. None of that is in scope for this issue.

> The PRD's example `council.yaml` (`prd.md:246-276`, members-as-mapping + snake_case policy)
> is **illustrative, not contractual**. The authoritative shape is the live
> `validateCouncilConfig`. This plan treats the PRD as illustrative.

## ADRs Created

None. See **Architecture conclusion** above.

## Core-Components Created

None. See **Architecture conclusion** above.

## Decision Log Impact

`project/architecture/ADR/DECISION-LOG.md` is **not modified** by this plan — no ADR or
core-component was created or changed. The pre-existing decisions (#6 "Validate council.yaml
centrally; members default to read-only" — CORE-COMPONENT-0003; #11 read-only default —
CORE-COMPONENT-0007; #12 typed `CouncilError` — CORE-COMPONENT-0008; #9 structured logs —
CORE-COMPONENT-0005) already govern this work.

---

## Chosen Approach (summary)

Replace the `notImplemented("init")` stub in `src/cli.ts` with a **thin** commander action
that delegates to a new, fully unit-tested module `src/commands/init.ts`. All filesystem
logic, input validation, and the starter-file templates live in that covered module (never in
`cli.ts`, which is excluded from coverage by `vitest.config.ts`). The scaffolder is
valid-by-construction (its output round-trips through `loadCouncilConfig`), safe (name
allowlist + `resolve`/`relative` traversal guard + atomic exclusive create + partial-failure
cleanup), and observable (structured `council.init` / `council.init.created` events).

## Implementation Seam

New module — `src/commands/init.ts`:

```ts
import { mkdir, writeFile, rm } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { ConfigError } from "../errors.js";
import { createLogger, type Logger } from "../logging/logger.js";

export interface ScaffoldCouncilOptions {
  name: string;
  baseDir?: string; // defaults to process.cwd(); injected in tests
  logger?: Logger;  // defaults to createLogger(); injected in tests
}

export interface ScaffoldCouncilResult {
  councilDir: string;   // absolute path to council/<name>
  created: string[];    // absolute paths created for this workspace (deterministic order)
}

export async function scaffoldCouncil(
  options: ScaffoldCouncilOptions,
): Promise<ScaffoldCouncilResult>;
```

Thin commander action — `src/cli.ts` (replaces lines 20-27; `notImplemented` stays for the
other still-stubbed verbs):

```ts
import { scaffoldCouncil } from "./commands/init.js";

program
  .command("init")
  .description("Scaffold a new council directory with a council.yaml")
  .argument("<name>", "council name")
  .action(async (name: string) => {
    logger.info("council.init", { name });
    await scaffoldCouncil({ name, logger });
  });
```

A thrown `ConfigError` propagates to the existing top-level
`program.parseAsync(...).catch(...)` (`src/cli.ts:59-64`), which logs `council.error` and sets
`process.exitCode = 1` — giving the required non-zero exit + structured error log "for free".
The action contains **no** filesystem logic.

## Generated Workspace Tree

`scaffoldCouncil` creates exactly this tree under `baseDir` (default `process.cwd()`):

```
council/                     # created with { recursive: true } if absent (NOT in `created`)
└── <name>/                  # created with { recursive: false } (exclusive / atomic)
    ├── council.yaml         # starter config (valid-by-construction)
    ├── artifacts/           # empty directory
    ├── transcript/          # empty directory
    ├── decisions.md         # seed file
    └── open-questions.md    # seed file
```

`created` (the returned array, deterministic order) =
`[councilDir, <name>/artifacts, <name>/transcript, <name>/council.yaml, <name>/decisions.md, <name>/open-questions.md]`.
The `council/` base dir is intentionally **excluded** from `created` so the array is identical
whether or not `council/` pre-existed.

**No `.gitkeep`** is written (Q3 resolution): `artifacts/` and `transcript/` are created as
empty directories, and the exact-tree test asserts they exist and are empty. (A generated
council workspace is user data, not repository-tracked source, so directory persistence in git
is irrelevant.)

## Starter `council.yaml` Contents

Members are an **array with explicit `id`**; policy keys are **camelCase**. `<name>` is the
CLI argument:

```yaml
# council.yaml — generated by `council init <name>`.
# Validated by loadCouncilConfig (CORE-COMPONENT-0003). Edit freely.
name: <name>
goal: Describe the outcome this council should produce.

members:
  - id: project-x
    cwd: ../../project-x
    role: Source of truth for the target project
    agent: project-architect
    tools: read-only

orchestrator:
  cwd: .
  model: gpt-5
  policy:
    maxRounds: 5
    requireProjectValidation: true
    writeArtifacts: true

artifacts:
  - artifacts/backlog.md
  - artifacts/epics.md
```

Q2 resolutions baked in: concrete `goal` placeholder; example member `id: project-x` with
`tools: read-only` (CORE-COMPONENT-0007 default); `model: gpt-5` (per PRD); a non-empty
`artifacts` list. The exact `maxRounds=5` / `requireProjectValidation=true` /
`writeArtifacts=true` values are asserted by the round-trip test.

**Q4 reconciliation (seed files vs. artifacts list).** The issue's required tree puts
`decisions.md` and `open-questions.md` at the **council root** as seed working files; the PRD
illustration instead lists them under `artifacts/`. The issue's tree is authoritative: root
`decisions.md` / `open-questions.md` are the human-curated working docs, and the `artifacts`
list enumerates **generative run outputs** under `artifacts/` (`backlog.md`, `epics.md`) — it
deliberately does **not** duplicate the root seeds, so no two files share a logical name in
conflicting locations.

## Seed File Contents

`decisions.md`:

```markdown
# Decisions

_Records of decisions made by this council. Append entries as the council runs._
```

`open-questions.md`:

```markdown
# Open Questions

_Unresolved questions for this council. Append entries as the council runs._
```

Exact content is asserted by the seed-file test so the tree assertion is deterministic.

## Security / Atomicity / Cleanup Approach

1. **Name validation (before any FS call).** Allowlist `^[A-Za-z0-9._-]+$` **plus** explicit
   rejection of: empty/whitespace-only, `.`, `..`, names containing a path separator (`/` or
   `\`), and names containing a null byte (`\u0000`). Failures raise `ConfigError` naming the
   offending `name`. (Q6 resolution: the conservative ASCII allowlist is accepted for v0;
   broader Unicode is out of scope.)
2. **Traversal guard (defense-in-depth).** Compute `councilBase = resolve(baseDir, "council")`
   and `councilDir = resolve(councilBase, name)`; reject when
   `relative(councilBase, councilDir)` is empty, equals `..`, or starts with `..` — the exact
   `resolve`+`relative` pattern from `ArtifactStore.write` (`src/store/artifact-store.ts:15-21`,
   CORE-COMPONENT-0006). Not string-matching alone.
3. **Atomic / exclusive create (TOCTOU-safe).** `mkdir(councilBase, { recursive: true })`, then
   `mkdir(councilDir, { recursive: false })`. An `EEXIST` from the exclusive create is mapped to
   a no-clobber `ConfigError` naming the path (CORE-COMPONENT-0008) — never `existsSync`-then-
   `mkdir`. The no-clobber path **does not** delete anything.
4. **Partial-failure cleanup.** Only **after** the exclusive create succeeds (i.e. the dir is
   ours) are the subdirs/files written inside a `try`. On any failure there, run
   `rm(councilDir, { recursive: true, force: true })` and rethrow a `ConfigError` (with `cause`).
   Cleanup is reachable only for failures that occur after we created the dir, so a pre-existing
   workspace is never removed (research R4).

## Logging Events (CORE-COMPONENT-0005)

- `council.init` — emitted by the cli action at start, `{ name }` (kept from current stub).
- `council.init.created` — emitted by `scaffoldCouncil` on success,
  `{ name, councilDir, created: <count> }`. It lives in the **module** (not `cli.ts`) so it is
  unit-testable via an injected logger.

No `console.log` anywhere; all output goes through the injected `Logger`.

## Open-Question Resolutions (research Q2–Q6)

| Q | Resolution |
|---|------------|
| Q2 | Concrete starter: `goal` placeholder, member `id: project-x` (`tools: read-only`), `model: gpt-5`, `artifacts: [artifacts/backlog.md, artifacts/epics.md]`. |
| Q3 | **No `.gitkeep`**; `artifacts/`/`transcript/` are empty dirs; exact-tree test asserts emptiness. |
| Q4 | Root seed files `decisions.md`/`open-questions.md`; `artifacts` list = generative outputs only (no duplication). |
| Q5 | **Re-export `scaffoldCouncil` + result/options types from `src/index.ts`** for public-surface consistency (every other module is barrel-exported). |
| Q6 | Allowlist `^[A-Za-z0-9._-]+$` accepted for v0; broader Unicode out of scope. |

## Implementation Tasks (outline)

Ordered by dependency (full detail in `02-task-breakdown.md`):

1. **TASK-01** — Module seam + name validation + traversal guard (`src/commands/init.ts`).
2. **TASK-02** — Starter `council.yaml` and seed-file content builders (members array, camelCase policy).
3. **TASK-03** — Filesystem orchestration: atomic exclusive create, tree write, no-clobber, partial-failure cleanup, success logging.
4. **TASK-04** — Wire the thin `council init` commander action in `src/cli.ts`.
5. **TASK-05** — Public exports (`src/index.ts`) + `LLM.txt` repo-map update.
6. **TASK-06** — Verification gate: coverage ≥80% and `./harness verify` green.

## Acceptance-Criteria Coverage (summary)

All 21 issue criteria (8 Core / 6 Edge / 7 Testing) map to ≥1 task and ≥1 test case. The full
traceability matrix lives in `02-task-breakdown.md` (AC→task) and `03-test-plan.md` (AC→test).

## Governing ADRs & Core-Components (referenced, not modified)

- **ADR-0002** — TypeScript + ESM/NodeNext, `commander`, `node:fs/promises`, function-seam philosophy.
- **CORE-COMPONENT-0003** — config schema + `validateCouncilConfig`/`loadCouncilConfig` (consumer).
- **CORE-COMPONENT-0005** — structured logging via `createLogger`, dotted events, no `console.log`.
- **CORE-COMPONENT-0006** — mkdir-p semantics + `resolve`/`relative` traversal pattern.
- **CORE-COMPONENT-0007** — member read-only default in the starter config.
- **CORE-COMPONENT-0008** — typed `ConfigError` (`CONFIG_ERROR`), `cause`, human-actionable messages.
- **CORE-COMPONENT-0009** — co-located `*.test.ts`, `.js` specifiers, `node` env, ≥80% coverage, named exports.
