# Task Breakdown: Issue #5 — `council run` fixed backlog phases

Source plan: `project/issues/5/plan/01-action-plan.md`.
Test cases (TP-IDs) are defined in `project/issues/5/plan/03-test-plan.md`.

**Acceptance-criterion IDs** (from the issue, used throughout):
Core `C1`–`C10`, Edge `E1`–`E8`, Testing `TS1`–`TS6`.

| ID | Acceptance criterion (short) |
|----|------------------------------|
| C1 | `council run <name>` loads config, runs the council, exits 0 (no `notImplemented`) |
| C2 | New `council-phases.ts` orchestrator; no `@github/copilot-sdk` import; fake-`SessionFactory` runnable |
| C3 | Phases in order context → draft → (validation) → refinement via `askMember` |
| C4 | Context/backlog ids resolved from config; `project-x`/`scrum-sme` NOT hardcoded |
| C5 | `writeArtifacts` → backlog/epics/open-questions written via `ArtifactStore.write` from `config.artifacts` |
| C6 | Every exchange appended to transcript (one block/turn), append-only across re-runs |
| C7 | Policy honored: `requireProjectValidation`, `writeArtifacts`, `maxRounds` + defaults (§8) |
| C8 | `runtime.stop()` in `finally` on every path; `stop()` failure doesn't mask original error |
| C9 | `OrchestrationError` added, exported from `index.ts`, registered in CORE-COMPONENT-0008 |
| C10 | Re-run overwrites artifacts in place, appends (not truncates) transcript |
| E1 | Phase referencing a member id not in config raises a typed error (no silent skip) |
| E2 | Unresolved/ambiguous/both-missing role raises a typed error with actionable message |
| E3 | Member throws mid-phase → typed error, prior transcript preserved, cleanup/`stop()` runs |
| E4 | Blank response (empty/whitespace after `trim()`) raises `OrchestrationError`; never written empty |
| E5 | Artifact write failure raises typed error wrapping cause; logged; transcript not lost |
| E6 | `writeArtifacts: false` runs all phases + transcript but writes no artifact files |
| E7 | `requireProjectValidation: false` skips validation, refines from the draft |
| E8 | `requireProjectValidation: true` + `maxRounds: 0` → typed error; negative/non-integer `maxRounds` → `ConfigError` |
| TS1 | Unit test drives full flow with fake factory; asserts exact `(memberId, prompt)` order |
| TS2 | Tests assert artifacts written to expected paths with non-blank content |
| TS3 | Tests assert transcript has one appended block per exchange |
| TS4 | Tests assert policy gating (validation skip, no files on `writeArtifacts:false`, rounds bound, contradiction throws) |
| TS5 | Tests assert typed-error propagation (unknown/ambiguous role, mid-phase throw + `stop()`, blank, write failure) |
| TS6 | `./harness test` ≥80% coverage; `./harness lint`/`build` pass |

---

## Task TASK-01: Add `OrchestrationError` and export it

- **Status:** Planned
- **Complexity:** Low
- **Dependencies:** None
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0008, CORE-COMPONENT-0009

### Description
Add `OrchestrationError` to `src/errors.ts`, extending `CouncilError` with
`code: "ORCHESTRATION_ERROR"` and a `(message, options?: { cause?: unknown })` constructor that
sets `this.name = "OrchestrationError"` and forwards `cause` to `super` — mirroring the existing
`ConfigError`/`SessionError` shape. It is re-exported automatically via the existing
`export * from "./errors.js"` in `src/index.ts` (confirm; no new export line needed for errors).
Registration in CORE-COMPONENT-0008 is already done by the planner — this task implements the code.

### Acceptance Criteria
- [ ] `OrchestrationError` extends `CouncilError`; `new OrchestrationError("x").code === "ORCHESTRATION_ERROR"`. (`C9`)
- [ ] `new OrchestrationError("x", { cause }).cause === cause` and `instanceof CouncilError === true`. (`C9`)
- [ ] `OrchestrationError` is importable from the package root (`import { OrchestrationError } from "conclave"` / `src/index.ts`). (`C9`)
- [ ] No change to `ConfigError`/`SessionError` behavior (regression guard). (`C9`)

### Test Coverage
- Extend `src/errors.test.ts` (or co-locate in `council-phases.test.ts`) — **TP-01**: construct
  with/without `cause`, assert `code`, `name`, `instanceof CouncilError`, and `cause` preservation.
- Exercised indirectly by every error-path test in TASK-02/03/04/05 (CORE-COMPONENT-0009 ≥80%).

---

## Task TASK-02: `normalizePolicy` — defaults + `maxRounds`/contradiction validation

- **Status:** Planned
- **Complexity:** Medium
- **Dependencies:** TASK-01
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0004, CORE-COMPONENT-0008, CORE-COMPONENT-0003

### Description
Add the **exported pure** function `normalizePolicy(policy?: OrchestratorPolicy): NormalizedPolicy`
in `src/runtime/council-phases.ts` (Q3). It:
1. Applies defaults `writeArtifacts = true`, `requireProjectValidation = true`, `maxRounds = 1`.
2. Coerces booleans defensively — only literal `true`/`false` are honored; any other value
   (the loader passes `policy` through untyped, research R1) falls back to the default.
3. Throws **`ConfigError`** (`CONFIG_ERROR`) when `maxRounds` is defined and not a non-negative
   integer (`!Number.isInteger(n) || n < 0`), naming the offending value (`E8`).
4. Throws **`OrchestrationError`** (`ORCHESTRATION_ERROR`) when
   `requireProjectValidation === true && maxRounds === 0` (contradiction), with an actionable
   message (`E8`).

Validation runs as phase 0 of `runBacklogCouncil` **before any `askMember` call**, so a bad
policy fails fast with no side effects.

### Acceptance Criteria
- [ ] `normalizePolicy(undefined)` → `{ writeArtifacts: true, requireProjectValidation: true, maxRounds: 1 }`. (`C7`)
- [ ] Non-boolean `writeArtifacts`/`requireProjectValidation` fall back to the documented default; explicit `false` is honored. (`C7`)
- [ ] `maxRounds` of `-1`, `-0.5`, `1.5`, `NaN` → `ConfigError` (`CONFIG_ERROR`); message names the value. (`E8`)
- [ ] `{ requireProjectValidation: true, maxRounds: 0 }` → `OrchestrationError` (`ORCHESTRATION_ERROR`). (`E8`)
- [ ] `{ requireProjectValidation: false, maxRounds: 0 }` is **accepted** (not contradictory) and yields `maxRounds: 0`. (`C7`)
- [ ] The function is pure (no IO, no logging) and exported for direct unit testing. (`C2`)

### Test Coverage
- **TP-02** (defaults), **TP-03** (`maxRounds` invalid → `ConfigError`), **TP-04** (contradiction
  → `OrchestrationError`), **TP-05** (boolean coercion + accepted `false/0` combo).
- Every branch (valid/invalid `maxRounds`; contradiction true/false; each default) must be hit to
  keep the module ≥80% (CORE-COMPONENT-0009).

---

## Task TASK-03: `resolveRoles` — fail-closed heuristic role resolution

- **Status:** Planned
- **Complexity:** Medium
- **Dependencies:** TASK-01
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0004, CORE-COMPONENT-0003, CORE-COMPONENT-0008

### Description
Add the **exported pure** function
`resolveRoles(config: CouncilConfig): { contextMemberId: string; backlogMemberId: string }`
implementing the documented Q1 heuristic (Option B — **no `config.orchestrator.roles` reads**;
that field is dropped by the loader, research R3):
- **Context source** ← member whose `role` matches `/\b(context|project|product|architect|repo|codebase|source of truth)\b/i`.
- **Backlog author** ← member whose `role` matches `/\b(scrum|backlog|stor(y|ies)|sprint|agile|product owner)\b/i`.

Fail-closed rules, each raising `OrchestrationError` with an **actionable** message naming the
role and offending member ids:
1. Zero matches for a role → missing-role error.
2. More than one match for a role → ambiguous-role error.
3. Context and backlog resolve to the **same** member → non-distinct error (guarantees a
   single-member council always fails, research R8).

No member id is hardcoded; ids come only from `config.members`.

### Acceptance Criteria
- [ ] Two distinct members (one matching context, one matching backlog) resolve to their ids; neither id is hardcoded. (`C4`)
- [ ] A single-member scaffold council (`project-x`, role "Source of truth …") raises `OrchestrationError` (`ORCHESTRATION_ERROR`) — backlog role unresolved — with a message naming the missing role. (`E2`)
- [ ] Two members matching the same role raise an **ambiguous-role** `OrchestrationError` naming both ids. (`E2`)
- [ ] A council where one member matches both roles (no second distinct match) raises a **non-distinct/missing** `OrchestrationError`. (`E2`)
- [ ] All messages are human-actionable (state which role failed and what to do). (`E2`)

### Test Coverage
- **TP-06** (happy path, distinct ids), **TP-07** (missing role / single member), **TP-08**
  (ambiguous role), **TP-09** (non-distinct / same member).
- Branch coverage for zero/one/many matches per role + distinctness check (CORE-COMPONENT-0009).

---

## Task TASK-04: Core ask sequence — prompts, phases, rounds, blank-checks, logging

- **Status:** Planned
- **Complexity:** High
- **Dependencies:** TASK-02, TASK-03
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0004, CORE-COMPONENT-0005, CORE-COMPONENT-0006, CORE-COMPONENT-0008

### Description
Implement the reasoning phases of `runBacklogCouncil(runtime, config, options)` (everything
except artifact writing, which is TASK-05):
1. **Pure prompt builders** (Q5, adapted from `prd.md:359–414`, **no preamble**):
   `contextPrompt(goal)`, `draftPrompt(summary)`, `validationPrompt(backlog)`,
   `refinementPrompt(backlog, validation?)` (omits the validation block when `validation` is
   undefined — "refine directly from the draft").
2. A private `askNonBlank(runtime, memberId, prompt)` helper: calls `runtime.askMember` (which
   auto-appends to the transcript — the orchestrator **never** appends directly, research R4) and
   throws `OrchestrationError` if `response.trim().length === 0` (`E4`).
3. Phase sequence: **context** (`contextMemberId`) → **draft** (`backlogMemberId`) → **rounds
   loop** `for (let r = 0; r < maxRounds; r++)`: optional **validation** (`contextMemberId`,
   gated by `requireProjectValidation`; when off set `validationSkipped = true`, `validation =
   undefined`) then **refinement** (`backlogMemberId`, using current working backlog + latest
   validation); track `rounds`.
4. Structured logs (CORE-COMPONENT-0005): `council.roles.resolved`, `phase.context.start`,
   `phase.draft.start`, `phase.validation.start`/`phase.validation.skipped`,
   `phase.refinement.start` — **ids/counts only, never prompt/response bodies** (research R7).
   Logger comes from `options.logger ?? createLogger()`.

`askMember` propagates `SessionError` for an unknown member id (no silent skip, `E1`) and
propagates any session-thrown error mid-phase (`E3`); the orchestrator does not catch these.

### Acceptance Criteria
- [ ] Prompt builders are pure and include the phase-appropriate intent; `refinementPrompt` omits the validation section when `validation` is undefined. (`C3`, `E7`)
- [ ] Phases run in the exact order context → draft → (validation) → refinement via `CouncilRuntime.askMember`. (`C3`)
- [ ] `requireProjectValidation: false` skips every validation ask and refines from the draft; `validationSkipped === true`. (`E7`)
- [ ] The validation/refinement loop runs exactly `maxRounds` times; `result.rounds === maxRounds`. (`C7`)
- [ ] A blank/whitespace-only response in **any** phase raises `OrchestrationError` (`ORCHESTRATION_ERROR`). (`E4`)
- [ ] The module has **no** `@github/copilot-sdk` import and is runnable with a fake `SessionFactory`. (`C2`)
- [ ] Each exchange is appended to the transcript exactly once (via `askMember`); the orchestrator never appends directly. (`C6`)
- [ ] An unknown member id surfaces as `SessionError`; a mid-phase session throw propagates untouched (no silent skip). (`E1`, `E3`)
- [ ] Logs use stable dotted events and never contain prompt/response bodies. (`C2`, CORE-COMPONENT-0005)

### Test Coverage
- **TP-11** (exact call order with recording fake), **TP-13** (one transcript block per exchange),
  **TP-16** (validation skipped + refine-from-draft), **TP-17** (rounds bounded by `maxRounds`),
  **TP-20** (blank response across phases → `OrchestrationError`), **TP-21** (mid-phase throw
  propagates + transcript preserved), **TP-22** (unknown member → `SessionError`), **TP-24**
  (no SDK import; fake factory runnable).
- Each policy/loop branch must be covered (CORE-COMPONENT-0009 ≥80%).

---

## Task TASK-05: Artifact phase — targeted asks, write wrapping, gating, result assembly

- **Status:** Planned
- **Complexity:** High
- **Dependencies:** TASK-04
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0006, CORE-COMPONENT-0008, CORE-COMPONENT-0005, CORE-COMPONENT-0007

### Description
Implement the artifact-generation phase and the `BacklogCouncilResult` (Q4, Q7, Q8):
1. **Pure helpers:** `epicsPrompt(backlog)`, `openQuestionsPrompt(backlog)`, and
   `resolveArtifactPath(logical, configArtifacts)` — basename-match `config.artifacts`, else
   default `artifacts/<logical>.md` (Q7).
2. **Gating:** when `writeArtifacts === false`, skip all asks and writes; set
   `artifactsSkipped = true`, `artifacts = []` (`E6`). The 4 reasoning-phase transcript blocks
   still exist (members are read-only; the council itself writes artifacts — CORE-COMPONENT-0007).
3. When enabled: write `backlog.md` (the refinement output), then `askNonBlank(backlogMemberId,
   epicsPrompt(...))` → write `epics.md`, then `askNonBlank(backlogMemberId,
   openQuestionsPrompt(...))` → write `open-questions.md`. Each write:
   `try { abs = await options.artifacts.write(rel, content) } catch (cause) { throw new
   OrchestrationError("Failed to write artifact '<rel>'", { cause }) }` — wrapping the store's
   plain `Error` (research R2). Collect absolute paths into `artifacts`.
4. Log `phase.artifacts.start`, `phase.artifacts.written` (`{ count }`) / `phase.artifacts.skipped`.
5. Return the finalized `BacklogCouncilResult` (Q8 shape): `contextMemberId`, `backlogMemberId`,
   `phases`, `rounds`, `artifacts`, `validationSkipped`, `artifactsSkipped`.

### Acceptance Criteria
- [ ] With `writeArtifacts` enabled, `backlog.md`, `epics.md`, `open-questions.md` are written via `ArtifactStore.write` to paths derived from `config.artifacts` by basename, defaulting to `artifacts/<logical>.md` when absent. (`C5`)
- [ ] `resolveArtifactPath` returns the matching `config.artifacts` entry when present (e.g. `artifacts/backlog.md`) and the default otherwise (e.g. `artifacts/open-questions.md` for the scaffold). (`C5`, `Q7`)
- [ ] All written artifacts have **non-blank** content (each derived from a blank-checked ask/output). (`C5`, `E4`)
- [ ] `writeArtifacts: false` writes **no** artifact files; `artifactsSkipped === true`, `result.artifacts === []`, transcript still written. (`E6`)
- [ ] An `ArtifactStore.write` failure (incl. traversal) raises `OrchestrationError` with `cause` preserved; the failure is logged; the transcript is intact. (`E5`)
- [ ] Re-running overwrites artifacts in place and the transcript is appended (not truncated). (`C10`)
- [ ] `BacklogCouncilResult` carries the exact Q8 fields with correct values. (`C7`, `Q8`)

### Test Coverage
- **TP-10** (`resolveArtifactPath` match + default), **TP-12** (artifacts at expected paths,
  non-blank), **TP-14** (re-run overwrite + transcript append), **TP-15** (`writeArtifacts:false`
  → no files, transcript present), **TP-23** (write failure → `OrchestrationError(cause)` +
  transcript intact).
- Branch coverage for gated-on/off and write-success/failure paths (CORE-COMPONENT-0009).

---

## Task TASK-06: Wire the thin `council run` action + structured error codes

- **Status:** Planned
- **Complexity:** Medium
- **Dependencies:** TASK-05
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0004, CORE-COMPONENT-0005, CORE-COMPONENT-0008

### Description
Replace `notImplemented("run")` in `src/cli.ts` with a **thin** action (Q6, Q9):
1. Load config (existing), log `council.run`.
2. Build `base = join("council", config.name)` (**`config.name` wins**, Q9), `TranscriptStore`
   (`<base>/transcript/full.md`), `ArtifactStore` (`<base>`), `CopilotSessionFactory`, and
   `CouncilRuntime`.
3. `try { await runtime.start(); const result = await runBacklogCouncil(runtime, config,
   { artifacts, logger }); logger.info("council.run.complete", { …counts/ids… }); }
   finally { try { await runtime.stop(); } catch (stopErr) { logger.error("council.stop.error",
   { message }); } }` — `stop()` runs on **every** path; its failure is caught/logged and
   **never masks** the original error (`C8`).
4. Enhance the top-level `program.parseAsync(...).catch(...)` to include `code` when
   `error instanceof CouncilError` (`{ code, error: message }`); import `CouncilError`.
5. Remove the `run`→`notImplemented` call; keep `notImplemented` for `add-member`/`continue`.

All orchestration logic stays in `council-phases.ts`; the action contains no phase logic
(`cli.ts` is coverage-excluded by `vitest.config.ts`).

### Acceptance Criteria
- [ ] `council run` loads config, runs `runBacklogCouncil`, and exits 0 on success; no `notImplemented` for `run`. (`C1`)
- [ ] `runtime.stop()` is invoked in `finally` on success and on failure; a throwing `stop()` is caught/logged as `council.stop.error` and does not replace the primary error. (`C8`)
- [ ] On a `CouncilError`, the top-level catch logs `council.error` with both `code` and message and sets a non-zero exit code. (`C1`, `C8`, Q6)
- [ ] Stores are built from `config.name` (`council/<config.name>/…`), consistent with session ids. (Q9)
- [ ] The action contains no phase logic; `runBacklogCouncil`/`CouncilRuntime`/stores imported with `.js` specifiers. (`C2`, CORE-COMPONENT-0009)
- [ ] `add-member`/`continue` actions remain unchanged. (regression guard)

### Test Coverage
- `src/cli.ts` is excluded from coverage; thinness is enforced by **code review** plus:
- **TP-25** (CLI smoke / integration): a successful `run` against a 2-member temp council exits 0
  with a `council.run.complete` JSON line; a failing `run` (e.g. single-member) exits non-zero
  with a `council.error` JSON line carrying `code`. Runs after `./harness build`.
- **TP-21**/**TP-26** validate the cleanup pattern (stop() called on throw; guarded finally does
  not mask the original error) against a real runtime + fake factory at unit level.

---

## Task TASK-07: Unit tests, fakes, and public-surface/`LLM.txt` updates

- **Status:** Planned
- **Complexity:** High
- **Dependencies:** TASK-01, TASK-02, TASK-03, TASK-04, TASK-05
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0009, CORE-COMPONENT-0008, CORE-COMPONENT-0005

### Description
Author the co-located test suite `src/runtime/council-phases.test.ts` and finalize the public
surface:
1. **Recording/scripting fake `SessionFactory`** (upgrade of `council-runtime.test.ts`'s
   `fakeFactory`): `createSession(member)` returns a `MemberSession` whose `sendAndWait(prompt)`
   pushes `{ memberId: member.id, prompt }` to a shared `calls[]` and returns a scripted response
   — configurable to return a specific string, a **blank** string, or **throw** for a given call.
   Use OS temp dirs (`mkdtemp(join(tmpdir(), "council-phases-"))`), `.js` import specifiers, and
   the `node` env (CORE-COMPONENT-0009). Build a real `CouncilRuntime` with this fake + a real
   `TranscriptStore`/`ArtifactStore` so the full flow is exercised end-to-end without the SDK.
2. Cover every TP in `03-test-plan.md` (TP-01 … TP-26) — every policy branch and every typed-error
   path, so the included module reaches ≥80% (research R6; `transcript-store.ts` also gains
   coverage when tests read the transcript back).
3. **`src/index.ts`** — add `export * from "./runtime/council-phases.js";` (so `runBacklogCouncil`,
   `normalizePolicy`, and `BacklogCouncilResult` are on the public surface; `OrchestrationError`
   is already re-exported via `./errors.js`).
4. **`LLM.txt`** — add a row for `src/runtime/council-phases.ts` describing the orchestrator and
   noting the `OrchestrationError` export + the documented default role heuristic.

### Acceptance Criteria
- [ ] `src/runtime/council-phases.test.ts` exists, co-located, `*.test.ts`, `.js` specifiers, `node` env, organized with `describe`/`it`. (`TS6`)
- [ ] A test drives the full flow with the fake `SessionFactory` and asserts the exact `(memberId, prompt)` order. (`TS1`)
- [ ] Tests assert artifact paths + non-blank content, transcript block count, every policy-gating branch, and every typed-error path. (`TS2`–`TS5`)
- [ ] `src/index.ts` re-exports `./runtime/council-phases.js`; `OrchestrationError` resolves from the package root. (`C2`, `C9`)
- [ ] `LLM.txt` contains a row naming `src/runtime/council-phases.ts`; no other rows reworded/reordered. (`C2`)

### Test Coverage
- This task **is** the test suite (TP-01 … TP-24, TP-26) plus the surface checks verified by
  **TP-25**/**TP-27** (`LLM.txt` grep + build).
- Coverage is computed over `council-phases.ts`/`errors.ts`/stores; target ≥80% all four metrics.

---

## Task TASK-08: Verification gate — `./harness verify` and coverage ≥80%

- **Status:** Planned
- **Complexity:** Low-Medium
- **Dependencies:** TASK-01 … TASK-07
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0009

### Description
Run the full gate via the harness operating surface (first-choice): `./harness lint`,
`./harness test`, `./harness build`, then `./harness verify` (lint + test + build). Confirm
conventions: tests co-located `*.test.ts`, `.js` specifiers, `node` env, overall coverage ≥80%
with `src/cli.ts` excluded (`vitest.config.ts`). If a needed harness verb is missing/degraded,
record the gap with `./harness friction add` before falling back to a direct command.

### Acceptance Criteria
- [ ] `./harness test` passes with coverage ≥80% (lines/functions/branches/statements). (`TS6`)
- [ ] `./harness lint` and `./harness build` pass; `./harness verify` reports verdict `pass`. (`TS6`)
- [ ] `LLM.txt` lists `src/runtime/council-phases.ts`; `src/index.ts` exports the new module. (`C2`, `C9`)
- [ ] Any harness bypass (missing/degraded verb) is recorded via `./harness friction add`. (process)

### Test Coverage
- **TP-27** (gate): `./harness verify` green; coverage threshold met; `LLM.txt`/`index.ts` surface
  checks. Aggregates `TS6`.

---

## Acceptance-Criteria → Task Traceability

| AC | Description (short) | Task(s) |
|----|---------------------|---------|
| C1 | `council run` runs + exits 0 (no `notImplemented`) | TASK-06 |
| C2 | New orchestrator; no SDK import; fake-factory runnable | TASK-02, TASK-04, TASK-07 |
| C3 | Phases in order via `askMember` | TASK-04 |
| C4 | Roles resolved from config; not hardcoded | TASK-03 |
| C5 | `writeArtifacts` → 3 artifacts via `ArtifactStore.write` | TASK-05 |
| C6 | Every exchange appended (one block/turn) | TASK-04 |
| C7 | Policy honored + defaults | TASK-02, TASK-04, TASK-05 |
| C8 | `stop()` in `finally`; no masking | TASK-06 |
| C9 | `OrchestrationError` added/exported/registered | TASK-01, TASK-07 |
| C10 | Re-run overwrites artifacts, appends transcript | TASK-05 |
| E1 | Unknown member id → typed error (no silent skip) | TASK-04 |
| E2 | Unresolved/ambiguous/both-missing role → typed error | TASK-03 |
| E3 | Mid-phase throw → typed error, transcript preserved, `stop()` runs | TASK-04, TASK-06 |
| E4 | Blank response → `OrchestrationError` | TASK-04, TASK-05 |
| E5 | Artifact write failure → typed error wrapping cause | TASK-05 |
| E6 | `writeArtifacts:false` → no files, transcript written | TASK-05 |
| E7 | `requireProjectValidation:false` skips validation | TASK-04 |
| E8 | Contradiction → typed error; bad `maxRounds` → `ConfigError` | TASK-02 |
| TS1 | Full-flow call-order test | TASK-07 |
| TS2 | Artifact path + non-blank content tests | TASK-07 |
| TS3 | Transcript block-count test | TASK-07 |
| TS4 | Policy-gating tests | TASK-07 |
| TS5 | Typed-error propagation tests | TASK-07 |
| TS6 | Coverage ≥80% + `./harness verify` | TASK-08 |
