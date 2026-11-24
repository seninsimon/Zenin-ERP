# Commands: start, stop, wipe

A quick reference for running Zenin ERP day to day.
- **Run every command from the `erp` folder** (for example `cd ~/Desktop/erp`),
  unless a section says otherwise.
- **For the full setup,** see [DEPLOYMENT.md](DEPLOYMENT.md).

- [Quick reference](#quick-reference)
- [1. Start, stop, restart](#1-start-stop-restart)
- [2. Wipe data](#2-wipe-data)
- [3. Demo data](#3-demo-data)
- [4. Backups](#4-backups)
- [5. Development mode (pnpm)](#5-development-mode-pnpm)
- [6. Turn on AI drafting (optional)](#6-turn-on-ai-drafting-optional)
- [7. Email](#7-email)
- [8. When something goes wrong](#8-when-something-goes-wrong)

---

## Quick reference

| I want to… | Command |
|---|---|
| **Install, or update** after new code or a `.env` change | `./deploy.sh` |
| **Start** the ERP | `./deploy.sh start` |
| **Stop** the ERP | `./deploy.sh stop` |
| **Restart** everything | `sudo docker compose restart` |
| See if it's **running** (plus address, backups, disk) | `./deploy.sh status` |
| Watch the **logs** | `./deploy.sh logs` (Ctrl+C to stop watching) |
| **Wipe all data** (keep the system) | `./deploy.sh wipe` |
| **Start over** with demo data | `./deploy.sh wipe` then `./deploy.sh demo` |
| **Back up** now | `./deploy.sh backup` |
| **Restore** a backup | `./deploy.sh restore backups/<folder>` |
| **Reset a password** | `./deploy.sh password <username>` |
| **Add or remove an app** (HR, Projects, Clinic…) | no command: in the ERP, **Administration → Manage apps** |
| **Name and logo** of your ERP | no command: in the ERP, **Administration → Branding** (sign-in page, sidebar, browser tab, emails). Everyone sets their own picture in **My profile** |
| **Email** (notifications, password links, morning summary) | no command: in the ERP, **Administration → Email** ([§7](#7-email)) |
| **Chat** and comments on records | no command: in the ERP, **Administration → Chat** (team chat is off until you switch it on) |
| Turn on **AI drafting** ("Describe your organization", Beta) | no command: in the ERP, **Administration → AI**: choose Claude, Gemini or ChatGPT and paste its key ([§6](#6-turn-on-ai-drafting-optional-beta)) |
| Open it to the **internet** / close it again | `./deploy.sh public` / `./deploy.sh private` |
| List all commands | `./deploy.sh --help` |

---

## 1. Start, stop, restart

```bash
./deploy.sh start      # start everything and wait until it's healthy
./deploy.sh stop       # stop everything (data is kept)
./deploy.sh status     # what's running, the address to share, last backup, free disk
```

- **After a reboot or power cut** the ERP **starts by itself**. The exception
  is if you stopped it with `./deploy.sh stop`: it then **stays stopped** until
  you run `./deploy.sh start`.
- **Stopping never deletes data.** Records, users and files stay in Docker's
  volumes.
- **Public access:** if it is on, it starts and stops with the ERP. Turn it on
  or off with `./deploy.sh public` / `./deploy.sh private`.
- **The free public address changes after every shutdown or restart.**
  `./deploy.sh`, `./deploy.sh start` and `./deploy.sh status` all wait for the
  tunnel and print the current address. Share that one; old addresses stop
  working.

**Restart** (when something seems stuck):

```bash
sudo docker compose restart          # everything
sudo docker compose restart api      # just one part: api, worker, web, db or storage
```

**After changing code or `.env`,** run `./deploy.sh` instead. A plain restart
keeps the old settings; `./deploy.sh` takes a backup, rebuilds, loads the new
settings and applies any database updates by itself.

---

## 2. Wipe data

Choose how much to delete. To remove **just one app** and its tables, you
don't need any of these: use **Administration → Manage apps → Remove app** in the ERP.

| Level | Command | Deletes | Keeps |
|---|---|---|---|
| **1. Wipe all data** (most common) | `./deploy.sh wipe` | every table and record, user, role and department, the installed apps, automations and notifications, the audit log and **every uploaded file** | the installed system, your settings (`.env`) and backups. The admin login is recreated |
| **2. Delete the Docker volumes** | see below | the database and file-storage volumes themselves | settings (`.env`) and backups |
| **3. Uninstall completely** | see below | everything, including settings and backups | nothing |

### Level 1: wipe all data

```bash
./deploy.sh wipe
```

1. It asks you to type `WIPE`. Anything else cancels.
2. It **takes a backup first**, saved as `backups/<date>_pre-wipe`.
3. It deletes everything, recreates the empty system, and restarts.
4. It prints the admin login. That's `ADMIN_USERNAME` / `ADMIN_PASSWORD` from
   `.env`, even if you had changed the admin password in the app.

**Changed your mind?** Restore the backup it just took:

```bash
sudo ls backups/                                   # find the *_pre-wipe folder
./deploy.sh restore backups/2026-11-10_112847_pre-wipe
```

In scripts, `./deploy.sh wipe --yes` skips the question.

### Level 2: delete the Docker volumes

Use this when the database itself is broken, or you want Docker to start from
nothing:

```bash
./deploy.sh backup                # just in case
sudo docker compose down -v       # removes containers AND the database/storage volumes
./deploy.sh                       # creates fresh, empty volumes and starts again
```

Log in with `ADMIN_USERNAME` / `ADMIN_PASSWORD` from `.env`.

### Level 3: uninstall completely

> ⚠️ This deletes your data, settings **and backups**. Copy a backup
> somewhere safe first if there's anything you might need.

```bash
sudo docker compose down -v --rmi local          # containers, volumes and built images
sudo rm -f /etc/cron.d/zenin-erp                 # nightly backups
sudo systemctl unmask sleep.target suspend.target hibernate.target hybrid-sleep.target
sudo rm -rf backups .env .deploy-first-login     # backups and settings
```

The `erp` folder (the code) is all that remains; delete it if you like.

---

## 3. Demo data

Load the demo company: 17 linked tables, 16 users and about 20,000 records.
The demo users and their logins are printed when it finishes.

**Just want to try one app?** You don't need the demo: in **Administration → Manage apps**,
add the app and tick *Add a few sample records to try it out*. The app's
**Remove … sample records** button takes them out again and keeps your own.

```bash
./deploy.sh demo                   # medium, about 20,000 records (a few seconds)
./deploy.sh demo --size=small      # about 3,000 records
./deploy.sh demo --size=large      # about 160,000 records, for speed tests
```

- **Load it into an empty system.** If any of its tables or users already
  exist (for example from an installed app), it refuses and changes nothing. **Start over with demo data:**
  ```bash
  ./deploy.sh wipe
  ./deploy.sh demo
  ```
- **Remove the demo again:** `./deploy.sh wipe`.

> ⚠️ All demo users share the password `demo-pass-123`, which is written in
> these docs. **Never load the demo on a server with real data or with public
> access turned on.**

---

## 4. Backups

```bash
./deploy.sh backup                            # back up now
sudo ls backups/                              # list backups (they're admin-only: they contain passwords)
./deploy.sh restore backups/<folder>          # restore one (type RESTORE to confirm)
```

- **Nightly:** a backup runs automatically every night at 02:30 and is kept
  for 14 days.
- **Automatic extras:** a backup is also taken before every update, restore
  and wipe.
- **More:** off-site copies and moving to a new computer are covered in
  [DEPLOYMENT.md §7](DEPLOYMENT.md#7-backups-and-restore).

---

## 5. Development mode (pnpm)

For changing the code with hot reload.

### The easy way: Task

The `Taskfile.yml` in the `erp` folder runs everything with one command
([Task](https://taskfile.dev) must be installed):

| Command | What it does |
|---|---|
| `task` | list all tasks |
| `task setup` | first time: install dependencies and create the `.env` files |
| `task dev` | start the database, storage, API (http://localhost:5000) and web app (**http://localhost:5173**) with hot reload. **Ctrl+C** stops the API and web app |
| `task stop` | stop the database and storage (skipped while the deployed ERP is running, since it uses them) |
| `task seed` | load the demo company (`task seed SIZE=small`) |
| `task reset` | wipe all data and files (asks first) |
| `task fresh` | wipe and load fresh demo data in one go (asks first) |
| `task test` | run the API tests (creates the separate test database the first time) |
| `task check` | type-check, lint and tests: everything CI checks |
| `task build` | production build of both parts |
| `task deploy` / `task status` | `./deploy.sh` / `./deploy.sh status` |

The output of each part is labelled `[api]`, `[web]` or `[docker]`.
`task dev:api` or `task dev:web` runs just one part, for example in its own
terminal.

### The manual way

You need three terminals.

> ⚠️ **On a computer that also runs the deployed ERP,** development uses
> **the same database and files**. Wiping in development wipes the deployed
> ERP too. On the real office server, don't run development mode.

**Start:**

```bash
# terminal 1: database and file storage (in the erp folder)
sudo docker compose up -d db storage

# terminal 2: API with hot reload (http://localhost:5000)
cd apps/api && pnpm dev

# terminal 3: web app with hot reload (http://localhost:5173)
cd apps/web && pnpm dev
```

**Stop:**
1. Press **Ctrl+C** in the API and web terminals.
2. Then stop the database and storage, unless the deployed ERP is using them:
   ```bash
   sudo docker compose stop db storage
   ```

**Wipe data and demo data** (in `apps/api/`):

```bash
pnpm db:reset                  # wipe ALL data and files (type RESET to confirm)
pnpm db:reset --yes            # same, without the question
pnpm seed                      # load the demo company (--size=small|medium|large)
pnpm db:reset --yes && pnpm seed   # start over with fresh demo data
```

`pnpm db:reset` also removes installed apps, automations and notifications.
Afterwards, **restart `pnpm dev`** (Ctrl+C, then `pnpm dev`), so
the API forgets its cached tables.

---

## 6. Turn on AI drafting (optional, Beta)

**Administration → Manage apps → Describe your organization** lets an AI draft
tables from a sentence like "We're a dental clinic with two branches". You see
the full preview before anything is created. It stays **off** until you add a
key. There's nothing to run, and no `.env` to edit:

1. In the ERP: **Administration → AI**.
2. Choose **Claude**, **Gemini** or **ChatGPT**, and get a key from the link
   under the key box (Anthropic Console, Google AI Studio or the OpenAI
   Platform).
3. Paste the key, press **Save**, then **Test**.

- **Cost:** each draft is one paid request to the provider you chose, billed
  to that key. Nothing is sent until someone presses **Draft tables**, and
  then only the description they typed.
- **See what it costs:** the same page shows this month's and last month's
  requests and an estimated cost (≈), by feature and by person. The provider's
  own billing page is the real bill.
- **Set limits** (optional): a monthly spend at which AI features pause
  (admins get a bell at 80% and 100%), and requests per person per day.
- **Switch features on and off** under **Features**: switched off means gone
  from everyone's screens. **Ask Zenin** (off at first) is an assistant in
  the top bar that answers questions about records, seeing only what the
  person asking can see. Choose who can use it: everyone, or only some roles.
- **Switch provider** at any time; each provider's key is kept, so switching
  back needs no pasting.
- **Turn it off:** **Remove key** on the same page. Apps already made from
  drafts keep working.
- **An `ANTHROPIC_API_KEY` already in `.env`** is copied into Administration →
  AI the first time the new version starts. After that you can delete the
  line.

---

## 7. Email

Set up in the ERP: **Administration → Email**. There's nothing to run, and no
`.env` editing.

1. Choose **Gmail**, then enter the address and its **app password**. That's
   16 letters from
   [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords);
   the Google account needs 2-Step Verification on. It isn't the normal
   Gmail password.
2. Check **Links in emails go to**. It's the address people open the ERP at,
   such as the office address `http://10.14.5.15`. The free public tunnel's
   address changes on every restart, so links in older emails would stop
   working; avoid it here.
3. **Save**, then **Send a test email** (it goes to the address in your My
   profile).

Once it's on:
- **People get an email** for what would ring their bell: a leave request to
  approve, a decision on theirs, a task given to them. They also get a
  **morning summary** (8:00 by default): due tasks, tomorrow's appointments,
  overdue invoices…
- **Each person chooses in My profile:** right away, once a day, or never.
- **Add person** can email a "set your password" link instead of you
  choosing one.
- **The sign-in page** has **Forgot your password?**

**Good to know:**
- **The password** is saved on the server and never shown again; leave the
  field empty to keep it.
- **Gmail sends about 500 emails a day**; the Email page shows how many went
  out.
- **Email settings in `.env`** (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`,
  `MAIL_FROM`…) are copied into Administration → Email the first time the
  ERP starts with none saved. After that, delete those lines; the app's
  settings are what count.

---

## 8. When something goes wrong

| Problem | Command |
|---|---|
| Is it running? What's the address? | `./deploy.sh status` |
| It's stopped | `./deploy.sh start` |
| It won't start | `./deploy.sh logs api` (read the last lines), then `./deploy.sh` |
| Emails don't arrive | Administration → Email: the **Recent emails** list says why (wrong app password, no internet, Gmail's daily limit). Check the spam folder too |
| Changed `.env` but nothing changed | run `./deploy.sh` (a restart keeps the old settings) |
| "Drafting with AI isn't set up" | Administration → AI: paste a key ([§6](#6-turn-on-ai-drafting-optional-beta)) |
| "… refused the API key" / "doesn't offer the model" | Administration → AI: paste a fresh key, or clear **Advanced → Model**, then **Test** |
| Forgot the admin password | `./deploy.sh password admin` |
| `permission denied … docker.sock` | put `sudo` in front of `docker` commands (`./deploy.sh` does this for you) |
| A port is already in use | run `./deploy.sh` again: it moves internal ports automatically |
| Undo a wipe or a mistake | `./deploy.sh restore backups/<folder>` |
| More | [DEPLOYMENT.md → Troubleshooting](DEPLOYMENT.md#11-troubleshooting) |
