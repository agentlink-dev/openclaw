import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Channel Tracker — records which channels the human has used
// ---------------------------------------------------------------------------

export interface ChannelRecord {
  from: string;
  accountId?: string;
  conversationId?: string;
  lastMessage: number;
}

export interface ChannelTracker {
  record(channelId: string, from: string, accountId?: string, conversationId?: string): void;
  getAll(): Record<string, ChannelRecord>;
  getMessagingChannels(): Record<string, ChannelRecord>;
  getMostRecent(): { channelId: string; record: ChannelRecord } | null;
}

const MESSAGING_CHANNELS = new Set(["slack", "whatsapp", "telegram", "discord", "signal"]);

export function createChannelTracker(dataDir: string): ChannelTracker {
  const filePath = path.join(dataDir, "channels.json");

  function load(): Record<string, ChannelRecord> {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      return {};
    }
  }

  function save(data: Record<string, ChannelRecord>): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  return {
    record(channelId, from, accountId, conversationId) {
      // Skip A2A channel — not a human channel
      if (channelId === "agentlink") return;

      const data = load();
      data[channelId] = {
        from,
        accountId,
        conversationId,
        lastMessage: Date.now(),
      };
      save(data);
    },

    getAll() {
      return load();
    },

    getMessagingChannels() {
      const all = load();
      const result: Record<string, ChannelRecord> = {};
      for (const [id, record] of Object.entries(all)) {
        if (MESSAGING_CHANNELS.has(id)) {
          result[id] = record;
        }
      }
      return result;
    },

    getMostRecent() {
      const all = load();
      let best: { channelId: string; record: ChannelRecord } | null = null;
      for (const [channelId, record] of Object.entries(all)) {
        if (!best || record.lastMessage > best.record.lastMessage) {
          best = { channelId, record };
        }
      }
      return best;
    },
  };
}
