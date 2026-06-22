# Research Brief: feat(cli) — implement `council add-member` to add a validated member to a council

## GitHub Issue
- **Issue:** #7
- **Title:** feat(cli): implement `council add-member` to add a validated member to a council

## Scope Classification
- **Scope Type:** `issue`

**Justification.** This is a single, self-contained CLI feature implemented **entirely within
the existing architectural boundaries**. Every contract it needs is already adopted and named
in the decision log:

- configuration shape + central validation — CORE-COMPONENT-0003 (`validateCouncilConfig` / `loadCouncilConfig`);
- read-only-by-default `tools` capability — CORE-COMPONENT-0007;
- typed error taxonomy — CORE-COMPONENT-0008 (`ConfigError`, `code: "CONFIG_ERROR"`);
- structured line-delimited JSON logging — CORE-COMPONENT-0005 (`createLogger`, dotted event names);
- path-traversal guard pattern (`resolve` + `relative` + `startsWith("..")`) — CORE-COMPONENT-0006 (`ArtifactStore.write`);
- stable `"<councilId>/<memberId>"` session-id path segment — CORE-COMPONENT-0004 (motivates the strict `memberId` charset);
- TypeScript on Node ≥20, ESM/NodeNext, commander CLI, `yaml` package, `node:fs/promises` — ADR-0002;
- coding/test standards (`*.test.ts`, vitest `node` env, ≥80% coverage) — CORE-COMPONENT-0009.

The work introduces **no new technology choice, no new runtime topology, and no new cross-cutting
behavioral contract** — it composes existing contracts behind a new, unit-testable module.
CORE-COMPONENT-0003 already names this exact consumer as in-scope ("any code path that reads
council definitions: the CLI … and future scaffolding"). Therefore the scope is an ordinary
feature **issue**, not an `architecture_decision` or a `core_component`. (One *small* path-convention
decision and one possible CORE-COMPONENT-0003 amendment are surfaced as **proposals** below for the
Plan stage to commit — see "Proposed ADRs" / "Proposed Core-Components". The Researcher proposes;
the Planner decides.)

## Problem Statement

`council add-member` is a stub. In `src/cli.ts` (lines 30–38) the command parses `<council>` and
`<memberId>`, logs `council.add-member`, then calls `notImplemented("add-member")` — which writes to
stderr and sets `process.exitCode = 1` (lines 9–12). The only way to add a member today is hand-editing
`council.yaml`, which **bypasses `validateCouncilConfig`** and therefore:

- allows **duplicate member ids** (the validator does not dedup — empirically verified below);
- allows **invalid `tools`** values, silently coerced to `read-only` (verified);
- allows **whitespace-only** `cwd`/`role` (the validator checks non-empty length, not trimmed — verified);
- can leave a council that `council run` / `council continue` later depend on **corrupt or partially written**.

This blocks the v0 MVP flow in `prd.md` (`council init` → `council add-member` → `council run` →
`council continue`). The goal is a **safe, validated, unit-tested** `add-member` that appends a member
to an **existing** council and guarantees the file is **never left invalid or partially written**.

**Dependency & on-disk contract.** `add-member` *edits* an existing council file produced by `council init`
(issue #6). The shared on-disk contract both commands must agree on is `council/<council>/council.yaml`
(consistent with the `init` scaffold in `src/commands/init.ts` and `prd.md`'s `council/<name>/…` layout).
`add-member` **must not** create the council or its directory. Until `init` is merged on this branch,
tests construct `council.yaml` fixtures directly (the issue's stated approach).

This brief is **research only**: it inspects the codebase, classifies scope, maps acceptance criteria to
existing modules, and *proposes* (does not decide) any ADR / DECISION-LOG / core-component work. The
implementation seam sketched below is a recommendation for the Plan stage, not a commitment.

## Existing Context

### Harness baseline (operating surface)
- `./harness orient` → **Verdict `pass`**; Node `v24.17.0`; package manager `npm`; test runner `vitest`;
  bundler `tsc`. The contract (`.harness/contract.yml`) exposes
  `help | orient | doctor | lint | test | build | boot | verify | status | clean | friction_add | friction_list`.
- `./harness verify` = `lint + test + build` and is the gate named by the issue's final acceptance
  criterion (`./harness lint`, `./harness test`, `./harness build`, `./harness verify` must pass).
- Where a needed verb is missing from the contract, the Plan/Implement stages MAY fall back to the wrapped
  npm script and SHOULD record the gap with `./harness friction add`.

### The stub to replace and the error path it relies on
- **Stub:** `src/cli.ts` lines 30–38 (the `add-member` `.action`). It must be replaced with a thin adapter
  delegating to a covered module.
- **Top-level handler:** `program.parseAsync(process.argv).catch(...)` (lines 60–65) already logs
  `council.error` with **`{ error: error.message }`** and sets `process.exitCode = 1`. It currently does
  **not** log the `ConfigError.code`. So a thrown `ConfigError` from `add-member` already yields the required
  non-zero exit + a structured error log — but to satisfy the AC "failure record includes the `code`", the
  failure record carrying `code` must be emitted **inside** `add-member` *before* re-throwing. Optionally the
  handler can be enhanced to include `error.code` for `CouncilError`s (the issue lists this as optional).
- **Coverage boundary:** `vitest.config.ts` enforces 80% across lines/functions/branches/statements and
  **excludes `src/cli.ts`** (`exclude: ["src/**/*.test.ts", "src/cli.ts"]`). → All testable logic MUST live
  in a covered module (`src/config/add-member.ts`), and CLI behavior must be exercised via an exported
  in-process entry (`buildProgram()` / `main(argv)`) that lives in a **covered** module, not inline in `cli.ts`.

### Configuration loader — the contract to reuse (CORE-COMPONENT-0003)
`src/config/council-config.ts` exports `validateCouncilConfig(data)` and `loadCouncilConfig(path)`.
Three behaviors of the **central** validator that `add-member` must compensate for were **empirically verified**
against the real validator (`npx tsx`):

| Validator behavior (verified) | Consequence for `add-member` |
|---|---|
| Whitespace-only `cwd`/`role` accepted — `{cwd:"   ",role:"   "}` passes (length check at `council-config.ts:47,50`, not `trim`) | `add-member` must **trim then validate** `memberId`/`cwd`/`role` itself with field-naming errors. |
| Invalid `tools` silently coerced — `tools:"garbage-mode"` → `"read-only"` (`council-config.ts:58`) | `add-member` must **reject** invalid `--tools` up front (only `read-only`/`read-write`). |
| Duplicate ids **not** deduped — two members with `id:"x"` both survive (`root.members.map(...)`, `council-config.ts:88`) | `add-member` **owns** duplicate detection (case-sensitive, trimmed). |

Also critical (CORE-COMPONENT-0003 "Expectations"): `validateCouncilConfig` **drops unknown/forward-compat
keys** — its normalized return contains only the typed fields. Therefore `add-member` must **persist the edited
YAML Document**, never write back the validator's normalized object (that would silently delete unknown keys and
reflow the file).

### YAML Document editing preserves comments + unknown keys — empirically verified
The repo already depends on `yaml@2.9.0` (`package.json`). I verified that `parseDocument(src)` →
`doc.get("members").add({...})` → `String(doc)`:
- preserves the top comment, an inline member comment, and an unknown forward-compat key (`unknownKey: keepme`);
- yields `doc.toJS()` suitable to feed `validateCouncilConfig` (member count increments correctly).

This confirms the AC's "use the `yaml` Document API … comments, key order, and the orchestrator section are
preserved". The validate-then-persist sequence is: `parseDocument` → edit Document → `validateCouncilConfig(doc.toJS())`
→ on success `String(doc)` → atomic write.

### Path-safety patterns already in the repo (two variants — a consistency choice for the Planner)
- **`ArtifactStore.write`** (`src/store/artifact-store.ts:14–25`, CORE-COMPONENT-0006): the canonical guard
  the issue names — `resolve` + `relative` + `startsWith("..")`. Note `ArtifactStore.write` uses a plain
  `writeFile` (no atomic temp+rename), so it is the **guard** that is mirrored, not an atomic-write pattern.
- **`init.ts` `resolveCouncilPaths`** (`src/commands/init.ts:74–87`): a **refined** guard that rejects only
  real escapes (`rel.length===0 || rel===".." || rel.startsWith("../") || rel.startsWith("..\\")`), deliberately
  *not* a bare `startsWith("..")` (which over-rejects allowlisted names like `..a`/`...`). `init` also already
  has a **private** path resolver returning `{councilBase, councilDir}` and a `NAME_ALLOWLIST = /^[A-Za-z0-9._-]+$/`.

  → **Existing-context flag for the Planner:** the new exported `resolveCouncilConfigPath(council)` overlaps with
  `init`'s private `resolveCouncilPaths`. Decide whether to (a) share/extract one resolver, and (b) reuse the
  refined `init` guard rather than the bare `artifact-store` guard, for consistency. (Proposal, not a decision.)

### `memberId` charset is intentionally stricter than `init`'s council-name allowlist
`init`'s `NAME_ALLOWLIST` is `^[A-Za-z0-9._-]+$` (permits a leading dot). The issue requires `memberId` to match
`^[A-Za-z0-9][A-Za-z0-9._-]*$` — **must start alphanumeric** — because `memberId` becomes a path segment in the
stable session id `"<councilId>/<memberId>"` (CORE-COMPONENT-0004, Decision #8). The stricter pattern forbids
`.`/`..`-style ids that would be unsafe as a path segment.

### Logging conventions (CORE-COMPONENT-0005)
`createLogger()` emits one JSON object per line; `info`/`debug` → stdout, `warn`/`error` → stderr.
`init` logs `council.init.created`. The issue specifies three events for this command: entry
`council.add-member` `{council, memberId}`, success `council.add-member.succeeded` `{council, memberId, tools}`,
failure `council.add-member.failed` `{council, memberId, code}`. (Minor naming-convention note for the Planner:
`init` uses a single `.created` past-tense event; `add-member` introduces `.succeeded`/`.failed`. The issue is
explicit, so this is a consistency observation, not a blocker.)

### Test conventions to mirror (`src/commands/init.test.ts`)
Existing tests show the house style `add-member` tests should follow: `mkdtemp(join(tmpdir(), "..."))` per test
with `rm(..., {recursive,force})` cleanup; a **capturing logger** injected to assert log records; a partial
`vi.mock("node:fs/promises", …)` that spies `writeFile` while delegating the rest (useful to force a
post-parse/write failure and assert the on-disk bytes are unchanged with **no leftover temp file**); ESM `.js`
import specifiers; `ConfigError` + `code === "CONFIG_ERROR"` assertions. Public surface is re-exported via
`src/index.ts` (`export * from "./config/..."`), so the new module/types should be exported there too.

### Documentation surface
- `README.md` lists the four commands (lines 31–34) but has **no** limitations/concurrency section yet
  (`grep` found none) — the documented single-writer limitation is **net-new** README content.
- `LLM.txt` is the repo map and must gain a line for `src/config/add-member.ts`.

## Proposed ADRs

**ADRs required for this issue: NO.** No new technology choice or architectural pattern is introduced; the
feature composes adopted contracts (ADR-0002 + CORE-COMPONENT-0003/0004/0005/0006/0007/0008/0009). The issue
itself states "no new ADR is expected". The Researcher does **not** propose any ADR title.

**However**, the issue introduces and **exports** a new shared helper `resolveCouncilConfigPath(council)`
establishing the canonical on-disk convention `council/<council>/council.yaml` that `run`/`continue` will later
need to reconcile against (today `run` defaults `--config` to a *flat* `council.yaml`, `src/cli.ts:44`). This is
a small but real **cross-command path convention**. Per AGENTS.md ("every ADR or core-component change must update
DECISION-LOG.md") and the issue's own guidance, this is best captured as a lightweight **DECISION-LOG entry**, not
a full ADR.

**Proposed DECISION-LOG decision (for the Planner to commit — I propose, I do not decide):**

> *"Locate a council's configuration through the shared, exported `resolveCouncilConfigPath(council)` helper,
> which resolves to `council/<council>/council.yaml`; this is the single source of truth for on-disk council
> layout that `add-member` (now) and `run`/`continue` (follow-up) depend on."*
> Suggested source attribution: CORE-COMPONENT-0003 (Configuration). Date: to be set by the Planner on commit.

The Planner should decide whether to attach this decision to CORE-COMPONENT-0003 (see below) or record it as a
standalone DECISION-LOG line, and must set the correct date.

## Proposed Core-Components

**New core-components required for this issue: NO.** No new reusable cross-cutting behavior is *required* — the
feature reuses adopted components. Two items are surfaced as **proposals/decisions for the Planner**, not assertions:

1. **(Likely) Amend CORE-COMPONENT-0003 (Configuration), do not create a new component.** The new
   `resolveCouncilConfigPath(council)` is a *configuration-location* concern that naturally extends
   CORE-COMPONENT-0003 (which already covers "any code path that reads council definitions"). Proposed amendment:
   add `resolveCouncilConfigPath` to its Interfaces and add a rule that commands resolve `council.yaml` only via
   this helper (never ad hoc). This keeps `add-member`/`run`/`continue` consistent. *The Planner decides whether to
   amend 0003 vs. record only a DECISION-LOG line.*

2. **(Open) Atomic config write — local helper now, candidate component later.** The atomic "unique same-dir temp +
   `rename` + cleanup-on-error" write is, for this issue, used **once** (writing `council.yaml`). AGENTS.md says
   reusable cross-cutting behavior must be a core-component — but a single-use helper is not yet cross-cutting.
   **Proposal for the Planner:** keep the atomic write as a local helper inside `src/config/add-member.ts` for v0;
   if/when `run`/`continue` (or transcript/artifact writers) need durable atomic writes, promote it to a new
   "Atomic File Write" core-component then. *Decision deferred to the Planner — the Researcher does not commit it.*

No core-component **titles** are proposed for creation, because no new component is required for this issue.

## Acceptance Criteria (from issue)

The following are reproduced **verbatim** from the issue body (between the
`<!-- ACCEPTANCE_CRITERIA_START -->` / `<!-- ACCEPTANCE_CRITERIA_END -->` markers):

**Core**
- [ ] `council add-member <council> <memberId>` replaces the `notImplemented("add-member")` stub in `src/cli.ts`.
- [ ] Member fields are accepted via `--cwd`, `--role`, `--agent` (optional), and `--tools`; `--tools` defaults to `read-only` (CORE-COMPONENT-0007).
- [ ] A new member is appended to `council/<council>/council.yaml` via the `yaml` package, and the path is produced by a shared, exported `resolveCouncilConfigPath(council)` helper.
- [ ] Editing uses the `yaml` Document API so existing comments, key order, and the orchestrator section are preserved (or, if `parse` + `stringify` is used, comment loss is explicitly documented).
- [ ] The full config is re-validated with `validateCouncilConfig` after the edit, and the file is written back only when validation passes.
- [ ] Edit logic lives in a separate unit-testable module (`src/config/add-member.ts`), not in the commander action (since `src/cli.ts` is coverage-excluded).
- [ ] Pre-existing members, the orchestrator section, and unknown/forward-compat keys survive the write (persist the edited document, not the normalized validator output).
- [ ] Writes are atomic: a uniquely named temp file in the same directory is `rename`d over the original and removed on error.
- [ ] On entry/success/failure the shared logger emits records; the failure record includes the `ConfigError` `code` plus `council` and `memberId`.
- [ ] On any failure the command exits non-zero (via the existing top-level handler) and leaves `council.yaml` byte-for-byte unchanged.

**Edge Cases**
- [ ] A missing council directory or missing `council.yaml` fails with an actionable `ConfigError` (nothing created or corrupted).
- [ ] A duplicate `memberId` (case-sensitive, trimmed comparison) is rejected with a clear conflict error; file unchanged.
- [ ] An invalid `--tools` value (anything other than `read-only`/`read-write`) is rejected (not silently coerced).
- [ ] Empty/whitespace/non-string `memberId`, `--cwd`, or `--role` are rejected with field-naming errors.
- [ ] A `memberId` violating `^[A-Za-z0-9][A-Za-z0-9._-]*$` (including `.`/`..`) is rejected.
- [ ] Malformed (unparseable) YAML surfaces a `ConfigError` and the file is not overwritten.
- [ ] A parseable-but-already-invalid `council.yaml` surfaces a `ConfigError` and is not overwritten.
- [ ] The `<council>` argument cannot traverse outside the council root (e.g. `../../etc`).
- [ ] Two concurrent `add-member` runs cannot corrupt the file (unique temp name + atomic `rename`); the single-writer limitation is documented.

**Testing**
- [ ] Unit test: adding a member then re-reading via `loadCouncilConfig` returns the new member.
- [ ] Unit test: duplicate `memberId` rejected (throws; file unchanged).
- [ ] Unit test: omitting `--tools` yields `read-only`; explicit `read-write` is preserved.
- [ ] Unit test: missing council/`council.yaml` throws `ConfigError`.
- [ ] Unit test: invalid `--tools` is rejected.
- [ ] Unit test: missing/whitespace required fields and charset-invalid `memberId` are rejected with field-naming messages.
- [ ] Unit test: malformed YAML and parseable-but-invalid YAML both throw `ConfigError` without overwriting.
- [ ] Test: comments, unknown keys, the orchestrator section, and pre-existing members survive a round-trip add.
- [ ] Test: sequential and concurrent adds leave a valid, uncorrupted file (no leftover temp file).
- [ ] CLI-behavior test via the in-process `buildProgram()`/`main(argv)`: a non-existent council exits non-zero with a structured error log; success exits 0 with start + success logs.
- [ ] Tests are co-located `*.test.ts`, use ESM `.js` specifiers, and keep coverage ≥ 80% (vitest thresholds).

### Key technical constraints distilled from the issue (for the Plan stage)
1. **Module seam:** pure `applyAddMember(doc, member)` (edits a parsed Document, throws on conflict) + IO wrapper
   `addMember(opts)` (resolve → read → edit → validate → atomic write) in `src/config/add-member.ts`; commander
   action stays a thin adapter; export `resolveCouncilConfigPath(council)`.
2. **Atomic write:** unique temp in the **same directory** (e.g. `council.yaml.<pid>.<rand>.tmp`) + `rename` over
   original + remove temp on any error. Temp **must** be same-FS (a cross-FS `rename` fails with `EXDEV`).
   `fsync` optional for v0.
3. **Preserve-on-disk:** persist `String(doc)` (Document API), **never** `validateCouncilConfig`'s normalized return
   (drops unknown/forward-compat keys, CORE-COMPONENT-0003).
4. **Input validation (trim then check):** `memberId` non-empty after trim **and** `^[A-Za-z0-9][A-Za-z0-9._-]*$`;
   `--cwd`/`--role` required non-empty after trim; `--agent` optional string; `--tools` exactly `read-only`/`read-write`,
   default `read-only` (reject anything else — validator silently coerces).
5. **Duplicate detection:** case-sensitive, trimmed exact match against existing ids; conflict `ConfigError`; no write.
6. **Pre-existing-invalid file:** re-validation means an already-invalid (but parseable) `council.yaml` blocks adding
   even a valid member — surface `ConfigError`, never overwrite; unparseable YAML likewise → `ConfigError`.
7. **Path safety:** mirror the traversal guard for the **`council` argument only** (it builds the path); `memberId`
   is additionally constrained by its charset. (See Planner note re: which guard variant to reuse.)
8. **Testability:** `src/cli.ts` is coverage-excluded — expose `buildProgram()`/`main(argv)` in a covered module for
   in-process CLI tests asserting exit code + log records (spawning built `dist/cli.js` is an allowed alternative but
   needs a build step).
9. **No new deps; ESM/NodeNext `.js` import specifiers** in source and tests (`yaml`, `commander`, `node:fs/promises`
   already present).

## Risks and Open Questions

**Risks**
- **R1 — Concurrency (documented limitation, not corruption).** v0 does not lock `council.yaml`. The unique-temp +
  same-dir `rename` strategy prevents *corruption* (one writer wins cleanly) but not *lost updates* (two near-simultaneous
  adds → last writer wins, the other member silently lost). The issue accepts this as a documented v0 limitation
  (README/`--help`). *Mitigation:* the concurrency test must assert a **valid, uncorrupted** file with **no leftover
  temp file**, not serialization. File locking is a future enhancement.
- **R2 — Path-convention divergence with `run`/`continue`.** `src/cli.ts:44` defaults `run --config` to a **flat**
  `council.yaml`, which will not find `council/<council>/council.yaml` after `init`. This issue introduces/exports
  `resolveCouncilConfigPath` and uses it, but **does not** reconcile `run`/`continue` (explicit out-of-scope follow-up).
  *Risk:* user confusion until the follow-up lands. *Mitigation:* file a tracked follow-up issue; note in the proposed
  DECISION-LOG entry that reconciliation is pending.
- **R3 — Comment/layout loss if the Document API is bypassed.** If an implementer uses plain `parse` + `stringify`
  instead of `parseDocument`, comments/key-order are lost. *Mitigation:* verified the Document API works
  (`yaml@2.9.0`); the AC permits `parse`+`stringify` **only if** comment loss is explicitly documented. Prefer the
  Document API.
- **R4 — Windows / cross-FS `rename` edge cases.** `rename` over an open or cross-filesystem target can fail
  (`EXDEV`, or `EPERM`/`EBUSY` on Windows). v0 targets the POSIX dev container; same-dir temp keeps it same-FS.
  *Mitigation:* document POSIX assumption; cleanup-on-error covers the failure path.
- **R5 — Durability without `fsync`.** Without `fsync` of the temp file (and parent dir) before/after `rename`, a
  crash mid-write could lose the update on some filesystems. The issue marks `fsync` optional for v0. *Accept for v0.*
- **R6 — `buildProgram()` refactor touches `cli.ts` (coverage-excluded).** The exported in-process entry must live in
  a **covered** module so the CLI-behavior AC actually counts toward coverage; a too-thin `cli.ts` that still holds
  logic would be untested. *Mitigation:* Planner specifies where `buildProgram`/`main` live (e.g. a covered
  `src/cli-program.ts` re-exported by `cli.ts`).

**Open questions (for the Planner — proposals only, no decisions made here)**
- **OQ1 — `resolveCouncilConfigPath` signature & home.** Does it take an optional `baseDir` (mirroring `init`'s
  injectable `baseDir` for testability)? Does it live in `src/config/council-config.ts` (alongside the loader) or a
  new shared path module, and should it share logic with `init`'s private `resolveCouncilPaths`?
- **OQ2 — Which traversal guard variant to reuse** for the `council` argument: the bare `artifact-store`
  `startsWith("..")` (named by the issue) or `init`'s refined guard (rejects only real escapes). Recommend the refined
  guard for consistency; Planner decides.
- **OQ3 — DECISION-LOG vs CORE-COMPONENT-0003 amendment** for the path-resolver decision (and its date) — see
  "Proposed ADRs" / "Proposed Core-Components".
- **OQ4 — Atomic-write helper placement:** local helper in `add-member.ts` now vs. a future "Atomic File Write"
  core-component if reused by `run`/`continue`/stores.
- **OQ5 — Should the top-level handler in `cli.ts` be enhanced** to log `error.code` for `CouncilError`s (issue marks
  this optional), given `add-member` already emits its own `council.add-member.failed` record carrying `code`?
- **OQ6 — Log-event naming convention:** keep the issue's `council.add-member.succeeded` / `.failed`, or align with
  `init`'s single `council.init.created` past-tense style? (Issue is explicit; flagging for consistency only.)
- **OQ7 — Follow-up tracking:** should this issue open the `run`/`continue` path-reconciliation follow-up now, so R2
  is not lost?

**Empirical evidence captured during research** (so the Plan stage need not re-derive):
- `yaml@2.9.0` `parseDocument` + `members.add()` + `String(doc)` preserves top/inline comments and an unknown
  forward-compat key; `doc.toJS()` increments member count for `validateCouncilConfig`.
- `validateCouncilConfig` accepts whitespace-only `cwd`/`role`, coerces `tools:"garbage-mode"` → `"read-only"`, and
  does **not** dedup duplicate ids — confirming `add-member` must own trim-validation, `--tools` rejection, and
  duplicate detection.
- `./harness orient` → `pass`; `src/cli.ts` is coverage-excluded with 80% thresholds (`vitest.config.ts`).
