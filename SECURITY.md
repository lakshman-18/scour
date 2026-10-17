# Security

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository. Include what you found, how to reproduce it, and
what an attacker could do with it. You'll get a reply within a week.

## What scour protects

- **Keys and sessions** live only in `~/.scour` (mode 0600/0700) and are sent only to the service they belong to.
- **`scour serve` / `scour ui`** listen on localhost by default; other interfaces require an API key. Requests
  to private networks and cloud-metadata addresses are refused (SSRF), and the web app rejects cross-site and
  DNS-rebinding requests and ships a strict Content-Security-Policy.
- **Local files** are never readable through the HTTP server. Through MCP, only document and media types are
  read, never from hidden folders such as `~/.ssh`.
- **Saved logins** are never used by a server that other machines can reach.

Anything that weakens one of these is a security issue worth reporting.
