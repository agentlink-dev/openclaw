import { describe, it, expect } from "vitest";
import { createA2ASessionManager } from "../src/a2a-session.js";

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

describe("A2A Session Manager", () => {
  describe("exchange counting", () => {
    it("starts at zero exchanges", () => {
      const mgr = createA2ASessionManager(noopLogger);
      expect(mgr.getExchangeCount("agent-x")).toBe(0);
    });

    it("increments exchange count", () => {
      const mgr = createA2ASessionManager(noopLogger);
      expect(mgr.recordExchange("agent-x")).toBe(1);
      expect(mgr.recordExchange("agent-x")).toBe(2);
      expect(mgr.getExchangeCount("agent-x")).toBe(2);
    });

    it("tracks per-contact independently", () => {
      const mgr = createA2ASessionManager(noopLogger);
      mgr.recordExchange("agent-x");
      mgr.recordExchange("agent-x");
      mgr.recordExchange("agent-y");
      expect(mgr.getExchangeCount("agent-x")).toBe(2);
      expect(mgr.getExchangeCount("agent-y")).toBe(1);
    });

    it("pauses at default limit (20)", () => {
      const mgr = createA2ASessionManager(noopLogger);
      for (let i = 0; i < 19; i++) mgr.recordExchange("agent-x");
      expect(mgr.isPaused("agent-x")).toBe(false);
      mgr.recordExchange("agent-x");
      expect(mgr.isPaused("agent-x")).toBe(true);
    });

    it("pauses at custom limit", () => {
      const mgr = createA2ASessionManager(noopLogger, 3);
      mgr.recordExchange("agent-x");
      mgr.recordExchange("agent-x");
      expect(mgr.isPaused("agent-x")).toBe(false);
      mgr.recordExchange("agent-x");
      expect(mgr.isPaused("agent-x")).toBe(true);
    });

    it("reset clears the count", () => {
      const mgr = createA2ASessionManager(noopLogger);
      for (let i = 0; i < 20; i++) mgr.recordExchange("agent-x");
      expect(mgr.isPaused("agent-x")).toBe(true);
      mgr.reset("agent-x");
      expect(mgr.isPaused("agent-x")).toBe(false);
      expect(mgr.getExchangeCount("agent-x")).toBe(0);
    });
  });

  describe("pending relays", () => {
    it("no pending relay by default", () => {
      const mgr = createA2ASessionManager(noopLogger);
      expect(mgr.hasPendingRelay("agent-x")).toBe(false);
      expect(mgr.consumePendingRelay("agent-x")).toBe(false);
    });

    it("set and consume pending relay", () => {
      const mgr = createA2ASessionManager(noopLogger);
      mgr.setPendingRelay("agent-x");
      expect(mgr.hasPendingRelay("agent-x")).toBe(true);
      expect(mgr.consumePendingRelay("agent-x")).toBe(true);
      // Consumed — should be gone
      expect(mgr.hasPendingRelay("agent-x")).toBe(false);
      expect(mgr.consumePendingRelay("agent-x")).toBe(false);
    });

    it("pending relay is per-contact", () => {
      const mgr = createA2ASessionManager(noopLogger);
      mgr.setPendingRelay("agent-x");
      expect(mgr.hasPendingRelay("agent-x")).toBe(true);
      expect(mgr.hasPendingRelay("agent-y")).toBe(false);
    });

    it("multiple setPendingRelay calls are idempotent", () => {
      const mgr = createA2ASessionManager(noopLogger);
      mgr.setPendingRelay("agent-x");
      mgr.setPendingRelay("agent-x");
      expect(mgr.consumePendingRelay("agent-x")).toBe(true);
      expect(mgr.consumePendingRelay("agent-x")).toBe(false);
    });
  });
});
