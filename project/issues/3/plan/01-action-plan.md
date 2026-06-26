# Action Plan: feat(cli) — implement `council continue` to resume a persisted council

## Feature
- **ID:** 3
- **Title:** feat(cli): implement `council continue` to resume a persisted council
- **Branch:** `feat/3-council-continue` (worktree at `.trees/issue-3`)
- **Research Brief:** `project/issues/3/research/00-research.md`
- **Scope Type:** `issue` (composes already-merged seams into a new CLI verb; **no new ADR, no new core-component**)

## Summary

`council continue <council>` is a stub: `src/cli-program.ts` (lines 148–155) logs `council.continue`
then calls `notImplemented("continue")` (stderr notice + `process.exitCode = 1`). This issue
replaces that stub with a real resume that:

1. Defines a durable **`state.json`** contract written by a new, decoupled **`CouncilStateStore`**
   (`src/store/council-state-store.ts`), read/written atomically (temp file + `rename`, `mkdir -p`).
2. Makes **`council run` emit/checkpoint that state** (the producer hook — **in scope**, Q1) so the
   feature is end-to-end functional, not inert against fixtures only.
3. Implements **resume**: load state, recreate the identical stable `"<councilId>/<memberId>"`
   sessions via the existing `CouncilRuntime.start()`/`SessionFactory.createSession` path, and
   continue the fixed phase/round flow from the persisted `lastPhase`/`lastRound`, re-checkpointing
   after each step.
4. Adds a typed **`StateError`** (`STATE_ERROR`) for missing/corrupt/incompatible state and lock
   conflicts, a **concurrency lock** (`.council.lock`), and **config-drift** detection.

All logic lives in **covered, SDK-decoupled, testable command functions** (`continueCouncil`,
`runCouncil`) that the thin commander actions delegate to — mirroring the `addMember` precedent —
so everything is unit-testable in-process with a **fake `SessionFactory` + real temp dirs**.

> **Note on the AC wording "implemented in `src/cli.ts`":** `src/cli.ts` is a 4-line bin entry
> (`void main(process.argv)`) that `vitest.config.ts` **excludes from coverage**. All command
> wiring lives in `src/cli-program.ts`. To be covered and unit-testable in-process (research R6),
> the `continue` action lands in `src/cli-program.ts`, delegating to `continueCouncil` in
> `src/commands/continue.ts`. This satisfies the AC's intent (the stub is removed; `continue` works).

## Non-goals (out of scope, per the issue)

- **Redefining the phase sequence / round semantics** — owned by `council run`; `continue` reuses
  the same `runBacklogCouncil` orchestrator and only adds a resume start point + checkpoint hook.
- The MCP "council bus", orchestrator-as-session, streaming UI, dynamic phases (ADR-0002 deferrals).
- **Any new runtime dependency** — the state store, `configHash`, and lock use only Node built-ins
  (`node:fs/promises`, `node:crypto`, `node:os`); no package is added.
- A schema-migration framework — v0 supports exactly `schemaVersion: 1`; anything else is a typed
  error (no best-effort upcasting).

## Architecture conclusion (explicit)

**No new ADR. No new core-component. Three existing core-components were UPDATED by the planner**
(agreeing with the research brief; mirroring how issue #5 governed `OrchestrationError`):

| Artifact | Change | Why | DECISION-LOG rows |
|---|---|---|---|
| **CORE-COMPONENT-0008** (Error Handling) | Registered `StateError` / `STATE_ERROR` in Rules + Interfaces; documented the `continue` error mapping (State/Config/Session). | **Required by the AC.** Extends the typed-error hierarchy (decision #12). Precedent: `OrchestrationError` (#17–#18). | #30, #31 |
| **CORE-COMPONENT-0006** (Artifact & Transcript Store) | Documented the run-state store (`CouncilStateStore`/`state.json`), the atomic write, schema validation on read, the `state.json`-is-authoritative rule, and the concurrency lock. | `state.json` becomes a durable on-disk contract joining transcript+artifacts. | #32, #33, #34, #35 |
| **CORE-COMPONENT-0004** (Session Lifecycle & Persistence) | Documented the resume contract: re-invoke `runBacklogCouncil` with persisted state, recreate stable-id sessions, continue from `lastPhase`/`lastRound`, idempotent-completed, failed-SDK-resume preserves state. | The resume model is a durable cross-run contract; CC-0004 governs `src/runtime/`. CC-0004 line 42 already anticipated `council continue`. | #36, #37, #38 |

**No ADR is required.** ADR-0002 already ratifies the runtime topology (Model A, one SDK session
per member behind a `SessionFactory` seam, SDK-decoupling, ESM/NodeNext/commander/vitest), lists
`council init|add-member|run|continue` as the CLI surface (ADR-0002 line 14), and explicitly defers
"the orchestration phases … to subsequent issues." `continue` is a **consumer** of those decisions;
it introduces no new technology or topology. **No genuinely new architectural decision was found.**

> All architecture edits are global artifacts under `project/architecture/`; none live inside the
> issue folder. The templates were not edited. `DECISION-LOG.md` was updated for every changed
> core-component (date bump to 2026-06-22 + decision rows #30–#38). These doc/log updates were made
> **by the planner now**; the implementer tasks implement the code to match (issue #5 pattern).

## ADRs Created

**None.** No new architectural decision was discovered; ADR-0002 already governs the runtime
topology, the no-new-deps constraint, and the `council continue` CLI verb. No existing ADR required
edits.

## Core-Components Created

**None.** No new cross-cutting behavior was introduced. Three **existing** core-components were
**amended** by the planner (see the table above and DECISION-LOG rows #30–#38): CORE-COMPONENT-0008
(registered `StateError`), CORE-COMPONENT-0006 (`CouncilStateStore`/`state.json` + `.council.lock`),
and CORE-COMPONENT-0004 (the resume contract).

---

## Open-Question resolutions (Q1–Q7)

### Q1 — Producer scope: **INCLUDE the minimal `council run` producer hook (option (a)).**

`council run` is changed to **emit and checkpoint `state.json`** so #3 is end-to-end functional.
Without a producer, `continue` is fully buildable/testable against fixtures but always hits the
"missing `state.json` → typed error" path in real use (research R1, highest impact). Concretely:

- On a real run start (after fail-fast policy/role checks pass and the lock is acquired), write the
  **initial** state: `status: "in-progress"`, `lastPhase: null`, `lastRound: 0`, the member session
  registry, `configHash`, `createdAt`/`updatedAt`, empty `products`.
- After **each completed phase/round**, `runBacklogCouncil` invokes an injected `checkpoint`
  callback that re-persists `state.json` (updated `lastPhase`/`lastRound`/`products`/`updatedAt`).
- On success, write the **terminal** state: `status: "completed"`.

**Feasibility/justification.** This requires a bounded, backward-compatible refactor of
`runBacklogCouncil` (add optional `resume` + `checkpoint`; when both are absent, behavior is
byte-identical to today, so existing `council-phases.test.ts` and the TP-19 fail-fast path still
pass) and extracting the `run` body into a testable `runCouncil(options)` so the producer hook is
unit-testable with a **fake `SessionFactory`** (the inline `new CopilotSessionFactory()` cannot be
unit-tested). Both `run` and `continue` then share the identity/path/lock/state wiring (DRY).

### Q2 — Resume granularity: **phase/round-boundary resume with a durable `products` checkpoint.**

Resume is **fine across phases, coarse within a phase**: a single `askMember` call is the atomic
unit — it either completed and was checkpointed, or it re-runs. We persist the minimal intermediate
work products (`summary`, `backlog`, `validation`) inside `state.json.products` so resume
reconstructs the flow **without re-running completed phases**. State is re-persisted **after every
completed phase/round** (satisfies the AC verbatim). This addresses research R2 (the monolithic
`runBacklogCouncil` keeps `summary`/`working` in memory only) with the smallest correct change.

**`lastPhase`/`lastRound` semantics against the fixed sequence**
`context → draft → [validation? → refinement] × maxRounds → [artifacts?]`:

| `lastPhase` | `lastRound` | Meaning (completed) | `products` carried | Resume continues at |
|---|---|---|---|---|
| `null` | 0 | run started, context not finished | — | `context` |
| `context` | 0 | context summary done | `summary` | `draft` |
| `draft` | 0 | initial backlog done | `backlog` | rounds loop, round index 0 |
| `validation` | `k`-1 | round `k` validation done, refinement pending | `backlog`, `validation` | round `k` **refinement** (skip its validation) |
| `refinement` | `k` | `k` rounds fully complete | `backlog` | round index `k` (or `artifacts` if `k == maxRounds`) |
| `artifacts` | `maxRounds` | artifacts written | `backlog` | nothing → mark `completed` |

`lastRound` = number of **fully completed** refinement rounds. Re-running a partially-completed
round re-asks `validation` (idempotent; the transcript append-only block is acceptable per CC-0006).
Roles are **re-derived** from config via `resolveRoles` (pure) — never persisted.

### Q3 — `state.json` home & identity: **slug-canonical path; enforce `config.name === <slug> === state.councilId`.**

This resolves the **R3 path-resolution divergence** (`add-member` keys on the CLI slug via
`resolveCouncilConfigPath`; `run` keys on YAML `config.name`):

- **Canonical home:** `state.json` lives at `council/<slug>/state.json`, where the council dir is
  `dirname(resolveCouncilConfigPath(<council>, baseDir))` — the **single source of truth** for a
  council's on-disk location (CORE-COMPONENT-0003, decision #26), traversal-guarded + slug-validated.
- **Identity invariant:** both `run` and `continue` assert **`config.name === <council slug>`**
  (the positional arg) and, on resume, **`state.councilId === config.name`**; any mismatch raises a
  `ConfigError` with an actionable message. This permanently closes R3 — the slug, the YAML name,
  and the persisted `councilId` are forced to coincide, so sessions/artifacts (keyed on
  `config.name`) and `state.json` (resolved from the slug) can never address different councils.
- **Session ids on resume** use `state.councilId` (== `config.name`); stored `sessionId` strings are
  only a **cross-check** (re-derived `"<councilId>/<memberId>"` must equal the stored value), never
  trusted blindly (research R4).
- **`run` is aligned to `resolveCouncilConfigPath`** for the council dir; given the invariant,
  `council/<config.name>` ≡ `council/<slug>`, so artifact/transcript paths are unchanged.

### Q4 — Concurrency mechanism: **a separate exclusive lock file `.council.lock`, `--force` escape hatch.**

A dedicated lock file `council/<slug>/.council.lock`, **not** an overloaded `state.json` status
field (`status` is run-lifecycle metadata `in-progress`/`completed`; a lock is a distinct liveness
mutex — research R5):

- **Acquire** via an atomic exclusive create (`writeFile(path, info, { flag: "wx" })`); `EEXIST`
  → another `run`/`continue` holds it → `StateError` ("another run/continue is in progress … if no
  process is running, re-run with `--force`"). TOCTOU-safe (mirrors `init`'s exclusive `mkdir`).
- The lock file holds `{ pid, hostname, startedAt }` for diagnostics.
- **Release** by unlinking in a `finally` on **every** exit path (success or failure).
- **Stale-lock escape hatch:** `--force` deletes a pre-existing lock and proceeds (logged
  `lock.forced`). A crashed process leaves a stale lock that `--force` clears.
- **`--force` scope (single flag):** `--force` covers **both** (a) clearing a stale lock and
  (b) overriding **member-set drift** (Q5/below). Non-structural drift warns and continues
  regardless of `--force`. Both `run` and `continue` accept `--force` and participate in the lock
  (the AC's "concurrent continue/**run**" guard).

### Q5 — Error taxonomy: **add `StateError` (`STATE_ERROR`), single code; reuse Config/Session.**

- **`StateError` (`STATE_ERROR`)** — new `CouncilError` subclass, exported from `src/index.ts`.
  **One code** covers all run-state failure modes (missing `state.json` / "no prior run", corrupt or
  partially-written `state.json`, unknown/newer `schemaVersion`, and lock conflict); the specific
  condition + remedy live in the **message** (CC-0008 style: one code per category, message names the
  entity). Distinct codes would over-fragment the taxonomy.
- **`ConfigError`** — config/member-set drift abort (no `--force`) and council-identity mismatch
  (`config.name` ≠ slug ≠ `councilId`), plus traversal/path failures (via `resolveCouncilConfigPath`).
- **`SessionError`** — SDK session-resume failures (`runtime.start()`/`createSession`).
- **`OrchestrationError`** — reused for phase failures inside the resumed `runBacklogCouncil`.

### Q6 — `.gitignore` policy: **commit `state.json`; ignore the lock file and atomic temp files.**

- **`state.json` is committed** — durable, diffable run metadata that pairs with the already-tracked
  transcript/artifacts; it is the authoritative resume contract and is useful to review/share.
- **Ignore `council/**/.council.lock`** (ephemeral, PID/host-specific liveness; would cause spurious
  conflicts and stale locks across machines) **and `council/**/.*.tmp`** (short-lived atomic-write
  temp files a crash could orphan). These two patterns are added to `.gitignore`.

### Q7 — Resume entry-point name/shape: **`runBacklogCouncil(..., { resume })`; no `CouncilRuntime.resume()`.**

Resume is performed by **re-invoking the existing orchestrator** with a resume start point, not by a
new runtime method:

- The phase/round model lives in `runBacklogCouncil` (CC-0004), **not** in `CouncilRuntime` (which
  owns only start/ask/stop). Adding `CouncilRuntime.resume(state)` would leak phase knowledge into
  the runtime and violate the CC-0004 boundary. The research's `CouncilRuntime.resume(state)` was an
  explicit "e.g." suggestion; this is the justified Plan decision.
- `continue` calls `runtime.start()` (already recreates the stable-id sessions — resume is "free")
  then `runBacklogCouncil(runtime, config, { artifacts, logger, resume, checkpoint })`. The **command
  entry point** is `continueCouncil(options)`; the **orchestrator entry point** is the new `resume`
  option. The same orchestrator serves `run` and `continue` (guarantees the phase model is reused,
  not redefined).

---

## The `state.json` schema (ratified)

`council/<slug>/state.json`, `schemaVersion: 1` (the only supported version in v0):

```jsonc
{
  "schemaVersion": 1,                         // integer; MUST be 1, else StateError
  "councilId": "scrum-project-x",             // == config.name == <slug> (enforced)
  "status": "in-progress",                    // "in-progress" | "completed"
  "lastPhase": "draft",                       // null | "context" | "draft" | "validation" | "refinement" | "artifacts"
  "lastRound": 0,                             // integer >= 0; fully-completed refinement rounds
  "members": [                                // session registry (set + id cross-check; research R4)
    { "id": "proj",  "sessionId": "scrum-project-x/proj" },
    { "id": "scrum", "sessionId": "scrum-project-x/scrum" }
  ],
  "configHash": "<sha256-hex>",               // sha256 of council.yaml bytes at run time
  "createdAt": "2026-06-22T08:00:00.000Z",    // ISO8601; set once at run start
  "updatedAt": "2026-06-22T08:05:00.000Z",    // ISO8601; bumped on every write
  "products": {                               // durable resume checkpoint (Plan extension; research R2)
    "summary": "…",                           // present once context done (consumed by draft)
    "backlog": "…",                           // present once draft done; updated each refinement
    "validation": "…"                         // present transiently: round validation done, refinement pending
  }
}
```

- **`products` is a ratified extension** to the field set the research enumerated
  (`councilId, status, lastPhase, lastRound, members, configHash, schemaVersion, timestamps`). It is
  the minimal durable carrier that makes mid-flow resume correct (R2); it is documented as part of
  the schema and kept lean (only the values needed to resume from the current boundary).
- **`configHash`** = `createHash("sha256").update(<council.yaml bytes>).digest("hex")` (`node:crypto`;
  no new dep). Any config change flips the hash; the **member-id set** comparison (below) classifies
  structural (member-set) vs non-structural drift.
- **Read validation** (`CouncilStateStore.read`): `ENOENT` → `StateError` ("no prior run; run
  `council run <council>` first"); `JSON.parse` failure → `StateError` (corrupt); `schemaVersion`
  not the integer `1` → `StateError` (unsupported/newer); any missing/ill-typed required field →
  `StateError` (corrupt). **Never returns a fresh/empty state** (research R4).

## How `council run` emits state (producer hook)

`runCouncil(options)` (extracted from the `run` action) does, in order:
1. `loadCouncilConfig` → `logger.info("council.run", …)` → fail-fast `normalizePolicy` + `resolveRoles`
   (unchanged; keeps the TP-19 fail-fast path intact).
2. Resolve `councilDir = dirname(resolveCouncilConfigPath(council, baseDir))`; **assert
   `config.name === council`** (`ConfigError` on mismatch).
3. Build `TranscriptStore`/`ArtifactStore`/`CouncilStateStore`/`CouncilLock` from `councilDir`.
4. **Acquire the lock** (`--force` clears a stale one).
5. Write the **initial** `state.json` (`status: "in-progress"`, `lastPhase: null`, members,
   `configHash`, timestamps, empty `products`).
6. `runtime.start()` → `runBacklogCouncil(runtime, config, { artifacts, logger, checkpoint })`, where
   `checkpoint(cp)` merges `{ lastPhase, lastRound, products }` into the base state and atomically
   re-persists (`status` stays `in-progress`).
7. On success, write the **terminal** state (`status: "completed"`).
8. `finally`: guarded `runtime.stop()` (failure logged as `council.stop.error`, never masks the
   primary error) **then** `lock.release()`.

On any failure mid-run, `state.json` remains `in-progress` at the last checkpoint → **resumable**.

## Risks carried from research (mitigations → tasks)

| Risk | Mitigation (task) |
|---|---|
| **R1** no producer of `state.json` | Include the producer hook in `runCouncil` (TASK-06); end-to-end resume tested at the function level (TASK-07 tests). |
| **R2** `runBacklogCouncil` not checkpoint/resume-capable | Backward-compatible `resume` + `checkpoint` options + durable `products` (TASK-05). |
| **R3** path/identity divergence | Slug-canonical `resolveCouncilConfigPath` home + `config.name === slug === councilId` invariant (TASK-06/07). |
| **R4** "throw on corrupt, never silent empty"; trusting stored ids | `read()` always throws typed; session ids re-derived, stored ids only cross-checked (TASK-03/07). |
| **R5** concurrency guard subtle | Separate `.council.lock`, atomic `wx`, release in `finally`, `--force` escape (TASK-04/06/07). |
| **R6** existing TP-19 asserts the stub | Update `cli-program.test.ts` TP-19 to the new `continue` behavior (TASK-08). |
| **R7** `atomicWriteFile` is private to `add-member` | Extract to a shared `src/store/atomic-write.ts`; both callers reuse it (TASK-02). |

## Implementation seam (signatures)

```ts
// src/errors.ts  (TASK-01)
export class StateError extends CouncilError { /* code: "STATE_ERROR" */ }

// src/store/atomic-write.ts  (TASK-02 — shared; not re-exported from index)
export function atomicWriteFile(targetPath: string, content: string): Promise<void>;

// src/store/council-state-store.ts  (TASK-03 — exported from src/index.ts)
export const STATE_SCHEMA_VERSION = 1;
export type CouncilStatus = "in-progress" | "completed";
export type CouncilPhase = "context" | "draft" | "validation" | "refinement" | "artifacts";
export interface CouncilStateMember { id: string; sessionId: string; }
export interface CouncilStateProducts { summary?: string; backlog?: string; validation?: string; }
export interface CouncilState {
  schemaVersion: number; councilId: string; status: CouncilStatus;
  lastPhase: CouncilPhase | null; lastRound: number; members: CouncilStateMember[];
  configHash: string; createdAt: string; updatedAt: string; products?: CouncilStateProducts;
}
export class CouncilStateStore {
  constructor(filePath: string);            // council/<slug>/state.json
  read(): Promise<CouncilState>;            // StateError on missing/corrupt/incompatible
  write(state: CouncilState): Promise<void>;// mkdir -p + atomicWriteFile
  exists(): Promise<boolean>;
}

// src/store/council-lock.ts  (TASK-04 — exported from src/index.ts)
export function councilConfigHash(raw: string): string;   // sha256 hex of council.yaml bytes
export class CouncilLock {
  constructor(filePath: string);            // council/<slug>/.council.lock
  acquire(force?: boolean): Promise<void>;  // wx create; StateError on conflict
  release(): Promise<void>;                  // best-effort unlink
}

// src/runtime/council-phases.ts  (TASK-05 — additive, backward-compatible)
export interface ResumePoint { lastPhase: CouncilPhase | null; lastRound: number; products: CouncilStateProducts; }
export interface PhaseCheckpoint { lastPhase: CouncilPhase; lastRound: number; products: CouncilStateProducts; }
export interface RunBacklogCouncilOptions {
  artifacts: ArtifactStore; logger?: Logger;
  resume?: ResumePoint;                                    // skip completed phases, seed products
  checkpoint?: (cp: PhaseCheckpoint) => Promise<void>;     // persist after each phase/round
}

// src/commands/run.ts  (TASK-06) and src/commands/continue.ts  (TASK-07)
export interface RunCouncilOptions { council: string; config?: string; force?: boolean; baseDir?: string; logger?: Logger; sessionFactory?: SessionFactory; }
export function runCouncil(options: RunCouncilOptions): Promise<void>;
export interface ContinueCouncilOptions { council: string; config?: string; force?: boolean; baseDir?: string; logger?: Logger; sessionFactory?: SessionFactory; }
export function continueCouncil(options: ContinueCouncilOptions): Promise<void>;
```

> **Why a `checkpoint` callback (not injecting `CouncilStateStore` into `runBacklogCouncil`):** the
> orchestrator owns phases/rounds/products only; identity fields (`councilId`, `members`,
> `configHash`, `createdAt`) and the full schema belong to the command + state store. The callback
> keeps `runBacklogCouncil` ignorant of the schema and fully testable (CC-0004 boundary).

## `continueCouncil` flow

1. `logger.info("council.continue", { council })` (entry, mirrors `add-member`).
2. `try`: resolve `councilDir = dirname(resolveCouncilConfigPath(council, baseDir))`;
   `configPath = options.config ?? join(councilDir, "council.yaml")`; `loadCouncilConfig`.
3. **Identity guard:** `config.name === council` else `ConfigError`.
4. `state = await stateStore.read()` (`StateError` on missing/corrupt/schema); **cross-check**
   `state.councilId === config.name` (`ConfigError`).
5. **Idempotent completed:** `state.status === "completed"` → `logger.info("council.continue.completed",
   { council, status })` no-op, return (exit 0); no lock taken.
6. **Drift:** member-id set differs → member-set drift → `ConfigError` unless `--force`
   (`logger.warn("config.drift", { kind: "member-set" })` + continue when forced); else if
   `councilConfigHash(raw) !== state.configHash` → non-structural drift →
   `logger.warn("config.drift", { kind: "non-structural" })` + continue.
7. **Session-id cross-check:** re-derive `"<config.name>/<member.id>"`, must equal stored `sessionId`
   (`ConfigError` on mismatch) — stored ids cross-checked, not trusted (R4).
8. Build stores + runtime (`sessionFactory = options.sessionFactory ?? new CopilotSessionFactory()`).
9. **Acquire lock** (`--force` clears stale).
10. `try { await runtime.start();` (`SessionError` on SDK failure → persisted state untouched)
    `logger.info("council.continue.resumed", { council, members, fromPhase, fromRound });`
    `await runBacklogCouncil(runtime, config, { artifacts, logger, resume, checkpoint });`
    write terminal `status: "completed"`; `logger.info("council.continue.completed", …); }`
    `finally { guarded runtime.stop(); await lock.release(); }`.
11. `catch (e)`: `councilError = toCouncilError(e)`;
    `logger.error("council.continue.failed", { council, code })`; `throw councilError` — `main()`
    logs `council.error` + sets exit 1 (CC-0008).

## Logging events (CORE-COMPONENT-0005, ids/counts/phase names only — never prompt/response bodies)

`council.continue`, `council.continue.resumed` (`{ council, members, fromPhase, fromRound }`),
`council.continue.completed`, `council.continue.failed` (`{ council, code }`), `state.read`,
`state.write` (`{ council, lastPhase, lastRound }`), `config.drift` (`{ council, kind }`),
`lock.acquired` / `lock.released` / `lock.forced`, plus the existing `session.created` (from
`start()`), `council.stop.error`, and `council.error` (top-level).

## Implementation Tasks (outline)

Ordered by dependency (full detail in `02-task-breakdown.md`; tests in `03-test-plan.md`):

1. **TASK-01** — Add `StateError` (`STATE_ERROR`) to `src/errors.ts`; auto-exported via `src/index.ts`.
2. **TASK-02** — Extract shared `atomicWriteFile` → `src/store/atomic-write.ts`; refactor `add-member` to reuse it (R7).
3. **TASK-03** — `CouncilStateStore` + `CouncilState` types + schema-validating `read`/atomic `write`; export from `src/index.ts`.
4. **TASK-04** — `CouncilLock` (atomic `wx`, `--force`, `StateError`) + `councilConfigHash`; export from `src/index.ts`.
5. **TASK-05** — Add backward-compatible `resume` + `checkpoint` to `runBacklogCouncil` (resume state machine + per-phase/round checkpoints).
6. **TASK-06** — Extract `runCouncil(options)` (behavior-preserving) + add the producer hook (identity guard, lock, initial/checkpoint/terminal state); rewire the thin `run` action + `--force`.
7. **TASK-07** — `continueCouncil(options)` (path/identity, read, idempotent-completed, drift, lock, resume, typed errors, logging); export from `src/index.ts`.
8. **TASK-08** — Wire the `continue` CLI action (replace stub; `-c/--config`, `--force`; thin adapter); update `.gitignore`; update `cli-program.test.ts` TP-19 (R6); update `LLM.txt`/surface.
9. **TASK-09** — Verification gate: `./harness verify` green; `npm run test:coverage` ≥80% (coverage runs via `npm run test:coverage`, since `./harness test` runs vitest **without** coverage).

## Acceptance Criteria (copied verbatim from issue #3)

**Core**
- [ ] `council continue <council>` is implemented in `src/cli.ts` (the `notImplemented("continue")` stub is removed).
- [ ] Running `continue` loads the council's `council.yaml` (honoring `-c/--config`) and reads `state.json` through a dedicated, decoupled state store.
- [ ] A new state store (e.g. `src/store/council-state-store.ts`) reads/writes `state.json` (councilId, status, lastPhase, lastRound, member session ids, timestamps, configHash, schemaVersion) with no orchestration logic, and is exported from `src/index.ts`.
- [ ] `state.json` writes create the parent dir (`mkdir -p` semantics) and are atomic (temp file + `rename`).
- [ ] Resume recreates member sessions through `SessionFactory.createSession(member, councilId)`, reusing the identical stable `${councilId}/${memberId}` session ids from the original run.
- [ ] The phase/round flow continues from the persisted `lastPhase`/`lastRound`, and updated state is re-persisted after each completed phase/round.
- [ ] File artifacts, transcript, and `state.json` are treated as authoritative; SDK session memory is best-effort and a failed SDK resume does not discard persisted state.
- [ ] All `continue` activity is logged via the structured `createLogger` (resume start, state read/write, sessions resumed, completion).
- [ ] Failures surface as typed `CouncilError` subclasses with stable codes and a non-zero exit code via the existing top-level CLI handler.

**Edge Cases**
- [ ] Missing `state.json` (council never run) -> typed error with an actionable message (e.g. "run `council run <council>` first"); no silent fresh-start.
- [ ] Corrupt or partially-written `state.json` (invalid JSON / failed schema check) -> typed error is thrown; state is never silently treated as empty.
- [ ] Unknown or newer `schemaVersion` in `state.json` -> typed error (no silent best-effort parse).
- [ ] Member-set drift in `council.yaml` since the last run -> command aborts with a typed error unless `--force`; non-structural drift warns and continues; both are logged.
- [ ] SDK session resume failure -> wrapped in a typed `SessionError`; persisted state is preserved so the run remains retryable.
- [ ] Concurrent `continue`/`run` of the same council -> a concurrency guard prevents state corruption (typed error / refusal), with a documented stale-lock escape hatch.
- [ ] Resuming an already-completed council (`status: "completed"`) is a safe no-op with a clear message (idempotent).
- [ ] The `<council>` argument and any config path are validated and cannot traverse outside the council directory.

**Testing**
- [ ] Unit test: resume reads persisted state and continues from the correct `lastPhase`/`lastRound`.
- [ ] Unit test: resume reuses the exact stable `${councilId}/${memberId}` session ids (asserted via a fake `SessionFactory`; no real SDK calls).
- [ ] Unit test: missing `state.json` raises the typed "no prior run" error.
- [ ] Unit test: corrupt/partial `state.json` raises a typed error (not an empty/fresh state).
- [ ] Unit test: unknown/newer `schemaVersion` raises a typed error.
- [ ] Unit test: state is re-persisted (updated `lastPhase`/`lastRound`/`updatedAt`) after progress, written atomically.
- [ ] Unit test: member-set drift aborts (typed error) without `--force` and is allowed with `--force`.
- [ ] Unit test: concurrent-continue guard rejects a second invocation while one is in progress.
- [ ] Tests are co-located as `*.test.ts`, use real temp dirs (`mkdtemp(tmpdir())`), and overall coverage stays >= 80%.

## Governing ADRs & Core-Components

- **ADR-0002** — TypeScript/ESM/NodeNext, `commander`, `SessionFactory` decoupling, vitest, no new deps (consumer; anticipates `continue`).
- **CORE-COMPONENT-0003** — slug-canonical `resolveCouncilConfigPath`, traversal guard, `loadCouncilConfig` (consumer; no change).
- **CORE-COMPONENT-0004** — runtime seam + resume contract; **updated** (resume entry point, stable-id reuse, continue-from-`lastPhase`).
- **CORE-COMPONENT-0005** — structured dotted logs, no bodies.
- **CORE-COMPONENT-0006** — stores + run-state store + lock; **updated** (`CouncilStateStore`, atomic write, schema validation, `.council.lock`).
- **CORE-COMPONENT-0007** — members stay read-only; resume changes no permission posture.
- **CORE-COMPONENT-0008** — typed errors; **updated** (`StateError`).
- **CORE-COMPONENT-0009** — co-located `*.test.ts`, `.js` specifiers, `node` env, ≥80% coverage.
