import type { PermissionHandler, PermissionRequest } from "@github/copilot-sdk";
import type { MemberConfig } from "../config/council-config.js";
import type { Logger } from "../logging/logger.js";
import {
  createMemberPermissionPolicy,
  type PermissionRequestContext,
} from "../permissions/policy.js";

/** Constant, path-free feedback returned to the SDK on every deny. */
const READ_ONLY_FEEDBACK = "Denied: member is read-only";

/**
 * Pure, side-effect-free translation of an SDK {@link PermissionRequest} into the
 * SDK-decoupled {@link PermissionRequestContext} consumed by the permission policy
 * (CORE-COMPONENT-0007). It **translates** the request into policy inputs; it never
 * re-implements the approve/deny rule (that stays single-sourced in `policy.ts`).
 *
 * The mapping is **fail-closed**: only `read` and `url` are classified as inert
 * (`writes: false`); every other kind — including `memory` (which has no read-only
 * variant) and any unknown/future/malformed kind via the `default` branch — is
 * classified `writes: true`. Only path-free hints are copied into the context: the
 * `toolName` for `mcp`/`custom-tool`/`hook`, otherwise the request `kind`. Filesystem
 * paths, diffs, command text, URLs, tool arguments, and memory facts are never read or
 * copied, satisfying the no-path security guarantee.
 */
export function toPermissionRequestContext(request: PermissionRequest): PermissionRequestContext {
  switch (request.kind) {
    case "read":
    case "url":
      return { writes: false, tool: request.kind };
    case "write":
    case "shell":
    case "extension-management":
    case "extension-permission-access":
    case "memory":
      return { writes: true, tool: request.kind };
    case "mcp":
    case "custom-tool":
    case "hook":
      return { writes: true, tool: request.toolName };
    default: {
      // Unknown / future / malformed kinds: fail closed and never leak fields.
      const fallbackKind = (request as unknown as { kind?: string }).kind;
      return { writes: true, tool: fallbackKind ?? "unknown" };
    }
  }
}

/**
 * Build an SDK {@link PermissionHandler} for a council member that **enforces** the
 * read-only policy on every live session. It *translates then delegates*: each SDK
 * request is mapped via {@link toPermissionRequestContext} and the approve/deny
 * decision is made by the single-sourced `createMemberPermissionPolicy` (the rule is
 * never re-implemented here).
 *
 * Each decision is logged once via the structured logger (CORE-COMPONENT-0005) as the
 * `permission.decision` event with exactly `{ member, kind, decision }` — never a path,
 * diff, command, URL, args, or memory fact. The handler returns SDK-shaped results
 * only: `{ kind: "approve-once" }` on approve and
 * `{ kind: "reject", feedback: "Denied: member is read-only" }` on deny. It never
 * throws, never returns `undefined`, and never returns `{ kind: "no-result" }`.
 */
export function createPermissionHandler(member: MemberConfig, logger?: Logger): PermissionHandler {
  const decide = createMemberPermissionPolicy(member);
  return (request) => {
    const decision = decide(toPermissionRequestContext(request));
    logger?.info("permission.decision", {
      member: member.id,
      kind: request.kind,
      decision,
    });
    if (decision === "deny") {
      return { kind: "reject", feedback: READ_ONLY_FEEDBACK };
    }
    return { kind: "approve-once" };
  };
}
