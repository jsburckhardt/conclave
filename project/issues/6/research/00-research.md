# Research Brief: feat(cli) — implement `council init` to scaffold a new council workspace

## GitHub Issue
- **Issue:** #6
- **Title:** feat(cli): implement `council init` to scaffold a new council workspace

## Scope Classification
- **Scope Type:** `issue`

**Justification.** This is a single, self-contained CLI feature that is implemented
entirely **within the existing architectural boundaries**. Every building block it
needs already exists and is already governed by an adopted core-component:

- configuration shape + validation — CORE-COMPONENT-0003 (`validateCouncilConfig` / `loadCouncilConfig`),
- typed error taxonomy — CORE-COMPONENT-0008 (`ConfigError`, `code: CONFIG_ERROR`),
- structured logging — CORE-COMPONENT-0005 (`createLogger`, dotted event names),
- path-safety pattern (`resolve` + `relative` + `startsWith("..")`) — CORE-COMPONENT-0006 (`ArtifactStore.write`),
- ESM/NodeNext + commander CLI + `node:fs/promises` — ADR-0002,
- coding/test standards (`.test.ts`, vitest `node` env, ≥80% coverage) — CORE-COMPONENT-0009.

The work introduces **no new technology choice, no new runtime topology, and no new
cross-cutting behavioral contract** — it composes existing contracts behind a new,
unit-testable function. CORE-COMPONENT-0003 already names `council init` explicitly as
an in-scope future consumer ("future scaffolding (`council init`)"). Therefore the scope
is an ordinary feature **issue**, not an `architecture_decision` or a `core_component`.

## Problem Statement
`council init <name>` is the foundational entry point of the Conclave MVP workflow, but
it is currently a stub: `src/cli.ts` (lines 20–27) registers the command, logs
`council.init`, and then calls `notImplemented("init")`, which writes an error to stderr
and sets `process.exitCode = 1`.

Consequences:

- There is **no supported way to create a council workspace**, so every downstream verb
  (`add-member`, `run`, `continue`) has nothing to operate on. `init` is the unblocker
  for the rest of the CLI.
- Without a generator, any hand-written `council.yaml` risks drifting from the shape that
  `loadCouncilConfig` / `validateCouncilConfig` actually accept. The PRD's illustrative
  `council.yaml` does **not** validate as-is (verified below), so users copying it hit
  confusing `ConfigError`s.

The goal is to make `council init <name>` scaffold a complete, **valid-by-construction**
council workspace — a directory tree plus a starter `council.yaml` that round-trips
through `loadCouncilConfig` with its typed policy fields populated — while being safe
(input validation, path-traversal guard, no-clobber, partial-failure cleanup) and
unit-testable (logic in a covered module, not inline in the commander action).

This brief is **research only**: it inspects the codebase, classifies scope, maps
acceptance criteria to existing modules, and *proposes* (does not decide) any ADR /
core-component work. The implementation seam below is a recommendation for the Plan stage.

## Existing Context

### Repository facts established by inspection
- **Harness baseline:** `./harness orient` → Verdict `pass`; Node `v24.17.0`; vitest
  test runner; `tsc` build. The harness contract (`.harness/contract.yml`) exposes
  `orient | doctor | lint | test | build | verify | status | clean | boot | friction_*`.
  `./harness verify` = lint + test + build and is the gate named by the issue's final AC.
- **Stub to replace:** `src/cli.ts` lines 20–27 (the `init` command's `.action`). The
  top-level `program.parseAsync(...).catch(...)` (lines 59–64) already logs
  `council.error` and sets `process.exitCode = 1` — so the init action only needs to let
  a thrown `ConfigError` propagate to get the required non-zero exit + structured error log.
- **Coverage gate:** `vitest.config.ts` enforces 80% lines/functions/branches/statements
  and **excludes `src/cli.ts`** from coverage (`exclude: ["src/**/*.test.ts", "src/cli.ts"]`).
  → All testable logic MUST live in a covered module, not in `cli.ts`.
- **No `src/commands/` directory exists yet** — the recommended new module would be the
  first occupant.

### Config schema discrepancy — empirically verified (not just asserted)
I executed the PRD's example shape and both policy-casing variants through the **real**
`validateCouncilConfig` (`npx tsx`, `yaml.parse` → `validateCouncilConfig`). Results:

| Input shape | Outcome |
|---|---|
| PRD `members:` as a **mapping** keyed by id (`project-x:`, `scrum-sme:`) | **Throws** `ConfigError: Council config requires at least one member` (validator requires `Array.isArray(members)`, `src/config/council-config.ts:74`) |
| Policy with **snake_case** keys (`max_rounds`, `require_project_validation`, `write_artifacts`), members as array | **Passes** validation, but typed `policy.maxRounds` is `undefined`; raw object retains `{max_rounds:5,...}` (policy is cast as-is at `council-config.ts:92–95`, keys unvalidated → silently ignored) |
| Policy with **camelCase** keys (`maxRounds`, `requireProjectValidation`, `writeArtifacts`), members as array | **Passes** and typed fields populate: `maxRounds=5`, `requireProjectValidation=true`, `writeArtifacts=true` |

**Binding contract for the generated file** is therefore *"round-trips through
`loadCouncilConfig` **and** exposes the intended policy via the typed fields"*, not merely
*"does not throw"*. The generator must emit `members` as an **array with explicit `id`**
and orchestrator policy in **camelCase**. (CORE-COMPONENT-0007's Exceptions section
independently confirms `orchestrator.policy.writeArtifacts` — camelCase — is the canonical
typed accessor.)

> Note: the PRD (`prd.md` lines 246–276) is the source of the misleading example — it shows
> members-as-mapping and snake_case policy. The PRD is illustrative, not a contract; the
> validator in `src/config/council-config.ts` is authoritative.

### Acceptance-criterion → module / core-component map
| Acceptance criterion (theme) | Where it lands | Governing contract |
|---|---|---|
| Replace `notImplemented("init")`, delegate to exported `scaffoldCouncil`, thin action | `src/cli.ts` (action), new `src/commands/init.ts` (logic) | ADR-0002; coverage rule (`cli.ts` excluded) |
| Create `council/<name>/{council.yaml, artifacts/, transcript/, decisions.md, open-questions.md}` | new `src/commands/init.ts` via `node:fs/promises` | CORE-COMPONENT-0006 (mkdir-p semantics, file-based memory) |
| Generated `council.yaml` passes `validateCouncilConfig` (members array w/ `id`) | new module emits YAML; assert via `validateCouncilConfig` | CORE-COMPONENT-0003 |
| `loadCouncilConfig` returns typed `policy.maxRounds/requireProjectValidation/writeArtifacts` | camelCase policy keys in generated YAML | CORE-COMPONENT-0003 (verified above) |
| Starter includes `name`, `goal`, ≥1 member (`cwd`/`role`/`agent`/`tools: read-only`), orchestrator, artifacts list | new module's template string | CORE-COMPONENT-0003 / 0007 (read-only default) |
| Success exits `0`, emits `council.init.created` w/ path, no `console.log` | new module / action uses injected `logger` | CORE-COMPONENT-0005 |
| `LLM.txt` updated to list new module file | `LLM.txt` (repo map) | docs convention (LLM.txt is the AI repo map) |
| No-clobber on existing dir → `ConfigError` naming path, non-zero, no mutation | exclusive `mkdir(councilDir,{recursive:false})`, `EEXIST`→`ConfigError` | CORE-COMPONENT-0008 |
| Atomic/exclusive create (TOCTOU-safe, not `existsSync`-then-mkdir) | exclusive `mkdir`, map `EEXIST` | CORE-COMPONENT-0008 |
| Reject invalid names (empty/ws, `.`, `..`, `/`, `\`, null byte) before any FS write | name validator in new module | CORE-COMPONENT-0008 |
| Reject names resolving outside `council/` base via `resolve`+`relative` guard | reuse `ArtifactStore` traversal pattern | CORE-COMPONENT-0006 |
| Partial-failure cleanup (`rm(councilDir,{recursive:true,force:true})` then rethrow) | try/catch in new module | CORE-COMPONENT-0008 |
| Human-actionable error messages naming offending name/path | `ConfigError` messages | CORE-COMPONENT-0008 |
| Unit tests vs temp `baseDir` (`mkdtemp(join(tmpdir(),…))`), assert exact tree | co-located `src/commands/init.test.ts` | CORE-COMPONENT-0009; mirror `src/store/artifact-store.test.ts` |
| Tests `.test.ts`, `.js` import specifiers, `node` env, coverage ≥80% | test file conventions | CORE-COMPONENT-0009; ADR-0002 |
| `./harness verify` passes | gate | CORE-COMPONENT-0009 / harness |

### Reference patterns already in the tree (reuse, don't reinvent)
- **Path-traversal guard:** `src/store/artifact-store.ts:15–21` — `resolve` + `relative` +
  `rel.startsWith("..")`. The AC explicitly asks for this exact pattern for the `name` → path guard.
- **Temp-dir test harness:** `src/store/artifact-store.test.ts` — `mkdtemp(join(tmpdir(), "…"))`,
  `.js` import specifiers, `rm(dir,{recursive:true})` cleanup, `node` env. This is the
  template for the new test file (inject `baseDir`, never touch real `process.cwd()`).
- **Error construction:** `src/errors.ts` — `new ConfigError(message, { cause })`, `code: "CONFIG_ERROR"`.
- **Logger usage:** `src/cli.ts:6` + `src/logging/logger.ts` — `createLogger()` then
  `logger.info("dotted.event", { field })`; never `console.log`.
- **History note (`prd.md` / issue):** the only prior fix commit `35d0781` retrofitted
  path-traversal protection into `ArtifactStore.write`, added missing unit tests, and added
  the 80% coverage thresholds. Security guards, tests, and coverage are the things this repo
  has historically missed — treat them as solved-by-default here.

### Recommended implementation seam (proposal for Plan, not a decision)
Export an async function in a new covered module, keep the commander action thin:

```ts
// src/commands/init.ts
export async function scaffoldCouncil(options: {
  name: string;
  baseDir?: string;        // defaults to process.cwd(); injected in tests
  logger?: Logger;
}): Promise<{ councilDir: string; created: string[] }>;
```

Flow: validate `name` (allowlist e.g. `^[A-Za-z0-9._-]+$`, plus explicit `.`/`..`/null-byte
rejection) → compute `councilDir = resolve(baseDir, "council", name)` and guard with
`resolve`+`relative` against `resolve(baseDir, "council")` → `mkdir(council/, {recursive:true})`
→ exclusive `mkdir(councilDir, {recursive:false})` (map `EEXIST` → no-clobber `ConfigError`)
→ write tree → on any post-create throw, `rm(councilDir, {recursive:true, force:true})` then
rethrow. The `cli.ts` action only parses args, calls `scaffoldCouncil`, logs
`council.init.created`, and lets errors bubble to the existing top-level `.catch`.

## Proposed ADRs
**ADRs required: NO.**

No new architectural decision is implied by this work. ADR-0002 already ratifies the
relevant choices (TypeScript/ESM/NodeNext, `commander` CLI, `node:fs/promises`, the
"keep logic behind a function seam for testability" philosophy used for `SessionFactory`).
`council init` consumes those decisions; it does not introduce or revise any. No ADR titles
are proposed.

## Proposed Core-Components
**Core-components required: NO — for the recommended path.**

The recommended path (emit `members` as an array + orchestrator policy in **camelCase**,
*within the existing CORE-COMPONENT-0003 schema*) requires **no core-component change**.
The scaffolder is a pure **consumer** of existing contracts (0003, 0005, 0006-pattern, 0008,
0007 read-only default, 0009 standards). CORE-COMPONENT-0003 already lists `council init`
as an in-scope consumer and already specifies `members[]`, so its wording is already aligned
with what the generator will emit.

**One conditional, decision-bearing alternative for the Planner (I propose, I do not decide):**

- *If* the Plan stage chooses to honor the **PRD's snake_case** policy keys (and/or the PRD's
  members-as-mapping form) for fidelity, that requires **extending `validateCouncilConfig`**
  to normalize keys (and/or accept a mapping) — a change to the **CORE-COMPONENT-0003**
  contract, which must be ratified in Plan and recorded in `DECISION-LOG.md`. In that case the
  proposed core-component edit would be titled approximately:
  **"CORE-COMPONENT-0003: normalize orchestrator policy key casing (accept snake_case) and/or members-mapping form."**

  **Researcher recommendation:** take the **camelCase, no-change** path. It is lower-risk,
  keeps `init` a pure consumer, needs zero validator changes, and is consistent with
  CORE-COMPONENT-0007's existing `writeArtifacts` reference. The PRD example should be treated
  as illustrative; if desired, a *documentation-only* clarification (a non-contractual note in
  CORE-COMPONENT-0003 and/or `docs/` stating "policy keys are camelCase") could be added — but
  that is optional and is a Planner call, not a researcher decision.

**Decision the Planner must explicitly make:** camelCase-no-change (recommended) **vs.**
extend CORE-COMPONENT-0003 to accept the PRD's snake_case/mapping forms.

## Acceptance Criteria (from issue)
Extracted verbatim from the issue body (between the `<!-- ACCEPTANCE_CRITERIA_START -->`
and `<!-- ACCEPTANCE_CRITERIA_END -->` markers):

**Core**
- [ ] `council init <name>` replaces the `notImplemented("init")` stub in `src/cli.ts` and delegates to a separately exported, unit-testable scaffolding function (e.g. `scaffoldCouncil`); no filesystem logic lives inline in the commander action.
- [ ] Running the command creates `council/<name>/` (creating the top-level `council/` directory if absent) containing `council.yaml`, `artifacts/`, `transcript/`, `decisions.md`, and `open-questions.md`.
- [ ] The generated `council.yaml` passes `validateCouncilConfig` (members serialized as an array with explicit `id`, per CORE-COMPONENT-0003).
- [ ] `loadCouncilConfig` on the generated file returns a `CouncilConfig` whose `orchestrator.policy` exposes the intended values via the typed fields (`maxRounds`, `requireProjectValidation`, `writeArtifacts`).
- [ ] The starter `council.yaml` includes `name` (= `<name>`), a `goal`, ≥1 example member (`cwd`/`role`/`agent`/`tools: read-only`), an `orchestrator` (`cwd`/`model`/`policy`), and an `artifacts` list.
- [ ] `decisions.md` and `open-questions.md` are created as seed files.
- [ ] On success the command exits `0` and emits a structured success log event (e.g. `council.init.created`) including the created path via the shared logger (CORE-COMPONENT-0005); no `console.log` is used.
- [ ] `LLM.txt` is updated to list any new module file introduced by this change.

**Edge Cases**
- [ ] If `council/<name>/` already exists, the command refuses to overwrite, raises `ConfigError` (`code: CONFIG_ERROR`) naming the path, exits non-zero, and modifies no existing files.
- [ ] Directory creation is atomic/exclusive (e.g. non-clobbering `mkdir`, `EEXIST` → `ConfigError`) so a duplicate or concurrent `init` cannot silently overwrite an existing workspace.
- [ ] Invalid names are rejected with `ConfigError` before any filesystem write: empty/whitespace-only, `.`, `..`, names containing a path separator (`/` or `\`), and names containing a null byte.
- [ ] Any `name` that resolves outside the `council/` base directory is rejected via a `resolve`+`relative` traversal guard (not string matching alone).
- [ ] If scaffolding fails partway (e.g. a write error after directories were created), the partially-created `council/<name>/` directory is removed before the error propagates, so a corrected re-run is not blocked.
- [ ] All error messages are human-actionable and name the offending `name`/path (CORE-COMPONENT-0008).

**Testing**
- [ ] Unit tests exercise the scaffolding function against a temporary base dir (`mkdtemp(join(tmpdir(), …))`) and assert the exact created tree.
- [ ] A test asserts the generated `council.yaml` passes `loadCouncilConfig`/`validateCouncilConfig` and that the typed `policy` fields are populated.
- [ ] A test asserts re-running against an existing council directory rejects with `ConfigError` and leaves existing content untouched.
- [ ] Tests assert each invalid-name class is rejected with `ConfigError` and that no directory is created on rejection.
- [ ] A partial-failure test (injected/forced write error) asserts the partial directory is cleaned up.
- [ ] Tests are co-located as `*.test.ts`, use `.js` import specifiers, run under the `node` vitest environment, and overall coverage stays ≥ 80%.
- [ ] `./harness verify` (lint + test + build) passes.

## Risks and Open Questions

### Risks
- **R1 — PRD/contract divergence (verified).** Copying the PRD `council.yaml` verbatim
  fails validation (members-mapping) or silently drops policy (snake_case). *Mitigation:*
  generate members-as-array + camelCase policy; add a test asserting typed policy fields are
  populated (not just "no throw"). This is the single most important correctness risk.
- **R2 — Coverage gate via `cli.ts` exclusion.** Logic placed in `cli.ts` is invisible to
  coverage; putting it there would both violate the AC and risk dropping overall coverage
  below 80%. *Mitigation:* keep all logic in `src/commands/init.ts` with direct unit tests.
- **R3 — TOCTOU / no-clobber correctness.** `existsSync`-then-`mkdir` is a check-then-act
  race and would fail the "atomic/exclusive" AC. *Mitigation:* exclusive
  `mkdir(councilDir, {recursive:false})` and treat `EEXIST` as the no-clobber `ConfigError`.
- **R4 — Partial-failure cleanup must not delete a pre-existing directory.** Cleanup should
  only remove a `councilDir` this invocation created; if the dir already existed we throw
  *before* writing and must not `rm` it. *Mitigation:* perform the exclusive create first;
  only enter the cleanup path for failures that occur *after* a successful exclusive create.
- **R5 — Name-validation completeness across platforms.** Path separators differ (`/` vs `\`),
  and `.`/`..`/null-byte/whitespace must all be rejected *before* any FS call. A naive regex
  may miss a class. *Mitigation:* conservative allowlist (`^[A-Za-z0-9._-]+$`) **plus**
  explicit `.`/`..` rejection, **plus** the `resolve`+`relative` guard as defense-in-depth;
  one test per invalid class.
- **R6 — Forcing a write error for the partial-failure test deterministically.** Need a
  reliable injection (e.g. pre-create a colliding *file* at a child path so a later `mkdir`/
  `writeFile` throws, or stub `fs`) without flakiness. *Mitigation:* prefer a filesystem-state
  collision over timing; keep it hermetic in a temp dir.
- **R7 — `.gitkeep` ambiguity.** The issue marks `.gitkeep` in `artifacts/`/`transcript/` as
  *optional*; tests asserting an **exact** tree must agree with whatever is generated.
  *Mitigation:* Plan should decide include-or-not and make the tree assertion match.

### Open questions (for the Planner to resolve — researcher does not decide)
- **Q1 (decision-bearing):** camelCase-no-change path (recommended) vs. extend
  CORE-COMPONENT-0003 to accept the PRD's snake_case/mapping forms? This is the one choice
  that determines whether a core-component change + DECISION-LOG entry is needed.
- **Q2:** Exact starter content — concrete `goal` string, example member id (`project-x`?),
  `model` value (`gpt-5` per PRD?), and the `artifacts` list entries. Should the generated
  `artifacts` list point at `artifacts/…` paths consistent with the created `artifacts/` dir?
- **Q3:** Include `.gitkeep` in the empty `artifacts/`/`transcript/` dirs? (Drives the exact-tree test.)
- **Q4:** Seed content for `decisions.md` / `open-questions.md` — single `#` heading text?
  (PRD layout also shows a top-level `decisions.md`/`open-questions.md`; the generator's
  `artifacts` list in the issue references `artifacts/decisions.md` etc. — Plan should reconcile
  the seed files vs. the artifacts-list entries so they are coherent.)
- **Q5:** Should `scaffoldCouncil` (and/or any name-validation helper) be re-exported from
  `src/index.ts` as part of the public package surface, or remain internal to `src/commands/`?
- **Q6:** Allowlist breadth — is `^[A-Za-z0-9._-]+$` acceptable, or do we need to allow more
  Unicode while still blocking separators/`.`/`..`/null bytes?

### Out of scope (per issue)
Creating SDK sessions, running council phases, and member-addition logic (`add-member`,
`run`, `continue`) are explicitly **out of scope** — separate issues. `init` is foundational
and has no dependencies; it unblocks the others.

---
*Researcher stage complete. No source code, ADRs, or core-components were modified. The
snake_case-vs-camelCase and members-mapping claims were empirically re-verified against the
live `validateCouncilConfig`. Handoff to Plan: confirm Q1 (the only decision that may require
a CORE-COMPONENT-0003 change + DECISION-LOG entry), then proceed with the recommended
camelCase-no-change consumer implementation.*
