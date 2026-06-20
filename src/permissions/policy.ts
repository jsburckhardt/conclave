import type { MemberConfig } from "../config/council-config.js";

export type PermissionDecision = "approve" | "deny";

export interface PermissionRequestContext {
  /** True when the requested operation would mutate the workspace. */
  writes?: boolean;
  /** Optional tool name associated with the request. */
  tool?: string;
}

export type MemberPermissionPolicy = (request: PermissionRequestContext) => PermissionDecision;

/**
 * Build a permission policy for a council member. Members default to read-only,
 * so any write request is denied unless the member is explicitly `read-write`.
 *
 * This module is deliberately decoupled from the Copilot SDK so the policy can
 * be unit-tested in isolation and wired into session permission handlers later.
 */
export function createMemberPermissionPolicy(member: MemberConfig): MemberPermissionPolicy {
  const readOnly = member.tools !== "read-write";
  return (request) => {
    if (readOnly && request.writes === true) {
      return "deny";
    }
    return "approve";
  };
}
