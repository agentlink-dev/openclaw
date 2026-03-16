import { describe, it, expect } from "vitest";
import {
  hashIdentifier,
  derivePersonalSalt,
  normalizeIdentifier,
} from "../src/discovery.js";
import { generateAgentIdV2 } from "../src/types-v2.js";

describe("Discovery Performance Benchmarks", () => {
  it("single hash computation < 500ms", async () => {
    const agentId = generateAgentIdV2();
    const identifier = "alice@example.com";

    const start = performance.now();
    await hashIdentifier(identifier, agentId);
    const duration = performance.now() - start;

    console.log(`  Single hash: ${duration.toFixed(2)}ms`);
    expect(duration).toBeLessThan(500);
  });

  it("10 sequential hashes < 5 seconds", async () => {
    const agentId = generateAgentIdV2();
    const identifiers = Array.from({ length: 10 }, (_, i) => `user${i}@example.com`);

    const start = performance.now();
    for (const id of identifiers) {
      await hashIdentifier(id, agentId);
    }
    const duration = performance.now() - start;

    console.log(`  10 sequential hashes: ${duration.toFixed(2)}ms`);
    console.log(`  Average per hash: ${(duration / 10).toFixed(2)}ms`);
    expect(duration).toBeLessThan(5000);
  });

  it("5 parallel hashes < 2 seconds", async () => {
    const agentId = generateAgentIdV2();
    const identifiers = Array.from({ length: 5 }, (_, i) => `user${i}@example.com`);

    const start = performance.now();
    await Promise.all(identifiers.map(id => hashIdentifier(id, agentId)));
    const duration = performance.now() - start;

    console.log(`  5 parallel hashes: ${duration.toFixed(2)}ms`);
    expect(duration).toBeLessThan(2000);
  });

  it("1000 personal salt derivations < 100ms", () => {
    const agentIds = Array.from({ length: 1000 }, (_, i) => generateAgentIdV2());

    const start = performance.now();
    agentIds.forEach(id => derivePersonalSalt(id));
    const duration = performance.now() - start;

    console.log(`  1000 salt derivations: ${duration.toFixed(2)}ms`);
    expect(duration).toBeLessThan(100);
  });

  it("10000 normalizations < 50ms", () => {
    const emails = Array.from({ length: 10000 }, (_, i) => `User${i}@Example.COM`);

    const start = performance.now();
    emails.forEach(email => normalizeIdentifier(email));
    const duration = performance.now() - start;

    console.log(`  10000 normalizations: ${duration.toFixed(2)}ms`);
    expect(duration).toBeLessThan(50);
  });
});
