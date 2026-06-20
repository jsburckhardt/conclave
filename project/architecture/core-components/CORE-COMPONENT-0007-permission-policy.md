# CORE-COMPONENT-0007: Permission Policy

## Status

Adopted

## Purpose

Council members are grounded in real repositories. To keep councils safe, members must be read-only by default, with writes allowed only when explicitly granted. A shared permission policy makes this guarantee uniform across members.

## Scope

Affects how member tool/permission requests are decided (`src/permissions/policy.ts`) and how the runtime wires permission handlers into Copilot sessions. Boundaries: this component decides approve/deny; it does not perform the IO being requested.

## Definition

### Rules
- Member capability is declared in config as `tools: "read-only" | "read-write"`, defaulting to `read-only`.
- `createMemberPermissionPolicy(member)` returns a pure decision function: deny writes for read-only members, otherwise approve.
- The policy module is decoupled from the Copilot SDK so it can be unit-tested and reused.
- v0 wires the SDK adapter with a permissive handler; the read-only policy is the documented target enforced as the orchestrator gains tool-routing (PRD v1).

### Interfaces
- `createMemberPermissionPolicy(member: MemberConfig): MemberPermissionPolicy`
- `type MemberPermissionPolicy = (request: PermissionRequestContext) => PermissionDecision`
- `type PermissionDecision = "approve" | "deny"`

### Expectations
- Read-only members never receive approval for write operations.
- Permission decisions are deterministic and side-effect free.

## Rationale

Separating the decision (pure function) from the SDK handler keeps the safety rule testable and independent of the evolving SDK permission API.

## Usage Examples

```ts
import { createMemberPermissionPolicy } from "conclave";

const decide = createMemberPermissionPolicy({
  id: "project-x",
  cwd: ".",
  role: "Source of truth",
  tools: "read-only",
});
decide({ writes: true }); // => "deny"
```

## Integration Guidelines

- Derive every member's permission handler from `createMemberPermissionPolicy`.
- Express capability through config `tools`, not ad hoc checks.

## Exceptions

- The orchestrator member may be granted `read-write` to write artifacts when `orchestrator.policy.writeArtifacts` is enabled.

## Enforcement

- [ ] Automated checks
- [x] Code review checklist
- [ ] Test coverage requirements

## Related ADRs

- [ADR-0002-typescript-copilot-sdk-runtime](../ADR/ADR-0002-typescript-copilot-sdk-runtime.md)
