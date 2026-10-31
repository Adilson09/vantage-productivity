# Vantage Productivity privacy

This policy describes the independently maintained Vantage Productivity 0.15.0-dev.1 preview and this repository's packaging configuration.

## Local document work

Documents, local search indexes, SQLite records, calendar/contact files, saved history and draft journals are stored on the computer. Document editing does not require a cloud upload. Files and indexes may contain sensitive information; their storage locations remain subject to operating-system and folder permissions.

## Network controls

Local mode is enabled by default. Remote feature switches are disabled by default and approved remote-origin lists start empty. The policy permits loopback services.

The policy covers Electron HTTP(S)/WebSocket requests and main-process fetch requests. Remote requests through these paths require an enabled feature and approved HTTPS origin. Redirect destinations are checked. These are application controls, not an operating-system firewall: native companions, raw sockets and external command providers require separate controls and network acceptance.

Settings are in the home workspace's Tools and privacy controls. Saving a remote feature choice changes the application's persisted policy.

## AI and connected services

Using a cloud AI provider sends the requested prompt, selected context and other request data to that provider. Review the configured provider and the content being shared before use. A user-configured loopback service is possible; the preview bundles no local model, weights or inference runtime.

Vantage Mail runs as a separate native companion. Its launch is blocked while Local mode is enabled or the Mail companion feature is disabled. Once launched, account connections are made by the companion; the Electron request filter is not a firewall around that process. Provider-hosted consent screens and account configuration have their own requirements.

The read-only Microsoft Graph, Gmail and Google Calendar adapters require explicit enablement and a consented environment token. Live account validation, complete consent/refresh workflows and whole-process traffic acceptance remain incomplete.

## Analytics and updates

The repository packaging configuration hard-disables analytics credential injection. This preview does not claim the inherited upstream default-analytics policy. The source still contains analytics implementation code; different independently modified packages need their own disclosure.

Automatic update publishing requires an explicitly configured update endpoint. A repository or release download does not by itself configure automatic updates. Approved connected services can receive ordinary connection metadata such as the public IP address.

## History, recovery and encryption

Saved-version history is bounded by configured storage and entry budgets and may be pruned or skipped. Optional encryption protects new history and draft payloads using an OS-protected key. It does not silently migrate existing plaintext. Markdown draft journaling covers text, not a complete bundle of pasted assets. Recovery is not a complete backup.

## Feedback and reports

GitHub issues and comments on the public repository are public. Do not attach private documents, credentials, tokens, account identifiers or unredacted logs. Use a minimal sanitized sample. Follow [SECURITY.md](SECURITY.md) for sensitive vulnerability reports.

See [the preview guide](docs/VANTAGE_PREVIEW.md), [network policy](packages/electron-utils/src/network-policy.ts), [runtime controls](apps/shell/src/main/privacy-runtime.ts) and [packaging configuration](apps/shell/electron-builder.cjs) for implementation details.
