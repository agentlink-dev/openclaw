import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AskManager } from "../src/ask-manager.js";
import type { AskRecord } from "../src/ask-manager.js";

const TEST_DIR = path.join(os.tmpdir(), `agentlink-test-ask-${process.pid}`);

function makeRecord(overrides: Partial<AskRecord> = {}): AskRecord {
  return {
    id: `ask_${Date.now()}_location.precise`,
    scope: "location.precise",
    contactAgentId: "cersei-1234",
    contactName: "Catherine Safaya",
    description: "home address",
    createdAt: "",
    status: "pending",
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// register + resolve (happy path)
// ---------------------------------------------------------------------------

describe("register + resolve", () => {
  it("resolves Promise with the decision when resolved in time", async () => {
    const mgr = new AskManager(TEST_DIR);
    const record = makeRecord({ id: "ask_happy" });

    const promise = mgr.register(record, 120_000);

    const inTime = mgr.resolve("ask_happy", "allow-once");
    expect(inTime).toBe(true);

    const decision = await promise;
    expect(decision).toBe("allow-once");
  });

  it("writes pending file on register", () => {
    const mgr = new AskManager(TEST_DIR);
    const record = makeRecord({ id: "ask_file_write" });

    mgr.register(record, 120_000);

    const filePath = path.join(TEST_DIR, "pending-asks", "ask_file_write.json");
    expect(fs.existsSync(filePath)).toBe(true);

    const saved = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(saved.status).toBe("pending");
    expect(saved.scope).toBe("location.precise");
  });

  it("updates file on resolve", async () => {
    const mgr = new AskManager(TEST_DIR);
    const record = makeRecord({ id: "ask_file_resolve" });

    const promise = mgr.register(record, 120_000);
    mgr.resolve("ask_file_resolve", "allow-always-contact");
    await promise;

    const filePath = path.join(TEST_DIR, "pending-asks", "ask_file_resolve.json");
    const saved = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(saved.status).toBe("resolved");
    expect(saved.decision).toBe("allow-always-contact");
    expect(saved.resolvedAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// timeout
// ---------------------------------------------------------------------------

describe("timeout", () => {
  it("resolves with 'timeout' after timeoutMs", async () => {
    const mgr = new AskManager(TEST_DIR);
    const record = makeRecord({ id: "ask_timeout" });

    const promise = mgr.register(record, 5_000);

    vi.advanceTimersByTime(5_000);

    const decision = await promise;
    expect(decision).toBe("timeout");
  });

  it("updates file with timeout status", async () => {
    const mgr = new AskManager(TEST_DIR);
    const record = makeRecord({ id: "ask_timeout_file" });

    const promise = mgr.register(record, 5_000);
    vi.advanceTimersByTime(5_000);
    await promise;

    const filePath = path.join(TEST_DIR, "pending-asks", "ask_timeout_file.json");
    const saved = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(saved.status).toBe("timeout");
    expect(saved.decision).toBe("timeout");
    expect(saved.resolvedAt).toBeTruthy();
  });

  it("clears from pending map after timeout", async () => {
    const mgr = new AskManager(TEST_DIR);
    const record = makeRecord({ id: "ask_timeout_clear" });

    const promise = mgr.register(record, 5_000);
    vi.advanceTimersByTime(5_000);
    await promise;

    expect(mgr.hasPendingForContact("cersei-1234")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// late reply
// ---------------------------------------------------------------------------

describe("late reply", () => {
  it("returns false when resolving after timeout", async () => {
    const mgr = new AskManager(TEST_DIR);
    const record = makeRecord({ id: "ask_late" });

    const promise = mgr.register(record, 5_000);
    vi.advanceTimersByTime(5_000);
    await promise;

    const inTime = mgr.resolve("ask_late", "allow-always-contact");
    expect(inTime).toBe(false);
  });

  it("still updates file on late reply", async () => {
    const mgr = new AskManager(TEST_DIR);
    const record = makeRecord({ id: "ask_late_file" });

    const promise = mgr.register(record, 5_000);
    vi.advanceTimersByTime(5_000);
    await promise;

    mgr.resolve("ask_late_file", "allow-always-everyone");

    const filePath = path.join(TEST_DIR, "pending-asks", "ask_late_file.json");
    const saved = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(saved.status).toBe("resolved");
    expect(saved.decision).toBe("allow-always-everyone");
  });
});

// ---------------------------------------------------------------------------
// double resolve
// ---------------------------------------------------------------------------

describe("double resolve", () => {
  it("second resolve returns false (already resolved)", async () => {
    const mgr = new AskManager(TEST_DIR);
    const record = makeRecord({ id: "ask_double" });

    const promise = mgr.register(record, 120_000);

    const first = mgr.resolve("ask_double", "allow-once");
    expect(first).toBe(true);

    const second = mgr.resolve("ask_double", "deny");
    expect(second).toBe(false);

    await promise;
  });
});

// ---------------------------------------------------------------------------
// hasPendingForContact
// ---------------------------------------------------------------------------

describe("hasPendingForContact", () => {
  it("returns true while ask is pending", () => {
    const mgr = new AskManager(TEST_DIR);
    const record = makeRecord({ id: "ask_pending_check" });

    mgr.register(record, 120_000);
    expect(mgr.hasPendingForContact("cersei-1234")).toBe(true);
  });

  it("returns false after resolve", async () => {
    const mgr = new AskManager(TEST_DIR);
    const record = makeRecord({ id: "ask_pending_resolved" });

    const promise = mgr.register(record, 120_000);
    mgr.resolve("ask_pending_resolved", "deny");
    await promise;

    expect(mgr.hasPendingForContact("cersei-1234")).toBe(false);
  });

  it("returns false after timeout", async () => {
    const mgr = new AskManager(TEST_DIR);
    const record = makeRecord({ id: "ask_pending_timeout" });

    const promise = mgr.register(record, 5_000);
    vi.advanceTimersByTime(5_000);
    await promise;

    expect(mgr.hasPendingForContact("cersei-1234")).toBe(false);
  });

  it("returns false for unknown contact", () => {
    const mgr = new AskManager(TEST_DIR);
    expect(mgr.hasPendingForContact("unknown-9999")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getPending
// ---------------------------------------------------------------------------

describe("getPending", () => {
  it("returns record from Map when pending", () => {
    const mgr = new AskManager(TEST_DIR);
    const record = makeRecord({ id: "ask_get_pending" });

    mgr.register(record, 120_000);

    const got = mgr.getPending("ask_get_pending");
    expect(got).not.toBeNull();
    expect(got!.scope).toBe("location.precise");
    expect(got!.status).toBe("pending");
  });

  it("falls back to file when timed out (not in Map)", async () => {
    const mgr = new AskManager(TEST_DIR);
    const record = makeRecord({ id: "ask_get_fallback" });

    const promise = mgr.register(record, 5_000);
    vi.advanceTimersByTime(5_000);
    await promise;

    const got = mgr.getPending("ask_get_fallback");
    expect(got).not.toBeNull();
    expect(got!.status).toBe("timeout");
  });

  it("returns null for unknown askId", () => {
    const mgr = new AskManager(TEST_DIR);
    expect(mgr.getPending("nonexistent")).toBeNull();
  });
});
