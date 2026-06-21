# Test Plan: Issue #4 — Enforce read-only member permissions in Copilot sessions

## Scope & Strategy

Validate that the read-only policy is **enforced** on every live session through a pure
SDK→policy mapper (`toPermissionRequestContext`) and a fail-closed handler
(`createPermissionHandler`), with the approve/deny rule still single-sourced in
`src/permissions/policy.ts`. Tests are deterministic, use **fabricated `PermissionRequest`
objects** (no live `CopilotClient`/session), and assert SDK-shaped results and the no-path
security guarantee.

## Test Infrastructure & Conventions (verified)

- **Runner:** `vitest`; `vitest.config.ts` sets `environment: "node"` **globally** and
  `include: ["src/**/*.test.ts"]`. ⇒ **No** `// @vitest-environment node` pragma is needed.
- **Location:** co-locate `src/runtime/permission-handler.test.ts` next to the source. The
  optional factory test lives in `src/runtime/copilot-session-factory.test.ts`.
- **ESM/NodeNext:** import specifiers use `.js` extensions (`./permission-handler.js`,
  `../permissions/policy.js`).
- **Coverage (v8):** thresholds **80%** on lines/functions/branches/statements;
  `include: ["src/**/*.ts"]`, `exclude: ["src/**/*.test.ts", "src/cli.ts"]`. The new
  `src/runtime/permission-handler.ts` is included and must hit every branch (10-way switch +
  `default` + `kind ?? "unknown"` nullish + handler approve/deny + `logger?` both ways).
- **Validation commands (harness-first):**
  - `./harness lint` → `eslint . && prettier --check && tsc --noEmit`
  - `./harness test` → `vitest run` (coverage thresholds enforced)
  - `./harness build` → `tsc -p tsconfig.json`
  - `./harness verify` → lint + test + build (baseline **pass**: 5 files / 18 tests)
  - Use direct `npm`/`vitest` only if the harness lacks a verb or reports `unknown`/`degraded`;
    record any bypass with `./harness friction add`.

## Shared Fixtures (described, to implement in the test file)

- `makeMember(tools: "read-only" | "read-write"): MemberConfig` →
  `{ id: "m1", cwd: ".", role: "tester", tools }` (mirrors `policy.test.ts`).
- **Request builders** returning minimally-valid `PermissionRequest` objects per `kind`,
  including path/secret fields to prove they are never copied, e.g.:
  - `write` → `{ kind: "write", fileName: "/home/user/secret/.env", diff: "…", intention: "x", canOfferSessionApproval: false }`
  - `read` → `{ kind: "read", path: "/etc/passwd", intention: "x" }`
  - `url` → `{ kind: "url", url: "https://evil.example", intention: "x" }`
  - `shell` → `{ kind: "shell", fullCommandText: "rm -rf /tmp/x", possiblePaths: ["/tmp/x"], possibleUrls: [], commands: [], hasWriteFileRedirection: true, intention: "x", canOfferSessionApproval: false }`
  - `mcp` → `{ kind: "mcp", toolName: "gh_create_issue", toolTitle: "t", serverName: "s", readOnly: false, args: { token: "secret" } }`
  - `custom-tool` → `{ kind: "custom-tool", toolName: "my_tool", toolDescription: "d", args: { p: "/abs/path" } }`
  - `hook` → `{ kind: "hook", toolName: "pre_write", toolArgs: { p: "/abs/path" } }`
  - `extension-management` → `{ kind: "extension-management", operation: "reload" }`
  - `extension-permission-access` → `{ kind: "extension-permission-access", capabilities: ["fs"], extensionName: "e" }`
  - `memory` → `{ kind: "memory", fact: "absolute /secret/fact", action, direction, subject: "s", citations: "c" }`
  - unknown → `{ kind: "future-kind", fileName: "/abs/leak" } as unknown as PermissionRequest`
  - malformed → `{} as unknown as PermissionRequest`
- `capturingLogger()` → a fake `Logger` whose `info/debug/warn/error` push
  `{ message, fields }` into an array for assertions.
- Cast fabricated objects with `as unknown as PermissionRequest` where fields are partial;
  never import or start a real `CopilotClient`.

---

## Test TP-01: Mapper returns correct `writes`/`tool` for every known and unknown kind

- **Type:** Unit (table-driven)
- **Task:** T3
- **Priority:** High

### Setup
Build a table of `{ request, expectedWrites, expectedTool }` covering all 10 SDK kinds, one
**unknown** kind, and one **malformed** `{}` request, using the shared request builders.

### Steps
1. For each row, call `toPermissionRequestContext(request)`.
2. Assert `result.writes === expectedWrites`.
3. Assert `result.tool === expectedTool` (`toolName` for `mcp`/`custom-tool`/`hook`; the
   `kind` for the rest; `"unknown"` for malformed).
4. Assert the serialized `result` (`JSON.stringify`) contains none of the request's
   path/secret values (`fileName`, `path`, `url`, `fullCommandText`, `args` values, `fact`).

### Expected Result
- `read`, `url` → `writes: false`; all of `write`, `shell`, `extension-management`,
  `extension-permission-access`, `memory`, `mcp`, `custom-tool`, `hook` → `writes: true`;
  unknown and malformed → `writes: true` (fail-closed `default`, exercising the
  `kind ?? "unknown"` nullish branch). No path/secret appears in any `tool`. Covers
  **C3, C4, C5, C7, E1, E2** and AC **T-a**.

---

## Test TP-02: Mapper classifies every `memory` variant as a write (Decision 1)

- **Type:** Unit (table-driven)
- **Task:** T3
- **Priority:** High

### Setup
Build `memory` requests for the full cross-product of `action ∈ {"store","vote",undefined}`
and `direction ∈ {"upvote","downvote",undefined}`.

### Steps
1. Call `toPermissionRequestContext` for each variant.
2. Assert `writes === true` for every combination.
3. Assert `tool === "memory"` and no `fact`/`subject`/`citations` value leaks into `tool`.

### Expected Result
- All `memory` variants → `writes: true` regardless of `action`/`direction`, documenting the
  committed memory mapping (no read-only memory variant exists in the SDK). Covers the
  re-expressed **E3** (mapper side).

---

## Test TP-03: Mapper is pure and deterministic

- **Type:** Unit
- **Task:** T3
- **Priority:** Medium

### Setup
Pick a representative `write` and a `read` request; deep-clone each before the call.

### Steps
1. Call `toPermissionRequestContext(request)` twice for the same input.
2. Assert the two results are deep-equal.
3. Assert the input object is unchanged versus its pre-call clone (no mutation).

### Expected Result
- Identical outputs for identical inputs and zero input mutation, demonstrating purity and
  concurrency-safety. Covers **E6** (and supports **E5**).

---

## Test TP-04: Read-only member denies a write through the handler

- **Type:** Unit
- **Task:** T4
- **Priority:** High

### Setup
`const handler = createPermissionHandler(makeMember("read-only"), capturingLogger())`.

### Steps
1. Invoke `handler(writeRequest, { sessionId: "c/m1" })` (await in case of a promise).
2. Inspect the result.

### Expected Result
- Result is exactly `{ kind: "reject", feedback: "Denied: member is read-only" }`. Covers
  **C4** and AC **T-b** (deny side).

---

## Test TP-05: Read-only member approves `read` and `url` through the handler

- **Type:** Unit
- **Task:** T4
- **Priority:** High

### Setup
Read-only handler as in TP-04.

### Steps
1. Invoke the handler with a `read` request, then a `url` request.

### Expected Result
- Both return `{ kind: "approve-once" }`. Covers **C5** and AC **T-b** (approve side).

---

## Test TP-06: `read-write` member approves a write (not over-locked)

- **Type:** Unit
- **Task:** T4
- **Priority:** High

### Setup
`const handler = createPermissionHandler(makeMember("read-write"))`.

### Steps
1. Invoke the handler with a `write` request and with a `shell` request.

### Expected Result
- Both return `{ kind: "approve-once" }`. Covers **C6, E4** and AC **T-c**.

---

## Test TP-07: Read-only member denies unknown, malformed, and memory requests

- **Type:** Unit
- **Task:** T4
- **Priority:** High

### Setup
Read-only handler.

### Steps
1. Invoke the handler with: an unknown-kind request, a malformed `{}` request, and a
   `memory` request (e.g. `action: "vote"`).

### Expected Result
- All three return `{ kind: "reject", feedback: "Denied: member is read-only" }`
  (fail-closed). Covers **E1, E2, E3** and AC **T-d**.

---

## Test TP-08: Handler returns SDK-shaped results, not internal strings

- **Type:** Unit
- **Task:** T4
- **Priority:** High

### Setup
Read-only and read-write handlers.

### Steps
1. Collect results for a denied and an approved request.
2. Assert each result is an object with a `kind` field.
3. Assert results are **not** the strings `"approve"` / `"deny"` and `kind` is one of
   `"approve-once"` / `"reject"`.

### Expected Result
- Results match the SDK `PermissionRequestResult` shapes; the internal
  `"approve"`/`"deny"` policy strings never leak to the SDK boundary. Covers AC **T-e**.

---

## Test TP-09: Each decision is logged with only `{ member, kind, decision }`

- **Type:** Unit
- **Task:** T4
- **Priority:** High

### Setup
`const log = capturingLogger(); const handler = createPermissionHandler(makeMember("read-only"), log);`

### Steps
1. Invoke the handler with a `write` (deny) and a `read` (approve).
2. Inspect the captured records.
3. Separately, build a handler **without** a logger and invoke it once.

### Expected Result
- Exactly one record per call with `message === "permission.decision"` and
  `fields === { member: "m1", kind: "write" | "read", decision: "deny" | "approve" }` and no
  other keys. The no-logger handler does not throw and still returns a valid result
  (exercises the `logger?` optional chain both ways). Covers **C8** and the
  logger-present/absent branches.

---

## Test TP-10: Security — no filesystem path leaks into feedback or logs

- **Type:** Security (unit)
- **Task:** T4
- **Priority:** Critical

### Setup
`const log = capturingLogger();` read-only handler with `log`. Use a write request with an
unmistakable absolute path: `fileName: "/home/user/secret/credentials.json"` (and a
`diff`/`newFileContents` containing the same path).

### Steps
1. Invoke the handler with the write request.
2. Assert the result is a `reject`.
3. Assert `result.feedback` does **not** contain `"/home/user/secret/credentials.json"`
   (nor any `/`-prefixed segment of it).
4. Serialize every captured log record (`JSON.stringify(log.records)`) and assert it does
   **not** contain the path substring, the `diff`, or `newFileContents`.
5. Repeat for a `shell` (`fullCommandText`/`possiblePaths`), `mcp` (`args`), and `memory`
   (`fact`) request to prove no sink leaks.

### Expected Result
- Neither `feedback` (constant `"Denied: member is read-only"`) nor any log field contains a
  path, diff, command text, args, or memory fact. Covers **C7** and AC **T-f** — the core
  security guarantee.

---

## Test TP-11: Handler robustness — total over all kinds, never throws

- **Type:** Unit
- **Task:** T4
- **Priority:** High

### Setup
Read-only handler.

### Steps
1. Iterate every builder (all 10 kinds + unknown + malformed); invoke the handler for each
   inside a try/catch.
2. Assert no invocation throws and each returns a defined object whose `kind` is
   `"approve-once"` or `"reject"` (never `undefined`, never `"no-result"`).
3. Invoke the same handler with two different requests in sequence; assert results are
   evaluated independently (a prior deny does not affect a later approve and vice versa).

### Expected Result
- Every path returns a valid SDK `PermissionRequestResult`; the handler is total and
  side-effect-free across calls. Covers **E5, E7**.

---

## Test TP-12: (Optional) Factory wires a non-`approveAll` handler

- **Type:** Unit / light integration
- **Task:** T5
- **Priority:** Conditional — implement only if a coverage metric drops below 80%

### Setup
A fake `CopilotClient` whose `createSession(config)` captures the `SessionConfig` and returns
a stub session; pass it (and a `capturingLogger()`) to
`new CopilotSessionFactory(fakeClient, log)`.

### Steps
1. `await factory.start()` then `await factory.createSession(makeMember("read-only"), "council-x")`.
2. Read the captured `config.onPermissionRequest`.
3. Assert it is defined and is **not** the SDK `approveAll`.
4. Invoke `config.onPermissionRequest(writeRequest, { sessionId: "council-x/m1" })` and assert
   `{ kind: "reject" }`.

### Expected Result
- The factory installs the policy-derived handler (rejecting a read-only write) rather than
  `approveAll`. Reinforces **C1/C2** with runtime evidence and lifts factory coverage if
  needed.

---

## Test TP-13: Regression — existing policy tests and full suite stay green at >=80%

- **Type:** Regression / coverage gate
- **Task:** T7
- **Priority:** High

### Setup
The complete repository after T3–T6.

### Steps
1. Run `./harness lint` (eslint + prettier + tsc — proves `approveAll` import removed).
2. Run `./harness test` (full `vitest run` with coverage).
3. Run `./harness build` and `./harness verify`.
4. Confirm `src/permissions/policy.test.ts` is unchanged and its 5 tests pass.

### Expected Result
- All harness verbs report **pass**; coverage is **>=80%** on lines/functions/branches/
  statements; the 5 `policy.test.ts` cases pass unmodified (rule remains single-sourced).
  Covers AC **T-g** and **E5** (single-sourcing). If coverage <80%, add TP-12 and re-run.

---

## Coverage Traceability Matrix

| Issue AC | Covered by |
|----------|------------|
| C1 (factory derives handler, no `approveAll`) | T5 lint gate, TP-12 |
| C2 (unused import removed) | T5, TP-13 (lint) |
| C3 (pure exported mapping) | TP-01, TP-03 |
| C4 (read-only denies write/shell/memory/ext-mgmt) | TP-01, TP-04, TP-07 |
| C5 (read-only approves read/url) | TP-01, TP-05 |
| C6 (read-write approves write) | TP-06 |
| C7 (no paths in feedback/logs) | TP-01, TP-09, TP-10 |
| C8 (log member/kind/decision) | TP-09 |
| E1 (unknown → write, deny) | TP-01, TP-07, TP-11 |
| E2 (missing mutation signal → write) | TP-01, TP-07, TP-11 |
| E3 (memory denied; re-expressed) | TP-02, TP-07 |
| E4 (read-write not over-locked) | TP-06 |
| E5 (sequential independent/deterministic) | TP-03, TP-11, TP-13 |
| E6 (concurrent-safe; pure/stateless) | TP-03 |
| E7 (never undefined/throws; valid SDK result) | TP-11 |
| T-a (mapping per kind) | TP-01, TP-02 |
| T-b (read-only deny write / approve read) | TP-04, TP-05 |
| T-c (read-write approves write) | TP-06 |
| T-d (ambiguous/unknown denied) | TP-07 |
| T-e (SDK-shaped results) | TP-08 |
| T-f (security: no path leak) | TP-10 |
| T-g (fabricated objects; coverage >=80%) | TP-01…TP-13 |
