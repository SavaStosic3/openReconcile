# Run openReconcile on an internal server

The Docker deployment runs the application, authenticated API, reconciliation solver, unattended scheduler, and SQLite database on a company's own server or VM. It uses the same frontend and calculation modules as the hosted application. It does not require a ChatGPT account, a Sites project, or a hosted database. No example account or password is included.

The existing hosted site remains available for development and testing. Each internal installation has its own users, models, permissions, schedules, audit history, and results. Nothing synchronizes with the hosted workspace automatically. Model JSON export/import transfers a model deliberately; it does not transfer accounts or workspace history.

## Requirements

- A Linux server or VM with [Docker Engine](https://docs.docker.com/engine/install/) and the Docker Compose plugin. Docker Desktop with Linux containers can also be used for local evaluation.
- Git, or an extracted download of this repository. Run the commands below from the repository root.
- Disk space for the application volume and separate backups. Choose storage and capacity for the company's expected model and audit data; this repository does not establish a plant-scale sizing guarantee.
- For other users to access the server: internal DNS, an HTTPS reverse proxy, and a certificate trusted by those users' browsers.

Only the Docker image build needs access to Docker Hub. Manual reconciliation has no external-service requirement after installation. SQL connectors need access to the configured plant-side gateway, and PI connectors need access to the configured PI Web API endpoint or company proxy.

## Install and create the administrator

The following commands use a Linux shell. Downloading the repository as a ZIP is also supported; use its extracted directory instead of cloning.

```sh
git clone https://github.com/SavaStosic3/openReconcile.git
cd openReconcile
cp deploy/.env.example .env
chmod 600 .env
docker compose build --pull
docker compose run --rm app node deploy/cli.mjs setup --username PlantAdmin
docker compose up -d
docker compose ps
```

Run setup from an interactive terminal. It prompts for a password of at least 12 characters and confirmation with input hidden; do not put the password in a command argument, environment variable, or source file. `PlantAdmin` is an example username that can be changed. Setup creates the first administrator in an empty workspace and refuses to replace an existing account or initialize a workspace that already has users. The first browser visitor never receives administrator access automatically.

Open **http://localhost:8080** on the server and sign in with the account you created. Use this exact origin with the default configuration. For a server without a desktop, temporarily use an SSH tunnel from your workstation:

```sh
ssh -L 8080:127.0.0.1:8080 user@internal-server
```

Then open http://localhost:8080 on that workstation. This default listener is bound to the server's loopback interface. For routine company access, configure HTTPS as described below.

The container runs as UID/GID **1000**, with a read-only application filesystem. The named volume **openreconcile_data** holds the writable database, server secret, and backups. Schema migrations run automatically, in order, on startup and in maintenance commands; applied migrations are tracked and validated rather than reapplied. Never remove the volume to upgrade the application.

## Configure company access with HTTPS

Edit `.env`:

```dotenv
PUBLIC_ORIGIN=https://reconcile.company.internal
BIND_ADDRESS=127.0.0.1
HTTP_PORT=8080
```

`PUBLIC_ORIGIN` must be the exact browser origin, including a nonstandard port if used, without a path. Production HTTP origins on other hosts are rejected. The application uses this configured origin for request URLs, same-origin checks, and secure session cookies. It does not accept identity or authentication claims from forwarded headers.

The following Nginx example assumes the reverse proxy is installed on the same VM. Replace the hostname and certificate paths with values provided by company IT. The certificate must have a valid trust chain; for an internal CA, distribute that CA through the company's normal device management.

```nginx
server {
    listen 80;
    server_name reconcile.company.internal;
    return 301 https://reconcile.company.internal$request_uri;
}

server {
    listen 443 ssl;
    server_name reconcile.company.internal;
    ssl_certificate /etc/nginx/certs/reconcile-fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/reconcile-key.pem;

    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_connect_timeout 5s;
        proxy_read_timeout 60s;
    }
}
```

Keep port 8080 restricted to loopback when using this arrangement. Publish the HTTPS hostname in internal DNS, apply the site's normal firewall rules, and reload the reviewed Nginx configuration. Recreate the app container after changing `.env`:

```sh
docker compose up -d --force-recreate
```

The default Compose file assumes a proxy on the host. A proxy in a separate container needs a deliberately configured shared network and upstream service address; `127.0.0.1` inside that proxy container does not refer to the app. Do not change `BIND_ADDRESS` to expose a plaintext company-wide login page.

## Add users and models

Create additional password accounts from the server's interactive terminal:

```sh
docker compose exec app node deploy/cli.mjs add-user --username OperatorOne --role operator
docker compose exec app node deploy/cli.mjs add-user --username EngineerOne --role editor
```

The command prompts for the password and confirmation. Supported roles are `viewer`, `operator`, `editor`, and `admin`; the default is `viewer`. Administrators use **Admin** in the application to grant each user access to particular models, change role/status, and protect models. A workspace role does not automatically grant an ordinary user access to every model. Keep at least one enabled administrator.

New internal accounts use PBKDF2-SHA256 with 600,000 iterations, an individual random salt, and an installation-specific pepper stored separately from the database. Existing session/permission checks remain enforced on the backend. Login limits are five attempts per username and, by default, 100 attempts per socket IP in a 15-minute window. `LOGIN_IP_LIMIT` in `.env` configures the IP limit from 20 to 1,000. With a reverse proxy, users share the proxy's socket-IP bucket; forwarded client IP headers are not trusted. Recreate the container after changing this setting.

There is no public password-reset flow. If an administrator loses access, an authorized server operator can create a new named administrator with `add-user --role admin`, sign in, and disable the old account. This does not reset the old password or reuse its sessions. Losing the installation's pepper affects all existing password accounts; restore it with the matching database backup.

The new workspace initially has no models. Use **Load template** for the **Slurry filtration with recycle** and **Tanks and storage** examples, or **Import** a model JSON file exported from another installation. The examples have independent [filtration](../examples/showcase-model.md) and [storage](../examples/storage-showcase-model.md) mathematical references. Review readings, reporting periods, units, uncertainty, geometry, and source mappings before using an imported model for a real process.

Publish a model and run a known reconciliation before assigning it to operators. Importing or duplicating a model does not copy accounts, permissions, retained runs, or an enabled schedule from another installation.

## Persistent data and backups

All durable application data lives in `/data`:

| File or directory | Purpose |
| --- | --- |
| `app.sqlite` and live SQLite journal files | Users, password hashes, sessions, models, grants, publications, schedules, recent runs, and audit history |
| `server-secrets.json` | Generated password pepper; keep private and back up with the database |
| `backups/` | Consistent backup directories created by the maintenance command |

The pepper is generated for the installation and retained across container replacement. Losing it prevents verification of existing passwords. A database-only copy is therefore insufficient. Model JSON exports are useful for portability but are not a complete workspace backup.

Create a consistent backup while the application is running:

```sh
docker compose exec app node deploy/cli.mjs backup
```

The command prints the new timestamped directory under `/data/backups/`. A fixed new directory can be requested, for example:

```sh
docker compose exec app node deploy/cli.mjs backup --output /data/backups/pre-upgrade
docker compose exec app node deploy/cli.mjs verify-backup --output /data/backups/pre-upgrade
mkdir -p backups
chmod 700 backups
docker compose cp app:/data/backups/pre-upgrade ./backups/
```

An existing destination is rejected. Each backup contains a consistent `app.sqlite`, the matching `server-secrets.json`, and a `backup-manifest.json`. `verify-backup` checks both file hashes, the secret format, and database integrity without applying migrations. This avoids copying a changing live database or omitting its write-ahead log. Protect and encrypt the exported backup according to company policy, and retain a copy outside this server/volume. The directory inside `/data` does not protect against loss of that volume. Restrict `.env` and the TLS private key separately; they are configuration outside this backup.

### Restore into a fresh volume

Restore the database and pepper together. The following example restores `./backups/pre-upgrade`; use the actual backup directory. Retain the original volume until the restored workspace is verified.

1. Stop the application: `docker compose stop app`.
2. In `.env`, set `OPENRECONCILE_DATA_VOLUME=openreconcile_restore_20261010` or another unused name. If reverting a failed upgrade, also select the previous application image before proceeding.
3. Create the stopped container and copy the backup files:

```sh
docker compose create app
docker compose cp ./backups/pre-upgrade/app.sqlite app:/data/app.sqlite
docker compose cp ./backups/pre-upgrade/server-secrets.json app:/data/server-secrets.json
docker compose cp ./backups/pre-upgrade/backup-manifest.json app:/data/backup-manifest.json
docker compose run --rm --no-deps --user 0 --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE --entrypoint node app --input-type=module -e "import { chownSync, chmodSync } from 'node:fs'; for (const name of ['app.sqlite', 'server-secrets.json', 'backup-manifest.json']) { const file = '/data/' + name; chownSync(file, 1000, 1000); chmodSync(file, 0o600); }"
docker compose run --rm --no-deps app node deploy/cli.mjs verify-backup --output /data
docker compose up -d
```

4. Confirm the container is healthy, sign in, and check users, model grants, publications, audit history, and a known reconciliation. Record the restore test. Use a fresh volume so no journal or data from the failed deployment is mixed with the backup.

Startup applies pending migrations to the restored database. For rollback to an older image, restore that version's pre-upgrade backup as well; older code may not support a schema already upgraded by newer code.

## Upgrade and rollback

Before an upgrade, record the Git commit, running image ID/tag, configuration, and backup path. Take an off-server backup and verify the restoration procedure. For controlled releases, build and retain a distinct image tag for each reviewed Git commit; `OPENRECONCILE_IMAGE` chooses the local tag used by Compose.

```sh
docker compose exec app node deploy/cli.mjs backup
docker compose stop app
git pull --ff-only
docker compose build --pull
docker compose up -d
docker compose ps
```

For a specific reviewed release, check out its tag or commit instead of following `main`. Changing application code or pulling a newer Node base image requires a rebuild. Changes to `.env` require container recreation. Keep the volume and pepper through every upgrade.

Confirm sign-in, model permissions, a known example's calculations, and configured input/output integrations. For recovery, stop the failed release, select the retained previous image, and restore its matching pre-upgrade backup into a fresh volume. Do not attempt a database downgrade by deleting migration records.

## PI Web API connectors

The app server can read physical PI meters and exact tank inventories and write selected reconciled values to existing output points. Follow the [PI Web API installation and mapping guide](pi-web-api.md) to mount a private connection file, choose HTTPS Basic authentication or a Bearer-authenticated company proxy, and configure input/output allowlists. PI is unconfigured by default. Credentials and physical tag paths stay on the server; the UI exposes only mapping aliases and units.

Connection tests and input previews do not write to PI. Test a known reporting period against the company's PI server, including quality flags, units, boundary timestamps, and a dedicated output point, before enabling automatic exports. The repository's PI tests use controlled HTTP fixtures and do not prove a connection to a plant historian.

## SQL connectors

The SQL gateway remains a separately operated service using standard SQL Server, PostgreSQL, and MySQL drivers. See its [installation and schema guide](../connectors/sql-gateway/README.md). Database credentials belong on that gateway, not in model mappings or this application's image.

Configure the application's `.env` with the gateway's valid HTTPS URL and matching secret token:

```dotenv
SQL_GATEWAY_URL=https://reconcile-gateway.company.internal
SQL_GATEWAY_TOKEN=<secret-generated-for-this-gateway>
```

Recreate the app after changing these values. The gateway's certificate must also be trusted by Node, not only by users' browsers. An IT-managed corporate CA can be mounted read-only and supplied through Node's `NODE_EXTRA_CA_CERTS` setting in a local Compose override. Keep that configuration and populated secrets out of Git. A Docker service hostname is not a loopback development exception for plaintext SQL gateway requests.

Have an authorized database administrator provision least-privilege users, table allowlists, and the required schema. Verify a real input read, a known period's reconciliation, and committed output rows before using the integration operationally. Storage inputs require the updated gateway's exact boundary-snapshot support. Container packaging does not verify a connection to any plant database.

## Unattended scheduling

The standalone server executes enabled schedules without a browser or an active login session. This applies to Docker installations and deployments using `npm run start:server`; it does not change the hosted testing site's browser-triggered scheduling.

1. Publish the model and open **☰ → Model Management** with editor or administrator access.
2. Choose the run frequency, completed reporting period, time zone, late-data allowance, and optional SQL or PI input/output sources.
3. Enable scheduled runs and save. The account saving the schedule authorizes it. The server checks that account's current status, role, model grant, and publication before execution; disabling the account or removing its scheduling permission blocks further runs. An administrator or eligible editor can save the schedule again to take responsibility for it.
4. Review **Schedule overview** and **Recent runs** for running, failed, and interrupted executions. Results remain attached to the publication used for that run.

After upgrading an existing installation, **save each existing enabled schedule once**. Earlier schedules have no recorded authorizing account and cannot silently acquire unattended authority. New models, duplicates, and models restored from deletion start with scheduling disabled. Database backups retain their saved schedules and authorization.

The following `.env` values configure the standalone service:

```dotenv
SCHEDULER_ENABLED=true
SCHEDULER_POLL_SECONDS=5
```

The check interval accepts whole seconds from 1 to 60. It controls how quickly a due schedule is noticed, independently of the model's run frequency. Set `SCHEDULER_ENABLED=false` to pause automatic execution while keeping manual reconciliation available; browsers do not take over scheduled triggering on this installation. Recreate the container after changing these settings:

```sh
docker compose up -d --force-recreate
```

Run frequency remains elapsed time: one day means 24 hours. Reporting boundaries use the model's configured calendar and time zone. At 10:07, an hourly reporting period is 09:00–10:00; a late-data allowance can defer its eligibility. On startup or after downtime, an overdue schedule runs once using the latest eligible completed period and advances to the next future frequency interval. It does not replay every missed period. Use a deliberate manual period rerun to obtain historical results.

Manual and scheduled runs share durable job claims that prevent overlapping runs for the same model and duplicate scheduled execution. Claims have a two-minute lease refreshed while work is active. After a process exits unexpectedly, recovery waits for the lease to expire before marking its abandoned run interrupted. The interrupted occurrence is retained as a failed run; it is not automatically retried. If output delivery had not begun, a subsequent due occurrence uses the normal latest-period policy. If output delivery is uncertain, automatic scheduling for that model is paused instead. Unpublishing, deleting, or changing a selected source also pauses the schedule.

SQL and PI output are external operations. A lost acknowledgement or process interruption after delivery begins may leave the outcome unknown. For either a manual or a scheduled run, the server records the failure or interruption and **pauses the model's automatic schedule**. It does not repeat that delivery or allow a later scheduled occurrence to export the same period while the outcome is unresolved. Check SQL rows for the run ID or PI output tags at the recorded event timestamps, decide whether a manual period rerun is needed, then explicitly enable and save the schedule in Model Management to resume automatic work. Manually rerunning creates a new run; SQL can produce additional rows, while PI replaces values at the same point and timestamp. This is not an exactly-once delivery guarantee. Keep destination permissions, timeouts, and recovery procedures appropriate for the installation.

Keep the app container running with the supplied restart policy. Stopping the container or host stops execution until service returns. The scheduler does not require internet access unless a configured input or output endpoint requires it.

## Operation and current limits

```sh
docker compose ps
docker compose logs --tail=100 app
docker compose exec app node deploy/cli.mjs --help
docker compose stop
docker compose up -d
```

`/healthz` reports service/database availability without exposing workspace content. The container health check calls it every 30 seconds. An unhealthy container requires investigation; Docker's restart policy restarts a process that exits, but does not automatically restart a running unhealthy process.

Run **one app instance** against a local Docker volume. SQLite is the embedded database for this deployment; multiple replicas, a shared network filesystem, and high-availability orchestration are outside this deployment. Protect server and Docker access because operators of the host can read its files and environment.

Schedules run unattended in this standalone service as described above. Run history remains capped at **20 runs per model**; output connectors are the destination for long-term reconciliation results. Audit retention remains configurable, with the existing 365-day default.

Password accounts have backend-enforced permissions, revocable sessions, and no public registration. ChatGPT sign-in belongs to the hosted deployment and is not offered by this internal password-only installation. The internal server does not trust client-supplied Sites identity headers.

## Verify a release

GitHub's **Internal server container** workflow builds the real Docker image and exercises authentication, permissions, model publication, both analytical showcase reconciliations, and persistence across container replacement. A green run demonstrates those synthetic checks on that runner; it does not establish plant accuracy, your TLS configuration, database connectivity, backup policy, or sizing.

For an installation acceptance check, test sign-in/logout, administrator and restricted-user permissions, both analytical example models, unattended execution after all browsers close, account/grant revocation, interruption recovery, a container recreation without data loss, a backup restoration into a fresh volume, and the company's actual input/output integrations. Record the release commit, image ID, configuration, and test evidence. Continue using the existing hosted development/build workflow separately; no hosted data or credentials need to be copied to the internal server.
