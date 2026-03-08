import { Type } from "@sinclair/typebox";
import { v4 as uuid } from "uuid";
import type { AgentLinkConfig, AgentStatus } from "./types.js";
import { createEnvelope, TOPICS } from "./types.js";
import type { StateManager } from "./state.js";
import type { ContactsManager } from "./contacts.js";
import type { MqttService } from "./mqtt-service.js";
import type { InviteManager } from "./invite.js";
import type { JobManager } from "./jobs.js";
import type { Logger } from "./mqtt-client.js";

// ---------------------------------------------------------------------------
// Tool result helper
// ---------------------------------------------------------------------------

function json(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// ---------------------------------------------------------------------------
// Publish agent status to group
// ---------------------------------------------------------------------------

async function publishStatus(
  config: AgentLinkConfig,
  mqtt: MqttService,
  groupId: string,
): Promise<void> {
  const status: AgentStatus = {
    agent_id: config.agent.id,
    owner: config.agent.description?.split("'s")[0] ?? config.agent.id,
    display_name: config.agent.displayName,
    status: "online",
    capabilities: config.agent.capabilities.map((c) => ({
      name: c.name,
      description: c.description ?? c.name,
      input_hint: c.input_hint ?? "",
    })),
    description: config.agent.description,
    ts: new Date().toISOString(),
  };

  await mqtt.publish(
    TOPICS.groupStatus(groupId, config.agent.id),
    JSON.stringify(status),
    { retain: true },
  );
}

// ---------------------------------------------------------------------------
// TypeBox Schemas
// ---------------------------------------------------------------------------

const CoordinateSchema = Type.Object({
  goal: Type.String({ description: "What the user wants to accomplish" }),
  done_when: Type.Optional(
    Type.String({ description: "How to know when this is complete" }),
  ),
  participants: Type.Array(Type.String(), {
    description: "Names or agent IDs of people to coordinate with",
  }),
});

const SubmitJobSchema = Type.Object({
  group_id: Type.String({ description: "The active group/coordination ID" }),
  capability: Type.String({
    description: "The capability to request (e.g. 'check_calendar')",
  }),
  target_agent: Type.Optional(
    Type.String({
      description: "Specific agent ID to target (optional — if omitted, routes by capability)",
    }),
  ),
  text: Type.String({
    description: "Natural language description of what you need",
  }),
});

const InviteAgentSchema = Type.Object({
  group_id: Type.String({ description: "The active group/coordination ID" }),
  name_or_agent_id: Type.String({
    description: "Contact name (e.g. 'Sara') or agent ID (e.g. 'sara-macbook')",
  }),
});

const JoinGroupSchema = Type.Object({
  invite_code: Type.String({
    description: "The 6-character invite code (e.g. 'AB3X7K')",
  }),
});

const CompleteSchema = Type.Object({
  group_id: Type.String({ description: "The active group/coordination ID" }),
  summary: Type.String({ description: "Final outcome summary" }),
  success: Type.Optional(
    Type.Boolean({
      description: "Whether the goal was achieved",
      default: true,
    }),
  ),
});

const StatusSchema = Type.Object({});

// ---------------------------------------------------------------------------
// createTools
// ---------------------------------------------------------------------------

export function createTools(
  config: AgentLinkConfig,
  state: StateManager,
  contacts: ContactsManager,
  mqtt: MqttService,
  invites: InviteManager,
  jobs: JobManager,
  logger: Logger,
  channelInbound?: { dispatchToMainSession(body: string): void; clearWatchdog(groupId: string): void } | null,
  resolveDisplayName?: (agentId: string) => string,
) {
  function log(msg: string) {
    if (config.outputMode === "debug") {
      logger.info(`[AgentLink] ${msg}`);
    }
  }

  // -----------------------------------------------------------------------
  // agentlink_coordinate
  // -----------------------------------------------------------------------
  const coordinateTool = {
    name: "agentlink_coordinate",
    label: "Coordinate",
    description:
      "Start coordinating with other people's agents. Use this when the user wants to do something that involves other people.",
    parameters: CoordinateSchema,
    async execute(_id: string, params: Record<string, unknown>) {
      const goal = params.goal as string;
      const doneWhen = (params.done_when as string) ?? `${goal} — completed to user's satisfaction`;
      const participants = params.participants as string[];

      const resolved = participants.map((p) => ({
        name: p,
        agentId: contacts.resolve(p),
      }));

      const known = resolved.filter((r) => r.agentId);
      const unknown = resolved.filter((r) => !r.agentId);

      const groupId = uuid();
      const intentId = uuid();

      state.addGroup({
        group_id: groupId,
        driver: config.agent.id,
        goal,
        done_when: doneWhen,
        intent_id: intentId,
        participants: [config.agent.id], // only driver initially — others added on join
        expected_participants: participants.length, // how many non-driver participants we invited
        status: "active",
        idle_turns: 0,
        created_at: new Date().toISOString(),
      });

      await mqtt.subscribeGroup(groupId);
      await publishStatus(config, mqtt, groupId);

      // Send direct invites to known contacts
      const invited: string[] = [];
      for (const r of known) {
        await invites.sendDirectInvite(r.agentId!, groupId, goal, doneWhen);
        logger.info(`[AgentLink] Invite sent to ${r.name}`);
        invited.push(r.name);
      }

      // Generate shareable invite codes for unknown contacts
      const inviteCodes: Array<{ name: string; code: string; message: string }> = [];
      for (const r of unknown) {
        const result = await invites.createInviteCode(groupId, config.agent.id, goal);
        inviteCodes.push({ name: r.name, code: result.code, message: result.shareableMessage });
        logger.info(`[AgentLink] Invite code ${result.code} created for ${r.name}`);
      }

      const result: Record<string, unknown> = { group_id: groupId };

      if (invited.length > 0) {
        result.invited = invited.join(", ");
        result.note = `Reaching out to ${invited.join(", ")}'s assistant. They'll join shortly.`;
      }

      if (inviteCodes.length > 0) {
        result.invite_codes = inviteCodes.map(ic => ({
          for: ic.name,
          code: ic.code,
          share_this: ic.message,
        }));
        result.action_needed = `Share the invite code(s) with: ${inviteCodes.map(ic => ic.name).join(", ")}. They need to run: agentlink setup --join <CODE>`;
      }

      return json(result);
    },
  };

  // -----------------------------------------------------------------------
  // agentlink_submit_job
  // -----------------------------------------------------------------------
  const submitJobTool = {
    name: "agentlink_submit_job",
    label: "Submit Job",
    description:
      "Send a specific task to another agent. Use this to request actions like checking a calendar, searching for restaurants, etc.",
    parameters: SubmitJobSchema,
    async execute(_id: string, params: Record<string, unknown>) {
      const groupId = params.group_id as string;
      const group = state.getGroup(groupId);
      if (!group) return json({ error: "Group not found or already closed" });

      const correlationId = await jobs.submitJob({
        groupId,
        intentId: group.intent_id,
        targetAgentId: params.target_agent as string | undefined,
        capability: params.capability as string,
        text: params.text as string,
      });

      state.resetIdleTurns(groupId);

      const targetName = params.target_agent
        ? (resolveDisplayName ? resolveDisplayName(params.target_agent as string) : (contacts.getNameByAgentId(params.target_agent as string) ?? params.target_agent as string))
        : null;
      return json({
        sent_to: targetName ?? "group",
        asking_about: params.capability as string,
        correlation_id: correlationId,
      });
    },
  };

  // -----------------------------------------------------------------------
  // agentlink_invite_agent
  // -----------------------------------------------------------------------
  const inviteAgentTool = {
    name: "agentlink_invite_agent",
    label: "Invite Agent",
    description:
      "Invite someone to join a coordination group. Use when adding new participants mid-coordination.",
    parameters: InviteAgentSchema,
    async execute(_id: string, params: Record<string, unknown>) {
      const groupId = params.group_id as string;
      const group = state.getGroup(groupId);
      if (!group) return json({ error: "Group not found" });

      const nameOrId = params.name_or_agent_id as string;
      const agentId = contacts.resolve(nameOrId);
      if (!agentId) {
        return json({ error: `Unknown contact: ${nameOrId}. Ask the user for their agent ID.` });
      }

      await invites.sendDirectInvite(agentId, groupId, group.goal, group.done_when);
      log(`Invite sent to ${nameOrId}`);

      return json({
        group_id: groupId,
        invited: agentId,
        status: "invite_sent",
      });
    },
  };

  // -----------------------------------------------------------------------
  // agentlink_join_group
  // -----------------------------------------------------------------------
  const joinGroupTool = {
    name: "agentlink_join_group",
    label: "Join Group",
    description: "Join a coordination group using an invite code that was shared with you.",
    parameters: JoinGroupSchema,
    async execute(_id: string, params: Record<string, unknown>) {
      const code = params.invite_code as string;
      const invite = await invites.resolveInviteCode(code);
      if (!invite) return json({ error: "Invalid or expired invite code" });

      const groupId = invite.group_id;

      await mqtt.subscribeGroup(groupId);

      state.addGroup({
        group_id: groupId,
        driver: invite.from,
        goal: invite.goal,
        done_when: "",
        intent_id: "",
        participants: [invite.from],
        expected_participants: 0, // joining agent doesn't know the full count
        status: "active",
        idle_turns: 0,
        created_at: new Date().toISOString(),
      });

      await publishStatus(config, mqtt, groupId);

      const joinMsg = createEnvelope(config.agent.id, {
        group_id: groupId,
        to: "group",
        type: "join",
        payload: { text: `${config.agent.id} joined the group` },
      });
      await mqtt.publishEnvelope(TOPICS.groupSystem(groupId), joinMsg);

      if (!contacts.resolve(invite.from)) {
        contacts.add(invite.from, invite.from);
      }

      return json({
        group_id: groupId,
        driver: invite.from,
        goal: invite.goal,
        status: "joined",
      });
    },
  };

  // -----------------------------------------------------------------------
  // agentlink_complete
  // -----------------------------------------------------------------------
  const completeTool = {
    name: "agentlink_complete",
    label: "Complete",
    description:
      "Declare that the coordination is complete. Only call this when the goal has been achieved or explicitly abandoned.",
    parameters: CompleteSchema,
    async execute(_id: string, params: Record<string, unknown>) {
      const groupId = params.group_id as string;
      const summary = params.summary as string;
      const success = (params.success as boolean) ?? true;

      const group = state.getGroup(groupId);
      if (!group) return json({ error: "Group not found" });

      if (group.driver !== config.agent.id) {
        return json({ error: "Only the driver agent can complete a coordination" });
      }

      const completionMsg = createEnvelope(config.agent.id, {
        group_id: groupId,
        to: "group",
        type: "leave",
        payload: {
          text: summary,
          status: success ? "completed" : "failed",
        },
      });
      await mqtt.publishEnvelope(TOPICS.groupSystem(groupId), completionMsg);

      await mqtt.unsubscribeGroup(groupId);

      await mqtt.publish(
        TOPICS.groupStatus(groupId, config.agent.id),
        "",
        { retain: true },
      );

      state.removeGroup(groupId);
      channelInbound?.clearWatchdog(groupId);

      log(`Coordination complete: ${summary}`);

      // Dispatch completion summary back to Main Session
      if (channelInbound) {
        const participantNames = group.participants
          .filter(p => p !== config.agent.id)
          .map(p => resolveDisplayName ? resolveDisplayName(p) : (contacts.getNameByAgentId(p) ?? p))
          .join(", ");
        channelInbound.dispatchToMainSession(
          `Coordination with ${participantNames} complete.\n\n**Goal:** ${group.goal}\n**Result:** ${summary}`,
        );
      }

      return json({
        group_id: groupId,
        status: success ? "completed" : "failed",
        summary,
      });
    },
  };

  // -----------------------------------------------------------------------
  // agentlink_status
  // -----------------------------------------------------------------------
  const statusTool = {
    name: "agentlink_status",
    label: "Status",
    description:
      "Check AgentLink health: broker connection, agent identity, and active groups. Use this to verify the plugin is working.",
    parameters: StatusSchema,
    async execute(_id: string, _params: Record<string, unknown>) {
      const connected = mqtt.getClient().isConnected();
      const activeGroupIds = state.getActiveGroups();
      const groups = activeGroupIds.map((id) => {
        const g = state.getGroup(id);
        return g
          ? { group_id: id, goal: g.goal, participants: g.participants.length, status: g.status }
          : { group_id: id };
      });

      return json({
        agent_id: config.agent.id,
        display_name: config.agent.displayName ?? null,
        broker: config.brokerUrl,
        connected,
        active_groups: groups.length,
        groups,
        capabilities: config.agent.capabilities.map((c) => c.name),
      });
    },
  };

  return [statusTool, coordinateTool, submitJobTool, inviteAgentTool, joinGroupTool, completeTool];
}
