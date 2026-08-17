# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately via [GitHub Security Advisories](https://github.com/SeriousGeese/PromptCI/security/advisories/new).
Include reproduction steps and the commit SHA you tested against. We'll acknowledge receipt
and keep you updated on the fix; if you'd like credit in the advisory, say so in the report.

## Supported versions

PromptCI is pre-1.0. Only the latest `main` receives security fixes.

## Scope

PromptCI reads instruction files from repositories it is pointed at, so untrusted repo
content is an input we care about. Reports in these areas are especially welcome:

- **Path handling** — anything that makes the scanner read or write outside the target repo root.
- **Catastrophic regex backtracking** — detector patterns that hang on crafted instruction files.
  The scanner is regex-heavy; a file that turns a scan into a denial of service is a valid report.
- **Report generation** — content from a scanned file escaping into `latest.md` or `report.json`
  in a way that misleads or injects.

Out of scope: findings that require an attacker to already control the machine running the scan,
and issues in dependencies that have no exploitable path through PromptCI (report those upstream).

Vulnerabilities in the hosted PromptCI dashboard (which is not part of this repository) are
also welcome through the same private-advisory channel.
