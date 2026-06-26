import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CouncilStateStore,
  STATE_SCHEMA_VERSION,
  type CouncilState,
} from "./council-state-store.js";
import { CouncilStateStore as RootStateStore } from "../index.js";
import { StateError } from "../errors.js";

const tempDirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "council-state-"));
  tempDirs.push(dir);
  return dir;
}

/** A nested state path whose parent dirs are intentionally absent. */
function statePath(dir: string): string {
  return join(dir, "council", "demo", "state.json");
}

function validState(overrides: Partial<CouncilState> = {}): CouncilState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    councilId: "demo",
    status: "in-progress",
    lastPhase: "draft",
    lastRound: 0,
    members: [
      { id: "proj", sessionId: "demo/proj" },
      { id: "scrum", sessionId: "demo/scrum" },
    ],
    configHash: "abc123",
    createdAt: "2026-06-22T08:00:00.000Z",
    updatedAt: "2026-06-22T08:05:00.000Z",
    products: { backlog: "# Backlog\n- S1" },
    ...overrides,
  };
}

async function writeRaw(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, "utf8");
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("CouncilStateStore", () => {
  it("is exported from the package root", () => {
    expect(RootStateStore).toBe(CouncilStateStore);
  });

  // TP-03: write is atomic, mkdir -p, and round-trips (incl. products).
  it("TP-03: write creates the parent dir, is atomic, and round-trips", async () => {
    const dir = await makeDir();
    const path = statePath(dir);
    const store = new CouncilStateStore(path);

    expect(await store.exists()).toBe(false);
    await store.write(validState());

    const back = await store.read();
    expect(back).toEqual(validState());
    expect(await store.exists()).toBe(true);

    // No leftover atomic-write temp file in the council dir.
    const entries = await readdir(dirname(path));
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
    expect(entries).toContain("state.json");
  });

  // TP-04: missing state.json → typed "no prior run" error.
  it("TP-04: read on a missing file throws an actionable StateError", async () => {
    const dir = await makeDir();
    const store = new CouncilStateStore(statePath(dir));
    const err = await store.read().then(
      () => {
        throw new Error("expected read() to reject");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StateError);
    expect((err as StateError).code).toBe("STATE_ERROR");
    expect((err as Error).message).toContain("council run");
    expect((err as Error).message).toContain("demo");
  });

  // TP-05: corrupt / partial state.json → typed error (never empty/fresh).
  it("TP-05: read on corrupt or partial state throws StateError", async () => {
    const dir = await makeDir();
    const path = statePath(dir);
    const store = new CouncilStateStore(path);

    const corruptVariants = [
      "{ not json",
      JSON.stringify({ schemaVersion: 1 }),
      JSON.stringify(validState({ lastRound: -1 })),
      JSON.stringify({ ...validState(), members: "nope" }),
      JSON.stringify({ ...validState(), members: [{ id: "proj" }] }),
      JSON.stringify({ ...validState(), status: "halfway" }),
      JSON.stringify({ ...validState(), lastPhase: "bogus" }),
      JSON.stringify({ ...validState(), products: { backlog: 5 } }),
      JSON.stringify([1, 2, 3]),
    ];

    for (const body of corruptVariants) {
      await writeRaw(path, body);
      const err = await store.read().then(
        () => {
          throw new Error(`expected read() to reject for: ${body}`);
        },
        (e: unknown) => e,
      );
      expect(err, body).toBeInstanceOf(StateError);
    }
  });

  // TP-06: unknown / newer schemaVersion → typed error (no best-effort parse).
  it("TP-06: read on an incompatible schemaVersion throws StateError", async () => {
    const dir = await makeDir();
    const path = statePath(dir);
    const store = new CouncilStateStore(path);

    for (const schemaVersion of [0, 2, "1", undefined, 1.5]) {
      await writeRaw(path, JSON.stringify({ ...validState(), schemaVersion }));
      const err = await store.read().then(
        () => {
          throw new Error(`expected read() to reject for schemaVersion=${String(schemaVersion)}`);
        },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(StateError);
    }

    // A valid schemaVersion === 1 does NOT reject on this check.
    await writeRaw(path, JSON.stringify(validState()));
    await expect(store.read()).resolves.toMatchObject({ schemaVersion: 1 });
  });

  // TP-07: valid state.json → typed CouncilState.
  it("TP-07: read on a valid file returns the typed CouncilState", async () => {
    const dir = await makeDir();
    const path = statePath(dir);
    await writeRaw(path, JSON.stringify(validState()));
    const store = new CouncilStateStore(path);

    const s = await store.read();
    expect(s.schemaVersion).toBe(1);
    expect(s.councilId).toBe("demo");
    expect(s.status).toBe("in-progress");
    expect(s.lastPhase).toBe("draft");
    expect(s.lastRound).toBe(0);
    expect(s.members).toEqual([
      { id: "proj", sessionId: "demo/proj" },
      { id: "scrum", sessionId: "demo/scrum" },
    ]);
    expect(s.products).toEqual({ backlog: "# Backlog\n- S1" });
  });

  it("round-trips a state without products", async () => {
    const dir = await makeDir();
    const store = new CouncilStateStore(statePath(dir));
    const state = validState({ products: undefined, lastPhase: null, lastRound: 0 });
    await store.write(state);
    const back = await store.read();
    expect(back.products).toBeUndefined();
    expect(back.lastPhase).toBeNull();
  });

  // Thread #3: write failures are normalized to a typed StateError naming the file.
  it("surfaces a filesystem write failure as a StateError", async () => {
    const dir = await makeDir();
    const path = statePath(dir); // <dir>/council/demo/state.json
    // Make the parent ('demo') a FILE so `mkdir -p` of the parent — and thus the
    // write — fails (ENOTDIR/EEXIST) instead of succeeding.
    await mkdir(join(dir, "council"), { recursive: true });
    await writeFile(join(dir, "council", "demo"), "i am a file, not a dir", "utf8");
    const store = new CouncilStateStore(path);

    const err = await store.write(validState()).then(
      () => {
        throw new Error("expected write() to reject");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StateError);
    expect((err as StateError).code).toBe("STATE_ERROR");
    expect((err as Error).message).toContain("Unable to write state file");
  });
});
