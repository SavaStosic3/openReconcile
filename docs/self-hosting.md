# Run openReconcile on an internal server

The Docker deployment runs the application, authenticated API, reconciliation solver, and SQLite database on a company's own server or VM. It uses the same frontend and calculation modules as the hosted application. It does not require a ChatGPT account, a Sites project, or a hosted database. No example account or password is included.

The existing hosted site remains available for development and testing. Each internal installation has its own users, models, permissions, schedules, audit history, and results. Nothing synchronizes with the hosted workspace automatically. Model JSON export/import transfers a model deliberately; it does not transfer accounts or workspace history.

## Requirements

- A Linux server or VM with [Docker Engine](https://docs.docker.com/engine/install/) and the Docker Compose plugin. Docker Desktop with Linux containers can also be used for local evaluation.
- Git, or an extracted download of this repository. Run the commands below from the repository root.
- Disk space for the application volume and separate backups. Choose storage and capacity for the company's expected model and audit data; this repository does not establish a plant-scale sizing guarantee.
- For other users to access the server: internal DNS, an HTTPS reverse proxy, and a certificate trusted by those users' browsers.

Only the Docker image build needs access to Docker Hub. Manual reconciliation has no external-service requirement after installation. SQL connectors additionally need access to the configured plant-side gateway.

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

Confirm sign-in, model permissions, a known example's calculations, and SQL input/output where used. For recovery, stop the failed release, select the retained previous image, and restore its matching pre-upgrade backup into a fresh volume. Do not attempt a database downgrade by deleting migration records.

## SQL connectors

The SQL gateway remains a separately operated service using standard SQL Server, PostgreSQL, and MySQL drivers. See its [installation and schema guide](../connectors/sql-gateway/README.md). Database credentials belong on that gateway, not in model mappings or this application's image.

Configure the application's `.env` with the gateway's valid HTTPS URL and matching secret token:

```dotenv
SQL_GATEWAY_URL=https://reconcile-gateway.company.internal
SQL_GATEWAY_TOKEN=<secret-generated-for-this-gateway>
```

Recreate the app after changing these values. The gateway's certificate must also be trusted by Node, not only by users' browsers. An IT-managed corporate CA can be mounted read-only and supplied through Node's `NODE_EXTRA_CA_CERTS` setting in a local Compose override. Keep that configuration and populated secrets out of Git. A Docker service hostname is not a loopback development exception for plaintext SQL gateway requests.

Have an authorized database administrator provision least-privilege users, table allowlists, and the required schema. Verify a real input read, a known period's reconciliation, and committed output rows before using the integration operationally. Storage inputs require the updated gateway's exact boundary-snapshot support. Container packaging does not verify a connection to any plant database.

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

Schedules currently remain **browser-triggered**: an eligible authenticated browser session must be open for due reconciliations to run. Moving the application into Docker does not introduce a background scheduler. Run history remains capped at **20 runs per model**; output connectors are the destination for long-term reconciliation results. Audit retention remains configurable, with the existing 365-day default.

Password accounts have backend-enforced permissions, revocable sessions, and no public registration. ChatGPT sign-in belongs to the hosted deployment and is not offered by this internal password-only installation. The internal server does not trust client-supplied Sites identity headers.

## Verify a release

GitHub's **Internal server container** workflow builds the real Docker image and exercises authentication, permissions, model publication, both analytical showcase reconciliations, and persistence across container replacement. A green run demonstrates those synthetic checks on that runner; it does not establish plant accuracy, your TLS configuration, database connectivity, backup policy, or sizing.

For an installation acceptance check, test sign-in/logout, administrator and restricted-user permissions, both analytical example models, a container recreation without data loss, a backup restoration into a fresh volume, and the company's actual input/output integrations. Record the release commit, image ID, configuration, and test evidence. Continue using the existing hosted development/build workflow separately; no hosted data or credentials need to be copied to the internal server.
