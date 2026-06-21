import { describe, it, expect } from "vitest";
import type { PermissionRequest } from "@github/copilot-sdk";
import { createPermissionHandler, toPermissionRequestContext } from "./permission-handler.js";
import type { Logger, LogFields } from "../logging/logger.js";
import type { MemberConfig } from "../config/council-config.js";

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

// ---------------------------------------------------------------------------
// Handler fixtures
// ---------------------------------------------------------------------------

function makeMember(tools: "read-only" | "read-write"): MemberConfig {
  return { id: "m1", cwd: ".", role: "tester", tools };
}

interface CapturedLog {
  message: string;
  fields?: LogFields;
}

/** A fake {@link Logger} that records every call for assertions. */
function capturingLogger(): Logger & { records: CapturedLog[] } {
  const records: CapturedLog[] = [];
  const push = (message: string, fields?: LogFields): void => {
    records.push({ message, fields });
  };
  return { records, debug: push, info: push, warn: push, error: push };
}

const invocation = { sessionId: "council-x/m1" };

// ---------------------------------------------------------------------------
// TP-04 … TP-11 — fail-closed, single-sourced, logged handler (Task T4)
// ---------------------------------------------------------------------------

describe("createPermissionHandler", () => {
  it("read-only member denies a write (TP-04, C4, T-b)", async () => {
    const handler = createPermissionHandler(makeMember("read-only"), capturingLogger());
    const result = await handler(requestBuilders.write(), invocation);
    expect(result).toEqual({ kind: "reject", feedback: "Denied: member is read-only" });
  });

  it("read-only member approves read and url (TP-05, C5, T-b)", async () => {
    const handler = createPermissionHandler(makeMember("read-only"));
    expect(await handler(requestBuilders.read(), invocation)).toEqual({ kind: "approve-once" });
    expect(await handler(requestBuilders.url(), invocation)).toEqual({ kind: "approve-once" });
  });

  it("read-write member approves write and shell — not over-locked (TP-06, C6, E4, T-c)", async () => {
    const handler = createPermissionHandler(makeMember("read-write"));
    expect(await handler(requestBuilders.write(), invocation)).toEqual({ kind: "approve-once" });
    expect(await handler(requestBuilders.shell(), invocation)).toEqual({ kind: "approve-once" });
  });

  it("read-only member denies unknown, malformed, and memory requests (TP-07, E1, E2, E3, T-d)", async () => {
    const handler = createPermissionHandler(makeMember("read-only"));
    const reject = { kind: "reject", feedback: "Denied: member is read-only" };
    expect(await handler(unknownRequest(), invocation)).toEqual(reject);
    expect(await handler(malformedRequest(), invocation)).toEqual(reject);
    expect(
      await handler(
        { kind: "memory", fact: "f", action: "vote" } as unknown as PermissionRequest,
        invocation,
      ),
    ).toEqual(reject);
  });

  it("returns SDK-shaped results, not internal approve/deny strings (TP-08, T-e)", async () => {
    const readOnly = createPermissionHandler(makeMember("read-only"));
    const readWrite = createPermissionHandler(makeMember("read-write"));
    const denied = await readOnly(requestBuilders.write(), invocation);
    const approved = await readWrite(requestBuilders.write(), invocation);
    for (const result of [denied, approved]) {
      expect(typeof result).toBe("object");
      expect(result).not.toBe("approve");
      expect(result).not.toBe("deny");
      expect(["approve-once", "reject"]).toContain((result as { kind: string }).kind);
    }
    expect((denied as { kind: string }).kind).toBe("reject");
    expect((approved as { kind: string }).kind).toBe("approve-once");
  });

  it("logs exactly { member, kind, decision } per call and is safe without a logger (TP-09, C8)", async () => {
    const log = capturingLogger();
    const handler = createPermissionHandler(makeMember("read-only"), log);

    await handler(requestBuilders.write(), invocation);
    await handler(requestBuilders.read(), invocation);

    expect(log.records).toHaveLength(2);
    expect(log.records[0]).toEqual({
      message: "permission.decision",
      fields: { member: "m1", kind: "write", decision: "deny" },
    });
    expect(log.records[1]).toEqual({
      message: "permission.decision",
      fields: { member: "m1", kind: "read", decision: "approve" },
    });
    // No keys beyond the three safe fields.
    expect(Object.keys(log.records[0].fields ?? {}).sort()).toEqual(["decision", "kind", "member"]);

    // Logger omitted: must not throw and still return a valid result.
    const noLogHandler = createPermissionHandler(makeMember("read-only"));
    expect(await noLogHandler(requestBuilders.write(), invocation)).toEqual({
      kind: "reject",
      feedback: "Denied: member is read-only",
    });
  });

  it("never leaks a filesystem path into feedback or logs (TP-10, C7, T-f)", async () => {
    const log = capturingLogger();
    const handler = createPermissionHandler(makeMember("read-only"), log);

    // Exercise every sink-bearing kind: write/shell/mcp/memory.
    for (const build of [
      requestBuilders.write,
      requestBuilders.shell,
      requestBuilders.mcp,
      requestBuilders.memory,
    ]) {
      const result = await handler(build(), invocation);
      expect((result as { kind: string }).kind).toBe("reject");
      expect((result as { feedback: string }).feedback).toBe("Denied: member is read-only");
      assertNoLeak(JSON.stringify(result));
    }
    assertNoLeak(JSON.stringify(log.records));
  });

  it("is total over all kinds and never throws or returns undefined (TP-11, E5, E7)", async () => {
    const handler = createPermissionHandler(makeMember("read-only"));
    const allRequests: PermissionRequest[] = [
      ...Object.values(requestBuilders).map((build) => build()),
      unknownRequest(),
      malformedRequest(),
    ];
    for (const request of allRequests) {
      let result: unknown;
      expect(() => {
        result = handler(request, invocation);
      }).not.toThrow();
      const resolved = await result;
      expect(resolved).toBeDefined();
      expect(["approve-once", "reject"]).toContain((resolved as { kind: string }).kind);
      expect((resolved as { kind: string }).kind).not.toBe("no-result");
    }

    // Sequential, independent evaluation: a prior deny does not taint a later approve.
    expect(await handler(requestBuilders.write(), invocation)).toEqual({
      kind: "reject",
      feedback: "Denied: member is read-only",
    });
    expect(await handler(requestBuilders.read(), invocation)).toEqual({ kind: "approve-once" });
  });
});
