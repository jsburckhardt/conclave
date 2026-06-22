# Test Plan: Issue #3 — `council continue` resume

Source: `project/issues/3/plan/01-action-plan.md`, `project/issues/3/plan/02-task-breakdown.md`.

## Conventions (apply to every test below)

- Tests are **co-located** as `*.test.ts` next to the code they cover (CORE-COMPONENT-0009),
  organized with `describe`/`it`.
- Intra-project imports use **`.js`** specifiers (e.g. `import { CouncilStateStore } from "./council-state-store.js"`).
- Tests run under the **`node`** vitest environment (`vitest.config.ts`).
- Filesystem tests use an **isolated real temp dir** — `dir = await mkdtemp(join(tmpdir(), "<prefix>-"))`
  — cleaned up with `rm(dir, { recursive: true, force: true })` in `afterEach`; **no test touches the
  real cwd** (mirrors `cli-program.test.ts` / `council-runtime.test.ts`).
- **No real SDK calls:** session behavior is driven by a **fake `SessionFactory`**; `continueCouncil`
  and `runCouncil` accept an injectable `sessionFactory` so `CopilotSessionFactory` is never
  constructed in tests.
- **Coverage:** `./harness test` runs vitest **without** coverage, so the **≥80%** gate
  (lines/functions/branches/statements; `src/cli.ts` excluded, all new modules included) is enforced
  via **`npm run test:coverage`** (TP-26). `./harness verify` is the lint+test+build signal.

### Shared fixtures

**`councilConfig(overrides?)`** — a valid 2-member council whose `role` strings resolve cleanly
(`proj` → context heuristic; `scrum` → backlog heuristic; distinct → resolves):

```ts
{
  name: "demo",                                  // == slug "demo" (identity invariant)
  goal: "Produce a backlog for Project X",
  members: [
    { id: "proj",  cwd: ".", role: "Source of truth for the target project", tools: "read-only" },
    { id: "scrum", cwd: ".", role: "Scrum SME and backlog author",          tools: "read-only" },
  ],
  orchestrator: { cwd: ".", policy: { maxRounds: 1, requireProjectValidation: true, writeArtifacts: true } },
  artifacts: ["artifacts/backlog.md", "artifacts/epics.md"],
}
```

**`recordingFactory(script?)`** — the scripting/throwing fake `SessionFactory` (records
`createSession` args + every `(memberId, prompt)`), upgraded from `council-runtime.test.ts`'s
`fakeFactory`:

```ts
function recordingFactory(script?: (memberId: string, prompt: string, i: number) => string) {
  const created: { councilId: string; memberId: string }[] = [];
  const calls: { memberId: string; prompt: string }[] = [];
  const stop = vi.fn(async () => {});
  const factory: SessionFactory = {
    start: vi.fn(async () => {}),
    createSession: async (member, councilId) => {
      created.push({ councilId, memberId: member.id });           // for stable-id assertions (TP-14)
      return { sendAndWait: async (prompt: string) => {
        const i = calls.length; calls.push({ memberId: member.id, prompt });
        return (script ?? defaultScript)(member.id, prompt, i);   // may return "", "   ", or throw
      } };
    },
    stop,
  };
  return { factory, created, calls, stop };
}
```

**`validState(overrides?)`** — a baseline `CouncilState` (`schemaVersion: 1`, `councilId: "demo"`,
`status: "in-progress"`, `lastPhase: "draft"`, `lastRound: 0`, `members: [{id:"proj",
sessionId:"demo/proj"}, {id:"scrum", sessionId:"demo/scrum"}]`, `configHash`, timestamps,
`products: { backlog: "# Backlog\n- S1" }`).

**`seedCouncil(baseDir, { yaml?, state? })`** — writes `council/demo/council.yaml` (via the
`councilConfig` YAML or an override) and, when given, `council/demo/state.json` (`JSON.stringify`),
so `continueCouncil({ council: "demo", baseDir })` resolves against a real on-disk council.

---

## Test TP-01: `StateError` shape and export

- **Type:** Unit
- **Task:** TASK-01
- **Priority:** High

### Setup
Extend `src/errors.test.ts`; `import { StateError, CouncilError } from "./errors.js"` and from the
package root for the export check.

### Steps
1. `const cause = new Error("io"); const e = new StateError("boom", { cause });`
2. Construct a second `StateError` without options.

### Expected Result
`e.code === "STATE_ERROR"`, `e.name === "StateError"`, `e instanceof CouncilError`, `e.cause === cause`;
the no-options instance has `cause === undefined`. `StateError` is importable from `conclave`/`src/index.ts`.
**Validates:** C9.

---

## Test TP-02: shared `atomicWriteFile` behavior + no orphan temp

- **Type:** Unit
- **Task:** TASK-02
- **Priority:** High

### Setup
New `src/store/atomic-write.test.ts`; `dir = mkdtemp(...)`.

### Steps
1. `await atomicWriteFile(join(dir, "f.json"), "hello")`; read it back; list `dir`.
2. Overwrite the same path with `"world"`; read back.
3. Force failure: call with a target whose parent does not exist (or stub `rename` to throw); catch.

### Expected Result
(1) file contains `"hello"` and **no** `.*.tmp` remains in `dir`; (2) file now contains `"world"`
(replaced in place); (3) the original error propagates and no temp file is orphaned. The existing
`add-member` suite still passes (regression).
**Validates:** C4.

---

## Test TP-03: `CouncilStateStore.write` is atomic, `mkdir -p`, round-trips

- **Type:** Unit
- **Task:** TASK-03
- **Priority:** High

### Setup
New `src/store/council-state-store.test.ts`; `dir = mkdtemp(...)`; path
`join(dir, "council", "demo", "state.json")` (parent dirs absent on purpose).

### Steps
1. `const store = new CouncilStateStore(path); await store.write(validState());`
2. `const back = await store.read();`
3. Inspect the directory listing during/after write.

### Expected Result
The nested parent dir is created (`mkdir -p`); the file is written via a temp file + `rename` (no
`.*.tmp` left); `back` deep-equals the written `CouncilState` (including `products`). `exists()`
returns `true`.
**Validates:** C3, C4, T6.

---

## Test TP-04: missing `state.json` → typed "no prior run" error

- **Type:** Unit
- **Task:** TASK-03
- **Priority:** High

### Setup
`store = new CouncilStateStore(join(dir, "council", "demo", "state.json"))` with **no** file written.

### Steps
1. `await expect(store.read()).rejects`.

### Expected Result
Rejects with `StateError` (`code === "STATE_ERROR"`) whose message is actionable and names the
remedy (e.g. contains "run `council run`"). No empty/fresh state is returned.
**Validates:** E1, T3.

---

## Test TP-05: corrupt / partial `state.json` → typed error

- **Type:** Unit
- **Task:** TASK-03
- **Priority:** High

### Setup
Write raw bytes to the state path: (a) `"{ not json"`; (b) valid JSON missing required fields
(e.g. `{"schemaVersion":1}`); (c) valid JSON with `lastRound: -1` / wrong-typed `members`.

### Steps
1. For each corrupt variant, `await expect(store.read()).rejects`.

### Expected Result
Every variant rejects with `StateError`; **never** returns an empty/fresh state (research R4). The
message identifies the file as corrupt.
**Validates:** E2, T4.

---

## Test TP-06: unknown / newer `schemaVersion` → typed error

- **Type:** Unit
- **Task:** TASK-03
- **Priority:** High

### Setup
Write otherwise-valid states with `schemaVersion` ∈ `{0, 2, "1", undefined}`.

### Steps
1. For each, `await expect(store.read()).rejects`.

### Expected Result
Each rejects with `StateError` (unsupported/newer schema); no best-effort parse. A state with
`schemaVersion === 1` does **not** reject on this check.
**Validates:** E3, T5.

---

## Test TP-07: valid `state.json` → typed `CouncilState`

- **Type:** Unit
- **Task:** TASK-03
- **Priority:** Medium

### Setup
Write `validState()` to the path.

### Steps
1. `const s = await store.read();`

### Expected Result
`s.schemaVersion === 1`, `s.councilId === "demo"`, `s.status === "in-progress"`, `s.lastPhase ===
"draft"`, `s.lastRound === 0`, `s.members` and `s.products` intact.
**Validates:** C2, C3.

---

## Test TP-08: `CouncilLock` acquire / conflict / `--force` / release

- **Type:** Unit
- **Task:** TASK-04
- **Priority:** High

### Setup
New `src/store/council-lock.test.ts`; `lockPath = join(dir, "council", "demo", ".council.lock")`
(parent created by the test or by `acquire`).

### Steps
1. `const a = new CouncilLock(lockPath); await a.acquire();` — assert file exists with JSON `{pid, hostname, startedAt}`.
2. `const b = new CouncilLock(lockPath); await expect(b.acquire()).rejects` (lock held).
3. `await b.acquire(true)` (`--force`).
4. `await a.release()`; `await a.release()` again (idempotent); assert file gone.

### Expected Result
(1) succeeds; (2) rejects with `StateError`; (3) `--force` clears the stale lock and succeeds;
(4) `release` removes the file and a second `release` is a safe no-op.
**Validates:** E6, T8.

---

## Test TP-09: `councilConfigHash` is deterministic and change-sensitive

- **Type:** Unit
- **Task:** TASK-04
- **Priority:** Medium

### Steps
1. `councilConfigHash("a: 1")` twice → equal.
2. `councilConfigHash("a: 1") !== councilConfigHash("a: 2")`.

### Expected Result
Stable hex digest for identical input; different digest when bytes change. Uses only `node:crypto`.
**Validates:** E4.

---

## Test TP-10: `runBacklogCouncil` checkpoints after each phase/round

- **Type:** Unit
- **Task:** TASK-05
- **Priority:** High

### Setup
Extend `src/runtime/council-phases.test.ts`. Real `CouncilRuntime` + `recordingFactory()` + real
`TranscriptStore`/`ArtifactStore` (temp dir). `const cps: PhaseCheckpoint[] = []; checkpoint = async
(cp) => { cps.push(structuredClone(cp)); };` Policy `maxRounds: 1, requireProjectValidation: true`.

### Steps
1. `await runBacklogCouncil(runtime, councilConfig(), { artifacts, logger, checkpoint });`

### Expected Result
`cps` records, in order, checkpoints for `context` (products.summary), `draft` (products.backlog),
`validation` (products.backlog+validation), `refinement` (products.backlog, validation cleared), and
`artifacts` — each with the correct `lastPhase`/`lastRound`. With **no** `checkpoint`, the function
behaves identically to today (regression).
**Validates:** C6, T6.

---

## Test TP-11: resume from `lastPhase: "draft"` skips context + draft

- **Type:** Unit
- **Task:** TASK-05
- **Priority:** High

### Setup
`recordingFactory()`; `resume = { lastPhase: "draft", lastRound: 0, products: { backlog: "# Backlog\n- S1" } }`.

### Steps
1. `await runBacklogCouncil(runtime, councilConfig(), { artifacts, logger, resume, checkpoint });`
2. Inspect `recordingFactory().calls`.

### Expected Result
The first recorded ask is the **validation** (or refinement) prompt — **no** context or draft prompt
is asked (provably skipped); the rounds loop is seeded from `products.backlog`; the run completes and
checkpoints continue from `refinement`/`artifacts`.
**Validates:** C6, T1.

---

## Test TP-12: resume from `lastPhase: "context"` runs draft onward

- **Type:** Unit
- **Task:** TASK-05
- **Priority:** Medium

### Setup
`resume = { lastPhase: "context", lastRound: 0, products: { summary: "PROJECT SUMMARY" } }`.

### Steps
1. Run with `resume`; inspect `calls`.

### Expected Result
No context prompt is asked; the first ask is the **draft** prompt, and it embeds the seeded
`summary` (`draftPrompt(summary)`); the run proceeds normally.
**Validates:** C6, T1.

---

## Test TP-13: resume from `lastPhase: "validation"` resumes mid-round at refinement

- **Type:** Unit
- **Task:** TASK-05
- **Priority:** High

### Setup
`maxRounds: 1`; `resume = { lastPhase: "validation", lastRound: 0, products: { backlog: "# B",
validation: "VALIDATION FEEDBACK" } }`.

### Steps
1. Run with `resume`; inspect `calls`.

### Expected Result
The round's **validation is not re-asked**; the first ask is the **refinement** prompt and embeds the
seeded `validation` (`refinementPrompt(backlog, validation)`); the round completes and the flow moves
to artifacts.
**Validates:** C6, T1.

---

## Test TP-14: resume reuses exact stable `${councilId}/${memberId}` ids (fake factory)

- **Type:** Unit
- **Task:** TASK-07
- **Priority:** High

### Setup
New `src/commands/continue.test.ts`. `seedCouncil(baseDir, { state: validState() })`;
`const rec = recordingFactory();`

### Steps
1. `await continueCouncil({ council: "demo", baseDir, logger, sessionFactory: rec.factory });`
2. Inspect `rec.created` and the stored `state.members`.

### Expected Result
`createSession` was called for **both** members with `councilId === "demo"`; the derived ids
`"demo/proj"` / `"demo/scrum"` equal the stored `state.members[*].sessionId`. **No** real SDK is
constructed.
**Validates:** C5, T2.

---

## Test TP-15: missing `state.json` → typed "no prior run" error (command)

- **Type:** Unit
- **Task:** TASK-07
- **Priority:** High

### Setup
`seedCouncil(baseDir, {})` (council.yaml only, no state.json).

### Steps
1. `await expect(continueCouncil({ council: "demo", baseDir, logger, sessionFactory: rec.factory })).rejects`.

### Expected Result
Rejects with `StateError` (actionable "run `council run demo` first"); a `council.continue.failed
{ code: "STATE_ERROR" }` record is logged; no lock file is created; no sessions started.
**Validates:** E1, T3, C8, C9.

---

## Test TP-16: corrupt + newer `schemaVersion` `state.json` → typed error (command)

- **Type:** Unit
- **Task:** TASK-07
- **Priority:** High

### Setup
Two cases: (a) `state.json` = `"{ broken"`; (b) `state.json` with `schemaVersion: 2`.

### Steps
1. For each, `await expect(continueCouncil({ council: "demo", baseDir, logger, sessionFactory: rec.factory })).rejects`.

### Expected Result
Both reject with `StateError`; persisted file is never treated as empty; no fresh run is started.
**Validates:** E2, E3, T4, T5.

---

## Test TP-17: member-set drift aborts without `--force`, allowed with `--force`

- **Type:** Unit
- **Task:** TASK-07
- **Priority:** High

### Setup
Seed `state.json` (members `proj`,`scrum`) but a `council.yaml` whose members are `proj`,`po` (set
changed). `rec = recordingFactory()`.

### Steps
1. `await expect(continueCouncil({ council: "demo", baseDir, logger, sessionFactory: rec.factory })).rejects` (no force).
2. `await continueCouncil({ council: "demo", force: true, baseDir, logger, sessionFactory: rec.factory })`.

### Expected Result
(1) rejects with `ConfigError` naming the member-set change (no sessions started); (2) with
`--force` proceeds, logging `config.drift { kind: "member-set" }`, and runs to completion.
**Validates:** E4, T7.

---

## Test TP-18: non-structural drift warns and continues

- **Type:** Unit
- **Task:** TASK-07
- **Priority:** Medium

### Setup
Seed `state.json` with a `configHash` that differs from the current `council.yaml` hash, but the
**member-id set is identical** (e.g. only a `role` wording changed).

### Steps
1. `await continueCouncil({ council: "demo", baseDir, logger, sessionFactory: rec.factory });`

### Expected Result
Completes without `--force`; a `config.drift { kind: "non-structural" }` warning is logged; the run
proceeds.
**Validates:** E4.

---

## Test TP-19: resuming a `completed` council is an idempotent no-op

- **Type:** Unit
- **Task:** TASK-07
- **Priority:** High

### Setup
Seed `state.json` with `status: "completed"`. `rec = recordingFactory()`.

### Steps
1. `await continueCouncil({ council: "demo", baseDir, logger, sessionFactory: rec.factory });`

### Expected Result
Returns successfully (no throw); logs `council.continue.completed`; **no** lock is acquired and
**no** session is started (`rec.created` empty, `rec.factory.start` not called); `state.json`
unchanged.
**Validates:** E7.

---

## Test TP-20: SDK session-resume failure → `SessionError`, state preserved

- **Type:** Unit
- **Task:** TASK-07
- **Priority:** High

### Setup
Seed a valid in-progress `state.json`. Provide a fake factory whose `start()` (or `createSession`)
**throws** a `SessionError` (simulating SDK resume failure). Snapshot `state.json` bytes before.

### Steps
1. `await expect(continueCouncil({ council: "demo", baseDir, logger, sessionFactory: failing })).rejects`.
2. Re-read `state.json`.

### Expected Result
Rejects with `SessionError` (`code: "SESSION_ERROR"`); `state.json` bytes are **unchanged**
(persisted state preserved → retryable); the lock is released (no leftover `.council.lock`).
**Validates:** E5, C7.

---

## Test TP-21: concurrency guard rejects a second invocation; `--force` clears stale lock

- **Type:** Unit
- **Task:** TASK-07
- **Priority:** High

### Setup
Seed a valid in-progress `state.json`. Pre-create the `.council.lock` file (simulating an in-flight
run/continue). `rec = recordingFactory()`.

### Steps
1. `await expect(continueCouncil({ council: "demo", baseDir, logger, sessionFactory: rec.factory })).rejects`.
2. `await continueCouncil({ council: "demo", force: true, baseDir, logger, sessionFactory: rec.factory })`.

### Expected Result
(1) rejects with `StateError` (lock conflict; no sessions started); (2) with `--force` the stale
lock is cleared (`lock.forced` logged) and the resume runs to completion, releasing the lock.
**Validates:** E6, T8.

---

## Test TP-22: council-identity mismatch (`config.name != slug`) → `ConfigError`

- **Type:** Unit
- **Task:** TASK-07
- **Priority:** Medium

### Setup
`seedCouncil(baseDir, { yaml: councilConfig({ name: "other" }) })` at `council/demo/council.yaml`
(YAML `name` is `other`, but the directory/slug is `demo`).

### Steps
1. `await expect(continueCouncil({ council: "demo", baseDir, logger, sessionFactory: rec.factory })).rejects`.

### Expected Result
Rejects with `ConfigError` naming the mismatch between `config.name` and the requested council; no
state read proceeds to a resume.
**Validates:** E8 (identity), C9.

---

## Test TP-23: resume continues from `lastPhase`/`lastRound` and re-persists atomically

- **Type:** Unit
- **Task:** TASK-07
- **Priority:** High

### Setup
Seed `state.json` = `{ status: "in-progress", lastPhase: "draft", lastRound: 0, products: { backlog:
"# Backlog\n- S1" } }`. `rec = recordingFactory()` (default non-blank script).

### Steps
1. `await continueCouncil({ council: "demo", baseDir, logger, sessionFactory: rec.factory });`
2. Inspect `rec.calls`, the final `state.json`, and the artifacts dir.

### Expected Result
Context + draft are **not** re-asked (first ask is validation/refinement); intermediate writes
update `state.json` `lastPhase`/`lastRound`/`updatedAt` (monotonic) with no `.*.tmp` orphan; the
final `state.json` has `status: "completed"`; artifacts (`backlog.md`, …) are written; `state.write`
records are logged.
**Validates:** C6, C7, T1, T6.

---

## Test TP-24: `run` producer writes initial → checkpoint → terminal state

- **Type:** Unit
- **Task:** TASK-06
- **Priority:** High

### Setup
New `src/commands/run.test.ts`. `seedCouncil(baseDir, { yaml: councilConfig() })` (no state.json yet).
`rec = recordingFactory()` (default non-blank script). Capture `state.write` log records.

### Steps
1. `await runCouncil({ council: "demo", baseDir, logger, sessionFactory: rec.factory });`
2. Read `council/demo/state.json`; inspect the captured write sequence and the lock file lifecycle.
3. Separately, run with a `council.yaml` whose `name !== "demo"`.

### Expected Result
An initial `in-progress`/`lastPhase: null` state is written before `start()`, then per-phase
checkpoints, then a terminal `completed` state; every write is atomic (no `.*.tmp` left). The
`.council.lock` is created during the run and removed at the end. The `name !== slug` case rejects
with `ConfigError` before any session starts.
**Validates:** C6, E8, T6.

---

## Test TP-25: CLI `continue` action wiring + TP-19 rewrite

- **Type:** Integration (in-process CLI)
- **Task:** TASK-08
- **Priority:** High

### Setup
Update `src/cli-program.test.ts`. Use `main([...], { logger, baseDir })` with a capturing logger and
a temp `baseDir`; `process.exitCode` reset per case. (`init` scaffolds the single-member `smoke`
council, which was never successfully run → no `state.json`.)

### Steps
1. `await main(["node","council","continue","smoke"], { logger, baseDir })`.
2. `await main(["node","council","continue","../escape"], { logger, baseDir })`.
3. `await main(["node","council","continue","smoke","--force"], { logger, baseDir })` (flag parse).
4. Rewrite the old TP-19 `continue` assertion accordingly.

### Expected Result
(1) exits 1; logs `council.continue`, `council.continue.failed { code: "STATE_ERROR" }`, and
`council.error { code: "STATE_ERROR" }`; **not** the old not-implemented notice. (2) exits 1 with a
`ConfigError` (traversal guard). (3) `--force` parses without a Commander error. The full
`cli-program.test.ts` suite is green.
**Validates:** C1, C8, C9, E8.

---

## Test TP-26: coverage gate ≥80% and harness green

- **Type:** Verification gate
- **Task:** TASK-09
- **Priority:** High

### Setup
All TASK-01…TASK-08 tests merged.

### Steps
1. `./harness lint` and `./harness build`.
2. `./harness test` (fast vitest, no coverage) → green.
3. `npm run test:coverage` (enforces thresholds; `./harness test` does **not** include coverage).
4. `./harness verify` (lint + test + build).

### Expected Result
Lint/build/test pass; `npm run test:coverage` reports **≥80%** lines/functions/branches/statements
with all new modules (`council-state-store.ts`, `council-lock.ts`, `atomic-write.ts`,
`council-phases.ts` resume paths, `commands/run.ts`, `commands/continue.ts`) included and `src/cli.ts`
excluded; `./harness verify` is green. `src/index.ts` exports `StateError`, `CouncilStateStore`,
`CouncilLock`, `councilConfigHash`, `runCouncil`, `continueCouncil`.
**Validates:** T9.

---

## Coverage matrix (issue Testing AC → tests)

| Issue Testing criterion | Tests |
|---|---|
| Resume continues from correct `lastPhase`/`lastRound` | TP-11, TP-12, TP-13, TP-23 |
| Resume reuses exact stable ids (fake `SessionFactory`) | TP-14 |
| Missing `state.json` → typed "no prior run" | TP-04, TP-15 |
| Corrupt/partial `state.json` → typed error (not empty) | TP-05, TP-16 |
| Unknown/newer `schemaVersion` → typed error | TP-06, TP-16 |
| State re-persisted after progress, atomic | TP-03, TP-10, TP-23, TP-24 |
| Member-set drift aborts without `--force`, allowed with `--force` | TP-17 |
| Concurrent-continue guard rejects second invocation | TP-08, TP-21 |
| Co-located `*.test.ts`, real temp dirs, ≥80% coverage | all + TP-26 |

## Edge-case matrix (issue Edge AC → tests)

| Edge criterion | Tests |
|---|---|
| E1 missing state | TP-04, TP-15 |
| E2 corrupt/partial state | TP-05, TP-16 |
| E3 unknown/newer schema | TP-06, TP-16 |
| E4 member-set vs non-structural drift | TP-17, TP-18, TP-09 |
| E5 SDK resume failure, state preserved | TP-20 |
| E6 concurrency guard + stale-lock escape | TP-08, TP-21 |
| E7 already-completed no-op | TP-19 |
| E8 traversal / identity validation | TP-22, TP-24, TP-25 |
