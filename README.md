# RMS Panel v3 — Web Dashboard for RMS UDP Custom Manager

© 2026 RMS. All rights reserved.

## What's new (latest) — Drill-Down Navigation

- **Super Admin** can now tap any admin to open a dedicated network view
  (`admin-network.html`) showing that admin's resellers and every VPN user
  across their whole network in one place.
- **Tapping a reseller** (from that page, or from the Resellers list
  directly) drills into just their VPN users, with a clear "viewing X's
  users" banner and a way back — available to both Super Admins and the
  Admin who manages that reseller.

## What's new (previous) — Profile Avatar

- Every role now has a simple placeholder avatar (generic blank-human
  silhouette, inline SVG, no upload needed) next to their name in the
  topbar. Tapping it opens the existing Profile page, where you can view
  your role/credits/status/member-since and change your password.

## What's new (previous) — Role-Scoped Visibility + Home Dashboard

- **Admins now only see their own network**, not every VPN user/reseller
  in the system. An admin sees themselves + the resellers they personally
  created (tracked via the existing `accounts.parent_id` column) — nothing
  from other admins' resellers. This applies to the VPN Users list,
  Expired Users list, Statistics, Resellers list, and every per-item action
  (renew/block/delete/credit-adjust/suspend) — an admin can't act on an
  out-of-scope record even by guessing its ID. `super_admin` still sees
  and manages everything, unrestricted.

- **New Home dashboard** (`home.html`), now the default page after login
  for every role. Shows role-appropriate stats (credits for resellers,
  network totals for admins, system-wide totals for super admins) and a
  quick-actions grid tailored to what each role can actually do.

## What's new (previous) — Reseller 30-Day Cap, Mobile Nav, Live Deployment

- **Resellers can no longer create or renew a VPN user for more than 30
  days.** Enforced server-side in both `POST /vpn-users` and
  `PUT /vpn-users/:id/renew` (`backend/routes/vpnUsers.js`) — a reseller
  requesting a longer duration gets a clean 403 before anything is
  created or credited. Super Admins and Admins are unaffected. A matching
  client-side hint/guard was added to `create-vpn-user.html` for UX, but
  the server check is the real enforcement.

- **Proper mobile navigation.** The sidebar used to shrink to a 68px
  icon-only strip on small screens and hide its text labels — but the nav
  links were text-only (no icons), so mobile users just saw an empty gray
  strip with nothing clickable. Replaced with a hamburger button + slide-out
  drawer (`frontend/js/app.js`, `frontend/css/style.css`) that reuses the
  exact desktop sidebar markup and styling, just positioned off-screen
  until opened. Tables also gained `overflow-x: auto` inside their card so
  columns that don't fit the screen width scroll into view instead of
  being cut off with no way to reach them.

- **Bug fix: `API_BASE` placeholder.** `frontend/js/app.js` shipped with
  `const API_BASE = "http://YOUR_VPS_IP_OR_DOMAIN:3000/api";` — a literal
  placeholder that was never filled in, so every API call failed with a
  browser `NetworkError`. Changed to a same-origin relative path
  (`const API_BASE = "/api";`) so it works through the Nginx reverse proxy
  regardless of hostname or HTTP/HTTPS, with no per-deployment edit needed.

- **Live deployment reference.** This version was deployed end-to-end on a
  bare Ubuntu 24.04 VPS with no purchased domain, using the free
  `sslip.io` wildcard-DNS trick for a real Let's Encrypt HTTPS certificate
  (see the updated deploy steps below). Full session notes/bugs found are
  in `CHANGELOG.md` at the repo root.

- **Companion repo bug fixes.** While wiring this panel up to a real
  `RMS-UDP-CUSTOM-MANAGER` install, found and fixed two real bugs in that
  repo's `install.sh` unrelated to the panel itself — a broken
  `raw.github.com` download domain (should be `raw.githubusercontent.com`)
  that could silently leave the tunnel binaries empty/broken, and a
  silent `ufw` ⇄ `iptables-persistent` package conflict that would remove
  whichever one was already installed with zero warning. Both are fixed in
  that repo directly; see its own changelog/commit history.

## What's new (previous) — Device Limit Enforcement

- **A new watchdog job** (`backend/jobs/deviceLimitWatchdog.js`) checks
  every 20 seconds whether any active VPN user has more simultaneous
  sessions than their `connection_limit` allows (resellers are always
  locked to 1, as covered above). If someone exceeds their limit, **all**
  of their active sessions get disconnected at once - they simply
  reconnect with only their allowed number of devices.
- This exists because I checked your actual `RMS-UDP-CUSTOM-MANAGER`
  repo directly (`udp` and `install.sh`) and confirmed: **there is no
  device-limit enforcement anywhere in your own script.** The Connection
  Limit field is only ever stored and displayed, never read back to
  reject or kick anything. Any real enforcement was either happening
  entirely inside the closed-source `/etc/UDPCustom/module` binary (which
  none of us can verify), or not happening at all.
- **Important honest caveat**: this watchdog works by counting how many
  processes are running under a user's Linux username, on the assumption
  that UDP Custom spawns one process per connected device. If it instead
  routes every connection through a single shared daemon process
  regardless of device count, the process count will always read as 1 no
  matter how many devices are actually connected - and this watchdog
  won't be able to tell the difference. **Test this for real once you're
  on the VPS**: connect one device with a limit-1 user, then try a second,
  and watch the Logs tab for a `device_limit_enforced` entry to confirm
  it's actually working as intended.

## What's new (previous) — Security Hardening

- **Single active session per account.** Logging in anywhere immediately
  invalidates any other open session for that same account. If someone
  opens the panel in a second browser/device with the same login, the
  first session stops working right away (it'll show "Session ended -
  you were logged in somewhere else"). Changing your password does the
  same thing, so a leaked-but-still-valid token can't survive a password
  change.
- **Account lockout.** 5 failed login attempts on one account locks it for
  15 minutes, regardless of which IP the attempts came from. This is
  logged (`account_locked`).
- **Rate limiting** on the whole API (300 requests / 15 min per IP) and a
  tighter limit specifically on the login endpoint (10 attempts / 15 min
  per IP) to blunt brute-force and scraping attempts.
- **Security headers** via `helmet` (CSP, X-Frame-Options, HSTS, etc.) on
  every API response.
- **CORS locked down** — set `FRONTEND_ORIGIN` in `.env` to your real
  domain once deployed, and the API will only accept requests from there
  instead of anywhere.
- **Stronger password requirements** — panel login passwords (super admin,
  admin, reseller accounts) now require 8+ characters everywhere,
  consistently. VPN user passwords (the ones your customers get) still
  follow the original script's own 3-character minimum, since that's a
  different thing entirely and matching the script exactly there matters
  more than panel-account security policy.
- Explicit **Logout** now also clears the session server-side, not just
  locally.

### If you already set up the database with an earlier version

Run this once against your existing database before restarting the API:
```bash
mysql -u rms_panel -p rms_panel < backend/scripts/migrate_security.sql
```
Fresh installs don't need this - `schema.sql` already includes everything.

### Deploying with the new security settings

After `npm install` (which now also pulls in `helmet` and
`express-rate-limit`), set in your `.env`:
```
FRONTEND_ORIGIN=https://panel.yourdomain.com
```
Leave it as `*` only while testing locally before you have a real domain.

## What's new (previous)
  - **Reseller**: their own VPN user count, how many are online/offline
    right now, and how many have expired/archived, plus a live list of
    their own users with an online/offline badge on each.
  - **Admin**: the same view but system-wide - total users across every
    reseller, online/offline counts, and a breakdown table grouped by
    reseller (who owns how many users, how many of theirs are online).
  - **Super Admin**: everything Admin sees, plus a count of how many
    Admins/Super Admins exist.
  - **Important honesty note**: the original script has no real
    online/offline tracking - it only ever checks `ps -u username` when
    *killing* a session. The Statistics page uses that exact same signal,
    so it's best-effort, not guaranteed-perfect. If UDP Custom multiplexes
    all connections through a single daemon process rather than spawning
    one per user, this indicator won't be fully accurate - the panel says
    so directly on the page itself.

## What's new (previous)
  - **Auto-expiry kicks and removes only the expired user** - `pkill -u`
    that username, then `userdel --force`, then archive their details. No
    service-wide restart, so every other currently-connected user is left
    completely untouched.
  - **Manual deletion** (the "Delete" button) matches `trm_user` exactly:
    `pkill` + `kill -9` + `userdel --force`.
  - **Renew** now also runs `usermod -U` after `usermod -e`, matching
    `renew_user`'s unlock-on-renew behavior.
  - **Validation matches `new_user`'s rules exactly**: username 3-12 chars
    (letters/numbers/underscores only), password minimum 3 characters, and
    a duplicate-username check before attempting creation - so you get a
    clean error instead of a silent `useradd` failure.
- **Expired Users list.** When a user's time is up, the system account is
  still deleted immediately and strictly, without affecting anyone else -
  but their username/password/limit are archived in a new **Expired Users**
  page instead of being thrown away. From there, a Super Admin, Admin, *or*
  Reseller (their own users only) can hit **Renew** to instantly recreate
  that exact user with a new duration, without retyping anything.

## What's new (previous)

- **Three-tier role system**:
  - **Super Admin** — you, the person who installs the panel on the VPS.
    Full access to everything: create/manage Admins and other Super Admins,
    resellers, VPN users, server config, and all logs.
  - **Admin** — created only by a Super Admin. Can create and manage
    resellers and VPN users, same as a Super Admin operationally, but
    **cannot** create or manage other Admins/Super Admins, and cannot edit
    Server Config.
  - **Reseller** — can only see and manage the VPN users they created
    themselves, and only their own entries in the Logs tab. No access to
    Resellers, Admins, or Server Config pages at all.
- Only a Super Admin can decide, at creation time, whether a new admin-tier
  account is an "Admin" or a "Super Admin" — there's no self-promotion path.
- The system still won't let you suspend the very last active Super Admin,
  so the panel can never lock itself out.

## What's new (previous)

- **Server Config page** (super admin only) — set your VPS host/IP and
  port range once. This is UDP Custom only, so there's no protocol picker.
- **Copyable user details everywhere** — right after creating a user, and
  from a "Copy" button on every row in VPN Users, you get:
  - **Copy User:Pass** — just `username:password`
  - **Copy Connection String** — the `host:port@username:password` format
  - **Copy Full Config** — a readable block with server, port, credentials,
    expiry, and device limit
- **Resellers are locked to 1-device users** — enforced server-side, not
  just hidden in the UI.
- Green/black color theme throughout.

## What's new in v2

- **Real multi-page frontend** — separate pages (`login.html`, `vpn-users.html`,
  `create-vpn-user.html`, `resellers.html`, `create-reseller.html`, `logs.html`)
  with a shared sidebar/topbar and a proper hand-written stylesheet instead of
  one long single-page CDN-utility layout.
- **Minutes / Hours / Days duration picker** on both create and renew,
  matching the original `udp` script's flow exactly.
- **Strict expiry enforcement** — a background job (`backend/jobs/expiryChecker.js`)
  runs every 30 seconds, and the moment a user's time is up it:
  1. Force-disconnects them and deletes the actual system account
  2. Removes their row from the panel
  3. Writes a log entry (`auto_expired_deleted`) attributed to whichever
     reseller (or you) owns that account, so it shows up in their own Logs
     tab automatically
- Live-refreshing tables (VPN Users and Logs poll every 20s) so expired
  users disappear and new log entries appear without a manual refresh.
- An "expiring soon" pill shows on any user with less than 1 hour left.

Everything else (API structure, database schema, credit system, wrapper
script, role-based access) works the same as before.

---

## Architecture recap

```
Browser (multi-page dashboard)  --HTTPS-->  Node.js API (VPS, port 3000)
                                                   |
                                    +--------------+---------------+
                                    |                               |
                            udp-api-wrapper.sh              expiryChecker.js
                            (on-demand actions:              (runs every 30s,
                             create/renew/block/delete)       auto-cleans expired
                                    |                          users)
                                    v
                       useradd / usermod / pkill on the VPS
```

## Deploy steps (as actually run — free VPS, no domain, Ubuntu 24.04)

This works with **just a bare VPS IP, no purchased domain**, using the
free `sslip.io` wildcard-DNS trick for real HTTPS.

### 1. Server prerequisites
```bash
apt update && apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
apt install -y mysql-server
mysql_secure_installation
systemctl enable --now mysql
```

### 2. Database
```bash
mysql -u root -p
```
```sql
CREATE DATABASE rms_panel;
CREATE USER 'rms_panel'@'localhost' IDENTIFIED BY 'a_strong_password_here';
GRANT ALL PRIVILEGES ON rms_panel.* TO 'rms_panel'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```
```bash
mysql -u rms_panel -p rms_panel < backend/scripts/schema.sql
```
(`schema.sql` alone is enough on a fresh install — it already includes
everything `migrate_security.sql` adds, so that script is only for
upgrading a database created with an older version of `schema.sql`.)

### 3. Backend
```bash
mkdir -p /etc/rms-panel
cp -r rms-panel-v3 /etc/rms-panel/
cd /etc/rms-panel/rms-panel-v3/backend
npm install --production
cp .env.example .env
nano .env   # fill in DB password, JWT_SECRET (openssl rand -hex 32),
            # SUPER_ADMIN_USERNAME/PASSWORD (8+ chars, not a weak variant
            # of the username), UDP_WRAPPER_PATH
chmod +x scripts/udp-api-wrapper.sh
node server.js   # test run - Ctrl+C once it boots cleanly
```
You should see:
```
Super admin account "..." created.
RMS Panel API running on port 3000
```
Confirm it's actually answering:
```bash
curl http://127.0.0.1:3000/api/health   # expect {"status":"ok"}
```

### 4. Keep it running
```bash
cp rms-panel-api.service /etc/systemd/system/
nano /etc/systemd/system/rms-panel-api.service
# set WorkingDirectory and EnvironmentFile to
# /etc/rms-panel/rms-panel-v3/backend
systemctl daemon-reload
systemctl enable --now rms-panel-api
systemctl status rms-panel-api   # should show active (running)
```

### 5. Nginx (static frontend + API reverse proxy)
```bash
apt install -y nginx
nano /etc/nginx/sites-available/rms-panel
```
```nginx
server {
    listen 80;
    server_name _;

    root /etc/rms-panel/rms-panel-v3/frontend;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3000/api/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
```bash
ln -s /etc/nginx/sites-available/rms-panel /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
```

### 6. Firewall
```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
ufw status
```
If you're also running `RMS-UDP-CUSTOM-MANAGER` on this same box, also
allow its tunnel ports (its installer does this automatically now):
```bash
ufw allow 36712/udp
ufw allow 1:65535/udp
```

### 7. Free HTTPS with no domain (sslip.io trick)
`sslip.io` auto-resolves `<your-ip>.sslip.io` back to your VPS IP with
zero DNS setup, which is enough for Let's Encrypt to issue a real free
certificate:
```bash
nano /etc/nginx/sites-available/rms-panel
# change: server_name _;
# to:     server_name YOUR_VPS_IP.sslip.io;
nginx -t && systemctl reload nginx

apt install -y certbot python3-certbot-nginx
certbot --nginx -d YOUR_VPS_IP.sslip.io
# choose "redirect HTTP to HTTPS" when asked
```
Your panel is now at `https://YOUR_VPS_IP.sslip.io` with a trusted padlock,
auto-renewing via `certbot.timer` — no purchased domain required.

### 8. Point the frontend at your API — no longer needed
`frontend/js/app.js` now uses `const API_BASE = "/api";`, a same-origin
relative path. It automatically follows whatever host/protocol the page
was loaded with, so nothing to edit here regardless of domain, IP, or
HTTP vs HTTPS.

---

## Testing the strict expiry behavior

Quick way to verify it works before trusting it in production:
1. Create a VPN user with duration = 1 minute
2. Watch the VPN Users page — it'll show "expiring soon" almost immediately
3. Within ~30-60 seconds it should vanish from the list automatically
4. Check the Logs tab — you should see an `Auto-expired & removed` entry
5. On the VPS itself, confirm the Linux user is really gone: `id <username>` should say "no such user"

## Managing multiple super admins

1. Log in as your original super admin (the one from `.env`)
2. Go to **Super Admins** in the sidebar → **+ New Super Admin**
3. Give the new person their username/password directly (there's no
   self-signup — only existing super admins can create new ones)
4. If you ever need to revoke someone's access, hit **Suspend** next to
   their name. The system will block this if they're the only active
   super admin left.

## Notes

- The expiry checker uses the database's own clock (`NOW()`) compared
  against `expires_at`, so as long as your VPS's system time is correct
  (check with `timedatectl`), enforcement is accurate to within 30 seconds.
- If you also want Hysteria2 accounts to go through the same strict
  auto-expiry (editing `/etc/hysteria/config.yaml` instead of `userdel`),
  that's a small addition to `udp-api-wrapper.sh` — let me know when you're
  ready and we'll wire it in.
