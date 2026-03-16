import { randomBytes } from "node:crypto";
import bs58 from "bs58";

/**
 * Generate a v2 agent ID using Base58 encoding with 128 bits of entropy.
 *
 * Format: Base58-encoded random bytes (22 characters)
 * Entropy: 128 bits (2^128 = 3.4 × 10^38 possible IDs)
 * Character set: 123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz
 *                (excludes 0, O, I, l for readability)
 *
 * Examples:
 * - 5HueCGU8rMjxEXxiPuD5BDk
 * - 7pq2KXW9vRnCzYmEHfTaUDx
 * - 3GjK8Lx4bFnM9PqRsVwX2Zy
 *
 * @returns High-entropy agent ID (22 characters)
 */
export function generateAgentIdV2(): string {
  const randomBuffer = randomBytes(16); // 128 bits
  return bs58.encode(randomBuffer);     // 22 chars
}

/**
 * Validate a v2 agent ID.
 *
 * Rules:
 * - Must be Base58 characters only
 * - Length: 21-23 characters (allow minor variance due to encoding)
 * - No confusing characters (0, O, I, l)
 *
 * @param id - The agent ID to validate
 * @returns true if valid v2 ID
 */
export function isValidAgentIdV2(id: string): boolean {
  if (typeof id !== "string") return false;
  if (id.length < 21 || id.length > 23) return false;

  // Base58 alphabet: no 0, O, I, l
  const base58Regex = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;
  return base58Regex.test(id);
}

/**
 * Detect the version of an agent ID.
 *
 * Version detection rules:
 * - V2: 21-23 Base58 characters (no 0, O, I, l)
 * - V1: slug-XXXX format (e.g., arya-7k3x)
 * - Invalid: anything else
 *
 * @param id - The agent ID to check
 * @returns "v1" | "v2" | "invalid"
 */
export function detectAgentIdVersion(id: string): "v1" | "v2" | "invalid" {
  if (typeof id !== "string") return "invalid";

  // Check v2 first (Base58, 21-23 chars)
  if (isValidAgentIdV2(id)) {
    return "v2";
  }

  // Check v1 (slug-XXXX format)
  // V1 format: lowercase letters, numbers, hyphens, 3-32 chars
  const v1Regex = /^[a-z0-9][a-z0-9-]{2,30}$/;
  if (v1Regex.test(id)) {
    return "v1";
  }

  return "invalid";
}
