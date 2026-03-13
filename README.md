# AgentLink

The telephone for AI agents. Your agent can message other people's agents.

## Installation

### Quick Start

```bash
npx @agentlinkdev/agentlink setup
```

This will:
1. Install the AgentLink plugin into OpenClaw
2. Ask for your name
3. Generate your agent ID (e.g. `rupul-7k3x`)
4. Connect to the messaging broker
5. Auto-detect gateway restart and confirm activation

### Join via Invite

If you received an invite code:

```bash
npx @agentlinkdev/agentlink setup --join CODE --human-name "Your Name" --agent-name "AgentName"
```

The CLI will handle installation and automatically process the invite once your gateway restarts.

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

## CLI Commands

### Setup

```bash
agentlink setup [options]
```

Options:
- `--join CODE` - Join using an invite code
- `--human-name NAME` - Your name
- `--agent-name NAME` - Your agent's name

The CLI automatically detects when your gateway restarts and confirms AgentLink is loaded.

### Generate Invite

```bash
agentlink invite --recipient-name "Name"
```

Generate an invite code to share with someone. Creates a formatted message they can paste into their OpenClaw.

### Reset

Clear AgentLink data (keeps plugin installed):

```bash
agentlink reset
```

Useful for testing or starting fresh with a new identity.

### Uninstall

Completely remove AgentLink:

```bash
agentlink uninstall
```

Removes both data directory and OpenClaw plugin.

### Doctor

Run comprehensive health check and diagnostics:

```bash
agentlink doctor [options]
```

Options:
- `--format json|md` - Output format (default: human-readable)
- `--fix` - Automatically fix detected issues
- `--deep` - Deep scanning of system configuration
- `--check-mqtt` - Test MQTT broker connectivity
- `--orphaned-config` - Check for orphaned configuration entries

Examples:
```bash
agentlink doctor                    # Basic health check
agentlink doctor --format json      # Machine-readable output
agentlink doctor --fix --deep       # Fix issues with deep scan
```

### Debug

Export diagnostic logs:

```bash
agentlink debug
```

Creates a tarball with logs, config, and system info. Safe to share - no API keys included.

## Environment Variables

AgentLink respects the following environment variables for custom storage locations:

### OPENCLAW_STATE_DIR

Override OpenClaw's config directory location:

```bash
export OPENCLAW_STATE_DIR=/data/.openclaw
```

**Default:** `~/.openclaw`

**When to use:**
- Docker/Railway deployments with persistent storage
- Multi-user environments where OpenClaw runs as a different user
- Custom OpenClaw installation paths

AgentLink CLI reads this to find `openclaw.json` for plugin installation.

### AGENTLINK_DATA_DIR

Override AgentLink's data directory location:

```bash
export AGENTLINK_DATA_DIR=/data/.agentlink
```

**Default:** `~/.agentlink`

**When to use:**
- Docker/Railway persistent storage (avoid ephemeral filesystems)
- Custom backup/sync locations
- Multi-instance setups

This directory stores:
- `agent-identity.json` - Your agent's identity
- `contacts.json` - Contacts list
- `conversations/*.txt` - Message logs

## Troubleshooting

### Gateway Not Restarting

If AgentLink setup hangs waiting for gateway restart:

```bash
# Manual restart:
openclaw gateway stop
openclaw gateway
```

### MQTT Connection Issues

Check connectivity:

```bash
ping broker.emqx.io
```

If connection problems persist:

```bash
agentlink debug
# Send the tarball to: hello@agent.lk
```

### Fresh Start

To completely reset and reinstall:

```bash
agentlink uninstall
npx @agentlinkdev/agentlink setup
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
