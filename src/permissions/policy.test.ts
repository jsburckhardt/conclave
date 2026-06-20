import { describe, it, expect } from "vitest";
import { createMemberPermissionPolicy, type PermissionRequestContext } from "./policy.js";
import type { MemberConfig } from "../config/council-config.js";

function makeMember(tools: "read-only" | "read-write"): MemberConfig {
  return { id: "test-member", cwd: ".", role: "tester", tools };
}

describe("createMemberPermissionPolicy", () => {
  it("denies write requests for read-only members", () => {
    const policy = createMemberPermissionPolicy(makeMember("read-only"));
    const request: PermissionRequestContext = { writes: true, tool: "editFiles" };
    expect(policy(request)).toBe("deny");
  });

  it("approves read requests for read-only members", () => {
    const policy = createMemberPermissionPolicy(makeMember("read-only"));
    const request: PermissionRequestContext = { writes: false, tool: "readFile" };
    expect(policy(request)).toBe("approve");
  });

  it("approves requests without writes flag for read-only members", () => {
    const policy = createMemberPermissionPolicy(makeMember("read-only"));
    const request: PermissionRequestContext = { tool: "search" };
    expect(policy(request)).toBe("approve");
  });

  it("approves write requests for read-write members", () => {
    const policy = createMemberPermissionPolicy(makeMember("read-write"));
    const request: PermissionRequestContext = { writes: true, tool: "editFiles" };
    expect(policy(request)).toBe("approve");
  });

  it("approves read requests for read-write members", () => {
    const policy = createMemberPermissionPolicy(makeMember("read-write"));
    const request: PermissionRequestContext = { writes: false };
    expect(policy(request)).toBe("approve");
  });
});
