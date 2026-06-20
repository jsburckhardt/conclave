import { describe, it, expect } from "vitest";
import type { PermissionRequest } from "@github/copilot-sdk";
import { toPermissionRequestContext } from "./permission-handler.js";

// ---------------------------------------------------------------------------
// Shared fixtures
//
// Fabricated `PermissionRequest` objects (never a live CopilotClient/session).
// Each builder deliberately carries path/secret fields to prove they are never
// copied into the context, feedback, or logs.
// ---------------------------------------------------------------------------

const SECRET_PATH = "/home/user/secret/credentials.json";

/** Substrings that must NEVER appear in a context / feedback / log. */
const LEAK_SUBSTRINGS = [
  SECRET_PATH,
  "/home/user/secret",
  "/etc/passwd",
  "/tmp/x",
  "/abs/path",
  "/abs/leak",
  "rm -rf",
  "https://evil.example",
  "token-secret-value",
  "absolute /secret/fact",
  "/secret/fact",
];

const requestBuilders: Record<string, () => PermissionRequest> = {
  read: () =>
    ({ kind: "read", path: "/etc/passwd", intention: "x" }) as unknown as PermissionRequest,
  url: () =>
    ({ kind: "url", url: "https://evil.example", intention: "x" }) as unknown as PermissionRequest,
  write: () =>
    ({
      kind: "write",
      fileName: SECRET_PATH,
      diff: `--- ${SECRET_PATH}`,
      newFileContents: SECRET_PATH,
      intention: "x",
      canOfferSessionApproval: false,
    }) as unknown as PermissionRequest,
  shell: () =>
    ({
      kind: "shell",
      fullCommandText: "rm -rf /tmp/x",
      possiblePaths: ["/tmp/x"],
      possibleUrls: [],
      commands: [],
      hasWriteFileRedirection: true,
      intention: "x",
      canOfferSessionApproval: false,
    }) as unknown as PermissionRequest,
  "extension-management": () =>
    ({ kind: "extension-management", operation: "reload" }) as unknown as PermissionRequest,
  "extension-permission-access": () =>
    ({
      kind: "extension-permission-access",
      capabilities: ["fs"],
      extensionName: "e",
    }) as unknown as PermissionRequest,
  mcp: () =>
    ({
      kind: "mcp",
      toolName: "gh_create_issue",
      toolTitle: "t",
      serverName: "s",
      readOnly: false,
      args: { token: "token-secret-value", p: "/abs/path" },
    }) as unknown as PermissionRequest,
  "custom-tool": () =>
    ({
      kind: "custom-tool",
      toolName: "my_tool",
      toolDescription: "d",
      args: { p: "/abs/path" },
    }) as unknown as PermissionRequest,
  hook: () =>
    ({
      kind: "hook",
      toolName: "pre_write",
      toolArgs: { p: "/abs/path" },
    }) as unknown as PermissionRequest,
  memory: () =>
    ({
      kind: "memory",
      fact: "absolute /secret/fact",
      action: "store",
      direction: "upvote",
      subject: "s",
      citations: "c",
    }) as unknown as PermissionRequest,
};

const unknownRequest = (): PermissionRequest =>
  ({ kind: "future-kind", fileName: "/abs/leak" }) as unknown as PermissionRequest;

const malformedRequest = (): PermissionRequest => ({}) as unknown as PermissionRequest;

function assertNoLeak(serialized: string): void {
  for (const leak of LEAK_SUBSTRINGS) {
    expect(serialized).not.toContain(leak);
  }
}

// ---------------------------------------------------------------------------
// TP-01 / TP-02 / TP-03 — pure mapper (Task T3)
// ---------------------------------------------------------------------------

describe("toPermissionRequestContext", () => {
  const cases: Array<{ name: string; request: PermissionRequest; writes: boolean; tool: string }> =
    [
      { name: "read", request: requestBuilders.read(), writes: false, tool: "read" },
      { name: "url", request: requestBuilders.url(), writes: false, tool: "url" },
      { name: "write", request: requestBuilders.write(), writes: true, tool: "write" },
      { name: "shell", request: requestBuilders.shell(), writes: true, tool: "shell" },
      {
        name: "extension-management",
        request: requestBuilders["extension-management"](),
        writes: true,
        tool: "extension-management",
      },
      {
        name: "extension-permission-access",
        request: requestBuilders["extension-permission-access"](),
        writes: true,
        tool: "extension-permission-access",
      },
      { name: "mcp", request: requestBuilders.mcp(), writes: true, tool: "gh_create_issue" },
      {
        name: "custom-tool",
        request: requestBuilders["custom-tool"](),
        writes: true,
        tool: "my_tool",
      },
      { name: "hook", request: requestBuilders.hook(), writes: true, tool: "pre_write" },
      { name: "memory", request: requestBuilders.memory(), writes: true, tool: "memory" },
      { name: "unknown kind", request: unknownRequest(), writes: true, tool: "future-kind" },
      { name: "malformed", request: malformedRequest(), writes: true, tool: "unknown" },
    ];

  it.each(cases)("maps $name → writes=$writes, tool=$tool (TP-01)", ({ request, writes, tool }) => {
    const ctx = toPermissionRequestContext(request);
    expect(ctx.writes).toBe(writes);
    expect(ctx.tool).toBe(tool);
  });

  it.each(cases)("never copies path/secret values for $name (TP-01, C7)", ({ request }) => {
    const ctx = toPermissionRequestContext(request);
    assertNoLeak(JSON.stringify(ctx));
  });

  it("classifies every memory variant as a write regardless of action/direction (TP-02, E3)", () => {
    const actions: Array<"store" | "vote" | undefined> = ["store", "vote", undefined];
    const directions: Array<"upvote" | "downvote" | undefined> = ["upvote", "downvote", undefined];
    for (const action of actions) {
      for (const direction of directions) {
        const request = {
          kind: "memory",
          fact: "absolute /secret/fact",
          subject: "s",
          citations: "c",
          action,
          direction,
        } as unknown as PermissionRequest;
        const ctx = toPermissionRequestContext(request);
        expect(ctx.writes).toBe(true);
        expect(ctx.tool).toBe("memory");
        assertNoLeak(JSON.stringify(ctx));
      }
    }
  });

  it("is pure and deterministic: stable output, no input mutation (TP-03, E6)", () => {
    const write = requestBuilders.write();
    const writeClone = structuredClone(write);
    expect(toPermissionRequestContext(write)).toEqual(toPermissionRequestContext(write));
    expect(write).toEqual(writeClone);

    const read = requestBuilders.read();
    const readClone = structuredClone(read);
    expect(toPermissionRequestContext(read)).toEqual(toPermissionRequestContext(read));
    expect(read).toEqual(readClone);
  });
});
