# Commands

The commands you need, and nothing else. Run them from the `Zenin-ERP`
folder unless it says otherwise. `./deploy.sh --help` lists them too.

- [1. Install on a server](#1-install-on-a-server)
- [2. Everyday](#2-everyday)
- [3. Open it from outside the office](#3-open-it-from-outside-the-office)
- [4. Backups, restore, new computer](#4-backups-restore-new-computer)
- [5. Wipe and demo data](#5-wipe-and-demo-data)
- [6. Local development](#6-local-development)
- [7. Tests and checks](#7-tests-and-checks)
- [8. Settings without commands](#8-settings-without-commands)
- [9. When something goes wrong](#9-when-something-goes-wrong)

---

## 1. Install on a server

**You need:** a Linux computer that stays on (Ubuntu 24.04 is best), 4 GB of
memory, 20 GB of free disk, a user that can use `sudo`, and internet during
the install. A wired network, a fixed IP (reserve it in the router: "DHCP
reservation") and a small UPS make it reliable.

```bash
cd ~/Zenin-ERP
./deploy.sh
```

The first run takes 5–10 minutes. It:
- installs Docker if it's missing, and starts it at boot;
- creates `.env` with new random passwords (only the first time);
- builds and starts everything, and waits until it's healthy;
- uses port 80 if it's free (otherwise 8080) and opens the firewall;
- turns off sleep (skip with `--allow-sleep`);
- schedules a backup every night at 02:30.

At the end it prints the address (for example `http://192.168.1.20`) and the
first admin login. **Change that password** after logging in (your name →
My profile).

**Update to a new version:** get the new code (`git pull`), then run
`./deploy.sh` again. It backs up first, rebuilds, upgrades the database and
waits until everything is healthy. Do it outside working hours.

**After a power cut** it starts by itself. Also set "Restore on AC power
loss → Power On" in the computer's BIOS, so the computer turns on by itself.

---

## 2. Everyday

| I want to… | Command |
|---|---|
| See if it's running (address, last backup, free disk) | `./deploy.sh status` |
| Start / stop | `./deploy.sh start` / `./deploy.sh stop` |
| Restart one part that seems stuck | `sudo docker compose restart api` (or `worker`, `web`, `db`, `storage`) |
| Watch the logs | `./deploy.sh logs` or `./deploy.sh logs api` (Ctrl+C stops watching) |
| Apply a change to `.env` or the code | `./deploy.sh` (a plain restart keeps the old settings) |
| Set a new password for someone | `./deploy.sh password <username>` |

Stopping never deletes data. If you stop it with `./deploy.sh stop`, it stays
stopped after a reboot until you run `./deploy.sh start`.

---

## 3. Open it from outside the office

On the office network, people open the address `./deploy.sh` printed. For
access from anywhere, the ERP brings a Cloudflare tunnel. No router changes
are needed, and visitors get HTTPS.

| Command | What it does |
|---|---|
| `./deploy.sh public` | turn on the **free** address, like `https://brave-lunar-fox.trycloudflare.com` |
| `./deploy.sh public "<token>"` | use **your own domain** with a Cloudflare tunnel token |
| `./deploy.sh public --free` | go back to the free address |
| `./deploy.sh private` | office network only again |

**The free address** changes after every restart (`./deploy.sh status` shows
the current one). Live updates on it come every few seconds instead of
instantly, because Cloudflare's free tunnels don't support the live stream.
It's fine for trying things and small teams.

**Your own domain** (about ₹900 a year) gives a fixed address and instant
updates:
1. In Cloudflare: **Zero Trust → Networks → Tunnels → Create a tunnel**
   (type Cloudflared).
2. Copy the token (it starts with `eyJ…`). Don't run the install command it
   shows.
3. Add a public hostname: for example `erp` . `yourcompany.com`, service
   **HTTP**, URL **`web:80`** (not `localhost`).
4. On the server: `./deploy.sh public "eyJ…"`.

**Before going public:** every person has their own strong password, the
demo data is not loaded, and backups go off the server (next section). With
your own domain, Cloudflare Access (free up to 50 people) can ask for an
email code before the login page.

---

## 4. Backups, restore, new computer

```bash
./deploy.sh backup                              # back up now
sudo ls backups/                                # list backups (admin-only: they hold passwords)
./deploy.sh restore backups/2026-11-10_023000   # restore one (type RESTORE to confirm)
```

- **Automatic:** every night at 02:30, kept for 14 days (`BACKUP_KEEP_DAYS`
  in `.env`). Also before every update, restore and wipe.
- **Each backup holds** the database, all uploaded files, and a copy of
  `.env`.
- **Restore** backs up the current state first, then signs everyone out.
- **Keep a copy off this computer.** A backup on the same disk dies with
  the disk. Set `BACKUP_DIR` in `.env` to a NAS or USB disk mount and run
  `./deploy.sh`, or copy the `backups` folder somewhere else every night.
- **Test a restore once,** before you need it.

**Move to a new computer** (or recover after the old one died):
```bash
# on the new computer, with the code and a backup folder copied onto it
cd ~/Zenin-ERP
sudo cp /path/to/backup/env .env && sudo chown "$USER" .env && chmod 600 .env
./deploy.sh
./deploy.sh restore /path/to/backup
```
Then give it the old computer's IP in the router.

---

## 5. Wipe and demo data

| I want to… | Command |
|---|---|
| Delete all data and files, keep the system | `./deploy.sh wipe` (type WIPE; it backs up first) |
| Load the demo company (empty system only) | `./deploy.sh demo` (`--size=small`, `medium` or `large`) |
| Start over with demo data | `./deploy.sh wipe` then `./deploy.sh demo` |
| Remove the ERP from this computer (keeps the data) | `sudo docker compose down` and `sudo rm /etc/cron.d/zenin-erp` |

> ⚠️ **Never load the demo on a server with real data or public access.**
> All demo users share the password `demo-pass-123`, which is written here.
> To try one app, use **Administration → Manage apps** and tick the sample
> records instead.

After a wipe, the admin login is `ADMIN_USERNAME` / `ADMIN_PASSWORD` from
`.env`. Changed your mind? Restore the `*_pre-wipe` backup it took.

---

## 6. Local development

For changing the code with hot reload. You need Node 22, pnpm and Docker.
**Don't run this on the real office server:** it uses the same database.

**With [Task](https://taskfile.dev)** (easiest):

| Command | What it does |
|---|---|
| `task setup` | first time: install packages, create the `.env` files |
| `task dev` | start everything: web app at **http://localhost:5173**, API at :5000. Ctrl+C stops it |
| `task stop` | stop the database and storage |
| `task seed` / `task reset` / `task fresh` | load demo data / wipe / wipe and load demo |
| `task check` | type-check, lint and tests: what CI checks |

**Without Task** (three terminals):
```bash
sudo docker compose up -d db storage   # 1: database and file storage
cd apps/api && pnpm dev                # 2: API, http://localhost:5000
cd apps/web && pnpm dev                # 3: web app, http://localhost:5173
```

In `apps/api`: `pnpm seed` loads demo data, `pnpm db:reset` wipes everything.
Restart `pnpm dev` after a reset or a `.env` change.

---

## 7. Tests and checks

Run these before saying a change is done.

```bash
# API: type check and tests (uses a separate generic_erp_test database, which gets wiped)
cd apps/api
pnpm exec tsc --noEmit
export TEST_DATABASE_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2- | sed -E 's#/[^/?]+$#/generic_erp_test#')"
pnpm test

# Web: type check and lint
cd apps/web
pnpm exec tsc -b
pnpm lint
```

`task test` creates the test database the first time if it's missing.

---

## 8. Settings without commands

These are set in the ERP, under **Administration**. No `.env` editing.

| What | Where |
|---|---|
| Apps (HR, Projects, Clinic…), or your own (**New app**) | **Manage apps**. A new table asks which app it goes in |
| ERP name and logo | **Branding** (everyone sets their own picture in **My profile**) |
| Email (notifications, password links, morning summary) | **Email**: choose Gmail, enter the address and its 16-letter app password, **Send a test email** |
| Team chat and comments on records | **Chat** (team chat is off until you switch it on) |
| AI (Beta): drafting apps, Ask Zenin, change access with AI (Users page) | **AI**: choose Claude, Gemini or ChatGPT, paste the key, **Test**. The same page shows the estimated cost and sets limits |
| People (Administrator, App access), what each level can do, teams | **Users**, **Access levels**, **Departments** |

---

## 9. When something goes wrong

| Problem | Fix |
|---|---|
| Nothing loads | `./deploy.sh status`. If it's stopped: `./deploy.sh start` |
| It won't start | `./deploy.sh logs api` (read the last lines), then `./deploy.sh` |
| Other computers can't open it | The IP may have changed: check `./deploy.sh status`, and reserve the IP in the router. Guest Wi-Fi usually blocks it |
| Forgot the admin password | `./deploy.sh password admin` |
| `permission denied … docker.sock` | Put `sudo` in front of `docker` commands (`./deploy.sh` does this itself) |
| "port … is in use" | Run `./deploy.sh` again; it moves the internal ports. For the web port, set `WEB_PORT` in `.env` |
| Public address: error 502 | The tunnel's hostname must be **HTTP** and **`web:80`** |
| Public address: error 1033 | The server or its internet is down, or the tunnel stopped: `./deploy.sh status`, then `./deploy.sh public` |
| The free address stopped working | It changed after a restart: `./deploy.sh status` shows the new one |
| Emails don't arrive | Administration → Email: **Recent emails** says why. Check spam too |
| AI says the key was refused | Administration → AI: paste a fresh key, then **Test** |
| Disk is full | Lower `BACKUP_KEEP_DAYS`, move `BACKUP_DIR` to a bigger disk, or `sudo docker system prune` |
| `pnpm dev` can't reach the database after a deploy | Copy `POSTGRES_PASSWORD` from `.env` into `DATABASE_URL` in `apps/api/.env`, then restart `pnpm dev` |
| Undo a wipe or a mistake | `./deploy.sh restore backups/<folder>` |
