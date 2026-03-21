# AgentLink PII "Ask" Flow — Implementation Plan (v2)

**Date:** 2026-03-21
**Status:** Draft
**Depends on:** AgentPII-PLAN.md Phase 1 (sharing.json, permission categories)
**Branch:** `privacy-mgt`

---

## Problem

The `"ask"` permission action in sharing.json has no implementation. When a scope is set to `"ask"`, the agent should pause the A2A conversation, consult the human, and act on their decision. Today there's no mechanism for this — the agent either shares or blocks.

A2A conversations complete in ~10 seconds. The human can't be consulted synchronously. We need an asynchronous flow that coordinates across three concurrent sessions:
1. **A2A session** (Arya <> Cersei) — where the ask is triggered
2. **Human channel session** (Arya <> Rupul via Slack) — where the human decides
3. **Remote agent** (Cersei) — who waits and follows up

---

## Architecture: AskManager (Promise + Map + File)

Modeled after OpenClaw's `ExecApprovalManager` — the same pattern used in production for exec approvals (tool pauses, human decides, tool resumes).

### Core: in-process Promise resolution

Both the A2A session and the Slack session run in the **same Node.js process** (the OpenClaw gateway). Coordination uses a shared singleton `AskManager` that holds pending Promises in a Map. No polling. No EventEmitter. Direct Promise resolution — zero latency.

```
AskManager (singleton, created at gateway startup)
├── pending: Map<askId, { promise, resolve, record }>
├── register(record, timeoutMs) → Promise<AskDecision>   // called by A2A tool
├── resolve(askId, decision) → boolean                    // called by Slack tool
└── getPending(askId) → AskRecord | null                  // for inspection
```

**Wait side** (A2A session tool calls `register`):
1. Writes pending-ask file to disk (durability)
2. Creates a Promise, stores its `resolve` callback in the Map
3. Sets `setTimeout` → auto-resolves with `"timeout"` after `timeoutMs`
4. Returns the Promise — tool blocks until resolved

**Resolve side** (Slack session tool calls `resolve`):
1. Writes resolution to pending-ask file + updates sharing.json if needed
2. Looks up the askId in the Map
3. If found → calls `resolve(decision)` on the stored Promise → A2A tool unblocks instantly
4. If not found (already timed out) → file is still updated (late-reply upgrade)

**Why not file polling:** Same-process coordination doesn't need filesystem as a signaling mechanism. Polling adds 0–10s latency per ask and requires a loop. The Promise resolves in the same event loop tick.

**Why files still exist:** Durability for late replies (human responds after timeout → sharing.json updated for next time), crash recovery (gateway restart → scan pending-asks/ for stale entries), and debuggability (`cat ~/.agentlink/pending-asks/*.json`).

---

## Notification UX

When Arya encounters an `ask` scope during A2A:

```
Catherine's agent is asking for your home address.

1. Allow (this time)
2. Always allow for Catherine
3. Always allow for everyone
4. Deny
```

**Option effects:**

| Option | This conversation | sharing.json change |
|--------|-------------------|---------------------|
| 1. Allow (this time) | Share the info | None |
| 2. Always allow for contact | Share the info | `contacts[agentId].overrides[scope] = "allow"` |
| 3. Always allow for everyone | Share the info | `permissions[scope] = "allow"` |
| 4. Deny | Refuse | None (scope stays "ask") |

**Decision values:** `"allow-once"` | `"allow-always-contact"` | `"allow-always-everyone"` | `"deny"` | `"timeout"`

---

## Flow Sequence

### Happy path

```
Cersei → Arya (A2A session):
  "What's Rupul's home address?"

Arya's prompt says location.precise = "ask" for this contact.
Arya calls agentlink_ask_human tool with scope + contact info.

  Tool implementation (programmatic, not LLM-driven):
    1. askManager.register(record, 120_000)
       → writes pending-ask file
       → creates Promise in Map
    2. pushNotification() to Rupul's Slack
    3. Awaits the Promise (blocks tool, not the event loop)

Arya (Slack session) → Rupul:
  "Catherine's agent is asking for your home address.
   1. Allow (this time)
   2. Always allow for Catherine
   3. Always allow for everyone
   4. Deny"

Rupul → Arya (Slack session):
  "2"

Arya (Slack session):
  Interprets "2" = always allow for Catherine
  Calls agentlink_resolve_ask("ask_xxx", "allow-always-contact")
    → askManager.resolve(askId, decision)
    → Writes resolution to file
    → Updates sharing.json: contacts[cersei].overrides.location.precise = "allow"
    → Promise resolves instantly

Arya (A2A session):
  agentlink_ask_human returns: { decision: "allow-always-contact", scope: "location.precise" }
  Arya tells Cersei: "Let me check... Rupul's home address is 742 Evergreen Terrace."

Arya → Cersei:
  "Rupul's home address is 742 Evergreen Terrace, 1081GZ Amsterdam."
  [CONVERSATION_COMPLETE]
```

### Timeout path

```
Arya (A2A session):
  agentlink_ask_human Promise resolves with "timeout" after 2 min.

Arya → Cersei:
  "Rupul hasn't responded — I can't share that right now."
  [CONVERSATION_COMPLETE]

[Later — Rupul replies "2" on Slack]
Arya (Slack session):
  Calls agentlink_resolve_ask → askManager.resolve()
  → askId not in Map (timed out), but file + sharing.json are still updated
  → Next time Cersei asks for location.precise, it's auto-allowed
```

---

## Relay Timer Suppression

The 30s silence timer fires relay summaries to the human during A2A conversations. If an ask is pending, this creates noise — the human sees the ask notification AND a relay summary interleaved in the same Slack session.

**Fix:** When the A2A silence timer fires, check `askManager.hasPending(senderAgentId)`. If true, skip the relay. The relay fires after the ask resolves or times out.

This is a one-line guard in the relay timer callback in `src/index.ts`.

---

## New Tools

### `agentlink_ask_human`

Available in A2A sessions. **Single tool that handles the entire ask flow programmatically** — the LLM calls one tool, the tool does all orchestration.

```typescript
{
  name: "agentlink_ask_human",
  description: "Ask your human for permission to share information with the other agent. Sends a notification to your human and waits for their decision (up to 2 minutes).",
  parameters: {
    scope: { type: "string", description: "The sharing scope being requested (e.g. 'location.precise')" },
    contactAgentId: { type: "string", description: "The agent ID of the requester" },
    contactName: { type: "string", description: "The human name of the requester" },
    description: { type: "string", description: "Brief description of what's being asked (e.g. 'home address')" }
  },
  returns: {
    decision: "allow-once | allow-always-contact | allow-always-everyone | deny | timeout",
    scope: "the scope that was asked about"
  }
}
```

**Implementation (all programmatic — no LLM steps):**

```typescript
async function askHuman(params, context): Promise<AskResult> {
  const { scope, contactAgentId, contactName, description } = params;
  const askId = `ask_${Date.now()}_${scope}`;

  // 1. Build the notification message
  const message = [
    `${contactName}'s agent is asking for your ${description}.`,
    "",
    "1. Allow (this time)",
    `2. Always allow for ${contactName}`,
    "3. Always allow for everyone",
    "4. Deny",
  ].join("\n");

  // 2. Register with AskManager (writes file + creates Promise)
  const record: AskRecord = { id: askId, scope, contactAgentId, contactName, description };
  const decisionPromise = context.askManager.register(record, 120_000);

  // 3. Push notification to human (fire-and-forget)
  await pushNotification({ message, ...context });

  // 4. Wait for decision (Promise resolves on human reply OR timeout)
  const decision = await decisionPromise;

  return { decision, scope };
}
```

**Why one tool, not two on the A2A side:** The old plan had the LLM execute a 4-step procedure (tell Cersei → write file → dispatch notification → call wait tool). Haiku drops steps from multi-step procedures. By consolidating into one tool call, the LLM's only job is: recognize "ask" scope → call tool → act on result.

### `agentlink_resolve_ask`

Available in all human-facing sessions (Slack, Discord, WhatsApp, webchat).

```typescript
{
  name: "agentlink_resolve_ask",
  description: "Resolve a pending sharing permission ask based on the human's decision.",
  parameters: {
    askId: { type: "string", description: "The pending ask ID" },
    decision: {
      type: "string",
      enum: ["allow-once", "allow-always-contact", "allow-always-everyone", "deny"],
      description: "The human's decision"
    }
  }
}
```

**Implementation:**

```typescript
function resolveAsk(params, context): string {
  const { askId, decision } = params;
  const resolved = context.askManager.resolve(askId, decision);

  if (resolved) {
    return `Decision recorded: ${decision}. The other agent will be notified.`;
  } else {
    // Timed out but late reply — sharing.json was still updated
    return `Decision recorded: ${decision}. The original conversation already ended, but this preference is saved for next time.`;
  }
}
```

---

## AskManager Class

```typescript
// src/ask-manager.ts

export type AskDecision =
  | "allow-once"
  | "allow-always-contact"
  | "allow-always-everyone"
  | "deny"
  | "timeout";

export interface AskRecord {
  id: string;
  scope: string;
  contactAgentId: string;
  contactName: string;
  description: string;
  createdAt: string;
  status: "pending" | "resolved" | "timeout";
  decision?: AskDecision;
  resolvedAt?: string;
}

interface PendingEntry {
  record: AskRecord;
  resolve: (decision: AskDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AskManager {
  private pending = new Map<string, PendingEntry>();
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /**
   * Register a new ask. Writes the pending file, returns a Promise
   * that resolves when the human decides or timeout is reached.
   */
  register(record: AskRecord, timeoutMs = 120_000): Promise<AskDecision> {
    record.createdAt = new Date().toISOString();
    record.status = "pending";

    // Write file for durability
    this.writeFile(record);

    return new Promise<AskDecision>((resolve) => {
      const timer = setTimeout(() => {
        // Timeout: resolve Promise, update file, clean up Map
        this.pending.delete(record.id);
        record.status = "timeout";
        record.decision = "timeout";
        record.resolvedAt = new Date().toISOString();
        this.writeFile(record);
        resolve("timeout");
      }, timeoutMs);

      this.pending.set(record.id, { record, resolve, timer });
    });
  }

  /**
   * Resolve a pending ask. Returns true if the ask was still pending
   * in-memory (instant wake-up). Returns false if already timed out
   * (file + sharing.json are still updated by the caller).
   */
  resolve(askId: string, decision: AskDecision): boolean {
    // Update the file regardless
    const record = this.readFile(askId);
    if (record) {
      record.status = "resolved";
      record.decision = decision;
      record.resolvedAt = new Date().toISOString();
      this.writeFile(record);
    }

    // Update sharing.json (caller handles this via sharing.ts functions)

    // Wake up the waiting Promise if still pending
    const entry = this.pending.get(askId);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(askId);
      entry.resolve(decision);
      return true; // resolved in time
    }

    return false; // timed out, but file was still updated (late reply)
  }

  /** Check if there's a pending ask for a given contact. */
  hasPendingForContact(contactAgentId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.record.contactAgentId === contactAgentId) return true;
    }
    return false;
  }

  /** Get a pending record by ID (for resolve tool to read context). */
  getPending(askId: string): AskRecord | null {
    return this.pending.get(askId)?.record ?? this.readFile(askId);
  }

  // --- File I/O (private) ---

  private filePath(askId: string): string {
    return path.join(this.dataDir, "pending-asks", `${askId}.json`);
  }

  private writeFile(record: AskRecord): void {
    const dir = path.join(this.dataDir, "pending-asks");
    fs.mkdirSync(dir, { recursive: true });
    // Atomic write: write to tmp, rename
    const tmp = this.filePath(record.id) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, this.filePath(record.id));
  }

  private readFile(askId: string): AskRecord | null {
    try {
      return JSON.parse(fs.readFileSync(this.filePath(askId), "utf-8"));
    } catch {
      return null;
    }
  }
}
```

---

## Prompt Changes

### A2A session prompt (in formatInboundMessage)

When any scope resolves to `"ask"`, append to the sharing policy block:

```
ASK YOUR HUMAN FIRST before sharing: {askScopes}.
Use the agentlink_ask_human tool — it will notify your human and wait for their decision.
Tell the other agent you're checking with your human while you wait.
```

This is a single instruction pointing to a single tool. The tool handles everything else.

### Slack/human session prompt

No prompt change needed. The dispatched notification includes full context and numbered options. The LLM interprets "2" → calls `agentlink_resolve_ask` naturally from session history.

**How the Slack LLM knows the askId:** The notification message includes it. The `pushNotification` message is formatted as:

```
[ask:{askId}] Catherine's agent is asking for your home address.

1. Allow (this time)
2. Always allow for Catherine
3. Always allow for everyone
4. Deny
```

The `[ask:{askId}]` prefix gives the Slack session LLM the ID it needs to call `agentlink_resolve_ask`.

---

## Wiring

### Singleton lifecycle

```typescript
// In src/index.ts (plugin init):
const askManager = new AskManager(config.dataDir);

// Pass to tool implementations via context:
tools.agentlink_ask_human.context = { askManager, pushNotification, ... };
tools.agentlink_resolve_ask.context = { askManager, sharing, ... };
```

### Relay timer guard

```typescript
// In src/index.ts, where the 30s silence timer fires:
if (askManager.hasPendingForContact(senderAgentId)) {
  logger.info(`[AgentLink] Skipping relay — ask pending for ${senderAgentId}`);
  return; // suppress relay while ask is in-flight
}
```

---

## Files to Change

| File | Change |
|------|--------|
| `src/ask-manager.ts` | **NEW** — `AskManager` class (Promise + Map + file persistence) |
| `src/tools.ts` | Add `agentlink_ask_human` and `agentlink_resolve_ask` tools |
| `src/channel.ts` | Update `formatInboundMessage()` to include ask instructions when ask scopes present |
| `src/index.ts` | Create `AskManager` singleton; pass to tool context; add relay timer guard |
| `~/.agentlink/pending-asks/` | New directory, created on first ask |

---

## Testing Strategy

### Phase 1: Unit tests — AskManager

**1a. Register + resolve (happy path):**
- `register()` returns a Promise that resolves with the decision
- `resolve()` returns `true` when ask is still pending
- Promise resolves with the correct decision value
- Pending-ask file is written on register, updated on resolve

**1b. Timeout:**
- Promise resolves with `"timeout"` after `timeoutMs`
- File is updated with `status: "timeout"`
- `hasPendingForContact()` returns false after timeout

**1c. Late reply:**
- After timeout, `resolve()` returns `false`
- File is still updated with the decision
- (Caller updates sharing.json — tested separately)

**1d. Double resolve:**
- Calling `resolve()` twice on the same askId is a no-op the second time

**1e. File durability:**
- `getPending()` reads from file when not in Map
- Atomic write (tmp + rename) doesn't corrupt on crash

### Phase 2: Tool tests

**2a. `agentlink_ask_human`:**
- Calls `askManager.register()` with correct record
- Calls `pushNotification()` with formatted message including askId
- Returns the decision from the Promise

**2b. `agentlink_resolve_ask`:**
- Calls `askManager.resolve()` with correct decision
- For `allow-always-contact`: calls `setContactOverride()`
- For `allow-always-everyone`: calls `setPermission()`
- For `allow-once` and `deny`: no sharing.json changes
- Returns appropriate message for in-time vs late resolution

### Phase 3: Integration tests (Arya + Cersei)

**3a. Happy path:** Cersei asks for ask-scoped data → Arya calls `agentlink_ask_human` → Rupul replies "1" → Arya shares with Cersei

**3b. Timeout path:** Cersei asks → Arya notifies → no reply → timeout → Arya denies

**3c. Late reply upgrade:** Timeout → deny → Rupul replies "2" later → sharing.json updated → Cersei asks again → auto-allowed

**3d. Allow-always-everyone:** Rupul replies "3" → base permission updated → different contact asks same scope → auto-allowed

**3e. Relay suppression:** While ask is pending, 30s relay timer does not fire

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Coordination mechanism | Promise + Map (in-process) | Same pattern as OpenClaw's ExecApprovalManager. Zero latency. Both sessions share the same Node.js process. |
| File persistence | Alongside in-memory Map | Durability for late replies, crash recovery, debuggability. File is the record, not the signaling mechanism. |
| Tool design | Single `agentlink_ask_human` tool | All orchestration (file write, notification, wait) is programmatic. LLM calls one tool, not a 4-step procedure. Haiku-safe. |
| Notification format | Numbered options (1/2/3/4) | Like Claude Code permission prompts. Structured, fast to answer. Biased toward allowing (3 allow paths, 1 deny). |
| Timeout behavior | 2 min → deny, late reply upgrades | Deny for this conversation. If human replies later with "always allow," sharing.json is updated for next time. |
| Relay timer | Suppressed while ask pending | Prevents noise — human sees only the ask notification, not interleaved relay summaries. |
| Channel selection | pushNotification (all known channels) | Uses existing `pushNotification()` infrastructure. Webchat fallback if no messaging channels known. |
| No "deny always" option | Intentional | Keeps default at "ask" for next time. User can change to "block" via CLI or `agentlink_update_policy` if they want permanent denial. |
| askId in notification | `[ask:{askId}]` prefix | Gives Slack session LLM the ID it needs to call `agentlink_resolve_ask`. No lookup needed. |

---

## Resolved Questions (from v1)

1. **Pending-ask cleanup:** Files accumulate (tiny, ~200 bytes each). No active cleanup. If it ever matters, add a 7-day TTL sweep on gateway startup.

2. **Concurrent asks:** Each gets its own askId and Promise. Human sees multiple notifications. Acceptable — the numbered-options format makes each self-contained.

3. **Ask scope bundling:** No bundling. If a message triggers multiple ask scopes, each gets its own `agentlink_ask_human` call. The LLM can batch them into one response to Cersei ("checking with Rupul on a couple things"), but each scope is a separate notification and decision. Keeps the UX simple.

4. **Human replies on different channel:** The `agentlink_resolve_ask` tool is available in all sessions. If the human sees the notification on Slack but replies on webchat, the webchat LLM can still call the tool if it has the askId (from session history or the human mentioning it). Edge case — not optimized for, but not broken.

5. **Notification includes conversation context:** Yes. The `description` parameter lets the A2A LLM provide context: "home address" rather than just "location.precise". The tool formats this naturally.
