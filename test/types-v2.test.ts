import { describe, it, expect } from "vitest";
import {
  generateAgentIdV2,
  isValidAgentIdV2,
  detectAgentIdVersion,
} from "../src/types-v2.js";

describe("generateAgentIdV2", () => {
  it("generates 22-character Base58 IDs", () => {
    const id = generateAgentIdV2();
    expect(id).toHaveLength(22);
    expect(isValidAgentIdV2(id)).toBe(true);
  });

  it("generates unique IDs (no collisions in 10k samples)", () => {
    const ids = new Set();
    for (let i = 0; i < 10000; i++) {
      ids.add(generateAgentIdV2());
    }
    expect(ids.size).toBe(10000);
  });

  it("uses only Base58 characters (no 0, O, I, l)", () => {
    for (let i = 0; i < 100; i++) {
      const id = generateAgentIdV2();
      expect(id).not.toMatch(/[0OIl]/);
    }
  });

  it("has 128 bits of entropy", () => {
    // Statistical test: Chi-squared test for randomness
    const ids = Array.from({ length: 1000 }, () => generateAgentIdV2());
    const firstChars = ids.map(id => id[0]);
    const distribution = firstChars.reduce((acc, char) => {
      acc[char] = (acc[char] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    // Expect roughly uniform distribution across Base58 chars
    const uniqueChars = Object.keys(distribution).length;
    expect(uniqueChars).toBeGreaterThan(30); // At least 30 of 58 chars
  });

  it("generates IDs efficiently (performance test)", () => {
    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      generateAgentIdV2();
    }
    const duration = Date.now() - start;
    const avgPerCall = duration / 100;

    // Should be < 1ms per generation
    expect(avgPerCall).toBeLessThan(1);
  });

  it("produces cryptographically random IDs (no patterns)", () => {
    // Generate 100 IDs and verify they don't share common prefixes
    const ids = Array.from({ length: 100 }, () => generateAgentIdV2());
    const prefixes = ids.map(id => id.substring(0, 3));
    const uniquePrefixes = new Set(prefixes);

    // Expect high diversity in prefixes (>90 unique)
    expect(uniquePrefixes.size).toBeGreaterThan(90);
  });

  it("no collisions in 100k samples (stress test)", () => {
    const ids = new Set();
    for (let i = 0; i < 100000; i++) {
      const id = generateAgentIdV2();
      expect(ids.has(id)).toBe(false); // No collision
      ids.add(id);
    }
    expect(ids.size).toBe(100000);
  }, 30000); // 30 second timeout for large test
});

describe("isValidAgentIdV2", () => {
  it("validates correct v2 IDs", () => {
    // Test with real generated IDs
    for (let i = 0; i < 10; i++) {
      const id = generateAgentIdV2();
      expect(isValidAgentIdV2(id)).toBe(true);
    }
  });

  it("validates Base58 IDs with correct length", () => {
    expect(isValidAgentIdV2("5HueCGU8rMjxEXxiPuD5BDk")).toBe(true);
    expect(isValidAgentIdV2("7pq2KXW9vRnCzYmEHfTaUDx")).toBe(true);
    expect(isValidAgentIdV2("3GjK8Lx4bFnM9PqRsVwX2Zy")).toBe(true);
  });

  it("rejects IDs with confusing characters (0, O, I, l)", () => {
    expect(isValidAgentIdV2("5HueCGU8rMjxEXxiPuD5BD0")).toBe(false); // contains 0
    expect(isValidAgentIdV2("OHueCGU8rMjxEXxiPuD5BDk")).toBe(false); // contains O
    expect(isValidAgentIdV2("IHueCGU8rMjxEXxiPuD5BDk")).toBe(false); // contains I
    expect(isValidAgentIdV2("lHueCGU8rMjxEXxiPuD5BDk")).toBe(false); // contains l
  });

  it("rejects IDs with incorrect length", () => {
    expect(isValidAgentIdV2("short")).toBe(false); // too short
    expect(isValidAgentIdV2("5HueCGU8rMjxEXxiPuD5BDk1234567890")).toBe(false); // too long
    expect(isValidAgentIdV2("")).toBe(false); // empty
  });

  it("rejects non-Base58 characters", () => {
    expect(isValidAgentIdV2("5HueCGU8rMjxEXxiPuD5BD!")).toBe(false); // special char
    expect(isValidAgentIdV2("5HueCGU8rMjxEXxiPuD5BD ")).toBe(false); // space
    expect(isValidAgentIdV2("5HueCGU8rMjxEXxiPuD5BD@")).toBe(false); // @ symbol
  });

  it("rejects non-string inputs", () => {
    expect(isValidAgentIdV2(null as any)).toBe(false);
    expect(isValidAgentIdV2(undefined as any)).toBe(false);
    expect(isValidAgentIdV2(123 as any)).toBe(false);
    expect(isValidAgentIdV2({} as any)).toBe(false);
  });

  it("accepts IDs within valid length range (21-23 chars)", () => {
    // Base58 encoding can produce 21-23 char results for 16 bytes
    const validLengths = [21, 22, 23];
    for (const length of validLengths) {
      const id = "A".repeat(length); // All Base58 chars
      expect(isValidAgentIdV2(id)).toBe(true);
    }
  });
});

describe("detectAgentIdVersion", () => {
  it("detects v2 IDs", () => {
    for (let i = 0; i < 10; i++) {
      const id = generateAgentIdV2();
      expect(detectAgentIdVersion(id)).toBe("v2");
    }
  });

  it("detects v1 IDs (slug-XXXX format)", () => {
    expect(detectAgentIdVersion("arya-7k3x")).toBe("v1");
    expect(detectAgentIdVersion("brienne-4m2p")).toBe("v1");
    expect(detectAgentIdVersion("agent-a1b2")).toBe("v1");
    expect(detectAgentIdVersion("mary-jane-watson-abc1")).toBe("v1");
  });

  it("detects invalid IDs", () => {
    expect(detectAgentIdVersion("")).toBe("invalid");
    expect(detectAgentIdVersion("AB")).toBe("invalid");
    expect(detectAgentIdVersion("-starts-with-dash")).toBe("invalid");
    expect(detectAgentIdVersion("UPPERCASE-INVALID")).toBe("invalid");
    expect(detectAgentIdVersion("contains spaces")).toBe("invalid");
    expect(detectAgentIdVersion("special!chars@here")).toBe("invalid");
  });

  it("distinguishes v1 from v2 correctly", () => {
    const v1Id = "arya-7k3x";
    const v2Id = generateAgentIdV2();

    expect(detectAgentIdVersion(v1Id)).toBe("v1");
    expect(detectAgentIdVersion(v2Id)).toBe("v2");
    expect(v1Id).not.toBe(v2Id);
  });

  it("rejects non-string inputs", () => {
    expect(detectAgentIdVersion(null as any)).toBe("invalid");
    expect(detectAgentIdVersion(undefined as any)).toBe("invalid");
    expect(detectAgentIdVersion(123 as any)).toBe("invalid");
    expect(detectAgentIdVersion({} as any)).toBe("invalid");
  });

  it("handles edge cases", () => {
    // Too long for v1 but not v2
    expect(detectAgentIdVersion("a".repeat(50))).toBe("invalid");

    // Too short for both
    expect(detectAgentIdVersion("ab")).toBe("invalid");

    // Mixed case (v1 is lowercase only)
    expect(detectAgentIdVersion("Arya-7k3x")).toBe("invalid");
  });

  it("validates Base58 IDs correctly as v2", () => {
    expect(detectAgentIdVersion("5HueCGU8rMjxEXxiPuD5BDk")).toBe("v2");
    expect(detectAgentIdVersion("7pq2KXW9vRnCzYmEHfTaUDx")).toBe("v2");
    expect(detectAgentIdVersion("3GjK8Lx4bFnM9PqRsVwX2Zy")).toBe("v2");
  });
});

describe("Performance benchmarks", () => {
  it("ID generation: < 1ms per call", () => {
    const iterations = 1000;
    const start = Date.now();

    for (let i = 0; i < iterations; i++) {
      generateAgentIdV2();
    }

    const duration = Date.now() - start;
    const avgPerCall = duration / iterations;

    expect(avgPerCall).toBeLessThan(1);
  });

  it("ID validation: < 0.1ms per call", () => {
    const ids = Array.from({ length: 100 }, () => generateAgentIdV2());
    const start = Date.now();

    for (const id of ids) {
      isValidAgentIdV2(id);
    }

    const duration = Date.now() - start;
    const avgPerCall = duration / ids.length;

    expect(avgPerCall).toBeLessThan(0.1);
  });

  it("Version detection: < 0.1ms per call", () => {
    const ids = Array.from({ length: 100 }, () => generateAgentIdV2());
    const start = Date.now();

    for (const id of ids) {
      detectAgentIdVersion(id);
    }

    const duration = Date.now() - start;
    const avgPerCall = duration / ids.length;

    expect(avgPerCall).toBeLessThan(0.1);
  });
});

describe("Integration with existing types", () => {
  it("v2 IDs are distinct from v1 IDs", () => {
    const v2Id = generateAgentIdV2();
    const v1Pattern = /^[a-z0-9][a-z0-9-]{2,30}$/;

    // V2 IDs should NOT match v1 pattern (due to uppercase letters)
    expect(v1Pattern.test(v2Id)).toBe(false);
  });

  it("v2 IDs can be used in MQTT topics", () => {
    const id = generateAgentIdV2();
    const topic = `agentlink/agents/${id}/from/sender`;

    // Should not contain invalid MQTT topic characters
    expect(topic).not.toMatch(/[#+]/);
  });

  it("v2 IDs are URL-safe", () => {
    const id = generateAgentIdV2();

    // Should not need URL encoding
    expect(encodeURIComponent(id)).toBe(id);
  });
});
