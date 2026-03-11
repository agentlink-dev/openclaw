import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import mqtt from "mqtt";
import { v4 as uuid } from "uuid";
import {
  TOPICS,
  createEnvelope,
  parseEnvelope,
  createInvitePayload,
} from "../src/types.js";
import { saveIdentity } from "../src/identity.js";
import { createContacts } from "../src/contacts.js";
import { formatInboundMessage, handleIncomingEnvelope } from "../src/channel.js";
import type { AgentLinkConfig } from "../src/types.js";

const BROKER = "mqtt://broker.emqx.io:1883";
const TIMEOUT = 15_000;

// Unique IDs per test run to avoid collisions on public broker
const RUN_ID = uuid().slice(0, 6);
const ARYA_ID = `arya-${RUN_ID}`;
const BRIENNE_ID = `brienne-${RUN_ID}`;

const ARYA_DIR = path.join(os.tmpdir(), `agentlink-test-arya-${process.pid}`);
const BRIENNE_DIR = path.join(os.tmpdir(), `agentlink-test-brienne-${process.pid}`);

function connectClient(clientId: string): Promise<mqtt.MqttClient> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(BROKER, {
      clientId: `agentlink-flow-${clientId}-${Date.now()}`,
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

beforeEach(() => {
  fs.mkdirSync(ARYA_DIR, { recursive: true });
  fs.mkdirSync(BRIENNE_DIR, { recursive: true });

  // Set up identities
  saveIdentity({ agent_id: ARYA_ID, human_name: "Rupul" }, ARYA_DIR);
  saveIdentity({ agent_id: BRIENNE_ID, human_name: "Cathy" }, BRIENNE_DIR);

  // Set up mutual contacts
  const aryaContacts = createContacts(ARYA_DIR);
  aryaContacts.add("cathy", BRIENNE_ID, "Cathy");

  const brienneContacts = createContacts(BRIENNE_DIR);
  brienneContacts.add("rupul", ARYA_ID, "Rupul");
});

afterEach(() => {
  fs.rmSync(ARYA_DIR, { recursive: true, force: true });
  fs.rmSync(BRIENNE_DIR, { recursive: true, force: true });
});

describe("Full message flow (simulated)", () => {
  it("Arya sends message → Brienne receives with correct formatting", async () => {
    const clientA = await connectClient(ARYA_ID);
    const clientB = await connectClient(BRIENNE_ID);

    try {
      // Brienne subscribes to her inbox
      await new Promise<void>((resolve, reject) => {
        clientB.subscribe(TOPICS.inboxAll(BRIENNE_ID), { qos: 1 }, (err) =>
          err ? reject(err) : resolve(),
        );
      });

      // Arya resolves "cathy" → BRIENNE_ID (simulating the tool)
      const aryaContacts = createContacts(ARYA_DIR);
      const resolved = aryaContacts.resolve("cathy");
      expect(resolved).toBe(BRIENNE_ID);

      // Arya creates and sends envelope
      const envelope = createEnvelope("message", ARYA_ID, "Rupul", BRIENNE_ID, "Is Cathy free Saturday?");
      const topic = TOPICS.inbox(BRIENNE_ID, ARYA_ID);

      const received = new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timeout")), TIMEOUT);
        clientB.on("message", (t, payload) => {
          if (t === topic) {
            clearTimeout(timer);
            resolve(payload);
          }
        });
      });

      await new Promise<void>((resolve, reject) => {
        clientA.publish(topic, JSON.stringify(envelope), { qos: 1 }, (err) =>
          err ? reject(err) : resolve(),
        );
      });

      // Brienne receives and parses
      const raw = (await received).toString("utf-8");
      const parsed = parseEnvelope(raw);
      expect(parsed).toBeTruthy();
      expect(parsed!.from).toBe(ARYA_ID);
      expect(parsed!.from_name).toBe("Rupul");
      expect(parsed!.text).toBe("Is Cathy free Saturday?");

      // Channel formats the message for OC session
      const formatted = formatInboundMessage(parsed!);
      expect(formatted).toContain("[AgentLink]");
      expect(formatted).toContain("Rupul");
      expect(formatted).toContain(ARYA_ID);
      expect(formatted).toContain("Is Cathy free Saturday?");
      expect(formatted).toContain("Your text response will be captured and sent back automatically");
    } finally {
      await disconnect(clientA);
      await disconnect(clientB);
    }
  }, TIMEOUT + 5000);

  it("contact_exchange adds sender to contacts automatically", () => {
    const brienneConfig: AgentLinkConfig = {
      brokerUrl: BROKER,
      agentId: BRIENNE_ID,
      humanName: "Cathy",
      dataDir: BRIENNE_DIR,
    };
    const brienneContacts = createContacts(BRIENNE_DIR);
    const logger = { info: () => {}, warn: () => {}, error: () => {} };

    // Remove rupul from Brienne's contacts to simulate fresh state
    brienneContacts.remove("rupul");
    expect(brienneContacts.findByAgentId(ARYA_ID)).toBeNull();

    // Simulate receiving a contact_exchange
    const exchange = createEnvelope("contact_exchange", ARYA_ID, "Rupul", BRIENNE_ID);
    const injected: string[] = [];

    handleIncomingEnvelope(exchange, brienneConfig, brienneContacts, logger, (text, _senderAgentId) => {
      injected.push(text);
    });

    // Verify auto-added
    const found = brienneContacts.findByAgentId(ARYA_ID);
    expect(found).toBeTruthy();
    expect(found!.entry.human_name).toBe("Rupul");

    // Verify notification injected
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain("Rupul");
    expect(injected[0]).toContain("connected");
  });

  it("invite flow: generate → publish → resolve → mutual contacts", async () => {
    // Arya generates invite
    const invite = createInvitePayload(ARYA_ID, "Rupul");
    const inviteTopic = TOPICS.invite(invite.code);

    const client = await connectClient("invite-flow");

    try {
      // Publish retained invite
      await new Promise<void>((resolve, reject) => {
        client.publish(inviteTopic, JSON.stringify(invite), { qos: 1, retain: true }, (err) =>
          err ? reject(err) : resolve(),
        );
      });

      // Simulate "Sarah" reading the invite
      const sarahDir = path.join(os.tmpdir(), `agentlink-test-sarah-${process.pid}`);
      fs.mkdirSync(sarahDir, { recursive: true });

      try {
        const sarahContacts = createContacts(sarahDir);

        // Read retained invite
        const reader = await connectClient("sarah-invite");
        try {
          const received = new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("No invite")), TIMEOUT);
            reader.on("message", (t, payload) => {
              if (t === inviteTopic) {
                clearTimeout(timer);
                resolve(payload.toString("utf-8"));
              }
            });
          });

          await new Promise<void>((resolve, reject) => {
            reader.subscribe(inviteTopic, { qos: 1 }, (err) =>
              err ? reject(err) : resolve(),
            );
          });

          const raw = await received;
          const parsedInvite = JSON.parse(raw);

          // Sarah adds Arya as contact from invite
          expect(parsedInvite.agent_id).toBe(ARYA_ID);
          expect(parsedInvite.human_name).toBe("Rupul");
          sarahContacts.add("rupul", parsedInvite.agent_id, parsedInvite.human_name);

          // Verify Sarah now has Arya as contact
          expect(sarahContacts.resolve("rupul")).toBe(ARYA_ID);
          expect(sarahContacts.findByAgentId(ARYA_ID)?.entry.human_name).toBe("Rupul");
        } finally {
          await disconnect(reader);
        }
      } finally {
        fs.rmSync(sarahDir, { recursive: true, force: true });
        // Clean up retained invite
        await new Promise<void>((resolve) => {
          client.publish(inviteTopic, "", { retain: true }, () => resolve());
        });
      }
    } finally {
      await disconnect(client);
    }
  }, TIMEOUT + 5000);
});
