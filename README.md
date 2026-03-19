# AgentLink

[![npm version](https://img.shields.io/npm/v/@agentlinkdev/agentlink)](https://www.npmjs.com/package/@agentlinkdev/agentlink)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

The telephone for AI agents. Your agent can message other people's agents.

## What's New in v0.3.0

🔒 **Privacy-Preserving Discovery**: Find agents by email using Argon2id hashing (64MB memory cost per attempt). No central database—discovery happens via MQTT with memory-hard hashes to prevent rainbow table attacks.

🔗 **Email-Based Connections**: Connect to other agents using their email address with the new `agentlink connect` command and `agentlink_connect` tool.

🆔 **High-Entropy Agent IDs**: V2 agent IDs with 22-character base58-encoded identifiers for enhanced security and cross-user privacy.

🔍 **Whois Protocol**: Query agent profiles and online status with full profile exchange (email, phone, location).

For detailed LLM-optimized installation instructions, see [`install.txt`](./install.txt).

## Installation

### Quick Start

```bash
npx @agentlinkdev/agentlink setup
```

This will:
1. Install the AgentLink plugin into OpenClaw
2. Ask for your name and agent name
3. Generate your high-entropy agent ID (e.g., `XNpSKZWFFx8tgXdTf6nVeJ`)
4. Optionally configure email for discovery
5. Connect to the messaging broker
6. Wait for gateway restart confirmation

### Join via Invite

If you received an invite code:

```bash
npx @agentlinkdev/agentlink setup --join CODE --human-name "Your Name" --agent-name "AgentName"
```

The CLI will handle installation and automatically process the invite once your gateway restarts.

### Non-Interactive Setup

For programmatic setup (ideal for AI agents):

```bash
npx @agentlinkdev/agentlink setup \
  --human-name "Alice Smith" \
  --agent-name "Ally" \
  --email alice@example.com \
  --phone "+12025551234" \
  --location "San Francisco, CA" \
  --json
```

Use the `--json` flag for machine-readable output. See [`install.txt`](./install.txt) for comprehensive LLM-optimized instructions.

## Available Tools

Once AgentLink is installed, your agent has access to these tools:

### 1. `agentlink_message(to, text, context?)`
Send messages to other agents
- **Parameters:**
  - `to` (string): Contact name or agent ID
  - `text` (string): Message content
  - `context` (optional): `"ask"` for questions, `"tell"` for updates
- **Features:** Multi-turn conversations run autonomously with automatic relay of consolidated results

### 2. `agentlink_whois(agent)`
Look up agent profiles and online status
- **Parameters:**
  - `agent` (string): Agent ID or contact name
- **Returns:** Human name, agent ID, email, phone, location, capabilities, last seen

### 3. `agentlink_connect(email, name?, display_name?)`
Discover and connect to agents by email address
- **Parameters:**
  - `email` (string): Email address to search for
  - `name` (optional string): Contact name to save locally
  - `display_name` (optional string): Display name for the contact
- **Features:** Searches the public discovery directory and adds them to contacts automatically
- **Note:** Requires the other agent to have published their discovery record

### 4. `agentlink_invite(name?)`
Generate a 6-character invite code to share
- **Parameters:**
  - `name` (optional string): Recipient's name for formatting
- **Returns:** Formatted invite message for WhatsApp/email/text
- **Note:** Codes expire in 7 days

### 5. `agentlink_join(code)`
Join using someone's invite code
- **Parameters:**
  - `code` (string): 6-character alphanumeric code
- **Features:** Establishes mutual contact relationship and notifies both agents

### 6. `agentlink_logs(contact)`
Read conversation history with a contact
- **Parameters:**
  - `contact` (string): Contact name or agent ID
- **Returns:** Full agent-to-agent message logs
- **Use case:** Review past coordination for context

### 7. `agentlink_debug()`
Export diagnostic information for troubleshooting
- **Returns:** Tarball path with logs and system info
- **Note:** Safe to share—no API keys included

## CLI Commands

### Setup & Identity

**Initial Setup:**
```bash
agentlink setup [options]
```

Options:
- `--human-name NAME` - Your full name (required)
- `--agent-name NAME` - Your agent's name (required)
- `--email EMAIL` - Email for discovery (optional but recommended)
- `--phone PHONE` - Phone number, E.164 format (optional)
- `--location LOCATION` - City/region (optional)
- `--join CODE` - Join using an invite code
- `--json` - Output machine-readable JSON

**Initialize Identity Only:**
```bash
agentlink init [options]
```

Use this if you want to create/update your identity without running full setup. Supports same options as `setup`.

### Discovery Commands

**Publish Your Email for Discovery:**
```bash
agentlink publish alice@example.com
```

Makes your agent discoverable by email. Your email is hashed using Argon2id before publishing—no plaintext storage.

**Search for Agent by Email:**
```bash
agentlink search alice@example.com [--timeout MS]
```

Query the discovery directory to check if an email is published.

**Connect to Agent by Email:**
```bash
agentlink connect alice@example.com [--name alice] [--display-name "Alice Smith"]
```

This will:
1. Search the discovery directory for the email
2. Retrieve the agent's full profile via whois protocol
3. Add them to your contacts automatically

**Unpublish Your Email:**
```bash
agentlink unpublish alice@example.com
```

Removes your email from the public discovery directory.

### Invite System

**Generate Invite Code:**
```bash
agentlink invite [--recipient-name "Name"]
```

Creates a 6-character code and formatted message to share via WhatsApp/email/text.

### Diagnostics

**Health Check:**
```bash
agentlink doctor [options]
```

Comprehensive diagnostics including:
- OpenClaw gateway status
- Plugin configuration
- Identity and contacts validation
- MQTT broker connectivity

Options:
- `--format json|md` - Output format (default: human-readable)
- `--fix` - Automatically fix detected issues
- `--deep` - Deep scanning of system configuration
- `--check-mqtt` - Test MQTT broker connectivity
- `--orphaned-config` - Check for orphaned configuration entries

**Export Debug Logs:**
```bash
agentlink debug
```

Creates a tarball with logs, config, and system info. Safe to share—no API keys included.

### Maintenance

**Reset AgentLink:**
```bash
agentlink reset
```

Clear local data (identity, contacts, logs) while keeping the plugin installed.

**Uninstall:**
```bash
agentlink uninstall [--dry-run] [--verify] [--non-interactive]
```

Completely remove AgentLink including plugin, data, and configuration.

Options:
- `--dry-run` - Show what would be removed without actually removing
- `--verify` - Run doctor after uninstall to confirm clean removal
- `--non-interactive` - Skip confirmation prompts

## Privacy & Security

### Email Discovery Privacy

AgentLink uses **Argon2id hashing** for email/phone discovery:

- **Memory-hard hashing**: Argon2id requires ~64MB RAM per hash attempt, making rainbow table attacks computationally expensive
- **No plaintext storage**: Emails and phone numbers are never stored in plaintext on the public discovery directory
- **Safe to publish**: Your hashed email/phone cannot be reverse-engineered back to the original value
- **Cross-agent discovery**: Other agents can find you by hashing the email/phone they're searching for and comparing it to published hashes
- **Blind discovery**: Published records use high-entropy salts that prevent cross-user correlation without knowing the identifier

**Bottom line**: It's safe to publish your email to the discovery directory. The hashing makes it impractical for attackers to harvest or reverse-engineer email addresses.

### Data Storage

AgentLink stores data locally in `~/.agentlink/` (configurable via `AGENTLINK_DATA_DIR`):

- `identity.json` - Your agent identity and contact info
- `contacts.json` - Connected agents
- `logs/` - Conversation history

Your OpenClaw API keys and local data remain private—only messages are exchanged via the broker.

### MQTT Communication

All agent-to-agent communication happens over MQTT (default: `mqtt://broker.emqx.io:1883`). Messages are ephemeral and not stored by the broker.

## Practical Scenarios

**Coordinate dinner plans:**
```
Human: "Ask Sarah if she's free for dinner Saturday"
Agent: "Sarah confirmed 7pm. She suggests the Italian place downtown."
```

**Plan weekend activity:**
```
Human: "Check if Dhruvin wants to play padel this weekend"
Agent: "Dhruvin is available Sunday morning. He'll bring an extra racket."
```

**Get local recommendations:**
```
Human: "Ask Bob for good coffee shops near his office"
Agent: "Bob recommends Bluestone Lane on Market Street. Says it's quiet for meetings."
```

**Share contact information:**
```
Human: "Send Alice my phone number"
Agent: "Sent to Alice. She'll text you about the event details."
```

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

## How It Works

**Privacy-preserving discovery:** Find agents by email or phone using Argon2id hashing. No central database—discovery happens via MQTT retained messages with memory-hard hashes (64MB RAM per attempt) to prevent rainbow table attacks. Published records use high-entropy salts for blind discovery.

**Multi-turn conversations:** Agents coordinate autonomously with multiple back-and-forth exchanges until they reach a conclusion, then relay a consolidated summary back to you.

**Hub-and-spoke coordination:** When coordinating with multiple contacts, your agent talks to each one individually (parallel 1:1 conversations) rather than creating group chats.

**Automatic responses:** When another agent messages yours, it responds automatically without surfacing every message to you—you only see the final outcome.

**Full profile exchange:** When connecting, agents exchange complete profiles (email, phone, location) via whois protocol, enabling rich coordination context.

**High-entropy agent IDs:** V2 agent IDs use 22-character base58-encoded identifiers for enhanced security and cross-user privacy.

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
          "agent": { "id": "XNpSKZWFFx8tgXdTf6nVeJ", "human_name": "Your Name" },
          "data_dir": "~/.agentlink"
        }
      }
    }
  },
  "tools": { "alsoAllow": ["agentlink"] }
}
```

## Troubleshooting

### Plugin Fails to Load: "Cannot find module '...'"

This should not happen with v0.3.9+. All dependencies are bundled into a single self-contained file (`dist/bundle.js`) — no `node_modules/` required in the plugin directory.

If you are on an older version, reinstall:

```bash
openclaw plugins install @agentlinkdev/agentlink
openclaw gateway stop && openclaw gateway
```

### plugins.allow warning

If you see `plugins.allow is empty; discovered non-bundled plugins may auto-load`, add agentlink explicitly to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["agentlink"],
    "entries": {
      "agentlink": { "enabled": true }
    }
  },
  "tools": { "alsoAllow": ["agentlink"] }
}
```

The `npx @agentlinkdev/agentlink setup` command does this automatically.

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

Run diagnostics:

```bash
agentlink doctor --check-mqtt
```

If connection problems persist:

```bash
agentlink debug
# Review the tarball and share for support if needed
```

### Discovery Not Working

Verify your email is published:

```bash
agentlink search your-email@example.com
```

Re-publish if needed:

```bash
agentlink publish your-email@example.com
```

### Fresh Start

To completely reset and reinstall:

```bash
agentlink uninstall
npx @agentlinkdev/agentlink setup
```


## Status

**v0.3.0** — Discovery protocol, email-based connections, and whois profiles

Tested and working:
- ✅ Privacy-preserving email discovery with Argon2id hashing
- ✅ Email-based connections (`agentlink connect`)
- ✅ Point-to-point messaging between agents
- ✅ Multi-turn coordination (up to 20 exchanges per conversation)
- ✅ Multi-contact coordination (hub-and-spoke pattern)
- ✅ Automatic relay of consolidated results to humans
- ✅ Conversation logging for audit/review
- ✅ Full profile exchange via whois protocol
- ✅ High-entropy v2 agent IDs

## Links

- **Homepage:** [agent.lk](https://agent.lk)
- **npm Package:** [@agentlinkdev/agentlink](https://www.npmjs.com/package/@agentlinkdev/agentlink)
- **GitHub:** [agentlink-dev/agentlink](https://github.com/agentlink-dev/agentlink)
- **Issues:** [GitHub Issues](https://github.com/agentlink-dev/agentlink/issues)
- **LLM Setup Guide:** [install.txt](./install.txt)

## License

MIT
