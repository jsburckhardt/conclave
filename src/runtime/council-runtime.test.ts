import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CouncilRuntime, type MemberSession, type SessionFactory } from "./council-runtime.js";
import { TranscriptStore } from "../store/transcript-store.js";
import { ArtifactStore } from "../store/artifact-store.js";
import { SessionError } from "../errors.js";
import type { CouncilConfig } from "../config/council-config.js";

function fakeFactory(): SessionFactory {
  return {
    start: async () => {},
    createSession: async (): Promise<MemberSession> => ({
      sendAndWait: async (prompt: string) => `echo: ${prompt}`,
    }),
    stop: async () => {},
  };
}

function sampleConfig(): CouncilConfig {
  return {
    name: "test-council",
    goal: "verify the runtime",
    members: [{ id: "m1", cwd: ".", role: "tester", tools: "read-only" }],
    orchestrator: { cwd: "." },
    artifacts: [],
  };
}

describe("CouncilRuntime", () => {
  it("asks a member and records the exchange in the transcript", async () => {
    const dir = await mkdtemp(join(tmpdir(), "council-"));
    const transcriptPath = join(dir, "transcript.md");
    const runtime = new CouncilRuntime({
      config: sampleConfig(),
      sessionFactory: fakeFactory(),
      transcript: new TranscriptStore(transcriptPath),
      artifacts: new ArtifactStore(dir),
    });

    await runtime.start();
    const reply = await runtime.askMember("m1", "hello");
    await runtime.stop();

    expect(reply).toBe("echo: hello");
    const transcript = await readFile(transcriptPath, "utf8");
    expect(transcript).toContain("hello");
    expect(transcript).toContain("echo: hello");
  });

  it("throws SessionError for an unknown member", async () => {
    const dir = await mkdtemp(join(tmpdir(), "council-"));
    const runtime = new CouncilRuntime({
      config: sampleConfig(),
      sessionFactory: fakeFactory(),
      transcript: new TranscriptStore(join(dir, "t.md")),
      artifacts: new ArtifactStore(dir),
    });
    await runtime.start();
    await expect(runtime.askMember("nope", "hi")).rejects.toBeInstanceOf(SessionError);
  });
});
