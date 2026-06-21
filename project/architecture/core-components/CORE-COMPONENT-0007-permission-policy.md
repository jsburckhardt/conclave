# CORE-COMPONENT-0007: Permission Policy

## Status

Adopted

## Purpose

Council members are grounded in real repositories. To keep councils safe, members must be read-only by default, with writes allowed only when explicitly granted. A shared permission policy makes this guarantee uniform across members, and it is **enforced in every live Copilot session** through a fail-closed permission handler.

## Scope

Affects how member tool/permission requests are decided (`src/permissions/policy.ts`), how SDK permission requests are translated into policy inputs (`src/runtime/permission-handler.ts`), and how the runtime wires permission handlers into Copilot sessions (`src/runtime/copilot-session-factory.ts`). Boundaries: this component decides approve/deny and the SDK→policy translation; it does not perform the IO being requested, and it does not (yet) govern network egress as a separate policy axis.

## Definition

### Rules
- Member capability is declared in config as `tools: "read-only" | "read-write"`, defaulting to `read-only`.
- `createMemberPermissionPolicy(member)` returns a pure decision function: deny writes for read-only members, otherwise approve. It is the **single source** of the approve/deny rule and must not be re-implemented elsewhere.
- The policy module is decoupled from the Copilot SDK so it can be unit-tested and reused.
- Every member session's `onPermissionRequest` handler is derived from `createMemberPermissionPolicy` via `createPermissionHandler(member, logger?)`. The SDK adapter must not wire `approveAll` for member sessions.
- `toPermissionRequestContext(request)` is a pure, side-effect-free function that maps an SDK `PermissionRequest` (discriminated by `kind`) to a `PermissionRequestContext` (`{ writes?, tool? }`); it translates then delegates and must not re-implement the read-only check.
- The mapping is **fail-closed**: any unknown/future `kind`, any request missing a mutation signal, and every `memory` request are classified `writes: true`. Only `read` and `url` are classified `writes: false`.
- Permission `feedback` and decision logs must never contain filesystem paths, diffs, command text, URLs, tool arguments, memory facts, or the session working directory. The only safe-to-emit fields are `member`, `kind`, `decision`, and — as the context `tool` hint only — the `toolName` for `mcp` / `custom-tool` / `hook`.
- The handler returns SDK-shaped results only: `{ kind: "approve-once" }` on approve and `{ kind: "reject", feedback: "Denied: member is read-only" }` on deny. It must never return `{ kind: "no-result" }`, never return `undefined`, and never throw.
- Each decision is logged exactly once via the structured logger (CORE-COMPONENT-0005) as the `permission.decision` event with fields `{ member, kind, decision }`.

### SDK request → `writes` mapping (`@github/copilot-sdk@1.0.2`, 10 kinds)

| `kind` | `writes` | `tool` hint | Rationale |
|--------|----------|-------------|-----------|
| `read` | `false` | `kind` | Inert read; no mutation. |
| `url` | `false` | `kind` | Workspace not mutated; network egress is a deliberate future policy axis. |
| `write` | `true` | `kind` | Mutates files. |
| `shell` | `true` | `kind` | May mutate the workspace; least-privilege. |
| `extension-management` | `true` | `kind` | Mutates extension state. |
| `extension-permission-access` | `true` | `kind` | Grants capabilities; fail-closed. |
| `mcp` | `true` | `toolName` | Side effects unknown; fail-closed (the SDK `readOnly` hint is ignored in v0). |
| `custom-tool` | `true` | `toolName` | Side effects unknown; fail-closed. |
| `hook` | `true` | `toolName` | Side effects unknown; fail-closed. |
| `memory` | `true` | `kind` | `store` and `vote` both mutate persistent memory; no read-only variant exists. |
| _unknown / future_ | `true` | `kind` or `"unknown"` | Fail-closed `default` branch. |

**Memory note.** `@github/copilot-sdk@1.0.2` `PermissionRequestMemory` exposes only `action?: "store" | "vote"` and `direction?: "upvote" | "downvote"` (vote sentiment — not read vs. write). Because no inert/read memory variant exists and both operations mutate persistent state, every `memory` request is classified `writes: true` and denied for read-only members.

### Interfaces
- `createMemberPermissionPolicy(member: MemberConfig): MemberPermissionPolicy`
- `type MemberPermissionPolicy = (request: PermissionRequestContext) => PermissionDecision`
- `type PermissionDecision = "approve" | "deny"`
- `toPermissionRequestContext(request: PermissionRequest): PermissionRequestContext`
- `createPermissionHandler(member: MemberConfig, logger?: Logger): PermissionHandler`
- SDK result shapes: approve → `{ kind: "approve-once" }`; deny → `{ kind: "reject"; feedback?: string }`.

### Expectations
- Read-only members never receive approval for write operations, including ambiguous, malformed, or future request kinds.
- Permission decisions are deterministic and side-effect free; the mapper and policy are pure and safe under concurrent evaluation.
- The handler always returns a valid SDK `PermissionRequestResult`; it never returns `undefined` / `no-result` and never throws.
- No filesystem paths or secrets appear in `feedback` or logs.

## Rationale

Separating the decision (pure function) from the SDK handler keeps the safety rule testable and independent of the evolving SDK permission API. A thin, pure translation layer (`toPermissionRequestContext`) lets the runtime enforce the rule on every live session while the single-sourced policy remains the one place the approve/deny logic lives. Fail-closed defaults ensure new or unrecognized SDK permission kinds cannot silently bypass the read-only guarantee.

## Usage Examples

```ts
import { createPermissionHandler } from "conclave";

const handler = createPermissionHandler(
  { id: "project-x", cwd: ".", role: "Source of truth", tools: "read-only" },
  logger,
);

// The SDK invokes handler(request, { sessionId }) per permission prompt:
//   write / shell / memory / mcp / ... => { kind: "reject", feedback: "Denied: member is read-only" }
//   read / url                         => { kind: "approve-once" }
```

## Integration Guidelines

- Derive every member's permission handler from `createPermissionHandler` (which builds on `createMemberPermissionPolicy`); never wire `approveAll` for member sessions.
- Express capability through config `tools`, not ad hoc checks.
- When the SDK adds a new permission `kind`, extend `toPermissionRequestContext` explicitly; until then the fail-closed `default` denies it for read-only members.
- Log every decision through the shared logger (CORE-COMPONENT-0005) passing only `{ member, kind, decision }`.

## Exceptions

- The orchestrator member may be granted `read-write` to write artifacts when `orchestrator.policy.writeArtifacts` is enabled.
- Relaxing the fail-closed classification by honoring SDK refinement hints (`mcp.readOnly`, `shell.commands[].readOnly`, `shell.hasWriteFileRedirection`) is a deliberate future enhancement and is out of scope for this component today.

## Enforcement

- [x] Automated checks (mapper + handler unit tests; lint fails on the unused `approveAll` import)
- [x] Code review checklist
- [x] Test coverage requirements (`src/runtime/permission-handler.ts` exercised to >=80% across all kinds, memory variants, and the fail-closed default; a security test asserts no path leakage in `feedback` or logs)

## Related ADRs

- [ADR-0002-typescript-copilot-sdk-runtime](../ADR/ADR-0002-typescript-copilot-sdk-runtime.md)

## Related Core-Components

- [CORE-COMPONENT-0003-configuration](./CORE-COMPONENT-0003-configuration.md) — source of `tools` and the read-only default.
- [CORE-COMPONENT-0005-logging-observability](./CORE-COMPONENT-0005-logging-observability.md) — structured logging of each permission decision.
