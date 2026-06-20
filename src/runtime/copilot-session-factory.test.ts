import { describe, it, expect } from "vitest";
import {
  approveAll,
  type CopilotClient,
  type CopilotSession,
  type PermissionRequest,
  type SessionConfig,
} from "@github/copilot-sdk";
import { CopilotSessionFactory } from "./copilot-session-factory.js";
import { SessionError } from "../errors.js";
import type { MemberConfig } from "../config/council-config.js";
import type { Logger, LogFields } from "../logging/logger.js";

function makeMember(tools: "read-only" | "read-write"): MemberConfig {
  return { id: "m1", cwd: ".", role: "tester", tools };
}

function capturingLogger(): Logger & { records: Array<{ message: string; fields?: LogFields }> } {
  const records: Array<{ message: string; fields?: LogFields }> = [];
  const push = (message: string, fields?: LogFields): void => {
    records.push({ message, fields });
  };
  return { records, debug: push, info: push, warn: push, error: push };
}

interface FakeClientHandle {
  client: CopilotClient;
  state: { config?: SessionConfig; stopped: boolean };
}

/** Fake {@link CopilotClient} that captures the SessionConfig; no live SDK session. */
function fakeClient(stopErrors: unknown[] = []): FakeClientHandle {
  const state: { config?: SessionConfig; stopped: boolean } = { stopped: false };
  const client = {
    start: async (): Promise<void> => {},
    createSession: async (config: SessionConfig): Promise<CopilotSession> => {
      state.config = config;
      return {
        sendAndWait: async () => ({ data: { content: "ok" } }),
      } as unknown as CopilotSession;
    },
    stop: async (): Promise<unknown[]> => {
      state.stopped = true;
      return stopErrors;
    },
  };
  return { client: client as unknown as CopilotClient, state };
}

const writeRequest = {
  kind: "write",
  fileName: "/abs/secret.txt",
  diff: "d",
  intention: "x",
} as unknown as PermissionRequest;

const readRequest = {
  kind: "read",
  path: "/abs/x",
  intention: "x",
} as unknown as PermissionRequest;

// ---------------------------------------------------------------------------
// TP-12 — factory wires a non-approveAll, policy-derived handler (Task T5)
// ---------------------------------------------------------------------------

describe("CopilotSessionFactory", () => {
  it("installs a policy-derived handler (not approveAll) that rejects read-only writes (TP-12, C1, C2)", async () => {
    const { client, state } = fakeClient();
    const factory = new CopilotSessionFactory(client, capturingLogger());

    await factory.start();
    const session = await factory.createSession(makeMember("read-only"), "council-x");

    const config = state.config;
    expect(config).toBeDefined();
    expect(config?.sessionId).toBe("council-x/m1");
    expect(config?.workingDirectory).toBe(".");

    const handler = config?.onPermissionRequest;
    expect(handler).toBeDefined();
    expect(handler).not.toBe(approveAll);

    expect(await handler!(writeRequest, { sessionId: "council-x/m1" })).toEqual({
      kind: "reject",
      feedback: "Denied: member is read-only",
    });
    expect(await handler!(readRequest, { sessionId: "council-x/m1" })).toEqual({
      kind: "approve-once",
    });

    // The wrapped MemberSession still relays prompts.
    expect(await session.sendAndWait("hi")).toBe("ok");
  });

  it("stop() resolves cleanly and surfaces client errors as SessionError", async () => {
    const ok = fakeClient();
    const okFactory = new CopilotSessionFactory(ok.client, capturingLogger());
    await expect(okFactory.stop()).resolves.toBeUndefined();
    expect(ok.state.stopped).toBe(true);

    // No logger argument exercises the `logger ?? createLogger()` default branch.
    const failing = fakeClient([new Error("boom")]);
    const failingFactory = new CopilotSessionFactory(failing.client);
    await expect(failingFactory.stop()).rejects.toBeInstanceOf(SessionError);
  });
});
