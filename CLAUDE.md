# Zenin-ERP: notes for Claude

A no-code ERP (formerly "Zenin ERP"). Admins build tables, apps, roles and
automations without code. Built by one founder in Thrissur, Kerala.

## Where things are
- `apps/api`: Node + TypeScript + Express + Postgres (JSONB data tables).
  Migrations in `apps/api/migrations`, tests in `apps/api/tests` (vitest).
- `apps/web`: React + Mantine + TanStack Query + Vite.
  UI rules: `apps/web/UI_GUIDELINES.md` (follow them for every UI change).
- `docs/` (only two guides; keep it that way):
  - COMMANDS.md: every command (install, everyday, backups, local dev, tests);
  - WORKFLOW.md: how it works, for developers.
- `deploy.sh` / `docker-compose.yml` (Docker project name `generic-erp`).
- **Plans and business notes:** `workspace/` (gitignored, private, not in
  any history):
  - ROADMAP.md, PRODUCTION_PLAN.md and new `*_PLAN.md` files;
  - OPEN_SOURCE.md;
  - FOUNDER_GUIDE.md, TARGET_MARKETS.md;
  - leads/all_leads.csv.

## How to work with the owner
- **Simple, plain English.** Short sentences. Honest about risks and
  numbers; label estimates as estimates.
- **Minimal and not confusing.** One clear way to do each thing. Make the
  design calls yourself and cut confusing options. Say why briefly.
- **Settings an admin may change belong in Administration screens,** never
  in `.env` edits.
- **Bigger features:** write a short plan in `workspace/` first and get
  approval. Keep each plan's status and decision log up to date.
- **When asked "what do you think?",** give a clear recommendation, then
  build once they say so.

## Hard rules
- **Never commit or push unless asked.**
- **Never print secrets:**
  - `ADMIN_PASSWORD`, `SMTP_PASS`, API keys, `.env` values;
  - read them only into variables, and compare by hash if needed.
- **Never load demo data** (`seed`, password `demo-pass-123`) on production or
  public servers. A throwaway local test database is fine.
- **Confirm before deleting or overwriting** the owner's data or files. The
  old folder `/home/ztark/Desktop/erp` is kept until the owner confirms the
  move to Zenin-ERP.
- **The owner's email and personal details stay private:** never send them
  to outside services.

## Checking work (do all of it before saying "done")
- **API:**
  ```bash
  cd apps/api
  pnpm exec tsc --noEmit
  export TEST_DATABASE_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2- | sed -E 's#/[^/?]+$#/generic_erp_test#')"
  pnpm test
  ```
  All tests must pass (296 on 2026-11-25). Add tests for new behaviour.
- **Web:**
  ```bash
  cd apps/web
  pnpm exec tsc -b
  pnpm lint
  ```
  Lint baseline: **35 warnings, 0 errors**. Don't add warnings. Note there's
  no `pnpm typecheck` script in web.
- **Browser walkthrough** for anything visible (Playwright with
  `/usr/bin/google-chrome`, headless):
  - **Throwaway database:** `erp_import_check`, created fresh by a small
    restart script.
  - **Test API:** port 5099, started with `tsx src/server.ts`, with
    `DATABASE_URL` pointed at that database, `S3_BUCKET=erp-import-check` and
    `CORS_ORIGINS=http://localhost:5174`.
  - **Web:** port 5174, run with
    `VITE_API_BASE_URL=http://localhost:5099/api VITE_FILE_BASE_URL=http://localhost:5099`.
  - **What to cover:** desktop, phone width (no sideways scroll), dark mode,
    no console errors.
  - **Afterwards:** stop the servers and drop the database.
- **Docs:** update WORKFLOW.md (how it works), COMMANDS.md (anything an admin
  runs or sets) and UI_GUIDELINES.md (UI patterns) with each change. Don't
  add new doc files; when a plan is finished, its "how it works" goes into
  WORKFLOW.md and the plan is deleted.

## Good to know
- **Live updates:**
  - Server-Sent Events at `/api/events`, with "hello" and "ping" events.
  - Falls back to checking every 5 s when the stream is held back.
    Cloudflare Quick Tunnels don't support Server-Sent Events.
- **Sounds and desktop notifications:**
  - `apps/web/src/lib/alerts.ts`; action sounds follow the green/red
    messages.
- **Files:**
  - Open them in the in-app viewer (`openFiles()`), never as a raw
    `/uploads` link in a new tab.
- **AI features:**
  - Provider and key are set in Administration → AI.
  - Claude via the Anthropic SDK; Gemini and OpenAI via REST.
  - Usage and costs are estimated in the `ai_usage` table.
- **Performance (measured 2026-11-24):** with 160k demo records and 30
  people working non-stop, 95% of requests finish under ~0.1 s (search under
  ~0.4 s). Not a priority.
