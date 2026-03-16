import { describe, it, expect } from "vitest";
import {
  derivePersonalSalt,
  hashIdentifier,
  normalizeIdentifier,
  extractShortHash,
  DEFAULT_GLOBAL_SALT,
} from "../src/discovery.js";

describe("derivePersonalSalt", () => {
  it("generates deterministic 256-bit salts", () => {
    const agentId = "5HueCGU8rMjxEXxiPuD5BDk";
    const salt1 = derivePersonalSalt(agentId);
    const salt2 = derivePersonalSalt(agentId);

    expect(salt1).toBe(salt2); // Deterministic
    expect(salt1).toHaveLength(64); // 256 bits = 64 hex chars
    expect(salt1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("generates different salts for different agent IDs", () => {
    const salt1 = derivePersonalSalt("5HueCGU8rMjxEXxiPuD5BDk");
    const salt2 = derivePersonalSalt("7pq2KXW9vRnCzYmEHfTaUDx");

    expect(salt1).not.toBe(salt2);
  });

  it("includes global salt in derivation", () => {
    const agentId = "5HueCGU8rMjxEXxiPuD5BDk";
    const salt1 = derivePersonalSalt(agentId, "global1");
    const salt2 = derivePersonalSalt(agentId, "global2");

    expect(salt1).not.toBe(salt2);
  });
});

describe("hashIdentifier", () => {
  it("generates Argon2id hashes", async () => {
    const hash = await hashIdentifier(
      "alice@example.com",
      "5HueCGU8rMjxEXxiPuD5BDk"
    );

    expect(hash).toContain("$argon2id$");
    expect(hash).toContain("m=65536"); // 64 MB
    expect(hash).toContain("t=3");     // 3 iterations
    expect(hash).toContain("p=4");     // 4 threads
  });

  it("generates same hash for same inputs", async () => {
    const agentId = "5HueCGU8rMjxEXxiPuD5BDk";
    const hash1 = await hashIdentifier("alice@example.com", agentId);
    const hash2 = await hashIdentifier("alice@example.com", agentId);

    expect(hash1).toBe(hash2);
  });

  it("generates same hash for all users (public directory)", async () => {
    const hash1 = await hashIdentifier("alice@example.com", "5HueCGU8rMjxEXxiPuD5BDk");
    const hash2 = await hashIdentifier("alice@example.com", "7pq2KXW9vRnCzYmEHfTaUDx");

    // v1: Global salt only, same hash for everyone (enables blind discovery)
    expect(hash1).toBe(hash2);
  });

  it("normalizes identifiers before hashing", async () => {
    const agentId = "5HueCGU8rMjxEXxiPuD5BDk";
    const hash1 = await hashIdentifier("Alice@Example.COM", agentId);
    const hash2 = await hashIdentifier("alice@example.com", agentId);

    expect(hash1).toBe(hash2); // Case-insensitive
  });

  it("takes reasonable time (< 500ms)", async () => {
    const start = Date.now();
    await hashIdentifier("alice@example.com", "5HueCGU8rMjxEXxiPuD5BDk");
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(500);
  });
});

describe("normalizeIdentifier", () => {
  it("normalizes emails to lowercase", () => {
    expect(normalizeIdentifier("Alice@Example.COM")).toBe("alice@example.com");
  });

  it("trims whitespace from emails", () => {
    expect(normalizeIdentifier("  alice@example.com  ")).toBe("alice@example.com");
  });

  it("normalizes phone numbers", () => {
    expect(normalizeIdentifier("+1 (512) 225-5512")).toBe("+15122255512");
    expect(normalizeIdentifier("512-225-5512")).toBe("+5122255512");
    expect(normalizeIdentifier("5122255512")).toBe("+5122255512");
  });

  it("handles phone numbers with different formats", () => {
    expect(normalizeIdentifier("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizeIdentifier("(555) 123-4567")).toBe("+5551234567");
  });

  it("preserves + prefix for international numbers", () => {
    expect(normalizeIdentifier("+14155551234")).toBe("+14155551234");
  });

  it("adds + prefix if missing from phone numbers", () => {
    expect(normalizeIdentifier("14155551234")).toBe("+14155551234");
  });
});

describe("extractShortHash", () => {
  it("extracts 32-char short hash from Argon2id output", async () => {
    const fullHash = await hashIdentifier("alice@example.com", "5HueCGU8rMjxEXxiPuD5BDk");
    const shortHash = extractShortHash(fullHash);

    expect(shortHash).toHaveLength(32);
    expect(shortHash).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("produces deterministic short hashes", async () => {
    const fullHash = await hashIdentifier("alice@example.com", "5HueCGU8rMjxEXxiPuD5BDk");
    const shortHash1 = extractShortHash(fullHash);
    const shortHash2 = extractShortHash(fullHash);

    expect(shortHash1).toBe(shortHash2);
  });

  it("produces different short hashes for different full hashes", async () => {
    const fullHash1 = await hashIdentifier("alice@example.com", "5HueCGU8rMjxEXxiPuD5BDk");
    const fullHash2 = await hashIdentifier("bob@example.com", "5HueCGU8rMjxEXxiPuD5BDk");

    const shortHash1 = extractShortHash(fullHash1);
    const shortHash2 = extractShortHash(fullHash2);

    expect(shortHash1).not.toBe(shortHash2);
  });
});

describe("Integration: Hash Consistency", () => {
  it("verifies same hash across all users (public directory)", async () => {
    const user1 = "5HueCGU8rMjxEXxiPuD5BDk";
    const user2 = "7pq2KXW9vRnCzYmEHfTaUDx";
    const identifier = "alice@example.com";

    // v1: Global salt only, all users hash to same value
    const hash1 = await hashIdentifier(identifier, user1);
    const hash2 = await hashIdentifier(identifier, user2);

    // Hashes should be identical (enables blind discovery)
    expect(hash1).toBe(hash2);

    // Short hashes should also be identical
    const short1 = extractShortHash(hash1);
    const short2 = extractShortHash(hash2);
    expect(short1).toBe(short2);
  });

  it("verifies global salt affects all hashes", async () => {
    const agentId = "5HueCGU8rMjxEXxiPuD5BDk";
    const identifier = "alice@example.com";

    const hash1 = await hashIdentifier(identifier, agentId, "global-salt-1");
    const hash2 = await hashIdentifier(identifier, agentId, "global-salt-2");

    expect(hash1).not.toBe(hash2);
  });

  it("verifies consistent hashing for same user", async () => {
    const agentId = "5HueCGU8rMjxEXxiPuD5BDk";
    const identifier = "alice@example.com";

    const hash1 = await hashIdentifier(identifier, agentId);
    const hash2 = await hashIdentifier(identifier, agentId);
    const hash3 = await hashIdentifier(identifier, agentId);

    expect(hash1).toBe(hash2);
    expect(hash2).toBe(hash3);
  });
});

describe("Performance", () => {
  it("hashes multiple identifiers efficiently", async () => {
    const agentId = "5HueCGU8rMjxEXxiPuD5BDk";
    const identifiers = [
      "alice@example.com",
      "bob@example.com",
      "charlie@example.com",
      "+15122255512",
      "+442079460958",
    ];

    const start = Date.now();
    const hashes = await Promise.all(
      identifiers.map(id => hashIdentifier(id, agentId))
    );
    const duration = Date.now() - start;

    expect(hashes).toHaveLength(5);
    expect(duration).toBeLessThan(2500); // 5 hashes in < 2.5s
  });

  it("derives personal salts quickly", () => {
    const agentIds = Array.from({ length: 100 }, (_, i) =>
      `agent${i}`.padEnd(22, 'x')
    );

    const start = Date.now();
    const salts = agentIds.map(id => derivePersonalSalt(id));
    const duration = Date.now() - start;

    expect(salts).toHaveLength(100);
    expect(duration).toBeLessThan(50); // 100 salts in < 50ms
  });
});
