# Development and hosted deployment

The [Docker quickstart](../README.md#quickstart) is the installation path for an internal server. This guide covers the retained hosted development workflow, authentication configuration, and verification commands.

## Hosted development locally

Requires Node.js 22.13 or later. The application uses a Workers backend, D1 database, and the Sites authentication integration. Frontend assets live in `public/`; `dist/` is generated build output.

```powershell
npm ci
'ADMIN_EMAIL=seedy@sites.test' | Set-Content .dev.vars
npm run build
npx wrangler d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file ./drizzle/0000_complete_random.sql
npx wrangler d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file ./drizzle/0001_published_snapshots.sql
npx wrangler d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file ./drizzle/0002_elite_layla_miller.sql
npx wrangler d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file ./drizzle/0003_kind_tempest.sql
npm run dev
```

Apply the SQL migrations once, in order, to an empty local database. For an existing database, apply only pending migrations; they preserve current models, grants, schedules, and runs. The explicit persistence path shares the database with the development server. Open the loopback URL printed by the development server, normally http://127.0.0.1:5173. The development server binds to this computer; its local ChatGPT sign-in simulates `seedy@sites.test`. This is a development identity, and the `.dev.vars` file is excluded from Git. Production has no simulated identity.

## Hosted authentication and database setup

The hosted application supports username/password accounts and ChatGPT sign-in through Sites. Its API stores users, model grants, models, schedules, run snapshots, password hashes, and revocable sessions in the D1 `DB` binding. Reconciliation runs on the server using saved model measurements. Both sign-in methods use the same backend role and model-permission checks.

For a new deployment, create a Sites project, set its project ID in `.openai/hosting.json`, provision the `DB` binding, apply the ordered SQL files in `drizzle/` through the host's D1 migration service, and configure `ADMIN_EMAIL` as a server runtime secret before the intended administrator's first sign-in. Publish the built application through Sites. Existing deployments apply only pending migrations. The generated configuration's database ID is a local development placeholder; the host supplies the production binding.

Only the verified identity matching `ADMIN_EMAIL` receives the initial administrator role when its account is inserted. Other first-time users become viewers with no model access until an administrator assigns grants. The first visitor does not become an administrator. Changing the secret does not promote an existing account or re-enable a disabled account; an existing administrator or an authorized database migration must handle those changes.

The production backend must be reached through the trusted Sites authentication dispatch. `app/chatgpt-auth.ts` reads the identity supplied by that dispatch; those headers must never be accepted directly from an untrusted client. When adapting the project to another host or identity provider, replace that integration with server-verified sessions or tokens and retain this trust boundary. A direct public Worker or an unauthenticated static server is not an equivalent deployment.

### Username/password administrator

Apply migration `0002`, then configure three server runtime values: `LOCAL_BOOTSTRAP_USERNAME`, secret `LOCAL_BOOTSTRAP_PASSWORD_HASH`, and secret `LOCAL_AUTH_PEPPER`. Generate the hash with `node scripts/create-local-login-hash.mjs`. It reads one JSON object containing `password` and an optional existing `pepper` from hidden stdin; do not pass credentials as command arguments. Its output contains a newly generated pepper and salted password hash, both sensitive. Put those values in the host's secret store and retain the pepper for subsequent sign-ins. The utility never writes a password or credential file. Passwords must be 8–1024 characters; usernames start with a letter and contain 3–64 letters, numbers, periods, underscores, or hyphens. Username matching ignores case.

The first password sign-in creates this initial administrator only if the username and its local user ID are new. Bootstrap never resets a password, promotes an existing user, or re-enables a disabled user. Username accounts have separate identities from ChatGPT accounts. Administrators can change their roles, disable accounts, and assign model permissions from Admin. Public registration, additional password-account creation, and password reset interfaces are not implemented.

Open `/?signin=1` to show the login form even when this browser already has a ChatGPT session. A link can retain `view=published` and `model=<model-id>` to open that model after sign-in. Password sessions take precedence over ChatGPT identity, expire after eight hours, and use HttpOnly, Secure, SameSite=Strict cookies on HTTPS. The database stores only a hash of each random session token. Every request checks current account status and permissions; account changes invalidate existing password sessions. Sign-out revokes the session and requires an explicit sign-in before reopening the workspace. HTTP password authentication is limited to loopback development.

Password storage uses PBKDF2-SHA256 with a random salt, 100,000 iterations, and a post-hash HMAC-SHA256 pepper kept outside D1. The work factor fits the hosted Workers runtime limit and is below the [OWASP PBKDF2 recommendation](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). Deployment on another backend should review that platform's password hashing options and increase the work factor or adopt Argon2id. Login attempts have per-username and per-edge-IP limits. Keep the pepper out of source, logs, database exports, and client responses; changing or losing it requires reissuing password credentials.

## Verification

Use Node.js 24 for the full test suite, including the standalone server's built-in SQLite and backup APIs. The Docker image and container workflow also use Node.js 24.

Use the [release checklist](../RELEASE_CHECKLIST.md) to record deployment, data protection, access, and browser checks for each release.

```powershell
npm test
npm run typecheck
npm run build
```

Tests cover analytical solutions, inferred/unobservable flows, recycles and rank reduction, nonnegative bounds, zero readings, conversions and interval duration, numerical conditioning, and independent cross-validation over 80 seeded tiny networks. They also cover model/source isolation, editable drafts, elapsed cadence, delayed runs, snapshots, adapter failures, bounded history, browser save queues, stale revisions, authenticated API permissions, account/grant changes, locks, deletion/restoration, atomic schedule claims, and canvas read-only behavior. Reporting-period tests cover configurable cutoffs, late-data allowance, historical selections, daylight saving changes and actual elapsed duration. Quality tests use controlled irregular samples, bad flags, stale readings, coverage gaps, counter resets, and rollover assumptions. The independent solver oracle enumerates every active face and solves KKT equations separately from the production QR/network algorithm.

The SQL gateway has a separate dependency installation and test command in its [setup guide](../connectors/sql-gateway/README.md). Gateway contract/driver tests and application SQL adapter tests use controlled data and mocked database drivers; they do not establish connectivity, schema compatibility, permissions, or data accuracy on a real plant database. Record actual SQL Server, PostgreSQL, and MySQL connection/read/write checks separately before relying on those integrations.
