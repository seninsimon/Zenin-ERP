# Running ERP - Zenin

This guide covers how to run the project in development, with Docker, and in
production. For how the system works, see [WORKFLOW.md](WORKFLOW.md).

- [Prerequisites](#prerequisites)
- [Option A: everything in Docker](#option-a-everything-in-docker)
- [Option B: development with hot reload](#option-b-development-with-hot-reload)
- [First login and first steps](#first-login-and-first-steps)
- [Running the tests](#running-the-tests)
- [Everyday commands](#everyday-commands)
- [Configuration reference](#configuration-reference)
- [Production deployment](#production-deployment)
- [Troubleshooting](#troubleshooting)

```
erp/
├── docker-compose.yml      db, storage, api, worker, web
├── .env.example            docker-compose settings (copy to .env)
├── apps/api/     API + worker (Node 22, TypeScript)
└── apps/web/       web app (React, Vite)
```

---

## Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| Docker + Docker Compose | recent | everything (database, storage, or the full stack) |
| Node.js | 22+ | local development |
| pnpm | 10 | local development (`corepack enable` gives you pnpm) |

**Linux:** your user must be allowed to use Docker. If you get
`permission denied ... docker.sock`:

```bash
sudo usermod -aG docker $USER
newgrp docker        # or log out and back in
```

---

## Option A: everything in Docker

Use this to run the whole app the way production does.

```bash
cd erp
cp .env.example .env          # defaults are fine on your own machine
docker compose up -d --build
```

The first build takes a few minutes. Then open:

| What | URL |
|---|---|
| **App** | http://localhost:8080 |
| API (health) | http://localhost:5000/api/health |
| Storage console (RustFS) | http://localhost:9001, log in with `S3_ACCESS_KEY` / `S3_SECRET_KEY` |

Services: `db` (Postgres), `storage` (RustFS), `api`, `worker` (imports and
exports), `web` (nginx + app).

```bash
docker compose ps                    # status
docker compose logs -f api worker    # logs (JSON)
docker compose up -d --build         # after changing code
docker compose down                  # stop, keep data
docker compose down -v               # stop and DELETE all data (database + files)
```

---

## Option B: development with hot reload

> **Shortcut:** with [Task](https://taskfile.dev) installed, `task setup` once
> and then `task dev` does all of the steps below in one terminal. `task` lists
> everything else (`seed`, `reset`, `test`, `check`, …); see
> [COMMANDS.md](COMMANDS.md#5-development-mode-pnpm).

Postgres and storage run in Docker. The API and the web app run on your
machine and reload when you save.

### 1. Start the database and storage

```bash
cd erp
docker compose up -d db storage
```

Postgres listens on **localhost:5433** and RustFS on **localhost:9000**.

### 2. API (terminal 1)

```bash
cd erp/apps/api
cp .env.example .env     # first time only; it already points at the docker db/storage
pnpm install
pnpm dev                 # http://localhost:5000
```

- `pnpm dev` restarts automatically when a `.ts` file changes. Restart it
  yourself after editing `.env`.
- Migrations run on start-up.
- The background worker runs **inside** the API process in development
  (`RUN_WORKER=true`), so imports and exports work without a second process.

### 3. Web app (terminal 2)

```bash
cd erp/apps/web
pnpm install
pnpm dev                 # http://localhost:5173
```

The web app's `.env`:

```
VITE_API_BASE_URL=http://localhost:5000/api
VITE_FILE_BASE_URL=http://localhost:5000
```

Changes appear in the browser immediately; no build step.

> **Don't run both modes at once.** If the Docker `api` and `web` are already
> running, stop them first so ports 5000 and 8080 are free:
> `docker compose stop api worker web`.

---

## First login and first steps

On a **fresh database** the first admin account is created from `ADMIN_USERNAME`
and `ADMIN_PASSWORD` (defaults `admin` / `admin12345`). If `ADMIN_PASSWORD` is
empty, a random password is printed in the API log.

These values are only used when the database has **no users yet**. Changing
them later has no effect; use `reset-password` instead (see
[Everyday commands](#everyday-commands)).

Then, as admin:

1. Go to **My profile** and change the password.
2. In **Manage apps**, pick your kind of organization. It adds the apps,
   their roles and starter departments (you can rename or remove those first).
3. In **Users**, use **Add person** for each person: name, login, department
   and what they can do in each app (No access / Staff / Manager).

Building your own tables instead? Create them under **Tables & columns**,
then give people access with a role under **Roles & permissions**.

[WORKFLOW.md § 2](WORKFLOW.md#2-admin-workflow-setting-up-access) explains how
these fit together.

---

## Running the tests

The API tests need a **throwaway Postgres database whose name ends in `_test`**.
It is wiped at the start of every run.

```bash
# once: create the test database in the docker Postgres
docker compose exec db createdb -U postgres generic_erp_test

# run the tests
cd apps/api
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/generic_erp_test pnpm test
```

Other checks:

```bash
cd apps/api && pnpm typecheck          # API types
cd apps/web   && pnpm lint && pnpm build # web lint + type-check + build
```

CI (GitHub Actions) runs the same checks on every push and pull request.

---

## Everyday commands

For the deployed server (`./deploy.sh start | stop | wipe | demo …`), see
[COMMANDS.md](COMMANDS.md).

### API (`apps/api/`)

| Command | What it does |
|---|---|
| `pnpm dev` | API with hot reload (also runs jobs) |
| `pnpm dev:worker` | standalone worker with hot reload (only needed with `RUN_WORKER=false`) |
| `pnpm typecheck` | TypeScript check |
| `pnpm test` | test suite (needs `TEST_DATABASE_URL`) |
| `pnpm build` | compile to `dist/` |
| `pnpm start` / `pnpm worker` | run the compiled API / worker |
| `pnpm migrate` | apply pending database migrations (also done on start-up) |
| `pnpm reset-password <user> <password>` | reset a password, re-enable the account, sign the user out |
| `pnpm seed [--size=small\|medium\|large]` | load the **demo company** (≈ 3k / 20k / 160k records, 16 demo users) |
| `pnpm db:reset [--yes]` | **wipe ALL data and files** and recreate an empty system with the first admin; restart the API afterwards |

### Web (`apps/web/`)

| Command | What it does |
|---|---|
| `pnpm dev` | dev server with hot reload |
| `pnpm lint` | ESLint |
| `pnpm build` | type-check + production build to `dist/` |
| `pnpm preview` | serve the production build locally |

### Docker

```bash
# reset a password in the docker stack
docker compose exec api node dist/scripts/resetPassword.js admin 'NewPassword123'

# run migrations as a separate step
docker compose run --rm api node dist/scripts/migrate.js

# load the demo company / wipe everything (demo and test systems only!)
docker compose exec api node dist/scripts/seed.js --size=medium --force
docker compose exec -it api node dist/scripts/reset.js --force
docker compose restart api worker   # after a reset

# open a SQL shell
docker compose exec db psql -U postgres generic_erp

# back up / restore the database
docker compose exec -T db pg_dump -U postgres -Fc generic_erp > backup-$(date +%F).dump
docker compose exec -T db pg_restore -U postgres -d generic_erp --clean < backup.dump
```

---

## Configuration reference

### Docker (`erp/.env`, used by `docker-compose.yml`)

| Variable | Default | Meaning |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | postgres / postgres / generic_erp | database credentials (URL-encode special characters in the password) |
| `PG_POOL_MAX` | 10 | DB connections per API/worker instance |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | erp-storage / erp-storage-secret | RustFS credentials, shared by storage, api and worker |
| `S3_BUCKET` | erp-uploads | bucket name (created automatically) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | admin / admin12345 | first admin (only on an empty database) |
| `COOKIE_SECURE` | false | set `true` when served over HTTPS |
| `LOG_LEVEL` | info | `debug`, `info`, `warn`, `error` |
| `METRICS_TOKEN` | *(empty)* | enables `GET /metrics` (Prometheus) with `Authorization: Bearer <token>` |
| `DB_PORT` / `STORAGE_PORT` / `STORAGE_CONSOLE_PORT` / `API_PORT` / `WEB_PORT` | 5433 / 9000 / 9001 / 5000 / 8080 | host ports (all but the web port are bound to 127.0.0.1) |

### API (`apps/api/.env`, local development)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 5000 | API port |
| `DATABASE_URL` | — | Postgres URL; add `?sslmode=require` for hosted databases |
| `PG_POOL_MAX` | 10 | connection pool size |
| `SLOW_QUERY_MS` | 500 | log queries slower than this |
| `EXACT_COUNT_LIMIT` | 50000 | above this many rows, list totals are estimated |
| `S3_ENDPOINT` / `S3_REGION` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_BUCKET` | — | object storage (RustFS, MinIO, AWS S3, R2) |
| `S3_FORCE_PATH_STYLE` | true | `false` for AWS virtual-hosted buckets |
| `UPLOAD_MAX_MB` / `IMPORT_MAX_MB` | 50 / 20 | max upload / CSV import size |
| `JOB_FILE_RETENTION_DAYS` | 14 | export files and import error reports are deleted after this |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | admin / — | first admin (only on an empty database) |
| `CORS_ORIGINS` | http://localhost:5173 | comma-separated web app origins allowed to call the API with cookies |
| `COOKIE_SECURE` | false | `true` behind HTTPS |
| `LOG_LEVEL` | info | log level (pretty output in development, JSON in production) |
| `METRICS_TOKEN` | — | enables `/metrics` |
| `RUN_WORKER` | true | run background jobs inside the API process |
| `TEST_DATABASE_URL` | — | only for `pnpm test` |

### Web (`apps/web/.env`)

| Variable | Development | Docker build |
|---|---|---|
| `VITE_API_BASE_URL` | `http://localhost:5000/api` | `/api` (set in the Dockerfile) |
| `VITE_FILE_BASE_URL` | `http://localhost:5000` | empty (same origin) |

---

## Production deployment

> **Hosting on an office computer for your local network?** Run
> `./deploy.sh` for a one-step install: Docker, random passwords, auto-start,
> no sleep, firewall and nightly backups. See [DEPLOYMENT.md](DEPLOYMENT.md).
> The steps below are the manual equivalent, plus HTTPS for an internet-facing
> server.

The Docker setup is the production setup. On a Linux server with Docker:

### 1. Configure secrets

```bash
cd erp
cp .env.example .env
```

Edit `.env`:
- set long random values for `POSTGRES_PASSWORD`, `S3_ACCESS_KEY` and
  `S3_SECRET_KEY` (e.g. `openssl rand -hex 24`);
- set `ADMIN_PASSWORD`;
- set `COOKIE_SECURE=true` (step 2 adds HTTPS);
- optionally set `METRICS_TOKEN`.

### 2. Put HTTPS in front

Only port **8080** (web) needs to be reachable. Terminate TLS in front of it,
for example with Caddy, which gets certificates automatically:

```
# /etc/caddy/Caddyfile
erp.example.com {
    reverse_proxy localhost:8080
}
```

Traefik, nginx with certbot, or a cloud load balancer work just as well.
Don't expose 5000, 5433, 9000 or 9001; they are bound to 127.0.0.1 by
default.

### 3. Start

```bash
docker compose up -d --build
docker compose ps        # all services healthy?
```

Log in, change the admin password, and set up departments, tables, roles and
users.

### 4. Backups (set these up before real data goes in)

- **Database:** a nightly `pg_dump`, e.g. from cron:
  ```bash
  0 2 * * * cd /srv/erp && docker compose exec -T db pg_dump -U postgres -Fc generic_erp > /backups/erp-$(date +\%F).dump
  ```
- **Files:** back up the `storage` Docker volume, or mirror the bucket with an
  S3 tool (e.g. `rclone sync`).
- **Test a restore** now and then.

### 5. Monitoring

- `GET /api/health` returns 200 when the API and database are up; Docker uses
  it as the health check.
- **Metrics:** with `METRICS_TOKEN` set, Prometheus can scrape
  `http://api:5000/metrics`. It covers:
  - request latency per route;
  - database query time and slow-query count;
  - job counts;
  - Node memory and event-loop stats.
- **Logs** are JSON on stdout (`docker compose logs`), each with a request id.
  Slow queries are logged with their SQL.

### 6. Upgrading

```bash
git pull                          # in both repos
docker compose exec -T db pg_dump -U postgres -Fc generic_erp > pre-upgrade.dump
docker compose up -d --build
```

Migrations run automatically when the new API starts. They are safe with
several instances.

### 7. Scaling

- **API:** stateless; run more `api` replicas behind nginx.
- **Worker:** run more `worker` replicas for heavy import/export loads. They
  share the queue safely.
- **Database connections:** keep `PG_POOL_MAX × (api + worker instances)` below
  Postgres `max_connections` (default 100), or add PgBouncer.
- **Big tables:** mark the columns people sort by as **Indexed** (Settings →
  Tables).

---

## Troubleshooting

| Problem | Cause / fix |
|---|---|
| `permission denied ... docker.sock` | add your user to the `docker` group (see [Prerequisites](#prerequisites)) |
| `port is already allocated` / `EADDRINUSE` | something else uses the port: a local Postgres on 5432, a dev server still running on 5000 or 5173, or Docker `api`/`web` while using Option B. Stop it, or change the port in `.env` |
| "Invalid username or password" for admin | the admin already existed before you set `ADMIN_PASSWORD`. Run `pnpm reset-password admin <new-password>` (or the Docker variant) |
| "Too many failed attempts" | 10 failed logins within 15 minutes from the same IP and username. Wait 15 minutes, or reset the password |
| Logged out right after logging in, on a server | `COOKIE_SECURE=true` but the site is served over plain HTTP. Serve it over HTTPS, or set `false` for testing |
| Web app at a new URL can't reach the API (CORS errors, 401s) | add that origin to `CORS_ORIGINS` (local development only; in Docker, nginx serves both on one origin) |
| "Missing X-Requested-With header" (403) | a custom client calling the API. Send `X-Requested-With: XMLHttpRequest` on POST/PUT/DELETE |
| Import or export stuck on "queued" | no worker is running. In Docker: `docker compose up -d worker`. Locally: `RUN_WORKER=true`, or run `pnpm dev:worker` |
| A user sees no tables | check that their role has **view** on the table *and* that they share a department with it |
| Records disappeared for users after an upgrade | they're "admins only" (no department yet). Settings → Tables → pick the table → move them in the yellow box. Tables shared with one department do this automatically when you save Access |
| `.env` change had no effect | restart the API (`pnpm dev`) or `docker compose up -d` |
| Tests refuse to run | `TEST_DATABASE_URL` must be set and its database name must end in `_test` |
