import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createInvitationsStore } from "../src/invitations.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("InvitationsStore", () => {
  const testDir = path.join(os.tmpdir(), `agentlink-test-invitations-${Date.now()}`);
  let store: ReturnType<typeof createInvitationsStore>;

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    store = createInvitationsStore(testDir);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("should start with empty history", () => {
    const history = store.getAll();
    expect(history.sent).toEqual([]);
    expect(history.received).toEqual([]);
  });

  it("should add a sent invite", () => {
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    store.addSent("ABC123", "John", expires);

    const sent = store.getSent();
    expect(sent.length).toBe(1);
    expect(sent[0].code).toBe("ABC123");
    expect(sent[0].to_name).toBe("John");
    expect(sent[0].status).toBe("pending");
    expect(sent[0].expires).toBe(expires);
  });

  it("should not add duplicate sent invites", () => {
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    store.addSent("ABC123", "John", expires);
    store.addSent("ABC123", "Jane", expires);

    const sent = store.getSent();
    expect(sent.length).toBe(1);
    expect(sent[0].to_name).toBe("John"); // First one wins
  });

  it("should update sent invite status to accepted", () => {
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    store.addSent("ABC123", "John", expires);
    store.updateSentStatus("ABC123", "accepted", "agent-jane-x7y2");

    const invite = store.findSentByCode("ABC123");
    expect(invite).not.toBeNull();
    expect(invite?.status).toBe("accepted");
    expect(invite?.accepted_by).toBe("agent-jane-x7y2");
    expect(invite?.accepted_at).toBeDefined();
  });

  it("should update sent invite status to expired", () => {
    const expires = new Date(Date.now() - 1000).toISOString(); // Expired
    store.addSent("ABC123", "John", expires);
    store.updateSentStatus("ABC123", "expired");

    const invite = store.findSentByCode("ABC123");
    expect(invite?.status).toBe("expired");
    expect(invite?.accepted_by).toBeUndefined();
  });

  it("should add a received invite", () => {
    store.addReceived("XYZ789", "agent-john-a1b2", "John Smith");

    const received = store.getReceived();
    expect(received.length).toBe(1);
    expect(received[0].code).toBe("XYZ789");
    expect(received[0].from_agent_id).toBe("agent-john-a1b2");
    expect(received[0].from_human_name).toBe("John Smith");
    expect(received[0].accepted).toBe(true);
  });

  it("should not add duplicate received invites", () => {
    store.addReceived("XYZ789", "agent-john-a1b2", "John Smith");
    store.addReceived("XYZ789", "agent-john-a1b2", "John Smith");

    const received = store.getReceived();
    expect(received.length).toBe(1);
  });

  it("should persist data across store instances", () => {
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    store.addSent("ABC123", "John", expires);
    store.addReceived("XYZ789", "agent-jane-x7y2", "Jane Doe");

    // Create a new store instance with the same directory
    const store2 = createInvitationsStore(testDir);
    const history = store2.getAll();

    expect(history.sent.length).toBe(1);
    expect(history.sent[0].code).toBe("ABC123");
    expect(history.received.length).toBe(1);
    expect(history.received[0].code).toBe("XYZ789");
  });

  it("should find sent invite by code", () => {
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    store.addSent("ABC123", "John", expires);
    store.addSent("DEF456", "Jane", expires);

    const invite = store.findSentByCode("DEF456");
    expect(invite).not.toBeNull();
    expect(invite?.code).toBe("DEF456");
    expect(invite?.to_name).toBe("Jane");
  });

  it("should return null for non-existent invite code", () => {
    const invite = store.findSentByCode("NOTFOUND");
    expect(invite).toBeNull();
  });

  it("should handle multiple sent and received invites", () => {
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    // Add multiple sent invites
    store.addSent("ABC123", "John", expires);
    store.addSent("DEF456", "Jane", expires);
    store.addSent("GHI789", undefined, expires); // No name

    // Add multiple received invites
    store.addReceived("XYZ111", "agent-a", "Alice");
    store.addReceived("XYZ222", "agent-b", "Bob");

    const history = store.getAll();
    expect(history.sent.length).toBe(3);
    expect(history.received.length).toBe(2);

    // Update one sent invite
    store.updateSentStatus("DEF456", "accepted", "agent-b");
    const updated = store.findSentByCode("DEF456");
    expect(updated?.status).toBe("accepted");
    expect(updated?.accepted_by).toBe("agent-b");
  });
});
