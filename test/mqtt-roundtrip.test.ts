import { describe, it, expect } from "vitest";
import mqtt from "mqtt";
import { v4 as uuid } from "uuid";
import {
  TOPICS,
  createEnvelope,
  parseEnvelope,
  createInvitePayload,
  createStatusPayload,
} from "../src/types.js";

const BROKER = "mqtt://broker.emqx.io:1883";
const TIMEOUT = 15_000;

function connectClient(clientId: string): Promise<mqtt.MqttClient> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(BROKER, {
      clientId: `agentlink-test-${clientId}-${Date.now()}`,
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

describe("MQTT Round-trip (broker.emqx.io)", () => {
  it("two agents exchange a message via sender-inbox topics", async () => {
    const agentA = "test-arya-" + uuid().slice(0, 8);
    const agentB = "test-brienne-" + uuid().slice(0, 8);

    const clientA = await connectClient(agentA);
    const clientB = await connectClient(agentB);

    try {
      // B subscribes to their inbox
      await new Promise<void>((resolve, reject) => {
        clientB.subscribe(TOPICS.inboxAll(agentB), { qos: 1 }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // A sends a message to B
      const envelope = createEnvelope("message", agentA, "Rupul", agentB, "Are you free Saturday?");
      const topic = TOPICS.inbox(agentB, agentA);

      // Listen for the message on B
      const received = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("No message received within timeout")), TIMEOUT);
        clientB.on("message", (t, payload) => {
          if (t === topic) {
            clearTimeout(timer);
            resolve(payload.toString("utf-8"));
          }
        });
      });

      // Publish
      await new Promise<void>((resolve, reject) => {
        clientA.publish(topic, JSON.stringify(envelope), { qos: 1 }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Verify
      const raw = await received;
      const parsed = parseEnvelope(raw);
      expect(parsed).toBeTruthy();
      expect(parsed!.type).toBe("message");
      expect(parsed!.from).toBe(agentA);
      expect(parsed!.from_name).toBe("Rupul");
      expect(parsed!.to).toBe(agentB);
      expect(parsed!.text).toBe("Are you free Saturday?");
      expect(parsed!.timestamp).toBeTruthy();
    } finally {
      await disconnect(clientA);
      await disconnect(clientB);
    }
  }, TIMEOUT + 5000);

  it("invite code round-trips via retained message", async () => {
    const client = await connectClient("invite-test");
    const invite = createInvitePayload("test-arya-inv", "Rupul");
    const topic = TOPICS.invite(invite.code);

    try {
      // Publish invite as retained
      await new Promise<void>((resolve, reject) => {
        client.publish(topic, JSON.stringify(invite), { qos: 1, retain: true }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // New client subscribes and reads retained
      const reader = await connectClient("invite-reader");
      try {
        const received = new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("No retained message")), TIMEOUT);
          reader.on("message", (t, payload) => {
            if (t === topic) {
              clearTimeout(timer);
              resolve(payload.toString("utf-8"));
            }
          });
        });

        await new Promise<void>((resolve, reject) => {
          reader.subscribe(topic, { qos: 1 }, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        const raw = await received;
        const parsed = JSON.parse(raw);
        expect(parsed.code).toBe(invite.code);
        expect(parsed.agent_id).toBe("test-arya-inv");
        expect(parsed.human_name).toBe("Rupul");
        expect(new Date(parsed.expires).getTime()).toBeGreaterThan(Date.now());
      } finally {
        // Clean up retained message
        await new Promise<void>((resolve) => {
          client.publish(topic, "", { retain: true }, () => resolve());
        });
        await disconnect(reader);
      }
    } finally {
      await disconnect(client);
    }
  }, TIMEOUT + 5000);

  it("status topic carries agent profile via retained message", async () => {
    const agentId = "test-status-" + uuid().slice(0, 8);
    const client = await connectClient(agentId);
    const statusTopic = TOPICS.status(agentId);

    try {
      // Publish online status as retained
      const status = createStatusPayload(agentId, "TestUser", true);
      await new Promise<void>((resolve, reject) => {
        client.publish(statusTopic, JSON.stringify(status), { qos: 1, retain: true }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // New client reads the retained status
      const reader = await connectClient("status-reader");
      try {
        const received = new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("No retained status")), TIMEOUT);
          reader.on("message", (t, payload) => {
            if (t === statusTopic) {
              clearTimeout(timer);
              resolve(payload.toString("utf-8"));
            }
          });
        });

        await new Promise<void>((resolve, reject) => {
          reader.subscribe(statusTopic, { qos: 1 }, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        const raw = await received;
        const parsed = JSON.parse(raw);
        expect(parsed.agent_id).toBe(agentId);
        expect(parsed.human_name).toBe("TestUser");
        expect(parsed.online).toBe(true);
      } finally {
        // Clean up retained
        await new Promise<void>((resolve) => {
          client.publish(statusTopic, "", { retain: true }, () => resolve());
        });
        await disconnect(reader);
      }
    } finally {
      await disconnect(client);
    }
  }, TIMEOUT + 5000);
});
