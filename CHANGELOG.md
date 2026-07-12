# RMS Panel — Deployment & Changes Log

VPS: 185.237.96.54 (Ubuntu 24.04, Kamatera)
Public URL: https://185.237.96.54.sslip.io

## Panel feature changes

- Added a hard 30-day cap on VPN user duration for the `reseller` role, enforced
  in both `POST /vpn-users` (create) and `PUT /vpn-users/:id/renew`. Super admins
  and admins are unaffected. Client-side hint + guard added in
  `create-vpn-user.html` for UX; server-side check is the real enforcement.
  Files: `backend/routes/vpnUsers.js`, `frontend/create-vpn-user.html`

## Bugs found and fixed during deployment

- `frontend/js/app.js`: `API_BASE` was left as an unfilled placeholder
  (`http://YOUR_VPS_IP_OR_DOMAIN:3000/api`), causing every API call to fail
  with a NetworkError. Changed to a same-origin relative path (`/api`) so it
  works through the Nginx reverse proxy regardless of hostname/protocol.

- `frontend/css/style.css`: the mobile breakpoint (`@media max-width:720px`)
  shrank the sidebar to a 68px icon-only strip and hid the nav-link text
  labels — but the nav links were never built with icons, only text, so
  mobile users saw a blank sidebar with nothing clickable.
  Fix: implemented a proper hamburger-menu + slide-out drawer for mobile
  that reuses the exact desktop sidebar markup/styling (see below), instead
  of trying to compress it.

- Tables (VPN Users, etc.) had no horizontal-scroll wrapper, so on narrow
  screens columns like Status/Actions ran off-screen with no way to reach
  them. Fixed by adding `overflow-x: auto` to `.card` inside the mobile
  media query.

## Mobile navigation redesign (hamburger + slide-out drawer)

- `frontend/js/app.js` (`renderTopbar`): added a hamburger button
  (`.hamburger-btn`) before the page title, plus `toggleSidebar()` /
  `closeSidebar()` functions that toggle a `sidebar-open` class on
  `<body>`. Also creates a `#sidebarBackdrop` overlay element once per page.
- `frontend/css/style.css`: added `.hamburger-btn` (hidden on desktop,
  shown ≤720px), `.sidebar-backdrop` (dark overlay), and mobile rules that
  position `.sidebar` as a fixed, full-height, off-canvas panel
  (`transform: translateX(-100%)`) that slides in when `body.sidebar-open`
  is set. Sidebar footer (Logout / copyright) stays pinned to the bottom
  via the existing `margin-top: auto` on `.sidebar-footer`, same as desktop.

## Infrastructure setup (Ubuntu 24.04 VPS)

- Node.js 20 (via NodeSource), MySQL 8.0, Nginx installed via apt.
- MySQL database `rms_panel` + dedicated `rms_panel` user, schema loaded
  from `backend/scripts/schema.sql` (already includes the security columns
  from `migrate_security.sql` — that migration script was skipped as
  unnecessary on a fresh install).
- Backend run via systemd unit `rms-panel-api.service`
  (`WorkingDirectory=/etc/rms-panel/rms-panel-v3/backend`), enabled on boot.
- Nginx reverse-proxies `/api/` to `127.0.0.1:3000` and serves
  `frontend/` as static files at `/etc/rms-panel/rms-panel-v3/frontend`.
- UFW enabled: OpenSSH + Nginx Full (80/443) allowed, all else denied by
  default. Port 3000 not exposed externally.
- Free HTTPS via Let's Encrypt/Certbot using the sslip.io wildcard-DNS
  trick (no domain purchased) — hostname `185.237.96.54.sslip.io` resolves
  automatically to the VPS IP, cert auto-renews via `certbot.timer`.

## Outstanding / in progress

- UDP tunnel daemon: the bundled `backend/scripts/udp-api-wrapper.sh` only
  manages Linux system accounts (`useradd`/`usermod -e`/`userdel`) — it does
  **not** install or run an actual tunnel daemon. This VPS had none, so
  test VPN users could not connect. Currently installing the user's own
  RMS-UDP-CUSTOM-MANAGER script (same repo as the existing Singapore VPS
  deployment) to provide the real UDP/SSH tunnel service the panel's
  accounts authenticate against.

## Final update — Drill-Down Navigation (Super Admin → Admin → Reseller)

- **Super Admin can now tap an admin** (on `admins.html`, or the new
  "View Network" button) to open `admin-network.html`: a dedicated page
  showing that admin's stats (reseller count, total users, active/blocked),
  their full list of resellers, and every VPN user across their whole
  network (their own directly-created users + all their resellers').
- **Tapping a reseller from that page (or from `resellers.html` directly)**
  opens `vpn-users.html?owner_id=X&owner_name=Y` — a scoped, read-context
  view of just that reseller's users, with a "Viewing: {name}'s users"
  banner, a Back link, and the "+ New User" button hidden (creating there
  would be attributed to the viewer's account, not the reseller's, so it's
  hidden to avoid that confusion rather than silently mis-attributing it).
- Backend: `GET /vpn-users` gained two optional query params —
  `?owner_id=X` (single owner's users; validated so an admin can only use
  it within their own network) and `?network_of=X` (an admin's own users
  + all their resellers', super_admin only). `GET /resellers` gained
  `?admin_id=X` (super_admin only; lets the network page list just that
  admin's resellers — an admin's own request always stays forced to their
  own ID regardless of this param, so it can't be used to peek at another
  admin's resellers).
- This works symmetrically for viewing another super_admin's own
  directly-created network too, since the same `parent_id`/`owner_id`
  relationships apply regardless of whether the account being viewed is
  `admin` or `super_admin`.

## Final update — Profile Avatar

- Added a simple generic "blank human" avatar (inline SVG silhouette, no
  upload/storage needed) next to "Hello, {username}" in the topbar for
  every role. Tapping it opens `profile.html`, which already had view
  (role, credits, status, member since) and edit (change password)
  functionality — the avatar just makes that entry point visually obvious
  instead of relying on the username text alone. Same avatar shown larger
  at the top of the profile page itself. Shared `avatarSvg(size)` helper
  added to `app.js` so both places stay visually consistent.

## Final update — Role-scoped visibility + Home dashboard

- **Admins no longer see every VPN user / reseller in the system.** Previously
  `admin` accounts could see all VPN users and all resellers system-wide,
  same as `super_admin`. Fixed across four routes to use the existing
  `accounts.parent_id` column (already set to the creating admin's ID when
  a reseller is created — no schema change needed):
  - `GET /vpn-users`: admin now sees only VPN users they created themselves
    plus users created by resellers where `parent_id = admin.id`.
  - `GET /expired-users`: same scoping applied.
  - `GET /statistics`: admin's summary numbers (totalUsers, resellerCount,
    expiredArchived, perOwnerBreakdown) are now scoped to their own network
    instead of the whole system. `super_admin` is unaffected either way.
  - `GET /resellers`: admin now only sees resellers where `parent_id` is
    their own ID, not every reseller under every admin.
  - Added `isInManagementScope(user, ownerId)` helper (in both
    `vpnUsers.js` and `expiredUsers.js`) and applied it to the renew/block/
    delete actions too, so an admin can't act on a VPN user or expired-user
    record outside their own network even by guessing an ID directly —
    previously only resellers had this per-action check, admins had none.
  - `PUT /resellers/:id/credits` and `PUT /resellers/:id/status`: admin can
    now only adjust credits or suspend/reactivate resellers they personally
    created, not any reseller in the system.
  - `super_admin` remains completely unrestricted everywhere, as intended.

- **New Home dashboard** (`frontend/home.html`), now the default landing
  page after login for all three roles (replacing the old direct-to-
  VPN-Users redirect in `login.html`/`index.html`):
  - Reuses the existing `.stat-grid`/`.stat-card` styling from Statistics
    for consistency, plus a new `.home-actions` quick-action card grid
    (new CSS in `style.css`).
  - Role-tailored content, entirely driven by the now-scoped
    `GET /statistics` response:
    - **Reseller**: their credit balance, their VPN user counts
      (total/online/offline), archived count, and quick links to create a
      user / view users / view expired / view their own statistics.
    - **Admin**: their network's totals (their own + their resellers'
      users), their reseller count, a by-owner breakdown table scoped to
      their network, and quick links to create a reseller / create a user /
      manage resellers / view network users / server-scoped statistics.
    - **Super Admin**: full system totals (admins, resellers, users,
      online/offline, expired), a top-8 by-owner breakdown across
      everyone, and quick links to every admin action (create admin,
      create reseller, create VPN user, all resellers, all admins, server
      config, logs).
  - Added "Home" as the first sidebar nav link (`renderSidebar` in
    `app.js`) for all roles.


Root-caused why VPN users created via the panel couldn't connect, even
before the panel existed: this installer's own download step was broken.

- **Broken download domain.** Three `wget` calls used `raw.github.com`,
  which is GitHub's old (2013-deprecated) raw-content domain and does not
  reliably redirect to the correct `raw.githubusercontent.com` — some
  requests silently 404 or return an HTML error page. Combined with `wget -q`
  suppressing errors, this meant `/root/udp/udp-custom` and `/bin/udpgw`
  could end up as empty files or saved HTML instead of real binaries, so
  `udp-custom.service` / `udpgw.service` would fail to start (or crash-loop)
  with no visible warning during install. This is the most likely reason
  the 20 test accounts had nothing to actually connect to.
  Fixed: all three download URLs now point at `raw.githubusercontent.com`
  (confirmed correct by inspecting the upstream http-custom/udp-custom repo
  directly, which has `bin/`, `module/`, and `config/` at that path on `main`).
  Added a post-download check that fails loudly (`file | grep -qi ELF`) if a
  download didn't produce a real executable, instead of continuing silently.

- **`ufw disable` in the installer.** This would have wiped out the SSH +
  Nginx-only firewall configuration already set up on this VPS, exposing
  every port (including anything that might ever bind to 0.0.0.0, e.g.
  MySQL/Node in a misconfiguration) to the internet.
  Fixed: firewall is now left enabled; instead the installer adds a
  targeted `ufw allow 1:65535/udp` (required for this tool's model of
  DNAT-redirecting any inbound UDP port to the real listener on 36712) and
  `ufw allow 36712/udp`. TCP access stays restricted to SSH/80/443 only.

- **Silent hang on `iptables-persistent` install.** The dependency install
  line (`apt install -y ... iptables-persistent`) had its output redirected
  to `/dev/null`, hiding `iptables-persistent`'s interactive "Save current
  IPv4 rules?" debconf prompt — the script appeared frozen at "Installing
  dependencies..." with no indication it was waiting for keyboard input.
  Fixed: added `export DEBIAN_FRONTEND=noninteractive` and
  `-o Dpkg::Options::="--force-confold"` before the install step so apt
  never blocks waiting for a prompt again.

- Confirmed compatible: the panel's `useradd -c "$limit,$password"` GECOS
  field format matches exactly what `udp`'s own limiter/menu script expects
  when parsing `/etc/passwd` field 5 (`cut -d',' -f1` for limit, `-f2` for
  password) — no changes needed there.

- **`iptables-persistent` silently removes `ufw`.** On Ubuntu, the
  `iptables-persistent` package Breaks older `ufw` packages (both try to
  manage netfilter rules/persistence). Because the installer runs
  `apt install -y`, apt auto-resolved that conflict by removing `ufw`
  entirely — no confirmation prompt, no visible warning in the script's
  output. Discovered live: after running the installer on 185.237.96.54,
  `dpkg -l | grep ufw` showed status `rc` (removed, config remains) even
  though ufw had been actively protecting the box seconds before. This is
  a genuine security regression the script would silently cause on any
  server that already had ufw configured.
  Fixed: the installer now snapshots whether ufw was active *before*
  installing `iptables-persistent`, and if it detects ufw got removed as a
  side effect, automatically reinstalls it, re-allows OpenSSH, and
  re-enables it — with an on-screen warning to re-add any other prior
  rules (e.g. `ufw allow 'Nginx Full'`) since the script has no way to know
  what else was allowed before.
  Immediate remediation on 185.237.96.54: `apt install -y ufw`, re-added
  `OpenSSH`, `Nginx Full`, `36712/udp`, and `1:65535/udp`, then re-enabled.

  **Follow-up:** reinstalling `ufw` this way then removed
  `iptables-persistent`/`netfilter-persistent` right back (same conflict,
  reverse direction) — which meant the DNAT port-redirect rule
  (`1:65535 → 36712`, the thing that makes the full UDP port range work)
  would silently NOT survive a reboot, since nothing was left to reapply
  `/etc/iptables/rules.v4` at boot.
  **Real fix:** dropped `iptables-persistent` from `install.sh` entirely.
  The DNAT rule is now written directly into `/etc/ufw/before.rules`
  (its own `*nat`/`COMMIT` block) so `ufw` itself reapplies it on every
  boot — no second package, no conflict, works whether ufw was already
  installed or not. If ufw genuinely isn't present at all, the script
  falls back to a live-only `iptables` rule and prints a clear warning
  that it won't survive a reboot, instead of silently losing it later.
  Live VPS remediated by hand with the equivalent `before.rules` edit,
  then `ufw reload`.


