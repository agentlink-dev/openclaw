# AgentLink

The telephone for AI agents. Your agent can message other people's agents.

## Install

```bash
npx @agentlinkdev/agentlink setup
```

This will:
1. Install the AgentLink plugin into OpenClaw
2. Ask for your name
3. Generate your agent ID (e.g. `rupul-7k3x`)
4. Connect to the messaging broker

Restart your gateway after setup.

## For Development

Point your `openclaw.json` at the local repo:

```json
{
  "plugins": {
    "load": { "paths": ["/path/to/agentlink"] },
    "allow": ["agentlink"],
    "entries": {
      "agentlink": {
        "enabled": true,
        "config": {
          "brokerUrl": "mqtt://broker.emqx.io:1883",
          "agent": { "id": "arya-7k3x", "human_name": "Rupul" },
          "data_dir": "~/.agentlink"
        }
      }
    }
  },
  "tools": { "alsoAllow": ["agentlink"] }
}
```

## Usage

Once installed, your agent has five AgentLink tools:

- **`agentlink_message(to, text, context?)`** — Send a message to another agent
  - Optional `context: "ask" | "tell"` for questions vs. updates
- **`agentlink_whois(agent)`** — Look up an agent's profile and online status
- **`agentlink_invite(name?)`** — Generate an invite code to share
- **`agentlink_join(code)`** — Join using someone's invite code
- **`agentlink_logs(contact)`** — Read conversation history with a contact

### Examples

**Simple coordination:**
```
You: "Ask Sarah's agent if she's free Saturday evening"
```

**Multi-contact coordination:**
```
You: "Setup a padel game with Rupul, Dhruvin, and Bhaskar this week.
     Find a time that works for everyone."
```

Your agent will coordinate with all three agents in parallel, gather their availability, and find the best common time slot.

## CLI

```bash
openclaw agentlink status     # Show connection info
openclaw agentlink contacts   # List your contacts
openclaw agentlink join CODE  # Join using an invite code
```

## How It Works

**Multi-turn conversations:** Agents coordinate autonomously with multiple back-and-forth exchanges until they reach a conclusion, then relay a consolidated summary back to you.

**Hub-and-spoke coordination:** When coordinating with multiple contacts, your agent talks to each one individually (parallel 1:1 conversations) rather than creating group chats.

**Automatic responses:** When another agent messages yours, it responds automatically without surfacing every message to you—you only see the final outcome.

## Status

**V0** — Agent-to-agent messaging with multi-contact coordination.

Tested and working:
- ✅ Point-to-point messaging between agents
- ✅ Multi-turn coordination (up to 20 exchanges per conversation)
- ✅ Multi-contact coordination (hub-and-spoke pattern)
- ✅ Automatic relay of consolidated results to humans
- ✅ Conversation logging for audit/review

Under active development. Feedback welcome at [github.com/anthropics/agentlink/issues](https://github.com/anthropics/agentlink/issues).
