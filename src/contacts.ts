import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface ContactEntry {
  agent_id: string;
  human_name?: string;
  capabilities?: string[];
  added: string;
}

export interface ContactsStore {
  /** Resolve a name or agent ID to an agent ID. Case-insensitive on names. */
  resolve(nameOrId: string): string | null;
  /** Get the full contact entry by name. */
  get(name: string): ContactEntry | null;
  /** Add or update a contact. */
  add(name: string, agentId: string, humanName?: string, capabilities?: string[]): void;
  /** Remove a contact by name. */
  remove(name: string): boolean;
  /** Check if a name exists in contacts. */
  has(name: string): boolean;
  /** Get all contacts. */
  getAll(): Record<string, ContactEntry>;
  /** Find a contact name by agent ID (first match). */
  findByAgentId(agentId: string): { name: string; entry: ContactEntry } | null;
}

const DEFAULT_DATA_DIR = path.join(os.homedir(), ".agentlink");

export function createContacts(dataDir: string = DEFAULT_DATA_DIR): ContactsStore {
  const filePath = path.join(dataDir, "contacts.json");

  function load(): Record<string, ContactEntry> {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      return raw.contacts ?? {};
    } catch {
      return {};
    }
  }

  function save(contacts: Record<string, ContactEntry>): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ contacts }, null, 2) + "\n");
  }

  return {
    resolve(nameOrId) {
      const contacts = load();
      // Exact name match
      if (contacts[nameOrId]) return contacts[nameOrId].agent_id;
      // Case-insensitive name match
      const lower = nameOrId.toLowerCase();
      for (const [name, entry] of Object.entries(contacts)) {
        if (name.toLowerCase() === lower) return entry.agent_id;
      }
      // Direct agent ID match (someone passed an ID instead of a name)
      for (const entry of Object.values(contacts)) {
        if (entry.agent_id === nameOrId) return nameOrId;
      }
      return null;
    },

    get(name) {
      const contacts = load();
      if (contacts[name]) return contacts[name];
      const lower = name.toLowerCase();
      for (const [n, entry] of Object.entries(contacts)) {
        if (n.toLowerCase() === lower) return entry;
      }
      return null;
    },

    add(name, agentId, humanName, capabilities) {
      const contacts = load();
      contacts[name.toLowerCase()] = {
        agent_id: agentId,
        human_name: humanName,
        capabilities,
        added: new Date().toISOString().split("T")[0],
      };
      save(contacts);
    },

    remove(name) {
      const contacts = load();
      const lower = name.toLowerCase();
      let found = false;
      for (const key of Object.keys(contacts)) {
        if (key.toLowerCase() === lower) {
          delete contacts[key];
          found = true;
        }
      }
      if (found) save(contacts);
      return found;
    },

    has(name) {
      const contacts = load();
      const lower = name.toLowerCase();
      return Object.keys(contacts).some(k => k.toLowerCase() === lower);
    },

    getAll() {
      return { ...load() };
    },

    findByAgentId(agentId) {
      for (const [name, entry] of Object.entries(load())) {
        if (entry.agent_id === agentId) return { name, entry };
      }
      return null;
    },
  };
}
