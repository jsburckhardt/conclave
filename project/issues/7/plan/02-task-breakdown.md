# Task Breakdown: Issue #7 — `council add-member`

Source plan: `project/issues/7/plan/01-action-plan.md`.
Test cases (TP-IDs) are defined in `project/issues/7/plan/03-test-plan.md`.

**Acceptance-criterion IDs** (from the issue, used throughout):
Core `C1`–`C10`, Edge `E1`–`E9`, Testing `TS1`–`TS11`.

| ID | Core acceptance criterion (short) |
|----|-----------------------------------|
| C1 | `add-member` replaces the `notImplemented("add-member")` stub in `src/cli.ts` |
| C2 | Fields via `--cwd`/`--role`/`--agent`(opt)/`--tools`; `--tools` defaults `read-only` (CC-0007) |
| C3 | New member appended to `council/<council>/council.yaml` via `yaml`; path from shared exported `resolveCouncilConfigPath` |
| C4 | Editing uses the `yaml` Document API; comments, key order, orchestrator section preserved |
| C5 | Full config re-validated with `validateCouncilConfig`; written back only when validation passes |
| C6 | Edit logic lives in a separate unit-testable module (`src/config/add-member.ts`), not the action |
| C7 | Pre-existing members, orchestrator section, unknown/forward-compat keys survive (persist the document) |
| C8 | Writes are atomic: unique same-dir temp `rename`d over the original, removed on error |
| C9 | Entry/success/failure logger records; failure record includes `ConfigError` `code` + `council` + `memberId` |
| C10 | On any failure: exit non-zero (top-level handler) and leave `council.yaml` byte-for-byte unchanged |

| ID | Edge acceptance criterion (short) |
|----|-----------------------------------|
| E1 | Missing council dir / missing `council.yaml` → actionable `ConfigError`; nothing created/corrupted |
| E2 | Duplicate `memberId` (case-sensitive, trimmed) rejected; file unchanged |
| E3 | Invalid `--tools` rejected (not silently coerced) |
| E4 | Empty/whitespace/non-string `memberId`/`--cwd`/`--role` rejected with field-naming errors |
| E5 | `memberId` violating `^[A-Za-z0-9][A-Za-z0-9._-]*$` (incl. `.`/`..`) rejected |
| E6 | Malformed (unparseable) YAML → `ConfigError`; file not overwritten |
| E7 | Parseable-but-already-invalid `council.yaml` → `ConfigError`; not overwritten |
| E8 | `<council>` arg cannot traverse outside the council root (e.g. `../../etc`) |
| E9 | Two concurrent adds cannot corrupt the file (unique temp + atomic `rename`); single-writer limitation documented |

| ID | Testing acceptance criterion (short) |
|----|--------------------------------------|
| TS1 | Unit: add then re-read via `loadCouncilConfig` returns the new member |
| TS2 | Unit: duplicate `memberId` rejected (throws; file unchanged) |
| TS3 | Unit: omitting `--tools` yields `read-only`; explicit `read-write` preserved |
| TS4 | Unit: missing council/`council.yaml` throws `ConfigError` |
| TS5 | Unit: invalid `--tools` rejected |
| TS6 | Unit: missing/whitespace required fields and charset-invalid `memberId` rejected with field-naming messages |
| TS7 | Unit: malformed YAML and parseable-but-invalid YAML both throw `ConfigError` without overwriting |
| TS8 | Test: comments, unknown keys, orchestrator section, pre-existing members survive a round-trip add |
| TS9 | Test: sequential and concurrent adds leave a valid, uncorrupted file (no leftover temp file) |
| TS10 | CLI-behavior via in-process `buildProgram()`/`main(argv)`: non-existent council exits non-zero w/ structured error log; success exits 0 with start + success logs |
| TS11 | Tests are co-located `*.test.ts`, use `.js` specifiers, keep coverage ≥80% |

---

## Task TASK-01: `resolveCouncilConfigPath` resolver and traversal guard

- **Status:** Planned
- **Complexity:** Low-Medium
- **Dependencies:** None
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0003 (amended), CORE-COMPONENT-0006, CORE-COMPONENT-0008, CORE-COMPONENT-0009

### Description
Add the shared, exported `resolveCouncilConfigPath(council: string, baseDir?: string): string`
to `src/config/council-config.ts` (its home per OQ1; the configuration-location concern named by
CORE-COMPONENT-0003). It:

- defaults `baseDir` to `process.cwd()` (injectable for hermetic tests, mirroring `init`);
- computes `councilBase = resolve(baseDir, "council")` and `councilDir = resolve(councilBase, council)`;
- applies the **refined `init` traversal guard** (OQ2): reject when
  `relative(councilBase, councilDir)` is empty, equals `..`, or starts with `../`/`..\` —
  **not** the bare `startsWith("..")`; throw `ConfigError` (CORE-COMPONENT-0008) naming the
  offending `<council>` value;
- returns `join(councilDir, "council.yaml")`;
- performs **no** filesystem IO.

Re-export it from `src/index.ts`. Do **not** refactor `init`'s private `resolveCouncilPaths` in
this issue (documented in OQ2); the two guards must remain behaviorally identical.

### Acceptance Criteria
- [ ] `resolveCouncilConfigPath` is exported from `src/config/council-config.ts` and re-exported
      from `src/index.ts`, with an explicit return type (named export; CORE-COMPONENT-0009). (`C3`)
- [ ] For a valid `council`, it returns `resolve(baseDir ?? process.cwd(), "council", council,
      "council.yaml")` and does no IO. (`C3`)
- [ ] `<council>` values that escape the council root — e.g. `..`, `../../etc`, `a/../..` — are
      rejected with `ConfigError` (`code === "CONFIG_ERROR"`) naming the value, via
      `resolve`+`relative` (not string matching alone). (`E8`)
- [ ] For every accepted name, `relative(resolve(baseDir,"council"), result-dir) === council`
      (resolved strictly inside `council/`). (`E8`)

### Test Coverage
- Co-located unit tests in `src/config/council-config.test.ts` (extend the existing file) or a
  new co-located `*.test.ts`, `.js` specifiers, `node` env (CORE-COMPONENT-0009).
- **TP-14** (traversal guard: escapes rejected; valid names resolve within root).
- **TP-15** (returns `council/<council>/council.yaml`; honors injected `baseDir`; no IO).
- Exported function must reach ≥80% coverage (CORE-COMPONENT-0009).

---

## Task TASK-02: Input validation and pure `applyAddMember(doc, member)`

- **Status:** Planned
- **Complexity:** Medium
- **Dependencies:** TASK-01
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0003, CORE-COMPONENT-0007, CORE-COMPONENT-0008, CORE-COMPONENT-0004, CORE-COMPONENT-0009

### Description
Create `src/config/add-member.ts` and implement the **pure** input-safety + edit layer (no file
IO yet):

- A scalar-input normalizer/validator (trim **then** check) that compensates for the central
  validator's gaps (verified in research): `memberId` non-empty after trim **and** matches
  `^[A-Za-z0-9][A-Za-z0-9._-]*$`; `cwd`/`role` required non-empty after trim; `agent` optional
  string; `tools` exactly `"read-only"`/`"read-write"`, defaulting to `"read-only"` and rejecting
  anything else (the validator silently coerces, so `add-member` must reject up front). Each
  failure throws `ConfigError` whose message **names the offending field** (CORE-COMPONENT-0008).
- `export function applyAddMember(doc: Document, member: MemberConfig): void` — a pure Document
  edit: read the `members` sequence, perform **case-sensitive, trimmed** duplicate detection
  against existing ids (throw a conflict `ConfigError` naming the id on a match), otherwise
  `members.add({ id, cwd, role, agent?, tools })` (omit `agent` when undefined). Throws
  `ConfigError` if `members` is absent/not a sequence (structural problem). No IO; operates on
  the parsed Document so comments/order are preserved (CORE-COMPONENT-0003 persist-the-document).

The strict `memberId` charset is required because `memberId` becomes a path segment in the stable
session id `"<councilId>/<memberId>"` (CORE-COMPONENT-0004).

### Acceptance Criteria
- [ ] Invalid `--tools` (e.g. `"garbage-mode"`, `"READ-ONLY"`, `""`) is rejected with a
      field-naming `ConfigError`; valid `read-only`/`read-write` accepted; omitted → `read-only`. (`C2`,`E3`)
- [ ] Empty/whitespace/non-string `memberId`, `--cwd`, `--role` are each rejected with a
      `ConfigError` naming the field. (`E4`)
- [ ] `memberId` failing `^[A-Za-z0-9][A-Za-z0-9._-]*$` — including `"."`, `".."`, `".hidden"`,
      `"-x"`, `"a b"`, `""` — is rejected with `ConfigError`. (`E5`)
- [ ] `applyAddMember` appends a member node to the Document's `members` seq, leaving existing
      nodes/comments untouched, and increments `doc.toJS().members.length` by one. (`C3`,`C4`)
- [ ] `applyAddMember` throws a `ConfigError` naming the id on a case-sensitive trimmed duplicate
      (e.g. existing `"alice"` + new `"alice"` or `" alice "`), and does **not** mutate the doc. (`E2`)
- [ ] All thrown errors are `ConfigError` (`code === "CONFIG_ERROR"`) with human-actionable messages. (`C9`)

### Test Coverage
- Co-located `src/config/add-member.test.ts` (`.test.ts`, `.js` specifiers, `node` env).
- **TP-02** (tools default/explicit), **TP-04** (invalid `--tools`), **TP-05** (required-field
  validation), **TP-06** (charset rejection), **TP-03** (duplicate via `applyAddMember` pure path).
- Pure functions → fully unit-coverable; branch coverage across each rejection class keeps the
  module ≥80% (CORE-COMPONENT-0009).

---

## Task TASK-03: Atomic same-directory write helper

- **Status:** Planned
- **Complexity:** Medium
- **Dependencies:** None (parallel with TASK-01/02; consumed by TASK-04)
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0006, CORE-COMPONENT-0008, CORE-COMPONENT-0009

### Description
Implement a **private** (not exported from `src/index.ts`) `atomicWriteFile(targetPath: string,
content: string): Promise<void>` inside `src/config/add-member.ts` (OQ4 — single-use, local):

1. Build a **unique temp name in the same directory** as the target:
   `join(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`)`
   (`randomUUID` from `node:crypto`, built-in — no new dependency).
2. `writeFile(temp, content, "utf8")`.
3. `rename(temp, targetPath)` — atomic replace on the same filesystem (same-dir temp keeps it
   same-FS, avoiding `EXDEV`; POSIX dev-container assumption documented, research R4).
4. On **any** error in steps 2–3: `rm(temp, { force: true })` (best-effort cleanup), then re-throw.
5. No `fsync` for v0 (research R5).

This is the corruption-safety mechanism behind **C8** and **E9**: unique temp names mean two
concurrent writers never share a temp file, and the final `rename` yields a clean last-writer-wins
(no partial/corrupt file). It is **not** promoted to a core-component (OQ4); the promotion trigger
is recorded in the action plan.

### Acceptance Criteria
- [ ] On success, the target is written via a **same-directory** temp file that is `rename`d into
      place; after the call, **no** `*.tmp` file remains in the directory. (`C8`)
- [ ] The temp filename is unique per call (includes `process.pid` + `randomUUID()`), so
      overlapping calls cannot collide on the temp path. (`C8`,`E9`)
- [ ] If `writeFile` or `rename` rejects, the helper re-throws and leaves **no** leftover temp
      file (cleanup ran); the original target (if any) is untouched. (`C8`,`C10`)
- [ ] No new runtime dependency is introduced (uses `node:fs/promises`, `node:path`, `node:crypto`). (ADR-0002)

### Test Coverage
- **TP-11** (happy path: temp created+renamed; no leftover `*.tmp`).
- **TP-12** (forced `writeFile`/`rename` failure via partial `vi.mock("node:fs/promises")` →
  re-throws; original bytes unchanged; no leftover temp).
- **TP-13** (concurrency/sequencing — exercised through `addMember`).
- Branch coverage for the success vs. cleanup-on-error paths keeps the module ≥80%.

---

## Task TASK-04: `addMember(options)` IO orchestration

- **Status:** Planned
- **Complexity:** High
- **Dependencies:** TASK-01, TASK-02, TASK-03
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0003 (amended), CORE-COMPONENT-0005, CORE-COMPONENT-0007, CORE-COMPONENT-0008, CORE-COMPONENT-0009

### Description
Compose TASK-01/02/03 into `export async function addMember(options: AddMemberOptions):
Promise<void>` in `src/config/add-member.ts`, following the action plan's ordered flow:

1. `path = resolveCouncilConfigPath(council, baseDir)` (TASK-01; **E8**).
2. Log entry `council.add-member { council, memberId }` via the injected/default logger.
3. Normalize+validate scalar inputs (TASK-02; **C2**,**E3**,**E4**,**E5**) **before** any IO.
4. `readFile(path)` → map a read error (missing dir/file) to `ConfigError` naming the path (**E1**).
5. `parseDocument(raw)` → map a parse error to `ConfigError` (**E6**). (Surface YAML
   `doc.errors` as a `ConfigError` too.)
6. `applyAddMember(doc, member)` (TASK-02; duplicate → **E2**).
7. `validateCouncilConfig(doc.toJS())` → `ConfigError` on invalid (incl. **pre-existing-invalid**
   parseable file; **E7**, **C5**). No write on failure.
8. `atomicWriteFile(path, String(doc))` (TASK-03; persists the **document**, not the normalized
   object — **C7**, **C8**).
9. Log success `council.add-member.succeeded { council, memberId, tools }`.
10. Wrap steps 4–9 so any throw emits `council.add-member.failed { council, memberId, code }`
    (with `code` from the `CouncilError`, else `"CONFIG_ERROR"` after wrapping in `ConfigError`
    with `cause`) **before** re-throwing — guaranteeing non-zero exit + byte-for-byte-unchanged
    file (**C9**, **C10**). No `console.log`; all output via the `Logger`.

Export `AddMemberOptions`; re-export `addMember`/`applyAddMember`/`AddMemberOptions` from
`src/index.ts` (done in TASK-06). Keep `src/cli.ts` free of this logic (**C6**).

### Acceptance Criteria
- [ ] Adding a valid member to a valid `council.yaml` writes the file and a re-read via
      `loadCouncilConfig` returns the new member with the expected `id`/`cwd`/`role`/`tools`. (`C3`,`C5`,`TS1`)
- [ ] Comments, key order, the `orchestrator` section, **unknown/forward-compat keys**, and all
      pre-existing members survive the write (file contains `String(doc)`, not the normalized
      validator output). (`C4`,`C7`,`TS8`)
- [ ] A missing council directory or missing `council.yaml` throws `ConfigError` naming the path;
      nothing is created or written. (`E1`,`TS4`)
- [ ] Malformed (unparseable) YAML throws `ConfigError` and does **not** overwrite the file. (`E6`,`TS7`)
- [ ] A parseable-but-already-invalid `council.yaml` (e.g. missing `orchestrator`) throws
      `ConfigError` (from re-validation) and does **not** overwrite the file. (`E7`,`TS7`)
- [ ] A duplicate `memberId` throws a conflict `ConfigError`; the file is byte-for-byte unchanged. (`E2`,`TS2`,`C10`)
- [ ] On any failure the file is byte-for-byte unchanged and `council.add-member.failed
      { council, memberId, code }` is emitted before the error propagates (non-zero exit). (`C9`,`C10`)
- [ ] On success, exactly one `council.add-member` (entry) and one `council.add-member.succeeded`
      `{ council, memberId, tools }` record are emitted; no `console.log`. (`C9`)

### Test Coverage
- **TP-01** (happy add + re-read), **TP-03** (duplicate, file unchanged), **TP-07** (missing
  file), **TP-08** (malformed YAML), **TP-09** (pre-existing-invalid), **TP-10** (preservation
  round-trip), **TP-12** (failure atomicity), **TP-16** (entry/success logs + no `console.log`),
  **TP-17** (failure log carries `code`).
- Branch coverage across each error-mapping path (read/parse/duplicate/re-validate/write) must keep
  the module ≥80% (CORE-COMPONENT-0009).

---

## Task TASK-05: CLI wiring — `src/cli-program.ts` (buildProgram/main) + `src/cli.ts` shim

- **Status:** Planned
- **Complexity:** Medium
- **Dependencies:** TASK-04
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0005, CORE-COMPONENT-0008, CORE-COMPONENT-0009

### Description
Make CLI behavior testable in a **covered** module (research R6):

1. Create `src/cli-program.ts` exporting `buildProgram(deps?: { logger?: Logger; baseDir?: string
   }): Command` and `main(argv: string[], deps?): Promise<void>`. Move the existing
   `init`/`run`/`continue` command wiring **verbatim** from `src/cli.ts`; keep the `notImplemented`
   helper for the still-stubbed `run`/`continue`. Replace the `add-member` action body so it reads
   `--cwd`/`--role`/`--agent`/`--tools` (default `read-only`) options and `await addMember({
   council, memberId, cwd, role, agent, tools, baseDir: deps?.baseDir, logger: deps?.logger ??
   logger })`. The action contains **no** edit/IO logic (**C6**).
2. `main` runs `buildProgram(deps).parseAsync(argv)` inside the existing top-level `catch` that
   logs `council.error` and sets `process.exitCode = 1` (never `process.exit`, so in-process tests
   survive). **(OPTIONAL, OQ5):** also include `code: error.code` in the `council.error` record
   when `error instanceof CouncilError` — harmless observability, no test dependency.
3. Reduce `src/cli.ts` to a thin shim that keeps `#!/usr/bin/env node` and calls
   `void main(process.argv)`; import with the `.js` specifier (`./cli-program.js`). `src/cli.ts`
   stays coverage-excluded (`vitest.config.ts`); thinness is enforced by review.

Register the `add-member` options with `commander` (`-c, --cwd <path>`, `--role <role>`, `--agent
<agent>`, `--tools <mode>` defaulting to `read-only`) so `--help` documents them.

### Acceptance Criteria
- [ ] `src/cli-program.ts` exports `buildProgram` and `main`; `buildProgram` wires all four
      subcommands; the `add-member` action delegates to `addMember` and holds no IO logic. (`C1`,`C6`)
- [ ] `src/cli.ts` is a shim (shebang + `main(process.argv)`), importing `./cli-program.js`; it no
      longer calls `notImplemented("add-member")`. (`C1`)
- [ ] In-process `main(["node","council","add-member","<missing>","m","--cwd",".","--role","r"],
      { logger, baseDir })` leaves `process.exitCode` non-zero and emits a structured error log
      carrying the `code`; success leaves `process.exitCode` 0 with start + success logs. (`C1`,`C9`,`C10`,`TS10`)
- [ ] `commander` `--help` for `add-member` lists `--cwd`, `--role`, `--agent`, `--tools`
      (default `read-only`). (`C2`)
- [ ] `init`/`run`/`continue` behavior is unchanged by the move (regression guard). (`C1`)

### Test Coverage
- Co-located `src/cli-program.test.ts` driving `main(argv, { logger, baseDir })` in-process.
- **TP-18** (add-member CLI: success exit 0 + start/success logs; non-existent council non-zero +
  error log with `code`).
- **TP-19** (smoke `init`/`run`/`continue` via `main` so the moved actions stay covered — keeps
  `src/cli-program.ts` ≥80% across functions/branches).
- `src/cli.ts` is coverage-excluded, so its thinness is enforced by **review**; compilation is
  validated by `./harness build` in **TP-21**.

---

## Task TASK-06: Public exports and documentation (`src/index.ts`, `LLM.txt`, `README.md`, `--help`)

- **Status:** Planned
- **Complexity:** Low
- **Dependencies:** TASK-04, TASK-05
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0003 (amended), CORE-COMPONENT-0009

### Description
Three surface updates:

1. **`src/index.ts`** — re-export the new public surface: `addMember`, `applyAddMember`,
   `AddMemberOptions` (from `./config/add-member.js`) and `resolveCouncilConfigPath` (already in
   `./config/council-config.js` via the existing `export *`). Keep named exports
   (CORE-COMPONENT-0009).
2. **`LLM.txt`** — add rows for `src/config/add-member.ts` (council add-member edit logic:
   `addMember`/`applyAddMember`/`resolveCouncilConfigPath` usage) and `src/cli-program.ts`
   (in-process CLI program: `buildProgram`/`main`). Update the `src/cli.ts` row to note it is now
   a thin shim. Preserve the file's existing column-alignment style; do not reword unrelated rows.
3. **`README.md` / `--help`** — expand the `council add-member` CLI bullet with its
   `--cwd`/`--role`/`--agent`/`--tools` flags, and add a net-new **Limitations** subsection
   documenting (a) the v0 **single-writer** concurrency limitation (unique-temp + atomic `rename`
   prevents corruption, not lost updates) and (b) the pending `run`/`continue` path-reconciliation
   follow-up (research R2, OQ7). `--help` text is surfaced by `commander` from the registered
   options (TASK-05).

### Acceptance Criteria
- [ ] `src/index.ts` re-exports `addMember`, `applyAddMember`, `AddMemberOptions`, and
      `resolveCouncilConfigPath` (named exports). (CORE-COMPONENT-0009)
- [ ] `LLM.txt` contains rows for `src/config/add-member.ts` and `src/cli-program.ts`; no
      unrelated rows are reworded/reordered. (documentation)
- [ ] `README.md` documents the `add-member` flags **and** a Limitations subsection covering the
      single-writer concurrency limitation and the `run`/`continue` reconciliation follow-up. (`E9`)
- [ ] `node dist/cli.js add-member --help` (post-build) lists `--cwd`/`--role`/`--agent`/`--tools`. (`C2`)

### Test Coverage
- **TP-20** verifies: `grep` `LLM.txt` for both new module rows; `grep` `README.md` for a
  Limitations/concurrency mention; `src/index.ts` re-exports resolve at type-check (`./harness
  build`). The barrel re-export is exercised transitively by the modules' own tests (no separate
  unit test needed for a pure re-export).
- **TP-18/TP-19** exercise the registered options indirectly via `main`.

---

## Task TASK-07: Verification gate — coverage ≥80% and `./harness verify`

- **Status:** Planned
- **Complexity:** Low-Medium
- **Dependencies:** TASK-01, TASK-02, TASK-03, TASK-04, TASK-05, TASK-06
- **Related ADRs:** ADR-0002
- **Related Core-Components:** CORE-COMPONENT-0009

### Description
Run the full gate using `./harness` as the first-choice surface (the contract exposes
`lint | test | build | verify`): `./harness lint`, `./harness test`, `./harness build`, then
`./harness verify` (lint + test + build). Confirm conventions: new tests are co-located
`*.test.ts`, use `.js` import specifiers, run under the `node` vitest environment, and overall
coverage stays **≥80%** (lines/functions/branches/statements) with `src/cli.ts` excluded
(`vitest.config.ts`). If a needed harness verb is missing or reports `degraded`/`unknown`, fall
back to the wrapped npm script and record the gap with `./harness friction add`.

### Acceptance Criteria
- [ ] `src/config/add-member.test.ts` and `src/cli-program.test.ts` exist, co-located, `*.test.ts`,
      `.js` specifiers, `node` env. (`TS11`)
- [ ] Overall coverage ≥80% (lines/functions/branches/statements) with `src/cli.ts` excluded;
      `src/config/add-member.ts`, `src/cli-program.ts`, and `resolveCouncilConfigPath` are
      exercised. (`TS11`)
- [ ] `./harness verify` reports verdict `pass` (lint + test + build). (`TS11`)
- [ ] Any harness gap encountered is recorded via `./harness friction add`. (operating surface)

### Test Coverage
- **TP-21** (gate): `./harness verify` green; coverage threshold met; convention checks pass.
- Aggregates the conventions/coverage criterion `TS11` and the harness gate.

---

## Acceptance-Criteria → Task Traceability

| AC | Description (short) | Task(s) |
|----|---------------------|---------|
| C1 | Replace stub; thin action delegates to `addMember` | TASK-05 |
| C2 | `--cwd`/`--role`/`--agent`/`--tools`; default `read-only` | TASK-02, TASK-05 |
| C3 | Append to `council/<council>/council.yaml` via shared `resolveCouncilConfigPath` | TASK-01, TASK-02, TASK-04 |
| C4 | `yaml` Document API preserves comments/order/orchestrator | TASK-02, TASK-04 |
| C5 | Re-validate with `validateCouncilConfig`; write only on pass | TASK-04 |
| C6 | Edit logic in `src/config/add-member.ts`, not the action | TASK-02, TASK-04, TASK-05 |
| C7 | Pre-existing members/orchestrator/unknown keys survive (persist document) | TASK-04 |
| C8 | Atomic write: unique same-dir temp + `rename` + cleanup | TASK-03, TASK-04 |
| C9 | Entry/success/failure logs; failure carries `code` + `council` + `memberId` | TASK-04, TASK-05 |
| C10 | Non-zero exit on failure; file byte-for-byte unchanged | TASK-03, TASK-04, TASK-05 |
| E1 | Missing dir/file → `ConfigError`; nothing created | TASK-04 |
| E2 | Duplicate `memberId` (case-sensitive, trimmed) rejected; file unchanged | TASK-02, TASK-04 |
| E3 | Invalid `--tools` rejected (not coerced) | TASK-02 |
| E4 | Empty/whitespace/non-string `memberId`/`--cwd`/`--role` rejected | TASK-02 |
| E5 | `memberId` charset `^[A-Za-z0-9][A-Za-z0-9._-]*$` enforced | TASK-02 |
| E6 | Malformed YAML → `ConfigError`; not overwritten | TASK-04 |
| E7 | Parseable-but-invalid `council.yaml` → `ConfigError`; not overwritten | TASK-04 |
| E8 | `<council>` cannot traverse outside the council root | TASK-01 |
| E9 | Concurrent adds cannot corrupt; single-writer limitation documented | TASK-03, TASK-04, TASK-06 |
| TS1 | Add then re-read via `loadCouncilConfig` | TASK-04 |
| TS2 | Duplicate rejected; file unchanged | TASK-02, TASK-04 |
| TS3 | Default `read-only`; explicit `read-write` preserved | TASK-02 |
| TS4 | Missing council/`council.yaml` → `ConfigError` | TASK-04 |
| TS5 | Invalid `--tools` rejected | TASK-02 |
| TS6 | Missing/whitespace fields + charset-invalid `memberId` (field-naming) | TASK-02 |
| TS7 | Malformed + parseable-but-invalid YAML → `ConfigError`, no overwrite | TASK-04 |
| TS8 | Comments/unknown keys/orchestrator/pre-existing members survive round-trip | TASK-04 |
| TS9 | Sequential + concurrent adds → valid, uncorrupted file, no leftover temp | TASK-03, TASK-04 |
| TS10 | In-process CLI: non-existent council non-zero w/ error log; success exit 0 w/ logs | TASK-05 |
| TS11 | Co-located `*.test.ts`, `.js` specifiers, coverage ≥80% | TASK-07 |
