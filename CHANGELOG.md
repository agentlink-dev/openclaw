# Changelog

All notable changes to AgentLink will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-03-19

### Fixed
- **Plugin loading:** All npm dependencies are now bundled into `dist/bundle.js` via esbuild, eliminating "Cannot find module" errors in Docker/staging environments. npm always strips `node_modules/` from published tarballs regardless of `files`; bundling is the only reliable solution.
- **Discovery:** Replaced `argon2` (native C addon) with `hash-wasm` (pure JS/WASM) — no postinstall builds, no native binaries, works in all environments including Docker containers.
- **Base58 ID length:** `isValidAgentIdV2` and tests now correctly accept 21–23 character IDs; Base58 encoding of 16 bytes varies with leading zero bytes.

### Changed
- **Build:** `tsc` for type checking + esbuild bundle step produces `dist/bundle.js` (all deps inlined, only Node built-ins external).
- **Extension entry:** `./dist/bundle.js` (was `./dist/src/index.js`).
- **CJS interop:** esbuild banner injects `createRequire` so CJS deps (`mqtt`, `ws`) that use dynamic `require()` work inside the ESM bundle.

### Removed
- `argon2` dependency (replaced by `hash-wasm`)

## [0.3.0] - 2026-03-18

### Added
- **Discovery Protocol:** Privacy-preserving agent discovery using Argon2id hashing (64MB memory cost per attempt)
- **Email-Based Connections:** Find and connect to agents by email address through public MQTT discovery directory
- **V2 Agent IDs:** High-entropy 22-character base58-encoded identifiers for enhanced security and cross-user privacy
- **Whois Protocol:** Full profile exchange including email, phone, location, and capabilities
- **CLI:** `agentlink publish <email>` - Publish your email to the discovery directory
- **CLI:** `agentlink search <email>` - Search for agents by email address
- **CLI:** `agentlink connect <email>` - Discover and connect to agents by email with automatic profile retrieval
- **CLI:** `agentlink unpublish <email>` - Remove your email from the discovery directory
- **CLI:** `agentlink init` - Update identity without running full setup
- **Tools:** `agentlink_connect(email, name?, display_name?)` - Discover and add contacts by email
- **Tools:** Enhanced `agentlink_whois(agent)` - Now returns full profile with email, phone, location
- **Documentation:** Comprehensive LLM-optimized installation guide in `install.txt`
- **Documentation:** Updated README with v0.3.0 features, practical scenarios, and discovery protocol details

### Changed
- Agent identity now includes email, phone, and location fields for rich profile exchange
- Discovery records published to `agentlink/discovery/v2/{shortHash}` topics with QoS 1 retention
- Whois queries now exchange complete profile information via MQTT request/response pattern
- Setup command now supports `--email`, `--phone`, and `--location` flags for non-interactive setup
- Connect flow automatically publishes email to discovery directory during setup if provided

### Fixed
- CLI v2 agent ID generation now properly uses high-entropy random bytes
- Connect command now saves email, phone, and location from whois profile response
- Identity file structure updated to match v2 schema with all profile fields

## [0.2.7] - 2026-03-14

### Fixed
- **Critical:** Relay routing now injects into origin session (Slack/WhatsApp) instead of A2A session
- Agent-to-agent conversation summaries now deliver synthesized responses to humans, not raw instruction prompts
- `dispatchToSession()` now uses `originCtx.channel` for correct session targeting
- Extended `OriginContext` interface with `to` and `accountId` fields for proper channel delivery

## [0.2.6] - 2026-03-13

### Added
- **CLI:** `agentlink doctor` command - Comprehensive health check and diagnostics with options for JSON/Markdown output, automatic fixes, deep scanning, MQTT connectivity testing, and orphaned config detection

### Fixed
- **Critical:** Fixed invite payload field name mismatch (`from` → `agent_id`) - invitees can now properly connect to sender agents
- Setup and uninstall bugs with custom data directories now work correctly
- Uninstall now comprehensively cleans plugin directory and load paths
- Enhanced uninstall to properly detect and clean `plugins.load.paths` entries

## [0.2.5] - 2026-03-12

### Fixed
- **Critical:** CLI now respects `OPENCLAW_STATE_DIR` environment variable
- Fixes Railway/Docker deployments where OpenClaw uses custom paths (e.g., `/data/.openclaw`)
- CLI works in multi-user environments (gateway as `openclaw` user, CLI as `root`)
- Added `AGENTLINK_DATA_DIR` environment variable support for custom data directories

### Changed
- Path detection: Falls back to `~/.openclaw` if `OPENCLAW_STATE_DIR` not set (backward compatible)
- Tested on both macOS (homebrew) and Railway (Docker/Linux)

## [0.2.4] - 2026-03-12 (Stable Release)

### Fixed
- **Install UX:** Improved invite message with security context to reduce LLM agent questioning from 4 rounds to ≤1
- **Install UX:** Added comprehensive security FAQ to landing page .txt response
- **Install UX:** CLI now watches for gateway restart and confirms when AgentLink loads

### Added
- **CLI:** `agentlink invite` command - Generate invite codes with recipient name formatting
- **CLI:** `agentlink reset` command - Clear local data without full uninstall
- **CLI:** `agentlink uninstall` command - Complete removal including plugin
- **CLI:** `agentlink debug` command - Export comprehensive diagnostics (tarball with logs, config, system info)
- **CLI:** Visual polish with spinners and progress feedback during setup
- **CLI:** Gateway restart detection with 2-minute timeout and WebSocket endpoint polling
- **Tools:** Updated invite message format with three-part structure (sender instructions, recipient instructions, install message)

### Changed
- CLI setup is now fully non-interactive when using `--join` flag
- Improved error messages and user feedback throughout install flow
- Invite messages now first-person from recipient's perspective
- Landing page security FAQ structured for better LLM parsing

## [0.2.3] - 2026-03-11

### Added
- Landing page improvements with auto-hello feature documentation
- Auto-confirmation messaging for better user experience

### Changed
- Updated invite copy to mention automatic confirmation
- Improved onboarding messaging on join page

## [0.2.2] - 2026-03-11

### Added
- Non-interactive CLI with `--human-name` and `--agent-name` options
- Auto-detection of names from MEMORY.md, USER.md, IDENTITY.md
- `.txt` extension in invite URLs for reliable LLM content delivery

### Fixed
- CLI prompts no longer block automated installation
- Gateway restart instructions improved for service-managed setups

## [0.2.1] - 2026-03-11

### Added
- Landing page at agent.lk with LLM-first design
- Content negotiation (plain text for LLMs, HTML for browsers)
- Configurable landing page URL in AgentLinkConfig

### Changed
- Invite URLs now use Vercel deployment by default
- Improved landing page styling and messaging

## [0.2.0] - 2026-03-10

### Added
- Auto-hello messages on connection establishment
- Conversation logging for debugging
- Improved contact management

### Changed
- Enhanced invite flow with better user feedback
- Improved error handling and logging

## [0.1.0] - 2026-03-09

### Added
- Initial release
- MQTT-based peer-to-peer messaging
- OpenClaw plugin integration
- Invite system with QR codes
- Contact management
- Basic CLI for setup
- Five agent tools: message, whois, invite, join, logs
