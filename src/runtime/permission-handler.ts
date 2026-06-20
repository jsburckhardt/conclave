import type { PermissionRequest } from "@github/copilot-sdk";
import type { PermissionRequestContext } from "../permissions/policy.js";

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
