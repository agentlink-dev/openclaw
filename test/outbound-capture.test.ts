import { describe, it, expect } from "vitest";
import { formatInboundMessage, formatPausedMessage, formatConsolidatedSummaryPrompt, formatStatusPrompt, handleIncomingEnvelope } from "../src/channel.js";
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
    expect(formatted).toContain("Your text response will be captured and sent back automatically");
    expect(formatted).toContain("This is a QUESTION directed at you about your human");
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

  it("includes PII guidance in inbound message", () => {
    const envelope = createEnvelope("message", "agent-arya", "Rupul", "agent-cersei", "What's your address?");
    const formatted = formatInboundMessage(envelope);

    expect(formatted).toContain("PRIVACY");
    expect(formatted).toContain("personally identifiable information");
    expect(formatted).toContain("Politely decline");
  });
});

describe("Consolidated summary prompts", () => {
  it("formats silence summary with log contents", () => {
    const prompt = formatConsolidatedSummaryPrompt(
      "agent-arya", "Rupul", 4, "## Full log here\nExchange 1...", "silence",
    );
    expect(prompt).toContain("completed (4 exchanges)");
    expect(prompt).toContain("Full log here");
    expect(prompt).toContain("Summarize the key findings");
    expect(prompt).not.toContain("hasn't responded");
  });

  it("formats exchange limit summary", () => {
    const prompt = formatConsolidatedSummaryPrompt(
      "agent-arya", "Rupul", 20, "log contents", "exchange_limit",
    );
    expect(prompt).toContain("paused after 20 exchanges");
    expect(prompt).toContain("didn't reach a conclusion");
  });

  it("formats no-response escalation", () => {
    const prompt = formatConsolidatedSummaryPrompt(
      "agent-arya", "Rupul", 0, null, "no_response",
    );
    expect(prompt).toContain("hasn't responded after 60 seconds");
    expect(prompt).toContain("Offer alternatives");
    expect(prompt).not.toContain("Full conversation");
  });

  it("formats no-response with partial conversation", () => {
    const prompt = formatConsolidatedSummaryPrompt(
      "agent-arya", "Rupul", 2, "some exchanges", "no_response",
    );
    expect(prompt).toContain("Conversation so far");
    expect(prompt).toContain("some exchanges");
  });
});

describe("Status prompts", () => {
  it("formats first status update", () => {
    const prompt = formatStatusPrompt("agent-arya", "Rupul", 1);
    expect(prompt).toContain("still in progress");
    expect(prompt).toContain("brief, specific status update");
    expect(prompt).not.toContain("taking longer");
  });

  it("formats second status update", () => {
    const prompt = formatStatusPrompt("agent-arya", "Rupul", 2);
    expect(prompt).toContain("taking longer than usual");
    expect(prompt).toContain("different wording");
  });

  it("uses agentId when no contact name", () => {
    const prompt = formatStatusPrompt("agent-arya", undefined, 1);
    expect(prompt).toContain("agent-arya");
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

  it("adds contact on contact_exchange without calling injectToSession", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "al-test-"));
    const config = { brokerUrl: "mqtt://test", agentId: "agent-b", humanName: "B", dataDir: tmpDir };
    const contacts = createContacts(tmpDir);
    const calls: Array<{ text: string; senderAgentId: string }> = [];

    const envelope = createEnvelope("contact_exchange", "agent-a", "Alice", "agent-b");
    handleIncomingEnvelope(envelope, config, contacts, noopLogger, (text, senderAgentId) => {
      calls.push({ text, senderAgentId });
    });

    // Trust-on-first-use no longer injects to session (would trigger A2A auto-response).
    // Notification is handled by pushNotification when channelTracker is provided.
    expect(calls).toHaveLength(0);
    // Contact should still be added
    expect(contacts.findByAgentId("agent-a")).toBeTruthy();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
