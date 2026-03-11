import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateAgentId } from "./types.js";

export interface Identity {
  agent_id: string;
  human_name: string;
  agent_name?: string; // Optional: agent's name (e.g., "Arya")
}

const DEFAULT_DATA_DIR = path.join(os.homedir(), ".agentlink");

/**
 * Load identity from disk. Returns null if no identity file exists.
 */
export function loadIdentity(dataDir: string = DEFAULT_DATA_DIR): Identity | null {
  const filePath = path.join(dataDir, "identity.json");
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    if (data.agent_id && data.human_name) {
      return {
        agent_id: data.agent_id,
        human_name: data.human_name,
        agent_name: data.agent_name, // Optional field
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Save identity to disk. Creates the data directory if needed.
 */
export function saveIdentity(identity: Identity, dataDir: string = DEFAULT_DATA_DIR): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = path.join(dataDir, "identity.json");
  fs.writeFileSync(filePath, JSON.stringify(identity, null, 2) + "\n");
}

/**
 * Ensure an identity exists. If not, auto-generate one from the given human name.
 * Returns the loaded or newly created identity.
 */
export function ensureIdentity(humanName: string, dataDir: string = DEFAULT_DATA_DIR): Identity {
  const existing = loadIdentity(dataDir);
  if (existing) return existing;

  const identity: Identity = {
    agent_id: generateAgentId(humanName),
    human_name: humanName,
  };
  saveIdentity(identity, dataDir);
  return identity;
}

/**
 * Resolve identity from plugin config or disk.
 * Priority: explicit config > identity.json > auto-generate.
 */
export function resolveIdentity(
  config: { agentId?: string; humanName?: string; agentName?: string; dataDir?: string },
): Identity {
  const dataDir = config.dataDir ?? DEFAULT_DATA_DIR;

  // If both agentId and humanName are explicitly provided in config, use them
  if (config.agentId && config.humanName) {
    return {
      agent_id: config.agentId,
      human_name: config.humanName,
      agent_name: config.agentName,
    };
  }

  // Try loading from disk
  const existing = loadIdentity(dataDir);

  // If config provides partial overrides, merge with existing
  if (existing) {
    return {
      agent_id: config.agentId ?? existing.agent_id,
      human_name: config.humanName ?? existing.human_name,
      agent_name: config.agentName ?? existing.agent_name,
    };
  }

  // No identity on disk and no explicit config — generate from name or fallback
  const name = config.humanName ?? os.userInfo().username ?? "agent";
  return ensureIdentity(name, dataDir);
}
