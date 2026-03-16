import argon2 from "argon2";
import { createHash } from "node:crypto";
import type { MqttClient as MqttClientType } from "mqtt";

/**
 * Global salt for discovery hashing.
 *
 * IMPORTANT: This should be configurable via environment variable
 * for testing and future rotation.
 *
 * Default: Hardcoded for v1 (can be rotated in v2)
 */
export const DEFAULT_GLOBAL_SALT = "agentlink-discovery-v2-2026";

/**
 * Derive a personal salt from an agent ID.
 *
 * Personal salts ensure that each user's hashes are unique,
 * preventing rainbow table attacks and cross-user correlation.
 *
 * Algorithm: SHA256(agentId + globalSalt)
 * Output: 64-character hex string (256 bits)
 *
 * @param agentId - High-entropy agent ID (v2 format)
 * @param globalSalt - Global salt (default: DEFAULT_GLOBAL_SALT)
 * @returns Personal salt (64-char hex)
 */
export function derivePersonalSalt(
  agentId: string,
  globalSalt: string = DEFAULT_GLOBAL_SALT
): string {
  return createHash("sha256")
    .update(agentId)
    .update(globalSalt)
    .digest("hex");
}

/**
 * Hash an identifier (email or phone) for privacy-preserving discovery.
 *
 * Algorithm: Argon2id with personal salt
 * - Time cost: 3 iterations
 * - Memory cost: 64 MB
 * - Parallelism: 4 threads
 *
 * This is memory-hard and prevents rainbow table attacks.
 * Each user's personal salt makes their hashes unique.
 *
 * @param identifier - Email or phone number (normalized)
 * @param agentId - Searcher's agent ID (for personal salt)
 * @param globalSalt - Global salt (default: DEFAULT_GLOBAL_SALT)
 * @returns Hash string (Argon2id format)
 */
export async function hashIdentifier(
  identifier: string,
  agentId: string,
  globalSalt: string = DEFAULT_GLOBAL_SALT
): Promise<string> {
  // Normalize identifier (lowercase email, strip phone formatting)
  const normalized = normalizeIdentifier(identifier);

  // Derive personal salt from agent ID
  const personalSalt = derivePersonalSalt(agentId, globalSalt);

  // Use personal salt as the argon2 salt (take first 16 bytes of hex string)
  // This ensures each agent ID gets a unique salt
  const saltBuffer = Buffer.from(personalSalt.slice(0, 32), "hex"); // 16 bytes from hex

  // Argon2id hash
  const hash = await argon2.hash(normalized, {
    type: argon2.argon2id,
    salt: saltBuffer,
    timeCost: 3,
    memoryCost: 65536,  // 64 MB
    parallelism: 4,
    hashLength: 32,     // 256-bit output
    raw: false,         // Return encoded string
  });

  return hash;
}

/**
 * Normalize an identifier for consistent hashing.
 *
 * Email: Lowercase, trim whitespace
 * Phone: Remove all non-digits, keep leading +
 *
 * @param identifier - Raw email or phone
 * @returns Normalized identifier
 */
export function normalizeIdentifier(identifier: string): string {
  const trimmed = identifier.trim();

  // Email detection: Contains @
  if (trimmed.includes("@")) {
    return trimmed.toLowerCase();
  }

  // Phone detection: Contains digits (but not email-like)
  if (/\d/.test(trimmed)) {
    // Keep leading +, remove all other non-digits
    const digits = trimmed.replace(/[^\d+]/g, "");
    return digits.startsWith("+") ? digits : `+${digits}`;
  }

  // Default: Lowercase
  return trimmed.toLowerCase();
}

/**
 * Extract the short hash for MQTT topic construction.
 *
 * Argon2id output is long (e.g., $argon2id$v=19$m=65536,t=3,p=4$...).
 * We need a shorter, MQTT-safe identifier.
 *
 * Strategy: Base64 encode the hash bytes, take first 32 chars.
 *
 * @param argon2Hash - Full Argon2id hash string
 * @returns Short hash for MQTT topic (32 chars, alphanumeric + =)
 */
export function extractShortHash(argon2Hash: string): string {
  // Parse Argon2 hash format: $argon2id$v=19$m=65536,t=3,p=4$salt$hash
  const parts = argon2Hash.split("$");
  const hashPart = parts[parts.length - 1]; // Last part is the hash

  // Return first 32 characters (MQTT-safe)
  return hashPart.slice(0, 32);
}

/**
 * Discovery record published to MQTT.
 *
 * Published to: agentlink/discovery/v2/{hash}
 * Retained: true (persists on broker)
 */
export interface DiscoveryRecord {
  agentId: string;      // Publisher's agent ID
  timestamp: number;    // Unix timestamp (ms)
}

/**
 * Discovery query parameters.
 */
export interface DiscoveryQuery {
  identifier: string;   // Email or phone to search
  timeoutMs?: number;   // Timeout for MQTT response (default: 5000ms)
}

/**
 * Discovery response.
 */
export interface DiscoveryResponse {
  found: boolean;
  agentId?: string;
  timestamp?: number;
}

/**
 * Publish a discovery record to MQTT.
 *
 * This allows other agents to find you by your email/phone.
 *
 * @param identifier - Your email or phone
 * @param myAgentId - Your agent ID
 * @param mqttClient - Connected MQTT client
 * @param globalSalt - Global salt (default: DEFAULT_GLOBAL_SALT)
 */
export async function publishDiscoveryRecord(
  identifier: string,
  myAgentId: string,
  mqttClient: MqttClientType,
  globalSalt: string = DEFAULT_GLOBAL_SALT
): Promise<void> {
  // Hash the identifier with personal salt
  const fullHash = await hashIdentifier(identifier, myAgentId, globalSalt);
  const shortHash = extractShortHash(fullHash);

  // Construct MQTT topic
  const topic = `agentlink/discovery/v2/${shortHash}`;

  // Create discovery record
  const record: DiscoveryRecord = {
    agentId: myAgentId,
    timestamp: Date.now(),
  };

  // Publish with retained flag (persists on broker)
  return new Promise((resolve, reject) => {
    mqttClient.publish(
      topic,
      JSON.stringify(record),
      { qos: 1, retain: true },
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

/**
 * Remove a discovery record from MQTT.
 *
 * Publishes empty retained message to delete the record.
 *
 * @param identifier - Email or phone to unpublish
 * @param myAgentId - Your agent ID
 * @param mqttClient - Connected MQTT client
 * @param globalSalt - Global salt (default: DEFAULT_GLOBAL_SALT)
 */
export async function unpublishDiscoveryRecord(
  identifier: string,
  myAgentId: string,
  mqttClient: MqttClientType,
  globalSalt: string = DEFAULT_GLOBAL_SALT
): Promise<void> {
  const fullHash = await hashIdentifier(identifier, myAgentId, globalSalt);
  const shortHash = extractShortHash(fullHash);
  const topic = `agentlink/discovery/v2/${shortHash}`;

  // Publish empty message with retain=true to delete
  return new Promise((resolve, reject) => {
    mqttClient.publish(
      topic,
      "",
      { qos: 1, retain: true },
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

/**
 * Search for an agent by email or phone using MQTT-only discovery.
 *
 * Flow:
 * 1. Hash the identifier with searcher's personal salt
 * 2. Subscribe to agentlink/discovery/v2/{hash}
 * 3. Wait for retained message (or timeout)
 * 4. Unsubscribe and return result
 *
 * @param query - Discovery query parameters
 * @param myAgentId - Searcher's agent ID (for personal salt)
 * @param mqttClient - Connected MQTT client
 * @param globalSalt - Global salt (default: DEFAULT_GLOBAL_SALT)
 * @returns Discovery response
 */
export async function searchByIdentifier(
  query: DiscoveryQuery,
  myAgentId: string,
  mqttClient: MqttClientType,
  globalSalt: string = DEFAULT_GLOBAL_SALT
): Promise<DiscoveryResponse> {
  const timeoutMs = query.timeoutMs ?? 5000;

  // Hash the identifier
  const fullHash = await hashIdentifier(query.identifier, myAgentId, globalSalt);
  const shortHash = extractShortHash(fullHash);
  const topic = `agentlink/discovery/v2/${shortHash}`;

  // Subscribe and wait for message
  return new Promise((resolve) => {
    let resolved = false;

    const cleanup = () => {
      mqttClient.removeListener("message", messageHandler);
      mqttClient.unsubscribe(topic);
    };

    const timeoutHandle = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve({ found: false });
      }
    }, timeoutMs);

    const messageHandler = (receivedTopic: string, payload: Buffer) => {
      if (receivedTopic === topic && !resolved) {
        resolved = true;
        clearTimeout(timeoutHandle);
        cleanup();

        // Check for empty payload (unpublished record)
        const payloadStr = payload.toString();
        if (!payloadStr || payloadStr.trim() === "") {
          resolve({ found: false });
          return;
        }

        // Parse discovery record
        try {
          const record: DiscoveryRecord = JSON.parse(payloadStr);
          resolve({
            found: true,
            agentId: record.agentId,
            timestamp: record.timestamp,
          });
        } catch {
          resolve({ found: false });
        }
      }
    };

    mqttClient.on("message", messageHandler);
    mqttClient.subscribe(topic, { qos: 1 });
  });
}
