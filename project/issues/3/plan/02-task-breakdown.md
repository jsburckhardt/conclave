# Task Breakdown: Issue #3 — `council continue` resume

Source plan: `project/issues/3/plan/01-action-plan.md`.
Test cases (TP-IDs) are defined in `project/issues/3/plan/03-test-plan.md`.

**Acceptance-criterion IDs** (from the issue, used throughout): Core `C1`–`C9`, Edge `E1`–`E8`,
Testing `T1`–`T9`.

| ID | Acceptance criterion (short) |
|----|------------------------------|
| C1 | `council continue <council>` implemented; `notImplemented("continue")` stub removed |
| C2 | `continue` loads `council.yaml` (honoring `-c/--config`) and reads `state.json` via a decoupled store |
| C3 | New `council-state-store.ts` reads/writes `state.json` (all fields), no orchestration logic, exported from `src/index.ts` |
| C4 | `state.json` writes `mkdir -p` the parent and are atomic (temp file + `rename`) |
| C5 | Resume recreates sessions via `SessionFactory.createSession(member, councilId)`, reusing stable `${councilId}/${memberId}` ids |
| C6 | Phase/round flow continues from persisted `lastPhase`/`lastRound`; state re-persisted after each completed phase/round |
| C7 | Artifacts, transcript, `state.json` authoritative; failed SDK resume does not discard persisted state |
| C8 | All `continue` activity logged via `createLogger` (resume start, state read/write, sessions resumed, completion) |
| C9 | Failures → typed `CouncilError` subclasses with stable codes + non-zero exit via the top-level handler |
| E1 | Missing `state.json` → typed actionable error ("run `council run` first"); no silent fresh-start |
| E2 | Corrupt/partial `state.json` → typed error; never silently treated as empty |
| E3 | Unknown/newer `schemaVersion` → typed error; no best-effort parse |
| E4 | Member-set drift → typed abort unless `--force`; non-structural drift warns + continues; both logged |
| E5 | SDK session-resume failure → `SessionError`; persisted state preserved (retryable) |
| E6 | Concurrent `continue`/`run` → concurrency guard (typed error/refusal) + documented stale-lock `--force` escape |
| E7 | Resuming a `completed` council is a safe idempotent no-op with a clear message |
| E8 | `<council>` arg and config path validated; cannot traverse outside the council dir |
| T1 | Unit: resume continues from the correct `lastPhase`/`lastRound` |
| T2 | Unit: resume reuses exact stable ids via a fake `SessionFactory` (no real SDK) |
| T3 | Unit: missing `state.json` → typed "no prior run" error |
| T4 | Unit: corrupt/partial `state.json` → typed error (not empty/fresh) |
| T5 | Unit: unknown/newer `schemaVersion` → typed error |
| T6 | Unit: state re-persisted (updated `lastPhase`/`lastRound`/`updatedAt`) after progress, atomically |
| T7 | Unit: member-set drift aborts without `--force`, allowed with `--force` |
| T8 | Unit: concurrency guard rejects a second invocation while one is in progress |
| T9 | Co-located `*.test.ts`, real temp dirs (`mkdtemp`), overall coverage ≥80% |

**Architecture note:** CORE-COMPONENT-0004/0006/0008 were already amended by the planner (see
`01-action-plan.md` and DECISION-LOG rows #30–#38). These tasks **implement the code to match**
those documented contracts; no further core-component edits are required from the implementer.

---

## Task TASK-01: Add `StateError` and export it

- **Status:** Planned
- **Complexity:** Low
- **Dependencies:** None
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0008, CORE-COMPONENT-0009

### Description
Add `StateError` to `src/errors.ts`, extending `CouncilError` with `code: "STATE_ERROR"` and a
`(message, options?: { cause?: unknown })` constructor that sets `this.name = "StateError"` and
forwards `cause` to `super` — mirroring the existing `ConfigError`/`SessionError`/`OrchestrationError`
shape. It is re-exported automatically via the existing `export * from "./errors.js"` in
`src/index.ts` (confirm; no new export line needed). Registration in CORE-COMPONENT-0008 is already
done by the planner (decisions #30–#31).

### Acceptance Criteria
- [ ] `StateError` extends `CouncilError`; `new StateError("x").code === "STATE_ERROR"`. (`C9`)
- [ ] `new StateError("x", { cause }).cause === cause` and `instanceof CouncilError === true`. (`C9`)
- [ ] `StateError` is importable from the package root (`import { StateError } from "conclave"` / `src/index.ts`). (`C9`)
- [ ] No change to `ConfigError`/`SessionError`/`OrchestrationError` behavior (regression guard). (`C9`)

### Test Coverage
- Extend `src/errors.test.ts` — **TP-01**: construct with/without `cause`; assert `code`, `name`,
  `instanceof CouncilError`, and `cause` preservation.
- Exercised indirectly by every state-error path in TASK-03/04/07 (CORE-COMPONENT-0009 ≥80%).

---

## Task TASK-02: Extract the shared `atomicWriteFile` helper

- **Status:** Planned
- **Complexity:** Low
- **Dependencies:** None
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0006, CORE-COMPONENT-0009

### Description
Move the private `atomicWriteFile` (currently in `src/config/add-member.ts`, lines 140–152) into a
new shared module `src/store/atomic-write.ts` and export it (`export async function atomicWriteFile`).
Refactor `add-member.ts` to import and use it (delete the local copy). Keep behavior **byte-identical**:
unique temp file `.<base>.<pid>.<uuid>.tmp` in the **same directory**, `writeFile` → `rename`, `rm`
temp (best-effort) on error and re-throw. Do **not** add `src/store/atomic-write.ts` to
`src/index.ts` (it stays an internal shared helper, not public API). Resolves research R7 (single
source of truth; avoids divergence). (CORE-COMPONENT-0006 decision #32.)

### Acceptance Criteria
- [ ] `atomicWriteFile(target, content)` lives in `src/store/atomic-write.ts` and is imported by both `add-member.ts` and (later) `council-state-store.ts`. (`C4`)
- [ ] Writes a uniquely-named temp file in the target's directory, then `rename`s over the target. (`C4`)
- [ ] On write/rename failure, the temp file is removed (best-effort) and the original error re-thrown; the target is left untouched. (`C4`)
- [ ] `add-member` behavior is unchanged (all existing `add-member` tests still pass). (`C4`)
- [ ] `atomic-write.ts` is **not** re-exported from `src/index.ts` (internal helper). 

### Test Coverage
- New `src/store/atomic-write.test.ts` — **TP-02**: write into a temp dir; assert content + that no
  `.*.tmp` remains; force a `rename` failure (e.g. target dir removed) and assert the original error
  propagates and no temp file is orphaned.
- Regression: the existing `src/config/add-member.test.ts` suite passes unchanged.

---

## Task TASK-03: `CouncilStateStore` + `CouncilState` schema (read/write)

- **Status:** Planned
- **Complexity:** Medium
- **Dependencies:** TASK-01, TASK-02
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0006, CORE-COMPONENT-0008, CORE-COMPONENT-0003

### Description
Create `src/store/council-state-store.ts` exporting `STATE_SCHEMA_VERSION = 1`, the `CouncilState`
type set (`CouncilStatus`, `CouncilPhase`, `CouncilStateMember`, `CouncilStateProducts`,
`CouncilState`), and `class CouncilStateStore` (constructed with the `state.json` file path; **no
orchestration logic**). Export the module from `src/index.ts` (C3). The schema is defined in
`01-action-plan.md` ("The `state.json` schema").

- `write(state)`: `mkdir -p` the parent dir, then `atomicWriteFile(path, JSON.stringify(state, null, 2))`
  (TASK-02). Atomic; never half-written. (C4)
- `read()`: `readFile`; map `ENOENT` → `StateError` ("No prior run for council '<id>'. Run
  `council run <council>` first.", E1); `JSON.parse` failure → `StateError` (corrupt, E2);
  `schemaVersion` not the integer `1` → `StateError` (unsupported/newer, E3); any missing/ill-typed
  required field (`councilId`, `status` enum, `lastPhase` enum|null, `lastRound` non-negative int,
  `members[]`, `configHash`, timestamps) → `StateError` (corrupt, E2). **Never** returns a
  fresh/empty state (research R4).
- `exists()`: best-effort `stat` boolean (helper for the producer/idempotent paths).

### Acceptance Criteria
- [ ] `CouncilStateStore` reads/writes `state.json` with the full field set and **no** orchestration logic; exported from `src/index.ts`. (`C3`)
- [ ] `write` creates the parent dir (`mkdir -p`) and is atomic (temp file + `rename` via `atomicWriteFile`); a reader never sees a partial file. (`C4`)
- [ ] `write` then `read` round-trips an identical `CouncilState` (including `products`). (`C3`)
- [ ] `read` on a missing file throws `StateError` whose message tells the user to run `council run <council>` first. (`E1`, `T3`)
- [ ] `read` on invalid JSON or a failed field/shape check throws `StateError` (never an empty state). (`E2`, `T4`)
- [ ] `read` on `schemaVersion !== 1` (missing, `0`, `2`, non-integer) throws `StateError`. (`E3`, `T5`)
- [ ] `read` on a valid file returns the typed `CouncilState`. (`C2`)

### Test Coverage
- New `src/store/council-state-store.test.ts` (real temp dirs via `mkdtemp`):
  **TP-03** (atomic write + `mkdir -p` + round-trip, `T6`/`C4`/`C3`), **TP-04** (missing → `StateError`,
  `T3`/`E1`), **TP-05** (corrupt JSON / bad shape → `StateError`, `T4`/`E2`), **TP-06**
  (`schemaVersion` 0/2/missing/non-integer → `StateError`, `T5`/`E3`), **TP-07** (valid → typed state).
- Every `read` branch and the `write` path must be exercised (coverage; research R6). (`T9`)

---

## Task TASK-04: `CouncilLock` + `councilConfigHash`

- **Status:** Planned
- **Complexity:** Medium
- **Dependencies:** TASK-01
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0006, CORE-COMPONENT-0008

### Description
Create `src/store/council-lock.ts` exporting `councilConfigHash(raw: string): string`
(`createHash("sha256").update(raw).digest("hex")` from `node:crypto`; hashes the **raw
`council.yaml` bytes**) and `class CouncilLock` (constructed with the `.council.lock` path). Export
from `src/index.ts`. No new dependency (Q4/Q5; research line 148–151).

- `acquire(force?)`: if `force`, best-effort `unlink` the existing lock first
  (`logger`-agnostic; the command logs `lock.forced`). Then `writeFile(path,
  JSON.stringify({ pid, hostname, startedAt }), { flag: "wx" })`; an `EEXIST` → `StateError`
  ("Another run/continue is in progress for '<id>' (lock at <path>). If no process is running,
  re-run with --force."). TOCTOU-safe (atomic `wx`), mirroring `init`'s exclusive `mkdir`. (E6)
- `release()`: best-effort `rm(path, { force: true })` (ignore errors); safe to call when not held.

### Acceptance Criteria
- [ ] `councilConfigHash(raw)` is deterministic, hex, and changes when the input bytes change; uses only `node:crypto`. (`E4`)
- [ ] `acquire()` succeeds and creates the lock file when none exists; a second `acquire()` (lock present) throws `StateError`. (`E6`, `T8`)
- [ ] `acquire(true)` (`--force`) clears a pre-existing lock and succeeds. (`E6`)
- [ ] `release()` removes the lock file and is a safe no-op when the file is absent (idempotent). (`E6`)
- [ ] Lock file content is JSON `{ pid, hostname, startedAt }`; the module adds **no** new dependency.

### Test Coverage
- New `src/store/council-lock.test.ts` (real temp dirs):
  **TP-08** (acquire → second acquire throws `StateError`; `release` then re-acquire succeeds;
  `acquire(true)` clears a stale lock; `release` idempotent — `T8`/`E6`),
  **TP-09** (`councilConfigHash` deterministic + differs on change — `E4`).

---

## Task TASK-05: Resume + checkpoint support in `runBacklogCouncil`

- **Status:** Planned
- **Complexity:** High
- **Dependencies:** TASK-03
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0004, CORE-COMPONENT-0006

### Description
Extend `src/runtime/council-phases.ts` **backward-compatibly**: add `ResumePoint` +
`PhaseCheckpoint` types and the optional `resume?` and `checkpoint?` fields to
`RunBacklogCouncilOptions`. When both are absent, `runBacklogCouncil` behaves **exactly as today**
(no checkpoint writes; existing `council-phases.test.ts` and the TP-19 fail-fast path unchanged).
Implement the resume state machine from `01-action-plan.md` (Q2 table):

- Seed `summary`/`working`/`rounds` and the start point from `options.resume`
  (`null`→context, `context`→draft, `draft`→rounds@0, `validation`→mid-round refinement,
  `refinement`→rounds@`lastRound` or artifacts, `artifacts`→done). Roles are re-derived via
  `resolveRoles` (pure; never persisted).
- After **each** completed phase/round, call `options.checkpoint?.({ lastPhase, lastRound, products })`
  with the minimal `products` (`summary` after context; `backlog` after draft/refinement;
  `{ backlog, validation }` after a round's validation). `status`/identity are owned by the caller
  (the callback merges into the full state). (C6)
- The transcript is still written automatically inside `askMember` (never appended directly, R4).
  `runtime.stop()` remains the caller's responsibility (guarded `finally`).

### Acceptance Criteria
- [ ] `runBacklogCouncil` with no `resume`/`checkpoint` is behavior-identical to the current implementation (regression). (`C6`)
- [ ] With `checkpoint`, the callback fires once after every completed phase/round, carrying the correct `lastPhase`, `lastRound`, and minimal `products`. (`C6`, `T6`)
- [ ] With `resume.lastPhase = "draft"`, context + draft are **not** re-asked; the flow continues into the rounds loop seeded from `products.backlog`. (`C6`, `T1`)
- [ ] With `resume.lastPhase = "context"`, draft onward runs seeded from `products.summary`. (`C6`, `T1`)
- [ ] With `resume.lastPhase = "validation"`, the in-progress round resumes at **refinement** (its validation is not re-asked), seeded from `products.validation`. (`C6`, `T1`)
- [ ] With `resume.lastPhase = "refinement"` and `lastRound == maxRounds`, only the artifacts phase remains. (`C6`)
- [ ] `BacklogCouncilResult` (phases/rounds/artifacts/...) stays correct for both fresh and resumed runs. (`C6`)

### Test Coverage
- Extend `src/runtime/council-phases.test.ts` with a recording/scripting fake `SessionFactory`
  (asserts exact `(memberId, prompt)` order so skipped phases are provably **not** re-asked):
  **TP-10** (checkpoint fires per phase/round with correct payload — `T6`/`C6`),
  **TP-11** (resume from `draft` skips context+draft — `T1`),
  **TP-12** (resume from `context` — `T1`),
  **TP-13** (resume from `validation` resumes mid-round at refinement — `T1`).
- All resume branches exercised (coverage; research R2/R6). (`T9`)

---

## Task TASK-06: `runCouncil` extraction + producer hook (state + lock)

- **Status:** Planned
- **Complexity:** High
- **Dependencies:** TASK-03, TASK-04, TASK-05
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0004, CORE-COMPONENT-0006, CORE-COMPONENT-0003, CORE-COMPONENT-0005

### Description
Extract the `run` action body from `src/cli-program.ts` into a testable
`runCouncil(options: RunCouncilOptions)` in `src/commands/run.ts` (injectable `baseDir`,
`logger`, `sessionFactory`), and rewire the commander `run` action to a thin adapter delegating to
it (mirrors the `addMember` pattern). Preserve existing behavior (log `council.run`, fail-fast
`normalizePolicy` + `resolveRoles` before any side effect → keeps TP-19 green) and **add the
producer hook** (Q1/Q3/Q4):

1. Resolve `councilDir = dirname(resolveCouncilConfigPath(council, baseDir))`; assert
   `config.name === council` else `ConfigError` (R3). (E8)
2. Build `TranscriptStore`/`ArtifactStore`/`CouncilStateStore`/`CouncilLock` from `councilDir`.
3. `lock.acquire(force)`; write the **initial** `state.json` (`in-progress`, `lastPhase: null`,
   member registry with `sessionId = "<name>/<id>"`, `configHash = councilConfigHash(raw yaml)`,
   timestamps, empty `products`).
4. `runtime.start()` → `runBacklogCouncil(runtime, config, { artifacts, logger, checkpoint })` where
   `checkpoint(cp)` merges `cp` into the base state and `await stateStore.write(...)` (E6/C6).
5. On success write the **terminal** `state.json` (`completed`).
6. `finally`: guarded `runtime.stop()` (failure → `council.stop.error`, never masks the primary
   error) **then** `lock.release()`.

Add `--force` to the `run` command (clears a stale lock). The `run` action stays thin; all logic is
in `runCouncil`. No prompt/response bodies are logged (CC-0005).

### Acceptance Criteria
- [ ] The `run` commander action delegates entirely to `runCouncil`; no run logic remains inline in `cli-program.ts`. 
- [ ] `runCouncil` writes an initial `in-progress` `state.json` before `start()` and a terminal `completed` `state.json` on success; both atomic. (`C6`, `T6`)
- [ ] `runCouncil` checkpoints `state.json` after each completed phase/round via the `runBacklogCouncil` callback. (`C6`)
- [ ] `runCouncil` asserts `config.name === <council>` and resolves the council dir via `resolveCouncilConfigPath` (traversal-guarded). (`E8`)
- [ ] `runCouncil` acquires/releases `.council.lock`; `release()` runs in `finally` on every path. (`E6`)
- [ ] On a mid-run failure, `state.json` remains `in-progress` at the last checkpoint (resumable). (`C7`)
- [ ] Existing `run` behavior (fail-fast on bad policy/roles, `council.run`/`council.run.complete` logs, guarded `stop()`) is preserved (TP-19 still passes). (`C8`)

### Test Coverage
- New `src/commands/run.test.ts` with a **fake `SessionFactory`** + real temp dir
  (`baseDir`): **TP-24** — drive a 2-member council to completion; assert the initial → checkpoint →
  terminal `state.json` sequence (`status`, `lastPhase`, `lastRound`, `updatedAt` monotonic), the
  lock file is created then removed, and `config.name !== slug` raises `ConfigError`. (`T6`/`C6`/`E8`)
- Regression: `cli-program.test.ts` TP-19 `run smoke` fail-fast path still exits 1 with `council.run`
  logged (no lock/state left behind). (`C8`)

---

## Task TASK-07: `continueCouncil` command (resume orchestration)

- **Status:** Planned
- **Complexity:** High
- **Dependencies:** TASK-03, TASK-04, TASK-05, TASK-06
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0004, CORE-COMPONENT-0006, CORE-COMPONENT-0008, CORE-COMPONENT-0003, CORE-COMPONENT-0005

### Description
Create `src/commands/continue.ts` exporting `continueCouncil(options: ContinueCouncilOptions)`
(injectable `baseDir`, `logger`, `sessionFactory`; default `new CopilotSessionFactory()`). Export
from `src/index.ts`. Implement the flow from `01-action-plan.md` ("`continueCouncil` flow"):

1. Log entry `council.continue { council }`; wrap the body in `try/catch` that logs
   `council.continue.failed { council, code }` and re-throws a typed `CouncilError` (mirrors
   `add-member`). (C8/C9)
2. Resolve `councilDir = dirname(resolveCouncilConfigPath(council, baseDir))` (slug-validated,
   traversal-guarded, E8); `configPath = options.config ?? join(councilDir, "council.yaml")`;
   `loadCouncilConfig`. Identity guard `config.name === council` (`ConfigError`). (C2/E8)
3. `stateStore.read()` → `state` (`StateError` on missing/corrupt/schema — E1/E2/E3); cross-check
   `state.councilId === config.name` (`ConfigError`).
4. **Idempotent completed:** `state.status === "completed"` → `council.continue.completed` no-op,
   return; no lock taken. (E7)
5. **Drift:** member-id set differs → member-set drift → `ConfigError` unless `force`
   (`config.drift { kind: "member-set" }` + continue when forced); else if
   `councilConfigHash(raw) !== state.configHash` → `config.drift { kind: "non-structural" }` +
   continue. (E4)
6. **Session-id cross-check:** re-derive `"<config.name>/<id>"` per member; must equal stored
   `sessionId` (`ConfigError` on mismatch). Stored ids are cross-checked, not trusted (R4). (C5)
7. Build stores + `CouncilRuntime` (with `options.sessionFactory`). `lock.acquire(force)`. (E6)
8. `try { await runtime.start();` (SDK failure → `SessionError`; persisted state untouched — E5/C7)
   `council.continue.resumed { council, members, fromPhase, fromRound };`
   `await runBacklogCouncil(runtime, config, { artifacts, logger, resume, checkpoint });`
   write terminal `completed`; `council.continue.completed` `}`
   `finally { guarded runtime.stop(); await lock.release(); }`. (C6/C7)

`resume` is `{ lastPhase, lastRound, products }` from `state`; `checkpoint` merges into the full
state and atomically re-persists (C6). Only ids/counts/phase names are logged (CC-0005).

### Acceptance Criteria
- [ ] `continueCouncil` loads `council.yaml` (honoring `config` override) and reads `state.json` via `CouncilStateStore` (decoupled). (`C2`)
- [ ] Resume builds the runtime and `runtime.start()` recreates sessions via `createSession(member, config.name)` with ids `"<config.name>/<id>"`, cross-checked against stored `sessionId`. (`C5`, `T2`)
- [ ] The phase/round flow continues from `state.lastPhase`/`state.lastRound`; state is re-persisted after each step and on completion. (`C6`, `T1`, `T6`)
- [ ] Missing/corrupt/`schemaVersion`-incompatible `state.json` → `StateError` (actionable; never silent fresh-start). (`E1`,`E2`,`E3`,`T3`,`T4`,`T5`)
- [ ] Member-set drift aborts with `ConfigError` without `--force`, proceeds (logged `config.drift`) with `--force`; non-structural drift warns + continues. (`E4`, `T7`)
- [ ] SDK `start()` failure surfaces as `SessionError` with persisted state intact (retryable). (`E5`, `C7`)
- [ ] Concurrent invocation (lock held) is rejected with `StateError`; `--force` clears a stale lock. (`E6`, `T8`)
- [ ] `status: "completed"` resume is an idempotent no-op logging `council.continue.completed`. (`E7`)
- [ ] `<council>` / config path cannot traverse outside the council dir (`ConfigError`). (`E8`)
- [ ] All activity logged (`council.continue`, `state.read/write`, `council.continue.resumed`, `council.continue.completed/failed`); failures re-thrown as typed `CouncilError`. (`C8`, `C9`)

### Test Coverage
- New `src/commands/continue.test.ts` with a **fake `SessionFactory`** + real temp dirs; a
  `writeState(dir, overrides)` fixture seeds `state.json`:
  **TP-14** (stable-id reuse via fake factory — `T2`/`C5`), **TP-15** (missing → `StateError` — `T3`),
  **TP-16** (corrupt + newer `schemaVersion` → `StateError` — `T4`/`T5`), **TP-17** (member-set drift
  abort vs `--force` — `T7`/`E4`), **TP-18** (non-structural drift warns + continues — `E4`),
  **TP-19** (already-`completed` no-op — `E7`), **TP-20** (SDK `start()` throw → `SessionError`,
  state preserved — `E5`), **TP-21** (lock held → `StateError`; `--force` clears — `T8`/`E6`),
  **TP-22** (identity mismatch `config.name != slug` → `ConfigError`), **TP-23** (resume continues
  from `lastPhase`/`lastRound` and re-persists atomically — `T1`/`T6`).
- All branches/error paths exercised (coverage; research R6). (`T9`)

---

## Task TASK-08: Wire the `continue` CLI action, `.gitignore`, and update TP-19

- **Status:** Planned
- **Complexity:** Medium
- **Dependencies:** TASK-07
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0005, CORE-COMPONENT-0008, CORE-COMPONENT-0009

### Description
Replace the `continue` stub in `src/cli-program.ts` (lines 148–155) with a thin adapter that wires
`-c, --config <path>` and `--force`, then delegates to `continueCouncil({ council, config,
force, baseDir, logger })`. Remove the now-unused `notImplemented("continue")` call path for
`continue` (keep `notImplemented` only if still used elsewhere — it is not, so delete the helper).
Add `--force` to the `run` command's option set (delegating to `runCouncil`, TASK-06). Update
`.gitignore` to ignore `council/**/.council.lock` and `council/**/.*.tmp` (Q6; `state.json` stays
tracked). Update `src/cli-program.test.ts` **TP-19** (research R6): the `continue smoke` assertion
must now expect the new behavior — `council.continue` logged, a `STATE_ERROR` failure (no prior
run, since `smoke` was never successfully run), exit 1 — instead of the not-implemented notice.
Update `LLM.txt` / any command surface docs to describe `council continue` and `--force`.

### Acceptance Criteria
- [ ] `council continue <council> [-c <path>] [--force]` parses and delegates to `continueCouncil`; the `notImplemented("continue")` stub is gone. (`C1`)
- [ ] `council run <council> [--force]` parses `--force` and delegates to `runCouncil`. (`E6`)
- [ ] A thrown `StateError`/`ConfigError`/`SessionError` from `continue` is logged as `council.error { code }` and sets exit 1 via the existing top-level handler. (`C9`)
- [ ] `.gitignore` ignores `council/**/.council.lock` and `council/**/.*.tmp`; `state.json` is **not** ignored. (Q6)
- [ ] `cli-program.test.ts` TP-19 asserts the new `continue` behavior (logs `council.continue`, fails `STATE_ERROR`, exits 1) and the suite is green. (`C1`, `C8`)
- [ ] `LLM.txt`/surface docs mention `council continue` + `--force`.

### Test Coverage
- Update `src/cli-program.test.ts` — **TP-25**: in-process `main([... "continue", "smoke"], { logger,
  baseDir })` → exit 1, `council.continue` + `council.continue.failed { code: "STATE_ERROR" }` +
  `council.error { code: "STATE_ERROR" }` logged; `main([... "continue", "../escape"], …)` →
  `ConfigError` exit 1 (traversal guard, `E8`); assert `--force` is accepted (parses without error).
- Full suite (`./harness test`) green after the TP-19 rewrite (research R6).

---

## Task TASK-09: Verification gate (coverage ≥80%, harness green)

- **Status:** Planned
- **Complexity:** Low
- **Dependencies:** TASK-01…TASK-08
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0009

### Description
Final gate. Run `./harness lint`, `./harness build`, `./harness test`, and `./harness verify` (the
first-choice operating surface). Because `./harness test` runs vitest **without** coverage, run
`npm run test:coverage` to enforce the ≥80% lines/functions/branches/statements thresholds
(`vitest.config.ts`, with `src/cli.ts` excluded; all new modules **included**). Fix any gaps by
adding targeted tests (not by lowering thresholds). Confirm no `console.log`, `.js` import
specifiers throughout, and that `src/index.ts` exports `StateError`, `CouncilStateStore`,
`CouncilLock`/`councilConfigHash`, `runCouncil`, and `continueCouncil`.

### Acceptance Criteria
- [ ] `./harness verify` (lint + test + build) is green. (`T9`)
- [ ] `npm run test:coverage` passes the ≥80% gate on all four metrics with new modules included. (`T9`)
- [ ] `src/index.ts` exports `StateError`, `CouncilStateStore`, `CouncilLock`, `councilConfigHash`, `runCouncil`, `continueCouncil`. (`C3`)
- [ ] No `console.log`; all intra-project imports use `.js` specifiers; `tsc --noEmit` clean. (`C8`)

### Test Coverage
- **TP-26** — coverage report shows new modules ≥80%; this task adds no new behavior, only the
  green gate (run `npm run test:coverage`). Any uncovered branch is closed with a targeted test in
  the owning `*.test.ts`.

---

## Dependency order (summary)

```
TASK-01 (StateError) ─┐
TASK-02 (atomicWrite) ┼─> TASK-03 (StateStore) ─┬─> TASK-05 (resume/checkpoint) ─┐
                      └─> TASK-04 (Lock+hash) ──┘                                 │
                                  TASK-03+04+05 ──> TASK-06 (runCouncil+producer) ┤
                                                    TASK-06 ──> TASK-07 (continue)┼─> TASK-08 (CLI) ─> TASK-09 (gate)
```

## Acceptance-Criteria coverage (summary)

All 26 issue criteria (9 Core / 8 Edge / 9 Testing) map to ≥1 task and ≥1 test. Full traceability:
this document (AC→task, via the `(Cx/Ex/Tx)` tags) and `03-test-plan.md` (AC→test, via the per-test
**Validates** lines).
