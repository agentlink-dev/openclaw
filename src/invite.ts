import type { AgentLinkConfig, InvitePayload, AgentStatus } from "./types.js";
import { TOPICS, createEnvelope, isInviteExpired } from "./types.js";
import type { MqttClient, Logger } from "./mqtt-client.js";
import type { ContactsStore } from "./contacts.js";
import type { InvitationsStore } from "./invitations.js";

/**
 * Resolve an invite code: subscribe to the invite topic, read the retained payload,
 * add the inviter as a contact, and send a contact_exchange back.
 */
export async function resolveInviteCode(
  code: string,
  config: AgentLinkConfig,
  mqttClient: MqttClient,
  contacts: ContactsStore,
  logger: Logger,
  invitations?: InvitationsStore,
): Promise<{ success: boolean; message: string }> {
  const topic = TOPICS.invite(code.toUpperCase());

  // Read retained invite payload
  const invite = await readRetained<InvitePayload>(mqttClient, topic, 8000);
  if (!invite) {
    return {
      success: false,
      message: `Invite code "${code}" not found or has expired. Ask the person who shared it to generate a new one.`,
    };
  }

  // Check expiry
  if (isInviteExpired(invite)) {
    return {
      success: false,
      message: `Invite code "${code}" has expired (was valid until ${new Date(invite.expires).toLocaleDateString()}). Ask for a new code.`,
    };
  }

  // Don't add ourselves
  if (invite.agent_id === config.agentId) {
    return {
      success: false,
      message: `That's your own invite code!`,
    };
  }

  // Check if already a contact
  const existing = contacts.findByAgentId(invite.agent_id);
  if (existing) {
    return {
      success: true,
      message: `${invite.human_name} (${invite.agent_id}) is already in your contacts as "${existing.name}".`,
    };
  }

  // Add inviter as contact
  const contactName = invite.human_name.toLowerCase();
  contacts.add(contactName, invite.agent_id, invite.human_name);
  logger.info(`[AgentLink] Added contact from invite: ${invite.human_name} (${invite.agent_id})`);

  // Track the received invite
  if (invitations) {
    invitations.addReceived(code.toUpperCase(), invite.agent_id, invite.human_name);
  }

  // Send contact_exchange back to the inviter (bidirectional handshake)
  const exchange = createEnvelope(
    "contact_exchange",
    config.agentId,
    config.humanName,
    invite.agent_id,
    undefined, // text
    undefined, // origin
    undefined, // context
    config.capabilities, // capabilities
  );
  const inboxTopic = TOPICS.inbox(invite.agent_id, config.agentId);

  try {
    await mqttClient.publish(inboxTopic, JSON.stringify(exchange));
    logger.info(`[AgentLink] Contact exchange sent to ${invite.agent_id}`);
  } catch (err) {
    // Non-fatal: they added us but we failed to notify them
    logger.warn(`[AgentLink] Failed to send contact exchange: ${err}`);
  }

  // Wait for ack with 5-second timeout
  logger.info(`[AgentLink] Waiting for ack from ${invite.agent_id}...`);
  const ackReceived = await waitForContactExchangeAck(
    mqttClient,
    invite.agent_id,
    config.agentId,
    5000,
  );

  if (ackReceived) {
    logger.info(`[AgentLink] Connection confirmed by ${invite.agent_id}`);
  } else {
    logger.warn(`[AgentLink] No ack received from ${invite.agent_id} (timeout)`);
  }

  // Send auto-hello message to close the feedback loop for the inviter
  try {
    const helloText = "Just connected via AgentLink. Ready to coordinate!";
    const helloEnvelope = createEnvelope(
      "message",
      config.agentId,
      config.humanName,
      invite.agent_id,
      helloText,
      "auto"
    );
    await mqttClient.publish(inboxTopic, JSON.stringify(helloEnvelope));
    logger.info(`[AgentLink] Auto-hello sent to ${invite.agent_id}`);
  } catch (err) {
    // Non-fatal: connection is established even if hello fails
    logger.warn(`[AgentLink] Failed to send auto-hello: ${err}`);
  }

  const statusText = ackReceived
    ? `Connected with ${invite.human_name}'s agent (${invite.agent_id}). Connection confirmed!`
    : `Connected with ${invite.human_name}'s agent (${invite.agent_id}). You can now message them with agentlink_message.`;

  return {
    success: true,
    message: statusText,
  };
}

// ---------------------------------------------------------------------------
// Helper: read a retained message with timeout
// ---------------------------------------------------------------------------

function readRetained<T>(
  mqttClient: MqttClient,
  topic: string,
  timeoutMs: number,
): Promise<T | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    }, timeoutMs);

    mqttClient.onMessage((msgTopic, payload) => {
      if (msgTopic === topic && !resolved) {
        resolved = true;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(payload.toString("utf-8")) as T);
        } catch {
          resolve(null);
        }
      }
    });

    mqttClient.subscribe(topic).catch(() => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Helper: wait for contact_exchange ack with timeout
// ---------------------------------------------------------------------------

function waitForContactExchangeAck(
  mqttClient: MqttClient,
  expectedFrom: string,
  myAgentId: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(false);
      }
    }, timeoutMs);

    const inboxTopic = TOPICS.inbox(myAgentId, expectedFrom);

    mqttClient.onMessage((msgTopic, payload) => {
      if (msgTopic === inboxTopic && !resolved) {
        try {
          const envelope = JSON.parse(payload.toString("utf-8"));
          if (
            envelope.type === "contact_exchange" &&
            envelope.ack === true &&
            envelope.from === expectedFrom
          ) {
            resolved = true;
            clearTimeout(timer);
            resolve(true);
          }
        } catch {
          // Invalid payload, ignore
        }
      }
    });

    mqttClient.subscribe(inboxTopic).catch(() => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(false);
      }
    });
  });
}
