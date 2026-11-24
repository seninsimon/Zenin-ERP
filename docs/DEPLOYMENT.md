# Hosting Zenin ERP on an office computer, 24x7

This guide turns one computer in your office into an **always-on ERP server**
that everyone on your network can open in a browser: desktops, laptops and
phones on the office Wi-Fi. With one more command, it can also be opened
securely from anywhere in the world (§4).

It takes **one command**:

```bash
./deploy.sh
```

- [1. What you need](#1-what-you-need)
- [2. Install (one step)](#2-install-one-step)
- [3. Open it from other computers and phones](#3-open-it-from-other-computers-and-phones)
- [4. Access from anywhere in the world](#4-access-from-anywhere-in-the-world)
- [5. Keeping it running 24x7](#5-keeping-it-running-24x7)
- [6. Everyday commands](#6-everyday-commands)
- [7. Backups and restore](#7-backups-and-restore)
- [8. Updating to a new version](#8-updating-to-a-new-version)
- [9. Security checklist](#9-security-checklist)
- [10. Moving to a new computer / disaster recovery](#10-moving-to-a-new-computer--disaster-recovery)
- [11. Troubleshooting](#11-troubleshooting)
- [12. Uninstall](#12-uninstall)

---

## 1. What you need

| | Minimum | Recommended |
|---|---|---|
| **Computer** | any PC or mini PC that can stay switched on | a small dedicated machine (mini PC, old desktop), not someone's work laptop |
| **Operating system** | Linux: Ubuntu 22.04+ or Debian 12+ | **Ubuntu 24.04 LTS** (Server or Desktop) |
| **CPU / memory** | 2 cores, 4 GB RAM | 4 cores, 8 GB RAM |
| **Disk** | 20 GB free | SSD with 50 GB+ free (data, uploads and 14 days of backups) |
| **Network** | Wi-Fi | **wired Ethernet**, and a **fixed IP** reserved in the router |
| **Power** | | a small **UPS**, so power cuts don't hard-crash the server |

The whole system uses about 1 GB of memory and comfortably serves an office
of a few hundred people. Windows and macOS aren't supported by the script; for
a 24x7 server, use a Linux machine.

You also need:
- the `erp` folder copied onto that computer (for example to
  `/home/<you>/erp` or `/srv/erp`);
- a user account that can use `sudo`;
- internet access during installation, to download Docker and the base images.

---

## 2. Install (one step)

Open a terminal on the server and run:

```bash
cd ~/erp            # wherever you put the folder
./deploy.sh
```

It will ask for your password once (for `sudo`). The first build takes **5–10
minutes**; later runs are much faster.

**What the script does:**

| Step | Details |
|---|---|
| 1. Installs Docker | only if it's missing, using Docker's official installer, and enables it **at boot** |
| 2. Creates `.env` | your settings file, with **new random passwords** for the database, file storage and first admin. It only does this if `.env` doesn't exist yet; it never overwrites your settings |
| 3. Builds and starts | five services: database, file storage, API, background worker, web app. It waits until every one is **healthy** |
| 4. Picks the port | **80** if free, so the address is just `http://<server-ip>`; otherwise 8080 |
| 5. Opens the firewall | if `ufw` or `firewalld` is active, it allows the web port |
| 6. Disables sleep | suspend and hibernate are turned off, so the server never goes to sleep. Skip with `./deploy.sh --allow-sleep` |
| 7. Schedules backups | **every night at 02:30**: database, uploaded files and settings, kept for 14 days |
| 8. Prints what to do next | the address and the first admin login |

At the end you'll see something like:

```
 Zenin ERP is running.

  Open it from any computer or phone on this network:
      http://192.168.1.20
      http://office-server.local   (also works on most networks)
  On this computer:  http://localhost

  First login:   admin / Xk3v9QpLm2Rt7sWa
  (also in .env as ADMIN_PASSWORD; change it after logging in)
```

**Write down the admin password** and change it after the first login (click
your name → **My profile** → Change password). Then create departments, roles, tables
and users. See [RUNNING.md](RUNNING.md#first-login-and-first-steps), or load
the demo company to explore first: [COMMANDS.md](COMMANDS.md#3-demo-data).

> **Already ran it with `docker compose up` before?** The script keeps your
> existing data. It moves the old database onto the new random password and
> keeps your user accounts, so log in with your existing admin. Forgot it?
> Run `./deploy.sh password admin`.

---

## 3. Open it from other computers and phones

Anyone on the **same network** (office LAN or Wi-Fi) opens the address the
script printed, for example `http://192.168.1.20`, in any modern browser.
Nothing needs to be installed on their computers.

**Make the address permanent.** Routers hand out IP addresses that can change
after a restart. In your router's admin page, look for **DHCP reservation**
(or "static lease" / "address reservation") and reserve the server's current
IP. This is the single most important step for a reliable setup.

**Use a name instead of an IP (optional).**
- `http://<computer-name>.local` works out of the box on most networks (Ubuntu
  Desktop, macOS, iPhone, recent Windows and Android).
- For a nicer name like `http://erp.office`, add a **local DNS entry** in your
  router (many have "Local DNS" or "Host names"). If the router can't, add a
  line to the `hosts` file of each computer:
  `192.168.1.20  erp.office`.

**Working from home or travelling?** See the next section.

---

## 4. Access from anywhere in the world

So far the ERP is reachable on the office network only. To let people open it
from **anywhere** (home, another city, another country, a phone on mobile
data) while it keeps running on **your computer**:

| Option | Cost | Public address | Verdict |
|---|---|---|---|
| **Free tunnel** (built in: `./deploy.sh public`) | **free**, no account, no domain | random, like `https://brave-lunar-fox.trycloudflare.com`; **changes after every restart** | **Start here.** HTTPS included; no router changes; works even when your internet provider gives no public IP |
| Own-domain tunnel (built in: `./deploy.sh public <token>`) | free Cloudflare account, plus a domain (about ₹900 / $10 a year) | fixed, like `https://erp.yourcompany.com` | The upgrade when a fixed address is worth a domain. Adds the Cloudflare Access email check |
| Port forwarding + free dynamic DNS (e.g. DuckDNS) + free Let's Encrypt certificate | free | fixed, like `yourcompany.duckdns.org` | Only works if your provider gives you a public IP (many home and office lines don't). Exposes your router and office IP: **not recommended** |
| Tailscale | its free plan is **for non-commercial use only** | n/a | Not allowed for a business without a paid plan |

Both built-in options make an *outgoing* connection from the server to
Cloudflare, which forwards visitors through it:
- no ports are opened on your router, and your office IP stays hidden;
- visitors get HTTPS automatically, and the login cookie becomes HTTPS-only
  for them;
- the tunnel starts with the rest of the ERP after every reboot;
- office computers can keep using the local address (`http://192.168.1.20`).

### Free: the Quick Tunnel (2 minutes)

> **Live updates on the free Quick Tunnel** come every few seconds, not
> instantly: Cloudflare's Quick Tunnels don't support the live stream, so
> Zenin checks instead, automatically. For instant updates use the fixed
> address with your own domain (below).

On the server:

```bash
./deploy.sh public
```

After a few seconds:

```
  ✓ Free tunnel connected. Anyone can now open the ERP from anywhere at:

      https://brave-lunar-fox-orbit.trycloudflare.com
```

Send that link to your team. It works on any phone or computer, anywhere.

**Things to know about the free address:**
- **It changes whenever the tunnel restarts:** after a reboot, a power cut or
  an update with `./deploy.sh`. Run `./deploy.sh status` to see the current
  address, and send the new link to your team (a WhatsApp group or email
  works well). The 24x7 settings in §5 (UPS, no sleep) keep restarts rare.
- **Cloudflare offers it for testing:** there's no uptime guarantee, and at
  most **200 requests can be in progress at once**. That's plenty for a team of
  tens of people working normally, but not for hundreds at the same moment.
- **Anyone who gets the link reaches the login page.** Random links like these
  have turned up in search engines. The ERP's own protections still apply
  (passwords, slow-down after failed logins, per-user access), so **strong
  passwords matter** (see the checklist below). The Cloudflare Access email
  check needs your own domain.
- **Moving to a fixed address later** is one command (next section); nothing
  else changes.

### Fixed address with your own domain (about ₹900 a year)

You need a **domain** (for example `yourcompany.com`) whose DNS is managed by
Cloudflare:
- buy one in the Cloudflare dashboard (**Domain Registration**), or
- add a domain you already own (**Add a site**, then change the nameservers at
  your registrar as Cloudflare shows you).

The tunnel itself and Cloudflare Access are free.

1. **Create the tunnel.** In the Cloudflare dashboard, open **Zero Trust →
   Networks → Tunnels** and click **Create a tunnel**:
   - type: **Cloudflared**;
   - name: for example `office-erp`.

   (Cloudflare sometimes renames menus; look for "Tunnels".)
2. **Copy the token.** The next page shows install commands containing a long
   token that starts with `eyJ…`. Copy any of them: the whole command is
   fine. **Don't run it**; the ERP brings its own connector.
3. **Add the public hostname.** Under **Public hostname** (or "Published
   application routes"):
   - Subdomain: `erp`;
   - Domain: `yourcompany.com`;
   - Service type: **HTTP**;
   - URL: **`web:80`**.

   Save. Use exactly `web:80` (the ERP's web container), **not**
   `localhost`.
4. **Connect.** On the server, paste the token (or the whole command) in
   quotes:
   ```bash
   ./deploy.sh public "eyJhIjoi…"
   ```
   After a few seconds you'll see `✓ Tunnel connected`, and everyone can
   open **`https://erp.yourcompany.com`** from anywhere. The free tunnel is
   switched off automatically.

### Commands

| Command | What it does |
|---|---|
| `./deploy.sh public` | turn public access on: the free address, or your own domain once a token is saved |
| `./deploy.sh public "<token>"` | use your own domain with this tunnel token |
| `./deploy.sh public --free` | go back to the free address, even with a token saved |
| `./deploy.sh private` | turn public access off; office network only |
| `./deploy.sh status` | shows whether the tunnel is connected, and the current free address |

### With your own domain: let only your people reach the login page

The ERP has its own logins, but once it's on the internet, anyone can try them.
**Cloudflare Access** adds a check *before* the ERP: visitors must prove they
own an approved email address, using a one-time code sent to that inbox. It is
free for up to 50 users. It needs the own-domain tunnel, not the free
address.

1. **Zero Trust → Access → Applications → Add an application → Self-hosted.**
2. Application domain: `erp.yourcompany.com`.
3. Policy: **Allow**, Include:
   - **Emails ending in** `@yourcompany.com`, or
   - a list of specific **Emails** (for staff using Gmail etc.).
4. Login method: **One-time PIN** (on by default).

Staff then enter their email, type the code they receive, and see the normal
ERP login. Attackers never reach the ERP at all.

### Before you go public

- [ ] Admin password changed; **every user has their own strong password**.
- [ ] Former staff are **deactivated** (Admin → Users).
- [ ] With your own domain: **Cloudflare Access** is on (above).
- [ ] **Off-site backups** are working (§7). A public system is a target.
- [ ] Keep it **updated** (§8) and glance at the **audit log** now and then.
- [ ] The demo company (`seed`) is **not** loaded: its passwords are public.

> **What hosting at the office means:** people outside can only work while
> this computer **and your office internet line** are up. Upload and download
> speed for files is limited by the line's *upload* speed. If the business
> comes to depend on outside access, consider a UPS for the router too, a
> backup internet line, or moving to a cloud server (§10).

---

## 5. Keeping it running 24x7

| Situation | What happens |
|---|---|
| **The server restarts** (updates, power cut) | Docker starts at boot and brings every service back automatically. Nobody needs to log in to the server |
| **A service crashes** | Docker restarts it within seconds |
| **The server tries to sleep** | it can't: the script disabled suspend and hibernate |
| **Logs grow** | each service keeps at most 50 MB of logs (5 × 10 MB, rotated) |
| **Old backups pile up** | backups older than `BACKUP_KEEP_DAYS` (14) are deleted automatically |

A few one-time settings complete the picture:

1. **Power on after a power cut.** In the BIOS/UEFI setup (press F2 or Del while
   booting), set **"Restore on AC power loss" → Power On**. The machine then
   boots by itself when the power returns, and the ERP comes back with it.
2. **UPS.** A small UPS covers short power cuts and lets the server shut down
   cleanly during long ones.
3. **Laptop as a server?** Keep it plugged in, and stop it sleeping when the
   lid closes: in `/etc/systemd/logind.conf` set `HandleLidSwitch=ignore` and
   `HandleLidSwitchExternalPower=ignore`, then run
   `sudo systemctl restart systemd-logind`.
4. **Screen lock / auto logout is fine.** The ERP keeps running when nobody is
   logged in to the server.
5. **Security updates.** Ubuntu's automatic security updates (`unattended-upgrades`)
   are safe to leave on; after a reboot everything starts again.
6. **Check now and then** with `./deploy.sh status`: are all services
   healthy, when was the last backup, how much disk is free?

---

## 6. Everyday commands

For a one-page cheat sheet, including how to wipe data at each level and
development mode, see [COMMANDS.md](COMMANDS.md).

Run these in the `erp` folder on the server.

| Command | What it does |
|---|---|
| `./deploy.sh` | install, or update after new code (backs up first) |
| `./deploy.sh status` | services and health, latest backup, free disk space, and the address to share |
| `./deploy.sh logs` | live logs of everything (Ctrl+C to stop). For one service: `./deploy.sh logs api` |
| `./deploy.sh backup` | take a backup right now |
| `./deploy.sh restore <folder>` | restore a backup (asks you to type `RESTORE`) |
| `./deploy.sh wipe` | delete ALL data and files and keep the system (backs up first; type `WIPE` to confirm) |
| `./deploy.sh demo` | load the demo company into an empty system (never on a real server) |
| `./deploy.sh password <user>` | set a new password for a user, for example a locked-out admin. It also re-enables the account |
| `./deploy.sh stop` | stop the ERP (it stays stopped after a reboot until you start it) |
| `./deploy.sh start` | start it again |
| `./deploy.sh public` / `private` | turn access from anywhere (Cloudflare Tunnel) on or off; see §4 |
| `./deploy.sh --help` | list the commands |

---

## 7. Backups and restore

**Every night at 02:30** a backup is saved to `erp/backups/<date_time>/`:

| File | Contents |
|---|---|
| `database.dump` | all tables, records, users, roles, departments and the audit log |
| `files.tar.gz` | all uploaded files and images |
| `env` | a copy of your `.env` settings (passwords included) |

- **Protection:** backup folders can only be read by the administrator (root),
  because they contain passwords. Use `sudo ls backups/` to see them.
- **Extra backups:** a backup is also taken automatically **before every update
  and every restore**, labelled `_pre-update` / `_pre-restore`.
- **Log:** the nightly job writes to `/var/log/zenin-erp-backup.log`.

**Keep a copy off the server.** A backup on the same disk doesn't help if that
disk dies. Choose one of these:
- Set `BACKUP_DIR` in `.env` to a mounted **NAS or network share** (for example
  `BACKUP_DIR=/mnt/nas/erp-backups`).
- Copy backups to a **USB disk** each night, with one line in
  `sudo crontab -e`:
  ```
  0 4 * * * rsync -a /home/<you>/erp/backups/ /media/<you>/USB/erp-backups/
  ```
- Or use any cloud backup tool on the `backups` folder.

**Restore** (for example after a mistake, or to go back to yesterday):

```bash
sudo ls backups/                                  # pick a folder
./deploy.sh restore backups/2026-11-10_023000
```

The restore:
- **asks for confirmation** (type `RESTORE`);
- **backs up the current state first**;
- replaces the database and files, restarts everything, and signs everyone out.

**Test a restore once** after setting things up, ideally on a spare computer
(see §10), so you know it works before you need it.

---

## 8. Updating to a new version

```bash
cd ~/erp
git -C apps/api pull      # or copy the new code in
git -C apps/web pull
./deploy.sh
```

`./deploy.sh` then:
- **backs up** the database;
- **rebuilds** the changed parts;
- **upgrades** the database structure automatically;
- **waits** until everything is healthy.

Users may see a few seconds of interruption, so run updates outside working
hours.

---

## 9. Security checklist

- [ ] **Change the admin password** after the first login, and give each
      person **their own account** (no shared logins).
- [ ] **Least access:** give each user only the departments and roles they
      need. See [README.md](../README.md) for how access works.
- [ ] **Never use port forwarding** on the router. For access from outside,
      use the built-in tunnel (§4): free, or with your own domain and
      **Cloudflare Access**.
- [ ] **Protect `.env`:** it holds the passwords. It is readable only by your
      user; keep a copy in a password manager or safe.
- [ ] **Off-site backups** (§7), and a restore tested at least once.
- [ ] **Don't load the demo company** (`seed`) on the real server: the demo
      users share a public password.
- [ ] **Office Wi-Fi:** use WPA2/WPA3 with a strong password, and keep guests
      on a separate guest network.
- [ ] **HTTPS:** public access through the tunnel (§4) is always HTTPS. On
      the office network the ERP runs over plain HTTP, which is common for
      internal tools. If you want encryption
      inside the office too, put Caddy in front, as in the
      [RUNNING.md production section](RUNNING.md#2-put-https-in-front), and set
      `COOKIE_SECURE=true` in `.env`. On a LAN that means Caddy's
      `tls internal` and installing its certificate on each device.

---

## 10. Moving to a new computer / disaster recovery

1. Install Linux on the new computer and copy the **`erp` folder** (code) onto it.
2. Copy a **backup folder** onto it too, from your NAS, USB disk or the old server.
3. Put the backed-up settings in place **before** installing, so passwords
   match:
   ```bash
   cd ~/erp
   sudo cp /path/to/backup/env .env && sudo chown "$USER" .env && chmod 600 .env
   ```
4. Install and restore:
   ```bash
   ./deploy.sh
   ./deploy.sh restore /path/to/backup
   ```
5. Give the new computer the **same fixed IP** in the router (or update your
   DNS name), and everyone carries on as before.

---

## 11. Troubleshooting

| Problem | Fix |
|---|---|
| **Other computers can't open it** but the server can | Check the IP with `./deploy.sh status`; it may have changed (reserve it in the router, §3). Make sure the device is on the same network, not the **guest Wi-Fi** (guest networks usually block access to other devices). |
| **It worked yesterday, now nothing loads** | `./deploy.sh status`. If services are down: `./deploy.sh start`. If the server was off, check the BIOS power setting (§5). |
| **`permission denied ... docker.sock`** | Normal: the script uses `sudo` for Docker. Just run `./deploy.sh`. Don't run plain `docker` commands without `sudo`. |
| **"ports 80 and 8080 are both in use"** / **"port … is used by another program"** for the web port | Another web server runs on this computer. Stop it, or set `WEB_PORT=8090` (any free port) in `.env` and run `./deploy.sh` again. |
| **"address already in use"** for ports 5000, 5433, 9000 or 9001 | These internal ports are only used on the server itself. `./deploy.sh` now moves them to the next free port automatically (and saves it in `.env`), so just run it again. |
| **Developing on the same computer** (`pnpm dev`) | The dev API and the deployed ERP share the same Docker database. After the first deploy, the database has a new password: copy `POSTGRES_PASSWORD` from `erp/.env` into `DATABASE_URL` in `apps/api/.env`, and restart `pnpm dev`. On a real office server, don't run the dev servers at all. |
| **The free `trycloudflare.com` link stopped working** | The address changed after a restart. `./deploy.sh status` shows the new one; send it to your team. Still not connected? `./deploy.sh public` again. |
| **Public address shows "Bad gateway" / error 502** | In the Cloudflare tunnel's public hostname, the service must be **HTTP** and **`web:80`** (not `localhost`). |
| **Public address shows error 1033 / tunnel not connected** | The server or its internet is down, or the tunnel isn't running: `./deploy.sh status`, then `./deploy.sh public`. A new token? `./deploy.sh public <token>`. |
| **Login works on the office address but not the public one** (or the reverse) | Clear the browser's cookies for that address and log in again. If `COOKIE_SECURE=true` is set in `.env`, plain-http office access can't keep a login: set it to `false` (public HTTPS stays secure) and run `./deploy.sh`. |
| **Forgot the admin password** | `./deploy.sh password admin` |
| **Disk is full** | `./deploy.sh status` shows free space. Lower `BACKUP_KEEP_DAYS`, move `BACKUP_DIR` to a bigger disk, or run `sudo docker system prune` to remove old build images. |
| **Build fails during install** | Usually no internet. Check the connection and run `./deploy.sh` again; it continues where it stopped. |
| **Something else** | `./deploy.sh logs api` shows the API's errors. See also [RUNNING.md → Troubleshooting](RUNNING.md#troubleshooting). |

---

## 12. Uninstall

```bash
cd ~/erp
sudo docker compose down                 # stop and remove the containers (data is KEPT)
sudo rm /etc/cron.d/zenin-erp            # stop nightly backups
sudo systemctl unmask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

To also **delete all data permanently**, back up first and then run
`sudo docker compose down -v`.
