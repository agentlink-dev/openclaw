# Changelog

All notable changes to AgentLink will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned for v0.2.5 - MQTT Stability
- Implement exponential backoff (1s → 30s) to prevent stuck-in-loop reconnection failures
- Increase keepAlive to 120 seconds for better connection stability
- Add disconnect reason logging for debugging

## [0.2.4] - 2026-03-12

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
