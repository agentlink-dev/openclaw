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

  describe("origin context", () => {
    it("no origin context by default", () => {
      const mgr = createA2ASessionManager(noopLogger);
      expect(mgr.getOriginContext("agent-x")).toBeUndefined();
    });

    it("set and get origin context", () => {
      const mgr = createA2ASessionManager(noopLogger);
      const ctx = { sessionKey: "main", channel: "webchat", agentId: "agent-x", timestamp: Date.now() };
      mgr.setOriginContext("agent-x", ctx);
      expect(mgr.getOriginContext("agent-x")).toEqual(ctx);
    });

    it("origin context is per-contact", () => {
      const mgr = createA2ASessionManager(noopLogger);
      const ctx = { sessionKey: "main", channel: "webchat", agentId: "agent-x", timestamp: 1000 };
      mgr.setOriginContext("agent-x", ctx);
      expect(mgr.getOriginContext("agent-x")).toEqual(ctx);
      expect(mgr.getOriginContext("agent-y")).toBeUndefined();
    });
  });

  describe("last exchange time", () => {
    it("returns 0 when no exchanges recorded", () => {
      const mgr = createA2ASessionManager(noopLogger);
      expect(mgr.getLastExchangeTime("agent-x")).toBe(0);
    });

    it("updates on recordExchange", () => {
      const mgr = createA2ASessionManager(noopLogger);
      const before = Date.now();
      mgr.recordExchange("agent-x");
      const after = Date.now();
      const lastTime = mgr.getLastExchangeTime("agent-x");
      expect(lastTime).toBeGreaterThanOrEqual(before);
      expect(lastTime).toBeLessThanOrEqual(after);
    });

    it("tracks per-contact independently", () => {
      const mgr = createA2ASessionManager(noopLogger);
      mgr.recordExchange("agent-x");
      const timeX = mgr.getLastExchangeTime("agent-x");
      expect(timeX).toBeGreaterThan(0);
      expect(mgr.getLastExchangeTime("agent-y")).toBe(0);
    });
  });
});
