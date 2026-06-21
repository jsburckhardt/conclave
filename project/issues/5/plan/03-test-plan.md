# Test Plan: Issue #5 — `council run` fixed backlog phases

Source: `project/issues/5/plan/01-action-plan.md`, `project/issues/5/plan/02-task-breakdown.md`.

## Conventions (apply to every unit test below)

- Unit tests live in the co-located file `src/runtime/council-phases.test.ts`
  (`*.test.ts`, `describe`/`it`; CORE-COMPONENT-0009). `OrchestrationError` construction may also
  extend `src/errors.test.ts`.
- Intra-project imports use **`.js`** specifiers (e.g. `import { runBacklogCouncil } from "./council-phases.js"`).
- Tests run under the **`node`** vitest environment (`vitest.config.ts`).
- Filesystem tests use an isolated temp dir — `dir = await mkdtemp(join(tmpdir(), "council-phases-"))`
  — cleaned up with `rm(dir, { recursive: true, force: true })`; no test touches the real cwd
  (mirrors `src/runtime/council-runtime.test.ts` / `src/store/artifact-store.test.ts`).
- Overall coverage must stay **≥80%** (lines/functions/branches/statements) with `src/cli.ts`
  excluded (`vitest.config.ts`); `council-phases.ts` is **included**, so every policy branch and
  every typed-error path below must be exercised (research R6).
- `./harness verify` (lint + test + build) is the final pass/fail signal.

### Shared fixtures

**`councilConfig(overrides?)`** — a valid 2-member council whose `role` strings resolve cleanly:

```ts
{
  name: "demo",
  goal: "Produce a backlog for Project X",
  members: [
    { id: "proj",  cwd: ".", role: "Source of truth for the target project", tools: "read-only" },
    { id: "scrum", cwd: ".", role: "Scrum SME and backlog author",          tools: "read-only" },
  ],
  orchestrator: { cwd: ".", policy: { /* set per test */ } },
  artifacts: ["artifacts/backlog.md", "artifacts/epics.md"], // open-questions.md omitted on purpose (scaffold-like)
}
```
`proj` matches the **context** heuristic ("source of truth", "project"); `scrum` matches the
**backlog** heuristic ("scrum", "backlog"). Distinct → resolves.

**`recordingFactory(script)`** — the scripting/throwing/blank fake `SessionFactory` (upgrade of
`council-runtime.test.ts`'s `fakeFactory`):

```ts
function recordingFactory(script: (memberId: string, prompt: string, i: number) => string) {
  const calls: { memberId: string; prompt: string }[] = [];
  const stop = vi.fn(async () => {});
  const factory: SessionFactory = {
    start: async () => {},
    createSession: async (member) => ({
      sendAndWait: async (prompt) => {
        const i = calls.length; calls.push({ memberId: member.id, prompt });
        return script(member.id, prompt, i); // may return "", "   ", or throw
      },
    }),
    stop,
  };
  return { factory, calls, stop };
}
```
A real `CouncilRuntime` is built with this fake + a real `TranscriptStore`/`ArtifactStore` (temp
dir), so the full flow runs without `@github/copilot-sdk`. The default `script` returns
non-blank, phase-appropriate strings keyed by call index (`["summary","draft","validation",
"refined","# Epics\n- E1","# Open Questions\n- Q1"]`).

---

## Test TP-01: `OrchestrationError` shape and export

- **Type:** Unit
- **Task:** TASK-01
- **Priority:** High

### Setup
Import `OrchestrationError` and `CouncilError` from `../errors.js`, and `OrchestrationError` from
the package root (`../index.js`).

### Steps
1. `const cause = new Error("boom"); const e = new OrchestrationError("x", { cause });`
2. Inspect `e.code`, `e.name`, `e.cause`, `e instanceof CouncilError`.
3. Confirm `OrchestrationError` resolves from `src/index.ts`.

### Expected Result
- `e.code === "ORCHESTRATION_ERROR"`, `e.name === "OrchestrationError"`, `e.cause === cause`,
  `e instanceof CouncilError === true`.
- The root export resolves (same class identity).
- Covers `C9`.

---

## Test TP-02: `normalizePolicy` applies documented defaults

- **Type:** Unit
- **Task:** TASK-02
- **Priority:** High

### Setup
None.

### Steps
1. `normalizePolicy(undefined)` and `normalizePolicy({})`.

### Expected Result
- Both return `{ writeArtifacts: true, requireProjectValidation: true, maxRounds: 1 }`.
- Covers `C7`.

---

## Test TP-03: `normalizePolicy` rejects non-integer/negative `maxRounds` with `ConfigError`

- **Type:** Unit
- **Task:** TASK-02
- **Priority:** High

### Setup
Table: `[-1, -0.5, 1.5, NaN]`.

### Steps
1. For each value: `expect(() => normalizePolicy({ maxRounds: v })).toThrow` and assert the thrown
   error is a `ConfigError`.

### Expected Result
- Every value throws `ConfigError` (`code === "CONFIG_ERROR"`); the message names the offending value.
- Covers `E8` (the `ConfigError` half).

---

## Test TP-04: `normalizePolicy` rejects the contradictory policy with `OrchestrationError`

- **Type:** Unit
- **Task:** TASK-02
- **Priority:** High

### Setup
None.

### Steps
1. `normalizePolicy({ requireProjectValidation: true, maxRounds: 0 })`.

### Expected Result
- Throws `OrchestrationError` (`code === "ORCHESTRATION_ERROR"`) with an actionable message.
- Covers `E8` (the contradiction half).

---

## Test TP-05: `normalizePolicy` coerces booleans and accepts non-contradictory `maxRounds: 0`

- **Type:** Unit
- **Task:** TASK-02
- **Priority:** Medium

### Setup
None.

### Steps
1. `normalizePolicy({ writeArtifacts: "yes" as never, requireProjectValidation: 0 as never })`.
2. `normalizePolicy({ writeArtifacts: false, requireProjectValidation: false, maxRounds: 0 })`.

### Expected Result
- Case 1: non-boolean inputs fall back to defaults (`writeArtifacts: true`,
  `requireProjectValidation: true`, `maxRounds: 1`).
- Case 2: explicit `false` honored; `{ writeArtifacts: false, requireProjectValidation: false,
  maxRounds: 0 }` is accepted (no throw — not contradictory because validation is off).
- Covers `C7` and the accepted-`(false,0)` branch.

---

## Test TP-06: `resolveRoles` resolves distinct context + backlog ids

- **Type:** Unit
- **Task:** TASK-03
- **Priority:** High

### Setup
`councilConfig()` (members `proj`, `scrum`).

### Steps
1. `const { contextMemberId, backlogMemberId } = resolveRoles(config);`

### Expected Result
- `contextMemberId === "proj"`, `backlogMemberId === "scrum"`; neither id is a hardcoded literal
  in source (they come from `config.members`).
- Covers `C4`.

---

## Test TP-07: `resolveRoles` fails closed on a missing role (single-member council)

- **Type:** Unit
- **Task:** TASK-03
- **Priority:** High

### Setup
Single-member config (`[{ id: "project-x", role: "Source of truth for the target project", … }]`)
— the `council init` scaffold shape.

### Steps
1. `expect(() => resolveRoles(config))` to throw.

### Expected Result
- Throws `OrchestrationError` (`ORCHESTRATION_ERROR`); message names the unresolved **backlog**
  role and is actionable (suggests adding a backlog-author member).
- Covers `E2` (missing role / single member, research R8).

---

## Test TP-08: `resolveRoles` fails closed on an ambiguous role

- **Type:** Unit
- **Task:** TASK-03
- **Priority:** High

### Setup
Config with **two** members matching the backlog heuristic (e.g. roles "Scrum master" and
"Backlog owner") plus one context member.

### Steps
1. `expect(() => resolveRoles(config))` to throw.

### Expected Result
- Throws `OrchestrationError`; message states the **backlog** role is ambiguous and names both
  candidate ids.
- Covers `E2` (ambiguous role).

---

## Test TP-09: `resolveRoles` fails closed when context and backlog are not distinct

- **Type:** Unit
- **Task:** TASK-03
- **Priority:** Medium

### Setup
Config with a single member whose role matches **both** heuristics (e.g. "Project architect and
scrum backlog author"), or a two-member config where only one member matches either role.

### Steps
1. `expect(() => resolveRoles(config))` to throw.

### Expected Result
- Throws `OrchestrationError`; message explains the council needs **distinct** context-source and
  backlog-author members.
- Covers `E2` (non-distinct).

---

## Test TP-10: `resolveArtifactPath` basename-matches, else defaults under `artifacts/`

- **Type:** Unit
- **Task:** TASK-05
- **Priority:** Medium

### Setup
`configArtifacts = ["artifacts/backlog.md", "artifacts/epics.md"]` (scaffold-like; no open-questions).

### Steps
1. `resolveArtifactPath("backlog", configArtifacts)`, `resolveArtifactPath("epics", configArtifacts)`,
   `resolveArtifactPath("open-questions", configArtifacts)`.

### Expected Result
- `"backlog"` → `"artifacts/backlog.md"` (matched by basename), `"epics"` → `"artifacts/epics.md"`,
  `"open-questions"` → `"artifacts/open-questions.md"` (default — absent in the list).
- Covers `C5` (path derivation, Q7).

---

## Test TP-11: Full flow drives the exact `(memberId, prompt)` call order (+ safe logging)

- **Type:** Unit
- **Task:** TASK-04, TASK-07
- **Priority:** High

### Setup
`councilConfig({ orchestrator: { cwd: ".", policy: { maxRounds: 1, requireProjectValidation: true,
writeArtifacts: true } } })`; `recordingFactory(defaultScript)`; real runtime + temp stores; a
capturing logger.

### Steps
1. `await runtime.start(); const result = await runBacklogCouncil(runtime, config, { artifacts, logger });`
2. Inspect `calls` and captured log records.

### Expected Result
- `calls` deep-equals, in order:
  1. `{ memberId: "proj",  prompt: contextPrompt(goal) }`
  2. `{ memberId: "scrum", prompt: draftPrompt(...) }`
  3. `{ memberId: "proj",  prompt: validationPrompt(...) }`
  4. `{ memberId: "scrum", prompt: refinementPrompt(...) }`
  5. `{ memberId: "scrum", prompt: epicsPrompt(...) }`
  6. `{ memberId: "scrum", prompt: openQuestionsPrompt(...) }`
  (the first four match the AC's `context → draft → validation → refinement` exactly; 5–6 are the
  `writeArtifacts`-gated artifact asks.)
- `result.phases` includes `["context","draft","validation","refinement","artifacts"]`;
  `result.rounds === 1`; `result.contextMemberId === "proj"`; `result.backlogMemberId === "scrum"`.
- Captured logs include `council.roles.resolved`, `phase.context.start`, `phase.draft.start`,
  `phase.validation.start`, `phase.refinement.start`, `phase.artifacts.written`; **no** log field
  contains a prompt or response body (assert none equals the scripted strings). (CORE-COMPONENT-0005, R7)
- Covers `TS1`, `C3`, and the logging contract.

---

## Test TP-12: Artifacts are written to expected paths with non-blank content

- **Type:** Unit
- **Task:** TASK-05
- **Priority:** High

### Setup
As TP-11 (`writeArtifacts: true`); `ArtifactStore` base = `dir`.

### Steps
1. Run the flow.
2. `readFile(join(dir, "artifacts", "backlog.md"|"epics.md"|"open-questions.md"), "utf8")`.
3. Inspect `result.artifacts`.

### Expected Result
- All three files exist at `artifacts/backlog.md`, `artifacts/epics.md`,
  `artifacts/open-questions.md`; each has **non-blank** content (the scripted refinement/epics/
  open-questions outputs).
- `result.artifacts` lists the three absolute paths; `result.artifactsSkipped === false`.
- Covers `TS2`, `C5`.

---

## Test TP-13: Transcript contains exactly one appended block per exchange

- **Type:** Unit
- **Task:** TASK-04
- **Priority:** High

### Setup
As TP-11 (`writeArtifacts: true`, `requireProjectValidation: true`, `maxRounds: 1` → 6 asks).

### Steps
1. Run the flow.
2. `const t = await readFile(transcriptPath, "utf8");` count blocks (e.g. occurrences of the
   `## ` member-header line, or the `---` separator).

### Expected Result
- Exactly **6** transcript blocks (one per `askMember` call) — proving the orchestrator never
  double-appends (research R4); blocks appear in call order with the right member ids.
- Covers `TS3`, `C6`.

---

## Test TP-14: Re-running overwrites artifacts in place and appends the transcript

- **Type:** Unit
- **Task:** TASK-05
- **Priority:** High

### Setup
As TP-11; run the flow **twice** against the same temp `dir` (fresh runtime each run, same stores
paths). Second run uses a script returning distinguishable content (e.g. `"refined-v2"`).

### Steps
1. Run once; capture `backlog.md` content and transcript block count `n1`.
2. Run again; re-read `backlog.md` and transcript block count `n2`.

### Expected Result
- `backlog.md` equals the **second** run's content (overwritten in place — not appended/duplicated).
- Transcript block count `n2 === 2 * n1` (appended, not truncated) — CORE-COMPONENT-0006 idempotency.
- Covers `C10`.

---

## Test TP-15: `writeArtifacts: false` runs all phases + transcript but writes no files

- **Type:** Unit
- **Task:** TASK-05
- **Priority:** High

### Setup
`policy: { writeArtifacts: false, requireProjectValidation: true, maxRounds: 1 }`; temp stores.

### Steps
1. Run the flow.
2. Inspect `result`, the transcript, and the `artifacts/` directory.

### Expected Result
- No artifact files exist (`readdir(join(dir, "artifacts"))` is empty or the dir is absent);
  `result.artifacts === []`, `result.artifactsSkipped === true`.
- The transcript still has the 4 reasoning blocks (context, draft, validation, refinement) — the
  epics/open-questions asks are skipped with the artifact phase.
- `calls.length === 4` (no artifact asks made).
- Covers `E6`, `TS4`.

---

## Test TP-16: `requireProjectValidation: false` skips validation and refines from the draft

- **Type:** Unit
- **Task:** TASK-04
- **Priority:** High

### Setup
`policy: { requireProjectValidation: false, writeArtifacts: true, maxRounds: 1 }`; capturing logger.

### Steps
1. Run the flow.
2. Inspect `calls`, `result.validationSkipped`, and logs.

### Expected Result
- No `validationPrompt` ask is issued; `calls` order is context → draft → refinement → epics →
  open-questions (5 asks). `result.validationSkipped === true`.
- A `phase.validation.skipped` event is logged; the refinement prompt contains no validation block
  ("refines directly from the draft").
- Covers `E7`, `TS4`.

---

## Test TP-17: Rounds are bounded by `maxRounds`

- **Type:** Unit
- **Task:** TASK-04
- **Priority:** High

### Setup
`policy: { requireProjectValidation: true, writeArtifacts: false, maxRounds: 2 }`.

### Steps
1. Run the flow.
2. Count validation asks and refinement asks in `calls`; inspect `result.rounds`.

### Expected Result
- Exactly **2** validation asks and **2** refinement asks (`calls` = context, draft, validation,
  refinement, validation, refinement); `result.rounds === 2`.
- (With `writeArtifacts:false`, no artifact asks.) Transcript has 6 blocks.
- Covers `C7`, `TS4` (rounds bound).

---

## Test TP-18: Contradictory policy throws before any ask (full-flow level)

- **Type:** Unit
- **Task:** TASK-02, TASK-04
- **Priority:** Medium

### Setup
`policy: { requireProjectValidation: true, maxRounds: 0 }`; recording factory.

### Steps
1. `await expect(runBacklogCouncil(runtime, config, { artifacts, logger })).rejects` → `OrchestrationError`.
2. Inspect `calls` and the `artifacts/` dir.

### Expected Result
- Rejects with `OrchestrationError` (`ORCHESTRATION_ERROR`); `calls.length === 0` (failed in
  phase 0); no transcript/artifact side effects.
- Covers `E8`, `TS4` (contradiction throws).

---

## Test TP-19: Bad `maxRounds` throws `ConfigError` before any ask (full-flow level)

- **Type:** Unit
- **Task:** TASK-02, TASK-04
- **Priority:** Medium

### Setup
`policy: { maxRounds: -1 }` (and a `1.5` variant); recording factory.

### Steps
1. `await expect(runBacklogCouncil(...)).rejects` and assert `ConfigError`.
2. Inspect `calls`.

### Expected Result
- Rejects with `ConfigError` (`CONFIG_ERROR`); `calls.length === 0`; no side effects.
- Covers `E8` (`ConfigError` half) at the orchestrator entry point.

---

## Test TP-20: A blank response in any phase raises `OrchestrationError`

- **Type:** Unit
- **Task:** TASK-04, TASK-05
- **Priority:** High

### Setup
Parametrize over the phase whose scripted response is blank — `""` or `"   "` — for: context,
draft, validation, refinement, epics, open-questions (script returns blank for that call index,
non-blank otherwise). `writeArtifacts: true` so epics/open-questions are reached.

### Steps
1. For each parametrized phase: `await expect(runBacklogCouncil(...)).rejects` → `OrchestrationError`.
2. Assert no artifact file for that phase (and downstream) is written.

### Expected Result
- Each blank phase rejects with `OrchestrationError` (`ORCHESTRATION_ERROR`); no empty artifact is
  ever written/returned.
- For a blank **epics**/**open-questions** response, `epics.md`/`open-questions.md` is not written.
- Covers `E4`, `TS5` (blank response).

---

## Test TP-21: A member throwing mid-phase propagates a typed error, preserves the transcript, and `stop()` still runs

- **Type:** Unit
- **Task:** TASK-04, TASK-06
- **Priority:** High

### Setup
Script the **validation** call (index 2) to `throw new SessionError("session blew up")`; earlier
calls return non-blank. Wrap the run in the CLI's guarded pattern:
`try { await runBacklogCouncil(...) } finally { try { await runtime.stop() } catch {} }`.

### Steps
1. Expect `runBacklogCouncil` to reject with a `CouncilError` (the `SessionError`).
2. After the `finally`, read the transcript and inspect the factory `stop` spy.

### Expected Result
- Rejects with the typed `SessionError` (a `CouncilError`); the error is **not** swallowed.
- The transcript still contains the **2 prior** turns (context, draft) — appended before the
  throw (research: `askMember` appends after a successful `sendAndWait`, so the failed turn is not
  appended but prior turns persist).
- The factory `stop` spy was called exactly once (cleanup ran).
- Covers `E3`, `TS5` (mid-phase throw + `stop()`).

---

## Test TP-22: An unknown member id raises `SessionError` (no silent skip)

- **Type:** Unit
- **Task:** TASK-04
- **Priority:** High

### Setup
(a) Seam check: a started `CouncilRuntime`; (b) orchestrator check: `vi.spyOn(runtime, "askMember")`
forced to throw `SessionError` for one phase.

### Steps
1. `await expect(runtime.askMember("ghost", "x")).rejects.toBeInstanceOf(SessionError)`.
2. With the spy throwing on the context call, `await expect(runBacklogCouncil(...)).rejects` →
   `SessionError`; assert the orchestrator did not catch/skip it.

### Expected Result
- Both reject with `SessionError` (`SESSION_ERROR`, a `CouncilError`) — the orchestrator never
  silently skips a missing/failed member (it resolves ids only from `config.members` and trusts
  the `askMember` seam).
- Covers `E1`, `TS5` (unknown member).

---

## Test TP-23: An artifact write failure raises `OrchestrationError(cause)`; transcript intact

- **Type:** Unit
- **Task:** TASK-05
- **Priority:** High

### Setup
`writeArtifacts: true`; `vi.spyOn(artifacts, "write").mockRejectedValueOnce(new Error("disk full"))`
on the **first** write (`backlog.md`). Capturing logger.

### Steps
1. `await expect(runBacklogCouncil(runtime, config, { artifacts, logger })).rejects` → `OrchestrationError`.
2. Inspect `err.cause`, the logged error event, and the transcript.

### Expected Result
- Rejects with `OrchestrationError` (`ORCHESTRATION_ERROR`); `err.cause` is the underlying
  `Error("disk full")` (research R2 — the store throws a plain `Error`, wrapped by the caller).
- The failure is logged (e.g. a `phase.artifacts` error event) — without the artifact body.
- The transcript (from the reasoning asks) is fully present — no already-written content lost.
- A traversal variant (artifact path resolving outside base) likewise surfaces as
  `OrchestrationError` wrapping the store's plain `Error`.
- Covers `E5`, `TS5` (write failure).

---

## Test TP-24: The orchestrator imports no SDK and runs with a fake `SessionFactory`

- **Type:** Unit / Static
- **Task:** TASK-04, TASK-07
- **Priority:** High

### Setup
Read `src/runtime/council-phases.ts` source; the recording fake from the shared fixtures.

### Steps
1. Assert the source contains no `@github/copilot-sdk` import (string/AST check).
2. Confirm the full TP-11 flow runs to completion using only the fake factory + real stores.

### Expected Result
- No `@github/copilot-sdk` import exists in `council-phases.ts`.
- The orchestrator completes end-to-end with the fake factory (no SDK).
- Covers `C2`.

---

## Test TP-25: CLI smoke — `council run` end-to-end exit codes and structured logs

- **Type:** Integration
- **Task:** TASK-06
- **Priority:** Medium

### Setup
Run after `./harness build`. In a temp cwd, scaffold a **2-member** `council.yaml` (context +
backlog members so role resolution succeeds) with a fake/stub session path, or run the failing
case directly. Invoke the built CLI via `child_process`
(`execFile(process.execPath, [join(repo, "dist/cli.js"), "run", "demo", "-c", cfgPath], { cwd })`).

### Steps
1. **Failure path (hermetic, no live SDK):** run against the single-member scaffold so role
   resolution fails.
2. (If a live/faked session is available) success path against a 2-member council.

### Expected Result
- Failure path: non-zero exit; a `council.error` JSON line on stderr carrying **both** `code`
  (`ORCHESTRATION_ERROR`) and message (Q6); `runtime.stop()` ran (no dangling state).
- Success path (when runnable): exit 0; a `council.run.complete` JSON line on stdout; artifacts
  under `council/demo/artifacts/`.
- Confirms `C1`, `C8`, Q6 end-to-end. (Marked optional/best-effort where a live SDK session is not
  available in CI; the failure path is hermetic and always runs.)

---

## Test TP-26: A `stop()` failure does not mask the original error

- **Type:** Unit
- **Task:** TASK-06
- **Priority:** Medium

### Setup
Real `CouncilRuntime` whose factory `stop` is `vi.fn().mockRejectedValue(new Error("stop failed"))`;
script a phase to throw `new OrchestrationError("primary")`. Replicate the CLI's guarded finally:
`let caught; try { await runBacklogCouncil(...) } catch (e) { caught = e } finally { try { await
runtime.stop() } catch (stopErr) { /* logged separately */ } }`.

### Steps
1. Run the guarded pattern.
2. Inspect `caught` and the `stop` spy.

### Expected Result
- `caught` is the **primary** `OrchestrationError` ("primary") — not the `stop` error; the guarded
  inner `catch` prevents the `finally` from overwriting it.
- `stop` was invoked (cleanup attempted) and its failure was handled separately.
- Covers `C8` (no masking).

---

## Test TP-27: Verification gate — coverage ≥80%, surface updated, `./harness verify` green

- **Type:** Gate / Verification
- **Task:** TASK-07, TASK-08
- **Priority:** High

### Setup
Clean tree with all tasks implemented.

### Steps
1. `./harness lint`, `./harness test`, `./harness build`, `./harness verify`.
2. `grep "src/runtime/council-phases.ts" LLM.txt`.
3. Confirm `src/index.ts` re-exports `./runtime/council-phases.js` (and `OrchestrationError`
   resolves from the root).

### Expected Result
- `./harness verify` returns verdict `pass`.
- Coverage ≥80% (lines/functions/branches/statements) with `src/cli.ts` excluded;
  `council-phases.ts` exercised by `council-phases.test.ts`.
- `LLM.txt` contains a row naming `src/runtime/council-phases.ts`; `src/index.ts` exports the module.
- Any missing/degraded harness verb recorded via `./harness friction add`.
- Covers `TS6`, plus `C2`/`C9` surface checks.

---

## Acceptance-Criteria → Test Traceability

| AC | Description (short) | Test(s) |
|----|---------------------|---------|
| C1 | `council run` runs + exits 0 (no `notImplemented`) | TP-25 |
| C2 | New orchestrator; no SDK import; fake-factory runnable | TP-11, TP-24, TP-27 |
| C3 | Phases in order via `askMember` | TP-11 |
| C4 | Roles resolved from config; not hardcoded | TP-06 |
| C5 | `writeArtifacts` → 3 artifacts via `ArtifactStore.write` from `config.artifacts` | TP-10, TP-12 |
| C6 | Every exchange appended (one block/turn) | TP-13 |
| C7 | Policy honored + defaults | TP-02, TP-05, TP-16, TP-17 |
| C8 | `stop()` in `finally`; no masking | TP-21, TP-25, TP-26 |
| C9 | `OrchestrationError` added/exported/registered | TP-01, TP-27 |
| C10 | Re-run overwrites artifacts, appends transcript | TP-14 |
| E1 | Unknown member id → typed error (no silent skip) | TP-22 |
| E2 | Unresolved/ambiguous/both-missing role → typed error | TP-07, TP-08, TP-09 |
| E3 | Mid-phase throw → typed error, transcript preserved, `stop()` runs | TP-21 |
| E4 | Blank response → `OrchestrationError` | TP-20 |
| E5 | Artifact write failure → typed error wrapping cause | TP-23 |
| E6 | `writeArtifacts:false` → no files, transcript written | TP-15 |
| E7 | `requireProjectValidation:false` skips validation | TP-16 |
| E8 | Contradiction → typed error; bad `maxRounds` → `ConfigError` | TP-03, TP-04, TP-18, TP-19 |
| TS1 | Full-flow exact call-order | TP-11 |
| TS2 | Artifact path + non-blank content | TP-12 |
| TS3 | Transcript one block per exchange | TP-13 |
| TS4 | Policy-gating (skip/no-files/rounds/contradiction) | TP-15, TP-16, TP-17, TP-18 |
| TS5 | Typed-error propagation (role, throw+stop, blank, write fail) | TP-20, TP-21, TP-22, TP-23 |
| TS6 | Coverage ≥80% + `./harness verify` | TP-27 |

### Policy-branch & error-path coverage checklist (80% gate)

| Branch / path | Test |
|---|---|
| `maxRounds` default applied | TP-02 |
| `maxRounds` invalid (negative/non-integer) → `ConfigError` | TP-03, TP-19 |
| contradiction `(true, 0)` → `OrchestrationError` | TP-04, TP-18 |
| boolean coercion + accepted `(false, 0)` | TP-05 |
| `requireProjectValidation` true (validation runs) | TP-11, TP-13, TP-17 |
| `requireProjectValidation` false (validation skipped) | TP-16 |
| `maxRounds` 1 vs 2 (loop bound) | TP-11, TP-17 |
| `writeArtifacts` true (artifacts written) | TP-12, TP-14 |
| `writeArtifacts` false (no files) | TP-15 |
| role resolve OK / missing / ambiguous / non-distinct | TP-06/07/08/09 |
| blank response (each phase) | TP-20 |
| member throw mid-phase + cleanup | TP-21, TP-26 |
| unknown member id | TP-22 |
| artifact write failure + traversal | TP-23 |
| `resolveArtifactPath` match vs default | TP-10 |
