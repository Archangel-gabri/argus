**[Русская версия →](README.ru.md)**

# Argus

Argus is a local-first desktop command center for people who run their own servers and want
subscriptions, balances, and AI-provider quotas in one place.

![Argus fleet view with three demo devices](assets/readme/fleet.png)

<p align="center">
  <img src="assets/readme/finance.png" alt="Argus finance view with demo balances and allocation chart" width="49%">
  <img src="assets/readme/subscriptions.png" alt="Argus subscriptions view with demo renewals and monthly costs" width="49%">
</p>

<p align="center"><sub>Captured from the Electron app with an isolated demo vault. No personal data.</sub></p>

**Stack:** Electron · React 19 · TypeScript · Tailwind CSS 4 · SQLCipher · Argon2id · Go

**Tests:** 1,330 unit/DOM tests in 103 files · 17 Playwright/Electron E2E checks

## What it does

- Keeps a fleet inventory with reachability, hardware metrics, open ports, and cost history.
- Opens SSH terminals, transfers files over SFTP, forwards ports, sends Wake-on-LAN, and handles
  power or dual-boot actions.
- Streams a remote screen through a separate Go agent, with an RDP fallback for Windows.
- Tracks manually entered balances and optional read-only integrations for exchanges, investments,
  and public blockchain addresses.
- Tracks subscription prices and renewal dates, and links infrastructure costs to devices so the
  same expense is not counted twice.
- Organizes AI accounts, plans, key locations, local tool usage, and quotas exposed by providers.

## How it works

```text
React renderer
      │ typed preload API
      ▼
Electron main process ─── SSH / provider APIs / Go screen agent
      │
      ▼
Argon2id-derived key ─── SQLCipher vault
```

Secrets stay in the Electron main process; the renderer receives status and data-transfer objects,
not stored secret values. App windows use context isolation and sandboxing with Node integration
disabled. Argus has no built-in LLM and no application cloud.

## Run it

Requires Node.js 26 and npm 11.16 or newer.

```bash
git clone https://github.com/Archangel-gabri/argus.git
cd argus
npm ci
npm run rebuild
npm run dev
```

`npm run dist` builds the Linux x86_64 AppImage and also requires Bash and Go. See the dated
[development status and verification notes](docs/STATUS.md) for the full test matrix.

## Limits

- Argus is a single-user application with no cloud sync or multi-user server.
- There is no master-password recovery. Losing it means losing access to the vault.
- It does not discover subscriptions from email or parse bank statements; data is entered manually
  or comes from an explicitly configured integration.
- Remote screen and control depend on the target OS and its capture permissions. The RDP fallback
  requires `guacd`.
- Release packaging currently targets a Linux x86_64 AppImage. There are no Windows or macOS
  packages and no auto-update channel.
- Version 0.1.0 is under active development.

## License

[MIT](LICENSE)

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
