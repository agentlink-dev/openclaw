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
 * @deprecated NO LONGER USED - Removed to enable public directory discovery.
 *
 * Previous behavior: Personal salts made each user's hashes unique,
 * preventing cross-user discovery. This was changed to use global salt
 * only, allowing anyone to find published emails/phones.
 *
 * Kept for backward compatibility and potential future private mode.
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
 * Algorithm: Argon2id with GLOBAL salt only (no personal salts)
 * - Time cost: 3 iterations
 * - Memory cost: 64 MB
 * - Parallelism: 4 threads
 *
 * This enables PUBLIC DIRECTORY functionality:
 * - Same identifier hashes to same value for all users
 * - Anyone can find published emails/phones
 * - Still memory-hard (prevents rainbow tables)
 *
 * Security: Argon2id (64MB) makes rainbow tables expensive (~$50K for top 1M emails).
 * Future v2: Add rate limiting or increase memory cost if needed.
 *
 * @param identifier - Email or phone number (normalized)
 * @param agentId - UNUSED (kept for API compatibility)
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

  // Use ONLY global salt (no personal salt)
  // This allows cross-user discovery to work
  const saltBuffer = Buffer.from(
    globalSalt.slice(0, 32).padEnd(32, "0"),
    "utf8"
  ).slice(0, 16); // 16 bytes

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
 * PUBLIC DIRECTORY: Uses global salt only, so anyone searching for
 * this identifier will find your agent ID.
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
  // Hash the identifier with global salt (enables cross-user discovery)
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
  // Using qos:0 because qos:1 callbacks don't fire when client has options
  // (CLI uses qos:1 with no-options pattern, but library function works with any client)
  return new Promise((resolve, reject) => {
    mqttClient.publish(
      topic,
      JSON.stringify(record),
      { qos: 0, retain: true },
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
 * PUBLIC DIRECTORY: Uses global salt only, so you can find any agent
 * who has published this identifier.
 *
 * Flow:
 * 1. Hash the identifier with global salt (same hash for all users)
 * 2. Subscribe to agentlink/discovery/v2/{hash}
 * 3. Wait for retained message (or timeout)
 * 4. Unsubscribe and return result
 *
 * @param query - Discovery query parameters
 * @param myAgentId - Searcher's agent ID (UNUSED, kept for API compatibility)
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
