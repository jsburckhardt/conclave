# Action Plan: feat(runtime) — implement `council run` fixed backlog phases and artifact generation

## Feature
- **ID:** 5
- **Title:** feat(runtime): implement `council run` fixed backlog phases and artifact generation
- **Branch:** `feat/5-council-run` (worktree at `.trees/issue-5`)
- **Research Brief:** `project/issues/5/research/00-research.md`
- **Scope Type:** `issue` (composes already-merged seams into a fixed v0 flow; no new ADR, no new core-component)

## Summary

`council run <name>` is currently a stub: `src/cli.ts` loads + validates `council.yaml`, logs
`council.run`, then calls `notImplemented("run")`. This issue replaces that stub with a real
run by adding a new, fully unit-tested orchestrator module `src/runtime/council-phases.ts`
exporting `runBacklogCouncil(...)`. The orchestrator drives the **already-merged**
`CouncilRuntime` (`start()`/`askMember()`/`stop()`) through a fixed v0 flow
(context → draft → optional validation → refinement → optional artifacts), resolves logical
member roles from config **without hardcoding** ids, validates orchestrator policy, writes
durable artifacts via `ArtifactStore.write`, and raises **typed errors** instead of returning
silent empties. A new `OrchestrationError` (`ORCHESTRATION_ERROR`) is added to `src/errors.ts`,
exported from `src/index.ts`, and registered in CORE-COMPONENT-0008. The commander action stays
**thin** (it is excluded from coverage); all logic lives in the covered orchestrator module.

## Architecture conclusion (explicit)

**No new ADR. No new core-component. Three existing core-components were UPDATED** (this is the
planner's call, agreeing with the research brief):

| Artifact | Change | Why | DECISION-LOG rows added |
|---|---|---|---|
| **CORE-COMPONENT-0008** (Error Handling) | Registered `OrchestrationError` / `ORCHESTRATION_ERROR` in Rules + Interfaces; documented export + wrapping of non-typed throwers; CLI logs `code` for `CouncilError`. | **Required by the AC.** Extends the existing typed-error hierarchy (decision #12). | #17, #18 |
| **CORE-COMPONENT-0004** (Session Lifecycle & Persistence) | Added a "Phase orchestration, policy, and role resolution" contract: fixed phase order, policy defaults/precedence, fail-closed heuristic role resolution, blank-response rule, `stop()`-in-`finally` rule, `runBacklogCouncil`/`normalizePolicy` interfaces. | Policy precedence + the role-resolution model are **durable cross-run contracts** that `council continue` will reuse (Q2). The orchestrator lives in `src/runtime/`, which CC-0004 governs. | #19, #20, #21, #22, #23 |
| **CORE-COMPONENT-0006** (Artifact & Transcript Store) | Documented the idempotency model (transcript append-only across re-runs; artifacts overwritten in place) and that callers wrap `ArtifactStore.write`'s plain `Error` in `OrchestrationError`. | The behavior already holds; the durable contract must be stated (Q2, research proposal #4). | #24, #25 |

**No ADR is required.** ADR-0002 already ratifies the runtime topology (Model A, one SDK session
per member behind a `SessionFactory` seam, SDK-decoupling, ESM/NodeNext/commander/vitest) and
explicitly defers "the orchestration phases … to subsequent issues." `runBacklogCouncil` is a
**consumer** of those decisions; it introduces no new technology or topology.

**No CORE-COMPONENT-0003 change** — see Q1 (Option B chosen).

> All architecture edits are global artifacts under `project/architecture/`; none live inside
> the issue folder. The templates were not edited. `DECISION-LOG.md` was updated for every
> changed core-component (date bump + ≥1 Decisions row each).

---

## Open-Question resolutions (Q1–Q9)

Each of the research brief's nine decision-bearing questions is resolved below; the rationale is
expanded where the choice shapes the implementation.

### Q1 — `orchestrator.roles`: **Option B (heuristic-only v0). No CORE-COMPONENT-0003 change.**

Ship the **documented, fail-closed role-resolution heuristic** now; do **not** add an explicit
`orchestrator.roles` mapping in v0. The AC phrases the requirement as *"explicit
`orchestrator.roles` **or** a documented heuristic,"* so the heuristic alone satisfies it.

Justification:
- **Minimal scope / pure consumer.** `validateCouncilConfig` currently **drops**
  `orchestrator.roles` (research Empirical finding #3 — re-verified: the validator rebuilds the
  orchestrator object with only `cwd`/`model`/`policy`). Reading `config.orchestrator.roles`
  without first extending CC-0003 would be **dead code that silently resolves to `undefined`**
  (research R3). Option B keeps the orchestrator a pure CC-0003 consumer with **no contract
  change** and no dead code.
- **The AC is fully satisfiable** by a heuristic whose ambiguity/missing-role/non-distinct
  errors are tested.
- Option A (extend CC-0003 `OrchestratorConfig` with `roles` + validate referenced ids exist +
  DECISION-LOG row) is deferred to a follow-up; it is the right move only when deterministic
  explicit mapping for large multi-member councils is needed. It is **out of scope** here.

**The heuristic (documented contract):** match each member's `role` string case-insensitively.
- **Context source** (`context` role) ← `role` matches `/\b(context|project|product|architect|repo|codebase|source of truth)\b/i`.
- **Backlog author** (`backlog` role) ← `role` matches `/\b(scrum|backlog|stor(y|ies)|sprint|agile|product owner)\b/i`.

Resolution is **fail-closed**:
1. Zero members match a role → `OrchestrationError` ("Cannot resolve the '<role>' role: no member's role matches …; add a member whose role describes …").
2. More than one member matches a role → `OrchestrationError` ("Ambiguous '<role>' role: members [a, b] all match …").
3. Context and backlog must resolve to **distinct** members; if the same member is selected for both → `OrchestrationError`. This guarantees the **single-member scaffold from `council init` always fails role resolution** (research R8) with an actionable message — expected fail-closed behavior until `add-member` lands.

The default mapping/heuristic is documented in code (JSDoc) and `LLM.txt` (AC).

### Q2 — Record policy + role model: **Yes — DECISION-LOG rows + a CORE-COMPONENT-0004 section.**

The policy precedence/defaults and the fail-closed role model are cross-run contracts (future
`council continue` reuses this orchestrator), not one-off implementation details. They are
recorded as DECISION-LOG rows #19–#23 and a new "Phase orchestration, policy, and role
resolution" section in **CORE-COMPONENT-0004** (the runtime layer that governs
`src/runtime/`). Idempotency is recorded in **CORE-COMPONENT-0006** (#24–#25).

### Q3 — Policy validation location + error types: **exported pure `normalizePolicy`; `ConfigError` for bad `maxRounds`, `OrchestrationError` for the contradiction.**

Validation lives in an **exported, pure** `normalizePolicy(policy?: OrchestratorPolicy): NormalizedPolicy`
(directly unit-testable in isolation, called as phase 0 of `runBacklogCouncil`). It:
- Applies defaults: `writeArtifacts = true`, `requireProjectValidation = true`, `maxRounds = 1`.
- Coerces the booleans defensively (only literal `true`/`false` honored; anything else → default) — necessary because the loader passes `policy` through untyped (research R1, re-verified).
- If `maxRounds` is defined and **not a non-negative integer** (`!Number.isInteger(n) || n < 0`) → throws **`ConfigError`** (`CONFIG_ERROR`) — matches the AC verbatim.
- If `requireProjectValidation === true && maxRounds === 0` → throws **`OrchestrationError`** (`ORCHESTRATION_ERROR`) — a logical contradiction between two individually-valid values, hence an orchestration error, not a config error.

### Q4 — Epics/open-questions derivation: **targeted asks, gated by `writeArtifacts`.**

`epics.md` and `open-questions.md` are produced by **dedicated `askMember` calls to the backlog
author** during the artifact phase (not by parsing delimited sections of the refined backlog).
Rationale: dedicated asks give clean, independently **blank-checked** content per artifact
(robustly satisfies "non-blank content"), are fully deterministic/testable with the scripting
fake, auto-append to the transcript (richer audit trail), and avoid a brittle delimiter contract
+ fragile fallback. These two asks run **only when `writeArtifacts` is enabled** (no point
deriving artifacts that will not be written), which keeps the `writeArtifacts: false` path cheap
and makes the transcript-block-count deterministic per policy. `backlog.md` is the refinement
output (already computed); never re-asked.

### Q5 — Phase prompt text: **pure prompt builders adapted from `prd.md:359–414`; no preamble.**

Each phase prompt is built by a **pure, unit-testable** function. Text is adapted from the PRD
pseudo-code (context summary; draft-from-summary; validate-draft-against-repo;
refine-using-validation; plus extract-epics and list-open-questions). **No "You are council
member …" preamble is added** — `CouncilRuntime.askMember` passes prompts **verbatim** (research
Q5; the PRD's preamble lived in the old `askMember` wrapper, which the real runtime does not
have). Member persona/role is already established by its session/agent config. Builders:
`contextPrompt(goal)`, `draftPrompt(summary)`, `validationPrompt(backlog)`,
`refinementPrompt(backlog, validation?)`, `epicsPrompt(backlog)`, `openQuestionsPrompt(backlog)`.

### Q6 — Structured error record with `code`: **enhance the top-level catch; `run` action uses try/finally.**

The single top-level `program.parseAsync(...).catch(...)` in `src/cli.ts` is enhanced to include
`code` when the error is a `CouncilError` (`{ code, error: message }`), which benefits **all**
commands (DRY) and keeps the `run` action thin. The `run` action wraps its body in
`try { … } finally { await runtime.stop() }` so cleanup runs on every path; the `stop()` call is
itself guarded (its failure is caught and logged as a separate `council.stop.error` event) so it
**never masks** the primary error. Both changes are thin glue in coverage-excluded `cli.ts`.

### Q7 — Default artifact filenames + matching: **basename match against `config.artifacts`, default under `artifacts/`.**

A pure `resolveArtifactPath(logicalName, configArtifacts)` helper maps each logical artifact
(`backlog` | `epics` | `open-questions`) to a relative path: find the **first** `config.artifacts`
entry whose `path.basename(entry) === "<logical>.md"` and use it (preserving the user's directory,
e.g. `artifacts/backlog.md`); if none matches (e.g. the scaffold omits `open-questions.md`),
default to `artifacts/<logical>.md`. Resolved paths are passed to `ArtifactStore.write`, whose
traversal guard (plain `Error`) is wrapped in `OrchestrationError` by the caller.

### Q8 — `BacklogCouncilResult` shape (finalized):

```ts
export interface BacklogCouncilResult {
  contextMemberId: string;    // resolved context-source member id
  backlogMemberId: string;    // resolved backlog-author member id
  phases: string[];           // ordered phase names that executed, e.g. ["context","draft","validation","refinement","artifacts"]
  rounds: number;             // validation/refinement rounds actually run (== normalized maxRounds)
  artifacts: string[];        // absolute artifact paths written (empty when writeArtifacts:false)
  validationSkipped: boolean; // true when requireProjectValidation === false
  artifactsSkipped: boolean;  // true when writeArtifacts === false
}
```

The CLI logs a `council.run.complete` summary derived from this (counts/ids only, no bodies);
tests assert each field.

### Q9 — Council base path: **`config.name` wins (session-id consistency).**

The CLI constructs the `TranscriptStore` (`council/<config.name>/transcript/full.md`) and
`ArtifactStore` (base `council/<config.name>`) from **`config.name`**, not the CLI `<council>`
positional arg. This keeps durable paths consistent with the session ids the runtime already
keys as `<config.name>/<memberId>` (`council-runtime.ts`). The CLI `<council>` arg is used for
logging/UX only. (Path construction is a CLI concern; the orchestrator only writes relative,
basename-resolved paths through the injected `ArtifactStore`.)

---

## Implementation seam

New covered module — `src/runtime/council-phases.ts` (**NO `@github/copilot-sdk` import**):

```ts
import type { CouncilRuntime } from "./council-runtime.js";
import type { CouncilConfig, OrchestratorPolicy } from "../config/council-config.js";
import type { ArtifactStore } from "../store/artifact-store.js";
import { createLogger, type Logger } from "../logging/logger.js";
import { ConfigError, OrchestrationError } from "../errors.js";

export interface NormalizedPolicy {
  writeArtifacts: boolean;
  requireProjectValidation: boolean;
  maxRounds: number;
}

export interface RunBacklogCouncilOptions {
  artifacts: ArtifactStore;   // CC-0006 store the orchestrator writes through
  logger?: Logger;            // CC-0005; defaults to createLogger()
}

export interface BacklogCouncilResult { /* Q8 shape */ }

export function normalizePolicy(policy?: OrchestratorPolicy): NormalizedPolicy;          // Q3 (pure)
export function resolveRoles(config: CouncilConfig): { contextMemberId: string; backlogMemberId: string }; // Q1 (pure, fail-closed)
export function resolveArtifactPath(logical: string, configArtifacts: string[]): string; // Q7 (pure)

export async function runBacklogCouncil(
  runtime: CouncilRuntime,
  config: CouncilConfig,
  options: RunBacklogCouncilOptions,
): Promise<BacklogCouncilResult>;
```

> **Why `options.artifacts` (a refinement of the research's `options?: { logger? }`):** the
> orchestrator must write artifacts, but CC-0004 states the runtime *"does not own … artifact
> writing,"* so it exposes no write method. Injecting the `ArtifactStore` (CC-0006) keeps that
> boundary intact and the orchestrator testable, while still depending only on the runtime,
> stores, config, and errors. `CouncilRuntime` is **not** modified. `options` is required
> (because `artifacts` is required).

**Internal flow of `runBacklogCouncil`:**
0. `normalizePolicy(config.orchestrator.policy)` → defaults + `ConfigError`/`OrchestrationError` checks (Q3).
1. `resolveRoles(config)` → `{ contextMemberId, backlogMemberId }` (Q1, fail-closed).
2. **context** — `ask(contextMemberId, contextPrompt(config.goal))` → blank-check.
3. **draft** — `ask(backlogMemberId, draftPrompt(summary))` → blank-check.
4. **rounds loop** (`for round in 0..maxRounds`): if `requireProjectValidation`, `ask(contextMemberId, validationPrompt(working))` → blank-check (else `validation = undefined`, `validationSkipped = true`); then `working = ask(backlogMemberId, refinementPrompt(working, validation))` → blank-check. `rounds++`.
5. `finalBacklog = working`.
6. **artifacts** (gated by `writeArtifacts`): write `backlog.md` (finalBacklog); `ask(backlogMemberId, epicsPrompt(finalBacklog))` → blank-check → write `epics.md`; `ask(backlogMemberId, openQuestionsPrompt(finalBacklog))` → blank-check → write `open-questions.md`. Each write goes through `resolveArtifactPath(...)` → `options.artifacts.write(...)`, wrapped in `try/catch → OrchestrationError(cause)`. When `writeArtifacts:false`: skip entirely; `artifactsSkipped = true`, `artifacts = []`.

A private `askNonBlank(runtime, memberId, prompt)` helper centralizes the blank-check
(`response.trim().length === 0 → OrchestrationError`). The transcript is written automatically
inside `askMember` — the orchestrator **never** appends directly (research R4).

Thin commander action — `src/cli.ts` `run` (replaces `notImplemented("run")`):

```ts
.action(async (council: string, options: { config: string }) => {
  const config = await loadCouncilConfig(options.config);
  logger.info("council.run", { council, members: config.members.length, goal: config.goal });
  const base = join("council", config.name);                         // Q9: config.name wins
  const transcript = new TranscriptStore(join(base, "transcript", "full.md"));
  const artifacts = new ArtifactStore(base);
  const runtime = new CouncilRuntime({
    config, sessionFactory: new CopilotSessionFactory(), transcript, artifacts, logger,
  });
  try {
    await runtime.start();
    const result = await runBacklogCouncil(runtime, config, { artifacts, logger });
    logger.info("council.run.complete", {
      council: config.name, context: result.contextMemberId, backlog: result.backlogMemberId,
      phases: result.phases, rounds: result.rounds, artifacts: result.artifacts.length,
      validationSkipped: result.validationSkipped, artifactsSkipped: result.artifactsSkipped,
    });
  } finally {
    try { await runtime.stop(); } catch (stopErr) {
      logger.error("council.stop.error", { message: stopErr instanceof Error ? stopErr.message : String(stopErr) });
    }
  }
});
```

Top-level catch enhanced (Q6) — `import { CouncilError } from "./errors.js"`:

```ts
program.parseAsync(process.argv).catch((error: unknown) => {
  const fields = error instanceof CouncilError
    ? { code: error.code, error: error.message }
    : { error: error instanceof Error ? error.message : String(error) };
  logger.error("council.error", fields);
  process.exitCode = 1;
});
```

## Logging events (CORE-COMPONENT-0005, no prompt/response bodies)

`phase.context.start`, `phase.draft.start`, `phase.validation.start` / `phase.validation.skipped`,
`phase.refinement.start`, `phase.artifacts.start` / `phase.artifacts.written` (`{ count }`) /
`phase.artifacts.skipped`, and `council.roles.resolved` (`{ context, backlog }`). The CLI adds
`council.run` (start), `council.run.complete` (summary), `council.stop.error`, and
`council.error` (`{ code, message }`). **Only ids/sizes/counts** are logged — never prompt or
response bodies (research R7).

## Risks carried from research (mitigations baked into tasks)

| Risk | Mitigation (task) |
|---|---|
| R1 policy unvalidated by loader | `normalizePolicy` validates `maxRounds` + coerces booleans (TASK-02). |
| R2 `ArtifactStore.write` throws plain `Error` | Wrap every write in `OrchestrationError(cause)` (TASK-05). |
| R3 `orchestrator.roles` dropped | Option B — heuristic only; no `config.orchestrator.roles` reads (TASK-03). |
| R4 double transcript append | Never append directly; rely on `askMember`; assert block count (TASK-04, tests). |
| R5 `stop()` masks original error | Guarded `stop()` in `finally`; separate `council.stop.error` log (TASK-06). |
| R6 coverage over new module | One test per policy branch + error path; recording/throwing/blank fake (TASK-07). |
| R7 logging sensitive content | Dotted events with ids/sizes/counts only (all tasks). |
| R8 single-member scaffold can't run | Distinct-roles rule → actionable `OrchestrationError` (TASK-03, tests). |
| R9 epics/open-questions underspecified | Targeted asks + blank-check per artifact (TASK-05). |

## Implementation Tasks (outline)

Ordered by dependency (full detail in `02-task-breakdown.md`):

1. **TASK-01** — Add `OrchestrationError` to `src/errors.ts` + export via `src/index.ts`.
2. **TASK-02** — `normalizePolicy` (pure): defaults, `maxRounds` `ConfigError`, contradiction `OrchestrationError`.
3. **TASK-03** — `resolveRoles` (pure, fail-closed heuristic, distinct members).
4. **TASK-04** — Phase prompt builders + `resolveArtifactPath` (pure) + the core ask sequence (context → draft → validation rounds → refinement) with blank-checks + structured logging.
5. **TASK-05** — Artifact phase: targeted epics/open-questions asks, `ArtifactStore.write` with `OrchestrationError` wrapping, `writeArtifacts` gating, `BacklogCouncilResult` assembly.
6. **TASK-06** — Wire the thin `run` action in `src/cli.ts` (build stores/factory/runtime from `config.name`, try/finally `stop()`, summary log) + enhance the top-level catch with `code`.
7. **TASK-07** — Co-located unit tests `src/runtime/council-phases.test.ts` (recording/throwing/blank fake; every branch + error path) and `src/index.ts`/`LLM.txt` surface updates.
8. **TASK-08** — Verification gate: `./harness verify` green, coverage ≥80% on the included modules.

## Acceptance-Criteria coverage (summary)

All 24 issue criteria (10 Core / 8 Edge / 6 Testing) map to ≥1 task and ≥1 test. The full
traceability matrices live in `02-task-breakdown.md` (AC→task) and `03-test-plan.md` (AC→test).

## Governing ADRs & Core-Components

- **ADR-0002** — TypeScript/ESM/NodeNext, `commander`, `SessionFactory` decoupling, vitest (consumer).
- **CORE-COMPONENT-0003** — config consumption; **no change** (Q1 Option B).
- **CORE-COMPONENT-0004** — runtime seam; **updated** (phase orchestration, policy, roles).
- **CORE-COMPONENT-0005** — structured dotted logs, no bodies.
- **CORE-COMPONENT-0006** — stores; **updated** (idempotency, write-failure wrapping).
- **CORE-COMPONENT-0007** — members stay read-only; the council writes artifacts itself.
- **CORE-COMPONENT-0008** — typed errors; **updated** (`OrchestrationError`).
- **CORE-COMPONENT-0009** — co-located `*.test.ts`, `.js` specifiers, `node` env, ≥80% coverage.
