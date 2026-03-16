import { describe, it, expect, beforeEach, afterEach } from "vitest";
import mqtt from "mqtt";
import { v4 as uuid } from "uuid";
import {
  publishDiscoveryRecord,
  unpublishDiscoveryRecord,
  searchByIdentifier,
  DEFAULT_GLOBAL_SALT,
} from "../src/discovery.js";

const BROKER = "mqtt://broker.emqx.io:1883";
const TIMEOUT = 15_000;

function connectClient(clientId: string): Promise<mqtt.MqttClient> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(BROKER, {
      clientId: `agentlink-discovery-test-${clientId}-${Date.now()}`,
      clean: true,
      connectTimeout: 10_000,
    });
    client.on("connect", () => resolve(client));
    client.on("error", reject);
    setTimeout(() => reject(new Error("Connect timeout")), 10_000);
  });
}

function disconnect(client: mqtt.MqttClient): Promise<void> {
  return new Promise((resolve) => client.end(false, {}, () => resolve()));
}

describe("MQTT Discovery Protocol", () => {
  let mqttClient: mqtt.MqttClient;

  beforeEach(async () => {
    // Connect to test broker
    mqttClient = await connectClient("discovery-" + uuid().slice(0, 8));
  });

  afterEach(async () => {
    await disconnect(mqttClient);
  });

  it("publishes and finds discovery records", async () => {
    const publisherId = "5HueCGU8rMjxEXxiPuD5BDk";
    const searcherId = publisherId; // Same user searching for themselves
    const testEmail = `test-${uuid().slice(0, 8)}@example.com`;

    // Publish
    await publishDiscoveryRecord(
      testEmail,
      publisherId,
      mqttClient
    );

    // Wait for broker to process
    await new Promise(resolve => setTimeout(resolve, 200));

    // Search
    const result = await searchByIdentifier(
      { identifier: testEmail },
      searcherId,
      mqttClient
    );

    expect(result.found).toBe(true);
    expect(result.agentId).toBe(publisherId);
    expect(result.timestamp).toBeDefined();

    // Cleanup
    await unpublishDiscoveryRecord(testEmail, publisherId, mqttClient);
  }, TIMEOUT);

  it("returns not found for unpublished identifiers", async () => {
    const testEmail = `nonexistent-${uuid().slice(0, 8)}@example.com`;
    const result = await searchByIdentifier(
      { identifier: testEmail, timeoutMs: 1000 },
      "5HueCGU8rMjxEXxiPuD5BDk",
      mqttClient
    );

    expect(result.found).toBe(false);
    expect(result.agentId).toBeUndefined();
  }, TIMEOUT);

  it("unpublishes discovery records", async () => {
    const agentId = "5HueCGU8rMjxEXxiPuD5BDk";
    const testEmail = `unpublish-${uuid().slice(0, 8)}@example.com`;

    // Publish
    await publishDiscoveryRecord(testEmail, agentId, mqttClient);
    await new Promise(resolve => setTimeout(resolve, 300));

    // Verify published
    let result = await searchByIdentifier(
      { identifier: testEmail },
      agentId,
      mqttClient
    );
    expect(result.found).toBe(true);

    // Wait before unpublish to ensure cleanup
    await new Promise(resolve => setTimeout(resolve, 300));

    // Unpublish
    await unpublishDiscoveryRecord(testEmail, agentId, mqttClient);
    await new Promise(resolve => setTimeout(resolve, 300));

    // Verify unpublished
    result = await searchByIdentifier(
      { identifier: testEmail, timeoutMs: 1000 },
      agentId,
      mqttClient
    );
    expect(result.found).toBe(false);
  }, TIMEOUT + 5000);

  it("times out if no record found", async () => {
    const testEmail = `timeout-${uuid().slice(0, 8)}@example.com`;
    const start = Date.now();
    const result = await searchByIdentifier(
      { identifier: testEmail, timeoutMs: 1000 },
      "5HueCGU8rMjxEXxiPuD5BDk",
      mqttClient
    );
    const duration = Date.now() - start;

    expect(result.found).toBe(false);
    expect(duration).toBeGreaterThanOrEqual(1000);
    expect(duration).toBeLessThan(1500);
  }, TIMEOUT);

  it("different searchers get different hashes (privacy)", async () => {
    const publisher = "5HueCGU8rMjxEXxiPuD5BDk";
    const searcher1 = publisher; // Same user can find
    const searcher2 = "7pq2KXW9vRnCzYmEHfTaUDx"; // Different user cannot
    const testEmail = `privacy-${uuid().slice(0, 8)}@example.com`;

    // Publisher publishes with their own salt
    await publishDiscoveryRecord(testEmail, publisher, mqttClient);
    await new Promise(resolve => setTimeout(resolve, 300));

    // Searcher 1 (same user) finds it
    const result1 = await searchByIdentifier(
      { identifier: testEmail },
      searcher1,
      mqttClient
    );
    expect(result1.found).toBe(true);
    expect(result1.agentId).toBe(publisher);

    // Wait between searches
    await new Promise(resolve => setTimeout(resolve, 300));

    // Searcher 2 (different user) cannot find it (different hash)
    const result2 = await searchByIdentifier(
      { identifier: testEmail, timeoutMs: 1000 },
      searcher2,
      mqttClient
    );
    expect(result2.found).toBe(false); // Different personal salt = different hash

    // Cleanup
    await unpublishDiscoveryRecord(testEmail, publisher, mqttClient);
  }, TIMEOUT + 5000);

  it("handles case-insensitive email searches", async () => {
    const agentId = "5HueCGU8rMjxEXxiPuD5BDk";
    const testEmail = `CaseSensitive-${uuid().slice(0, 8)}@Example.COM`;

    // Publish with mixed case
    await publishDiscoveryRecord(testEmail, agentId, mqttClient);
    await new Promise(resolve => setTimeout(resolve, 200));

    // Search with different case
    const result = await searchByIdentifier(
      { identifier: testEmail.toLowerCase() },
      agentId,
      mqttClient
    );

    expect(result.found).toBe(true);
    expect(result.agentId).toBe(agentId);

    // Cleanup
    await unpublishDiscoveryRecord(testEmail, agentId, mqttClient);
  }, TIMEOUT);

  it("handles phone number normalization", async () => {
    const agentId = "5HueCGU8rMjxEXxiPuD5BDk";
    const phoneWithFormatting = "+1 (512) 225-5512";
    const phoneNormalized = "+15122255512";

    // Publish with formatting
    await publishDiscoveryRecord(phoneWithFormatting, agentId, mqttClient);
    await new Promise(resolve => setTimeout(resolve, 200));

    // Search with normalized version
    const result = await searchByIdentifier(
      { identifier: phoneNormalized },
      agentId,
      mqttClient
    );

    expect(result.found).toBe(true);
    expect(result.agentId).toBe(agentId);

    // Cleanup
    await unpublishDiscoveryRecord(phoneWithFormatting, agentId, mqttClient);
  }, TIMEOUT);

  it("allows same identifier for multiple agents with different salts", async () => {
    const agent1 = "5HueCGU8rMjxEXxiPuD5BDk";
    const agent2 = "7pq2KXW9vRnCzYmEHfTaUDx";
    const sharedEmail = `shared-${uuid().slice(0, 8)}@example.com`;

    // Both agents can publish the same email (different hashes)
    await publishDiscoveryRecord(sharedEmail, agent1, mqttClient);
    await publishDiscoveryRecord(sharedEmail, agent2, mqttClient);
    await new Promise(resolve => setTimeout(resolve, 300));

    // Each agent can find their own record
    const result1 = await searchByIdentifier(
      { identifier: sharedEmail },
      agent1,
      mqttClient
    );
    expect(result1.found).toBe(true);
    expect(result1.agentId).toBe(agent1);

    // Wait between searches
    await new Promise(resolve => setTimeout(resolve, 300));

    const result2 = await searchByIdentifier(
      { identifier: sharedEmail },
      agent2,
      mqttClient
    );
    expect(result2.found).toBe(true);
    expect(result2.agentId).toBe(agent2);

    // Cleanup
    await unpublishDiscoveryRecord(sharedEmail, agent1, mqttClient);
    await unpublishDiscoveryRecord(sharedEmail, agent2, mqttClient);
  }, TIMEOUT + 5000);

  it("retained messages persist after disconnect", async () => {
    const agentId = "5HueCGU8rMjxEXxiPuD5BDk";
    const testEmail = `retained-${uuid().slice(0, 8)}@example.com`;

    // Publish with first client
    await publishDiscoveryRecord(testEmail, agentId, mqttClient);
    await new Promise(resolve => setTimeout(resolve, 200));

    // Disconnect first client
    await disconnect(mqttClient);

    // Connect new client
    mqttClient = await connectClient("discovery-retained-" + uuid().slice(0, 8));

    // New client should still find the retained record
    const result = await searchByIdentifier(
      { identifier: testEmail },
      agentId,
      mqttClient
    );

    expect(result.found).toBe(true);
    expect(result.agentId).toBe(agentId);

    // Cleanup
    await unpublishDiscoveryRecord(testEmail, agentId, mqttClient);
  }, TIMEOUT + 5000);
});

describe("MQTT Discovery Protocol - Edge Cases", () => {
  let mqttClient: mqtt.MqttClient;

  beforeEach(async () => {
    mqttClient = await connectClient("discovery-edge-" + uuid().slice(0, 8));
  });

  afterEach(async () => {
    await disconnect(mqttClient);
  });

  it("handles rapid publish/unpublish cycles", async () => {
    const agentId = "5HueCGU8rMjxEXxiPuD5BDk";
    const testEmail = `rapid-${uuid().slice(0, 8)}@example.com`;

    // Rapid cycle
    await publishDiscoveryRecord(testEmail, agentId, mqttClient);
    await unpublishDiscoveryRecord(testEmail, agentId, mqttClient);
    await publishDiscoveryRecord(testEmail, agentId, mqttClient);
    await new Promise(resolve => setTimeout(resolve, 300));

    // Should be published
    const result = await searchByIdentifier(
      { identifier: testEmail },
      agentId,
      mqttClient
    );

    expect(result.found).toBe(true);

    // Cleanup
    await unpublishDiscoveryRecord(testEmail, agentId, mqttClient);
  }, TIMEOUT);

  it("handles special characters in emails", async () => {
    const agentId = "5HueCGU8rMjxEXxiPuD5BDk";
    const specialEmail = `test+special.${uuid().slice(0, 8)}@sub-domain.example.com`;

    await publishDiscoveryRecord(specialEmail, agentId, mqttClient);
    await new Promise(resolve => setTimeout(resolve, 300));

    const result = await searchByIdentifier(
      { identifier: specialEmail },
      agentId,
      mqttClient
    );

    expect(result.found).toBe(true);
    expect(result.agentId).toBe(agentId);

    // Cleanup
    await unpublishDiscoveryRecord(specialEmail, agentId, mqttClient);
  }, TIMEOUT);
});
