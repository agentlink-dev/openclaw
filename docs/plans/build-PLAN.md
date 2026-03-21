# AgentLink PII Sharing — Build Plan

**Date:** 2026-03-21
**Branch:** `privacy-mgt`
**Depends on:** AgentPII-PLAN.md (design), AgentPII-AskFlow-PLAN.md v2 (ask architecture), pretest-results.md (validation)

---

## Context

The pretest (11/13 pass) proved prompt-based sharing control works with Haiku. The pretest hook (`sharing-prompt.txt` in `channel.ts:455-476`) is throwaway scaffolding to be replaced by structured `sharing.json` reading.

Two plans to implement:
1. **AgentPII-PLAN.md** — Core sharing policy system (sharing.json, profiles, prompt injection, CLI, update tool)
2. **AgentPII-AskFlow-PLAN.md v2** — Ask flow (AskManager, agentlink_ask_human, agentlink_resolve_ask)

---

## Dependency Graph

```
sharing.ts (types, profiles, read/write, resolution)
    |
    +---> channel.ts (replace pretest hook with structured sharing.json reader)
    |        |
    |        \---> needs sharing.ts: readSharing(), getAllowedScopes(), etc.
    |
    +---> tools.ts: agentlink_update_policy
    |        |
    |        \---> calls setPermission(), setContactOverride(), setProfile()
    |
    \---> ask-manager.ts (AskManager class — standalone, no sharing.ts dependency)
             |
             +---> tools.ts: agentlink_ask_human (calls askManager.register + pushNotification)
             |
             \---> tools.ts: agentlink_resolve_ask (calls askManager.resolve + sharing.ts writers)

index.ts  <-- wires AskManager singleton, relay timer guard
bin/cli.js <-- sharing/trust CLI commands (independent, can be last)
```

---

## Phase 1: sharing.ts + channel.ts update

### What to build

**`src/sharing.ts` (new file):**
- Types: `SharingProfile`, `PermissionAction`, `SharingConfig`, scope constants
- Profile constants: `OPEN_PROFILE`, `BALANCED_PROFILE`, `PRIVATE_PROFILE`
- Pure functions (stateless, read from disk each call):
  - `readSharing(dataDir)` — reads `sharing.json`, returns defaults if missing
  - `resolvePermission(sharing, scope, contactAgentId?)` — resolution order: contact override > base permission > block
  - `getAllowedScopes(sharing, contactAgentId?)` — scopes that resolve to "allow"
  - `getAskScopes(sharing, contactAgentId?)` — scopes that resolve to "ask"
  - `getBlockedScopes(sharing, contactAgentId?)` — scopes that resolve to "block"
  - `writeSharing(dataDir, sharing)` — atomic write (tmp + rename)
  - `setProfile(dataDir, profile)` — resets to profile defaults
  - `setPermission(dataDir, scope, action)` — update base permission
  - `setContactOverride(dataDir, agentId, name, humanName, scope, action)`
  - `removeContactOverride(dataDir, agentId, scope)`

**`src/channel.ts` update:**
- Remove pretest hook (lines ~455-476 — `sharing-prompt.txt` reader)
- Replace with structured reader calling `readSharing()`, `getAllowedScopes()`, `getAskScopes()`, `getBlockedScopes()`
- Build prompt block: "You MAY share: ...", "ASK your human first: ...", "NEVER share: ..."
- When ask scopes exist, add: "Use the agentlink_ask_human tool..."

### How to test

- **Unit tests for sharing.ts:** Pure function tests, no gateway needed.
  - `readSharing()` returns open profile defaults when file missing
  - `resolvePermission()` follows resolution order (contact > base > block)
  - Per-contact overrides work for allow and block
  - `writeSharing()` round-trips correctly
  - `setPermission()` / `setContactOverride()` modify the file correctly
- **Regression: re-run pretest suite** with sharing.json files instead of sharing-prompt.txt
  - Convert each of the 13 test prompts to a sharing.json config
  - Same questions, same grep patterns, same expected results
  - Gate: 11/13 must still pass (matching pretest baseline)

### Checklist

- [x] Create `src/sharing.ts` with types and profile constants
- [x] Implement `readSharing()` and `writeSharing()` with atomic write
- [x] Implement `resolvePermission()` with contact > base > block resolution
- [x] Implement `getAllowedScopes()`, `getAskScopes()`, `getBlockedScopes()`
- [x] Implement `setProfile()`, `setPermission()`, `setContactOverride()`, `removeContactOverride()`
- [x] Unit test sharing.ts (resolution logic, profiles, read/write, overrides)
- [x] Update `channel.ts`: remove pretest hook (sharing-prompt.txt reader)
- [x] Update `channel.ts`: add structured sharing.json reader in `formatInboundMessage()`
- [x] Update `channel.ts`: add ask-scope instruction line when ask scopes present
- [x] Build (`npm run build`) and verify no TypeScript errors
- [x] Convert pretest cases to sharing.json configs
- [x] Re-run pretest regression (gate: 11/13 pass)
- [x] Commit

---

## Phase 2: ask-manager.ts

### What to build

**`src/ask-manager.ts` (new file):**
- Types: `AskDecision`, `AskRecord`, `PendingEntry`
- `AskManager` class:
  - `register(record, timeoutMs=120_000)` — writes pending-ask file, creates Promise in Map, sets timeout
  - `resolve(askId, decision)` — writes resolution to file, resolves Promise if still pending, returns true/false
  - `hasPendingForContact(contactAgentId)` — checks Map for pending asks from a contact
  - `getPending(askId)` — reads from Map or falls back to file
  - Private: `writeFile(record)` (atomic tmp+rename), `readFile(askId)`
- Directory: `~/.agentlink/pending-asks/` created on first ask

### How to test

- Pure unit tests, no gateway, no LLM, no MQTT. Fast.
- Use a temp directory for dataDir.

### Checklist

- [x] Create `src/ask-manager.ts` with types
- [x] Implement `register()` — file write + Promise creation + timeout
- [x] Implement `resolve()` — file update + Promise resolution + late-reply handling
- [x] Implement `hasPendingForContact()` and `getPending()`
- [x] Implement private file I/O with atomic writes
- [x] Unit test: register + resolve happy path (Promise resolves with decision)
- [x] Unit test: register + timeout (Promise resolves with "timeout" after timeoutMs)
- [x] Unit test: late resolve after timeout (resolve returns false, file still updated)
- [x] Unit test: double resolve is no-op
- [x] Unit test: hasPendingForContact correct before/after resolve/timeout
- [x] Unit test: file written on register, updated on resolve, updated on timeout
- [x] Unit test: getPending reads from Map when pending, falls back to file when timed out
- [x] Build and verify no TypeScript errors
- [x] Commit

---

## Phase 3: Tools + wiring

### What to build

**`src/tools.ts` — three new tools:**
- `agentlink_update_policy` — set_profile / set_permission / set_contact_override / remove_contact_override
- `agentlink_ask_human` — calls askManager.register(), pushNotification(), awaits Promise
- `agentlink_resolve_ask` — calls askManager.resolve(), updates sharing.json for "always" decisions

**`src/index.ts` — wiring:**
- Create `AskManager` singleton at plugin init
- Pass askManager to tool context
- Add relay timer guard: `if (askManager.hasPendingForContact(senderAgentId)) skip relay`

### How to test

- **Smoke test (gateway needed):**
  - Start Arya with sharing.json set to "open" profile
  - Via webchat: "block financial for everyone" → verify sharing.json updated
  - Via webchat: "always allow calendar.write for Cersei" → verify contact override in sharing.json
- **Ask flow integration (manual, one-time):**
  - Set `location.precise = "ask"` in sharing.json
  - Cersei asks for Rupul's home address
  - Verify: notification arrives on Slack with numbered options
  - Reply "2" on Slack
  - Verify: sharing.json updated with contact override
  - Verify: Arya shares the address with Cersei (same conversation or re-ask)
  - Test timeout path: don't reply, verify Arya denies after 2 min
  - Test late reply: reply after timeout, verify sharing.json still updated

### Checklist

- [x] Add `agentlink_update_policy` tool to `src/tools.ts`
- [x] Add `agentlink_ask_human` tool to `src/tools.ts`
- [x] Add `agentlink_resolve_ask` tool to `src/tools.ts`
- [x] Wire AskManager singleton in `src/index.ts` (create at plugin init)
- [x] Pass askManager + pushNotification to ask tool contexts
- [x] Add relay timer guard in `src/index.ts` (suppress relay while ask pending)
- [x] Build and verify no TypeScript errors
- [x] Smoke test: `agentlink_update_policy` via webchat (set profile, set permission, set override)
- [x] Integration test: ask flow happy path (Cersei asks → Slack/WhatsApp notification → reply → share)
- [x] Integration test: ask flow timeout (no reply → deny after 2 min)
- [x] Integration test: late reply upgrade (timeout → later reply → sharing.json updated)
- [x] Integration test: relay timer suppressed while ask pending
- [x] Programmatic reply interception (message_received hook resolves ask on "1"/"2"/"3"/"4")
- [x] Clean LLM confirmation via before_agent_start hook (Slack + WhatsApp)
- [x] Commit

---

## Phase 4: CLI

### What to build

**`bin/cli.js` — new commands:**
- `agentlink sharing` — show current sharing summary (profile, allowed/ask/blocked scopes)
- `agentlink sharing set <scope> <allow|ask|block>` — modify base permission
- `agentlink sharing profile <open|balanced|private>` — switch profile (resets to defaults)
- `agentlink trust <contact> [--grant <scope>] [--revoke <scope>] [--full]` — per-contact exceptions

**`bin/cli.js` — setup additions:**
- End-of-setup sharing summary (profile, what's shared/asked/blocked)
- `--sharing-profile <open|balanced|private>` flag
- `--block <scope>` and `--allow <scope>` flags (repeatable)

### How to test

- CLI-level tests: run commands, check sharing.json output. No gateway needed.

### Checklist

- [ ] Add `agentlink sharing` subcommand (read + display summary)
- [ ] Add `agentlink sharing set` subcommand (write permission)
- [ ] Add `agentlink sharing profile` subcommand (reset to profile)
- [ ] Add `agentlink trust` subcommand (per-contact overrides)
- [ ] Add sharing summary to end-of-setup flow
- [ ] Add `--sharing-profile`, `--block`, `--allow` flags to setup
- [ ] Test: `agentlink sharing` shows correct output for each profile
- [ ] Test: `agentlink sharing set calendar.write block` updates sharing.json
- [ ] Test: `agentlink sharing profile private` resets to private defaults
- [ ] Test: `agentlink trust cersei --grant location.precise` adds override
- [ ] Test: `agentlink trust cersei --full` sets all scopes to allow
- [ ] Build and verify no errors
- [ ] Commit

---

## Post-build

- [ ] Remove any remaining pretest scaffolding (sharing-prompt.txt references)
- [ ] Update version in package.json
- [ ] Test locally with `reset-arya.sh --source local` before publishing
- [ ] Publish to npm
- [ ] Update MEMORY.md with new architecture notes
