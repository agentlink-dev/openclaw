import { describe, it, expect } from "vitest";
import mqtt from "mqtt";
import { v4 as uuid } from "uuid";
import { hashIdentifier, extractShortHash } from "../src/discovery.js";

const BROKER = "mqtt://broker.emqx.io:1883";
const TIMEOUT = 15_000;

describe("Discovery Publish Pattern Test", () => {
  it("publishes discovery record using exact invite pattern (qos:1, no options)", async () => {
    const agentId = "test-agent-" + uuid().slice(0, 8);
    const email = `test-${uuid().slice(0, 8)}@example.com`;

    // Exact pattern from working invite code (18a0bb8)
    const client = mqtt.connect(BROKER);  // NO OPTIONS

    try {
      await new Promise<void>((resolve, reject) => {
        client.on("connect", async () => {
          // Hash the identifier
          const fullHash = await hashIdentifier(email, agentId);
          const shortHash = extractShortHash(fullHash);
          const topic = `agentlink/discovery/v2/${shortHash}`;

          const record = {
            agentId,
            timestamp: Date.now(),
          };

          // Publish with exact invite pattern
          client.publish(topic, JSON.stringify(record), { retain: true, qos: 1 }, (err) => {
            client.end();  // END INSIDE CALLBACK
            if (err) reject(err);
            else resolve();
          });
        });

        client.on("error", reject);
        setTimeout(() => reject(new Error("MQTT connection timeout")), 10000);
      });

      // Now verify the retained message persists
      const client2 = mqtt.connect(BROKER);

      const found = await new Promise<boolean>((resolve, reject) => {
        client2.on("connect", async () => {
          const fullHash = await hashIdentifier(email, agentId);
          const shortHash = extractShortHash(fullHash);
          const topic = `agentlink/discovery/v2/${shortHash}`;

          let messageReceived = false;

          client2.on("message", (receivedTopic, payload) => {
            if (receivedTopic === topic) {
              messageReceived = true;
              const record = JSON.parse(payload.toString());
              expect(record.agentId).toBe(agentId);
              client2.end();
              resolve(true);
            }
          });

          client2.subscribe(topic, { qos: 1 });

          // If no retained message, will timeout
          setTimeout(() => {
            if (!messageReceived) {
              client2.end();
              resolve(false);
            }
          }, 3000);
        });

        client2.on("error", reject);
      });

      expect(found).toBe(true);
    } finally {
      // Cleanup: unpublish the test record
      const client3 = mqtt.connect(BROKER);
      await new Promise<void>((resolve) => {
        client3.on("connect", async () => {
          const fullHash = await hashIdentifier(email, agentId);
          const shortHash = extractShortHash(fullHash);
          const topic = `agentlink/discovery/v2/${shortHash}`;
          client3.publish(topic, "", { retain: true, qos: 1 }, () => {
            client3.end();
            resolve();
          });
        });
      });
    }
  }, TIMEOUT + 5000);

  it("verifies cross-user discovery with invite pattern", async () => {
    const aliceId = "test-alice-" + uuid().slice(0, 8);
    const bobId = "test-bob-" + uuid().slice(0, 8);
    const email = `shared-${uuid().slice(0, 8)}@example.com`;

    // Alice publishes using invite pattern
    const aliceClient = mqtt.connect(BROKER);

    await new Promise<void>((resolve, reject) => {
      aliceClient.on("connect", async () => {
        const fullHash = await hashIdentifier(email, aliceId);
        const shortHash = extractShortHash(fullHash);
        const topic = `agentlink/discovery/v2/${shortHash}`;

        const record = {
          agentId: aliceId,
          timestamp: Date.now(),
        };

        aliceClient.publish(topic, JSON.stringify(record), { retain: true, qos: 1 }, (err) => {
          aliceClient.end();
          if (err) reject(err);
          else resolve();
        });
      });

      aliceClient.on("error", reject);
      setTimeout(() => reject(new Error("Alice publish timeout")), 10000);
    });

    // Wait a bit for broker
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Bob searches (different agent ID, same email)
    const bobClient = mqtt.connect(BROKER);

    const found = await new Promise<{ found: boolean; agentId?: string }>((resolve, reject) => {
      bobClient.on("connect", async () => {
        // Bob uses SAME email, so gets SAME hash (global salt)
        const fullHash = await hashIdentifier(email, bobId);
        const shortHash = extractShortHash(fullHash);
        const topic = `agentlink/discovery/v2/${shortHash}`;

        let messageReceived = false;

        bobClient.on("message", (receivedTopic, payload) => {
          if (receivedTopic === topic) {
            messageReceived = true;
            try {
              const record = JSON.parse(payload.toString());
              bobClient.end();
              resolve({ found: true, agentId: record.agentId });
            } catch {
              bobClient.end();
              resolve({ found: false });
            }
          }
        });

        bobClient.subscribe(topic, { qos: 1 });

        setTimeout(() => {
          if (!messageReceived) {
            bobClient.end();
            resolve({ found: false });
          }
        }, 3000);
      });

      bobClient.on("error", reject);
    });

    expect(found.found).toBe(true);
    expect(found.agentId).toBe(aliceId);

    // Cleanup
    const cleanupClient = mqtt.connect(BROKER);
    await new Promise<void>((resolve) => {
      cleanupClient.on("connect", async () => {
        const fullHash = await hashIdentifier(email, aliceId);
        const shortHash = extractShortHash(fullHash);
        const topic = `agentlink/discovery/v2/${shortHash}`;
        cleanupClient.publish(topic, "", { retain: true, qos: 1 }, () => {
          cleanupClient.end();
          resolve();
        });
      });
    });
  }, TIMEOUT + 10000);
});
