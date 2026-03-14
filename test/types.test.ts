import { describe, it, expect } from "vitest";
import {
  generateAgentId,
  isValidAgentId,
  TOPICS,
  parseSenderFromTopic,
  createEnvelope,
  parseEnvelope,
  createStatusPayload,
  generateInviteCode,
  createInvitePayload,
  isInviteExpired,
} from "../src/types.js";

describe("Agent ID", () => {
  it("generates slug-XXXX format", () => {
    const id = generateAgentId("Rupul");
    expect(id).toMatch(/^rupul-[a-z0-9]{4}$/);
  });

  it("handles names with spaces and special chars", () => {
    const id = generateAgentId("Mary Jane Watson");
    expect(id).toMatch(/^mary-jane-watson-[a-z0-9]{4}$/);
  });

  it("handles empty name", () => {
    const id = generateAgentId("");
    expect(id).toMatch(/^agent-[a-z0-9]{4}$/);
  });

  it("validates correct IDs", () => {
    expect(isValidAgentId("arya-7k3x")).toBe(true);
    expect(isValidAgentId("agent-a1b2")).toBe(true);
    expect(isValidAgentId("a-b")).toBe(true);
  });

  it("rejects invalid IDs", () => {
    expect(isValidAgentId("")).toBe(false);
    expect(isValidAgentId("AB")).toBe(false);
    expect(isValidAgentId("-starts-with-dash")).toBe(false);
  });
});

describe("MQTT Topics", () => {
  it("builds inbox topic", () => {
    expect(TOPICS.inbox("brienne-4m2p", "arya-7k3x")).toBe(
      "agentlink/agents/brienne-4m2p/from/arya-7k3x"
    );
  });

  it("builds inbox wildcard", () => {
    expect(TOPICS.inboxAll("arya-7k3x")).toBe(
      "agentlink/agents/arya-7k3x/from/#"
    );
  });

  it("builds status topic", () => {
    expect(TOPICS.status("arya-7k3x")).toBe(
      "agentlink/agents/arya-7k3x/status"
    );
  });

  it("builds invite topic", () => {
    expect(TOPICS.invite("AB3X7K")).toBe("agentlink/invites/AB3X7K");
  });

  it("parses sender from inbox topic", () => {
    expect(
      parseSenderFromTopic("agentlink/agents/brienne-4m2p/from/arya-7k3x")
    ).toBe("arya-7k3x");
  });

  it("returns null for non-inbox topics", () => {
    expect(parseSenderFromTopic("agentlink/agents/arya-7k3x/status")).toBeNull();
    expect(parseSenderFromTopic("random/topic")).toBeNull();
  });
});

describe("Message Envelope", () => {
  it("creates valid envelope", () => {
    const env = createEnvelope("message", "arya-7k3x", "Rupul", "brienne-4m2p", "Hello");
    expect(env.type).toBe("message");
    expect(env.from).toBe("arya-7k3x");
    expect(env.from_name).toBe("Rupul");
    expect(env.to).toBe("brienne-4m2p");
    expect(env.text).toBe("Hello");
    expect(env.timestamp).toBeTruthy();
  });

  it("creates contact_exchange envelope without text", () => {
    const env = createEnvelope("contact_exchange", "sarah-9m2p", "Sarah", "arya-7k3x");
    expect(env.type).toBe("contact_exchange");
    expect(env.text).toBeUndefined();
  });

  it("round-trips through JSON", () => {
    const env = createEnvelope("message", "a-1234", "Test", "b-5678", "Hello");
    const parsed = parseEnvelope(JSON.stringify(env));
    expect(parsed).toEqual(env);
  });

  it("rejects invalid JSON", () => {
    expect(parseEnvelope("not json")).toBeNull();
  });

  it("rejects missing required fields", () => {
    expect(parseEnvelope(JSON.stringify({ type: "message", from: "a" }))).toBeNull();
  });

  it("rejects missing fields", () => {
    expect(parseEnvelope(JSON.stringify({ version: 1 }))).toBeNull();
  });
});

describe("Status Payload", () => {
  it("creates online status", () => {
    const s = createStatusPayload("arya-7k3x", "Rupul", true);
    expect(s.agent_id).toBe("arya-7k3x");
    expect(s.human_name).toBe("Rupul");
    expect(s.online).toBe(true);
    expect(s.timestamp).toBeTruthy();
  });
});

describe("Invite", () => {
  it("generates 6-char code", () => {
    const code = generateInviteCode();
    expect(code).toHaveLength(6);
    expect(code).toMatch(/^[A-Z2-9]+$/);
  });

  it("creates invite payload with 7-day expiry", () => {
    const invite = createInvitePayload("arya-7k3x", "Rupul");
    expect(invite.agent_id).toBe("arya-7k3x");
    expect(invite.human_name).toBe("Rupul");
    expect(invite.code).toHaveLength(6);

    const created = new Date(invite.created).getTime();
    const expires = new Date(invite.expires).getTime();
    const days = (expires - created) / (1000 * 60 * 60 * 24);
    expect(days).toBeCloseTo(7, 0);
  });

  it("detects expired invites", () => {
    const invite = createInvitePayload("a-1234", "Test");
    expect(isInviteExpired(invite)).toBe(false);

    const expired = { ...invite, expires: "2020-01-01T00:00:00Z" };
    expect(isInviteExpired(expired)).toBe(true);
  });
});
