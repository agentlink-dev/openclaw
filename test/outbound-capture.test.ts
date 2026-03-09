import { describe, it, expect } from "vitest";
import { formatInboundMessage, formatPausedMessage, handleIncomingEnvelope } from "../src/channel.js";
import { createEnvelope } from "../src/types.js";
import { createContacts } from "../src/contacts.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

describe("Outbound capture formatting", () => {
  it("formats A2A inbound message with auto-response instruction", () => {
    const envelope = createEnvelope("message", "agent-arya", "Rupul", "agent-cersei", "What meetings does Rupul have?");
    const formatted = formatInboundMessage(envelope);

    expect(formatted).toContain("[AgentLink] Message from Rupul (agent-arya):");
    expect(formatted).toContain("What meetings does Rupul have?");
    expect(formatted).toContain("your text response will be captured and sent back automatically");
    expect(formatted).toContain("Respond naturally");
    expect(formatted).toContain("Do NOT use the agentlink_message tool");
    // Should NOT contain the old anti-loop instruction
    expect(formatted).not.toContain("do not send follow-up");
  });

  it("includes exchange count when A2A context provided", () => {
    const envelope = createEnvelope("message", "agent-arya", "Rupul", "agent-cersei", "Hello");
    const formatted = formatInboundMessage(envelope, { exchangeCount: 3, maxExchanges: 5 });

    expect(formatted).toContain("Exchange 3/5");
    expect(formatted).toContain("pause at the limit");
  });

  it("works without A2A context (no exchange info)", () => {
    const envelope = createEnvelope("message", "agent-arya", "Rupul", "agent-cersei", "Hello");
    const formatted = formatInboundMessage(envelope);

    expect(formatted).not.toContain("Exchange");
  });

  it("formats paused message with contact info", () => {
    const msg = formatPausedMessage("agent-arya", "Rupul", 5);

    expect(msg).toContain("paused after 5 exchanges");
    expect(msg).toContain("Rupul's agent");
    expect(msg).toContain("exchange limit");
    expect(msg).toContain("continue");
  });

  it("formats paused message without human name", () => {
    const msg = formatPausedMessage("agent-arya", undefined, 5);

    expect(msg).toContain("agent-arya");
    expect(msg).toContain("paused after 5 exchanges");
  });
});

describe("handleIncomingEnvelope with senderAgentId", () => {
  it("passes senderAgentId to injectToSession for message type", () => {
    const config = { brokerUrl: "mqtt://test", agentId: "agent-b", humanName: "B", dataDir: "/tmp/test" };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "al-test-"));
    const contacts = createContacts(tmpDir);
    const calls: Array<{ text: string; senderAgentId: string }> = [];

    const envelope = createEnvelope("message", "agent-a", "Alice", "agent-b", "Hello");
    handleIncomingEnvelope(envelope, config, contacts, noopLogger, (text, senderAgentId) => {
      calls.push({ text, senderAgentId });
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].senderAgentId).toBe("agent-a");
    expect(calls[0].text).toContain("[AgentLink]");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("passes senderAgentId for contact_exchange type", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "al-test-"));
    const config = { brokerUrl: "mqtt://test", agentId: "agent-b", humanName: "B", dataDir: tmpDir };
    const contacts = createContacts(tmpDir);
    const calls: Array<{ text: string; senderAgentId: string }> = [];

    const envelope = createEnvelope("contact_exchange", "agent-a", "Alice", "agent-b");
    handleIncomingEnvelope(envelope, config, contacts, noopLogger, (text, senderAgentId) => {
      calls.push({ text, senderAgentId });
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].senderAgentId).toBe("agent-a");
    expect(calls[0].text).toContain("connected");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
