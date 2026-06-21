import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";

describe("createLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function spyStreams() {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    return { out, err };
  }

  it("writes info records as a single JSON line to stdout with fields", () => {
    const { out, err } = spyStreams();
    const logger = createLogger();

    logger.info("council.init", { name: "demo" });

    expect(out).toHaveBeenCalledTimes(1);
    expect(err).not.toHaveBeenCalled();
    const line = out.mock.calls[0][0] as string;
    expect(line.endsWith("\n")).toBe(true);
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(record.level).toBe("info");
    expect(record.message).toBe("council.init");
    expect(record.name).toBe("demo");
    expect(typeof record.ts).toBe("string");
  });

  it("routes warn and error records to stderr", () => {
    const { out, err } = spyStreams();
    const logger = createLogger();

    logger.warn("council.warn");
    logger.error("council.error", { error: "boom" });

    expect(out).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(2);
    expect(JSON.parse(err.mock.calls[0][0] as string).level).toBe("warn");
    const errorRecord = JSON.parse(err.mock.calls[1][0] as string) as Record<string, unknown>;
    expect(errorRecord.level).toBe("error");
    expect(errorRecord.error).toBe("boom");
  });

  it("suppresses records below the configured minimum level", () => {
    const { out, err } = spyStreams();
    const logger = createLogger();

    logger.debug("council.debug");

    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });

  it("emits debug records when the minimum level is debug", () => {
    const { out } = spyStreams();
    const logger = createLogger("debug");

    logger.debug("council.debug", { detail: 1 });

    expect(out).toHaveBeenCalledTimes(1);
    expect(JSON.parse(out.mock.calls[0][0] as string).level).toBe("debug");
  });
});
