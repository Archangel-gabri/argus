# Contributing to Argus

Thank you for helping improve Argus. Keep changes focused, preserve local-first behavior, and
add regression coverage for bug fixes.

## Start with an Issue

Search the [issue tracker](https://github.com/Archangel-gabri/argus/issues) first. Open an issue
for a bug or proposal so the scope, platform impact, and security boundary can be agreed.

## Local Setup

Argus requires Node.js 26 and npm 11.16 or newer. Go is also required for the full quality gate.

```bash
git clone https://github.com/Archangel-gabri/argus.git
cd argus
npm ci
npm run rebuild
npm run dev
```

Development uses a local Electron vault. Do not copy a real user vault into the repository or
replace it with a test fixture.

## Tests and Linting

Run the normal checks independently while iterating:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Before a pull request, run the combined gate when its Go and host prerequisites are available:

```bash
npm run check
```

Live device, network, vault-ABI, and Electron E2E checks are separate; report exactly which
commands and environments you verified.

## Code Style

- Follow the surrounding TypeScript, React, Electron, and Go conventions.
- Keep ESLint and both TypeScript projects clean; let `gofmt` format Go changes.
- Preserve Electron sandboxing, context isolation, IPC validation, and secret redaction.
- Avoid unrelated formatting, generated catalogs, build output, or dependency changes.

## Propose a Change

1. Agree the scope in an issue.
2. Create a branch such as `fix/vault-lock` from `main`.
3. Make the smallest complete change and update tests and documentation.
4. Run the relevant checks and review the complete diff.
5. Open a pull request with the issue link, test output, platform details, and screenshots if useful.

## Data and Secrets

Do not submit real vaults, balances, subscriptions, device addresses, SSH material, API keys,
tokens, credentials, personal data, database dumps, exported account data, or sensitive logs.
Use synthetic fixtures and redacted examples only.

## Security Vulnerabilities

Do not open a public issue for a suspected vulnerability. Use GitHub Security's
[Report a vulnerability](https://github.com/Archangel-gabri/argus/security/advisories/new)
form and include safe reproduction steps without secrets or personal data.
