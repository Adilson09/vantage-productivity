# Vantage Productivity security reporting

Vantage Productivity is a development preview. No independent security certification or complete hostile-file acceptance is claimed.

## Report a suspected vulnerability privately

Use the repository's **Security → Report a vulnerability** option if GitHub makes it available. Do not put exploit details, private documents, tokens or passwords into a public issue.

If private reporting is unavailable, open a minimal issue requesting a private reporting channel from @Adilson09, without vulnerability details or sensitive attachments. Wait for a private channel before sharing those details. No response-time guarantee is made.

A useful private report identifies the version or commit, operating system, affected component, reproduction steps, impact and a minimal sanitized example.

## Scope and limits

The preview processes complex document formats, renders HTML, launches native helper processes and can use optional connected providers. Each path needs its own review. The application-level local-mode controls do not form an operating-system firewall around external commands or native Mail.

Cloud service operations and provider-hosted consent are separately operated. Report service-specific problems through the provider's reporting process.

See [PRIVACY.md](PRIVACY.md) for data/network behavior and [the preview guide](docs/VANTAGE_PREVIEW.md) for current acceptance gaps. Please report a boundary bypass; do not treat the existence of a setting or a selected test as a security guarantee.
