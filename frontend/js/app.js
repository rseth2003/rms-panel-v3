// ============ CONFIG ============
// Same-origin relative path — Nginx proxies /api/ to the backend on port 3000
const API_BASE = "/api";

// ============ AUTO-LOGOUT ON BROWSER CLOSE / TAB CLOSE ============
// Uses sessionStorage flag: if user opened a new tab, flag persists; on fresh close it doesn't
window.addEventListener('beforeunload', () => {
  // Use sendBeacon so the request fires even as page unloads
  const token = localStorage.getItem('rms_token');
  if (token) {
    navigator.sendBeacon(`${API_BASE}/auth/logout`, JSON.stringify({ token }));
    clearSession();
  }
});

// Also handle visibility change (tab hidden / browser minimized counts as leaving)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    const token = localStorage.getItem('rms_token');
    if (token) {
      navigator.sendBeacon(`${API_BASE}/auth/logout`, JSON.stringify({ token }));
      clearSession();
    }
  }
});

// ============ AUTH STATE ============
function getToken() { return localStorage.getItem('rms_token'); }
function getUser() {
  const raw = localStorage.getItem('rms_user');
  return raw ? JSON.parse(raw) : null;
}
function setSession(token, user) {
  localStorage.setItem('rms_token', token);
  localStorage.setItem('rms_user', JSON.stringify(user));
}
function clearSession() {
  localStorage.removeItem('rms_token');
  localStorage.removeItem('rms_user');
}

// Call at the top of every protected page
function requireAuth() {
  if (!getToken()) {
    window.location.href = 'login.html';
    return null;
  }
  return getUser();
}

async function logout() {
  try {
    await apiFetch('/auth/logout', { method: 'POST' });
  } catch (err) {
    // Even if this fails (e.g. session already invalid), still clear locally
  }
  clearSession();
  window.location.href = 'login.html';
}

// ============ API HELPER ============
async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getToken()}`,
      ...(options.headers || {})
    }
  });
  if (res.status === 401) {
    clearSession();
    window.location.href = 'login.html';
    throw new Error('Session expired');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ============ SIDEBAR ============
function renderSidebar(activePage) {
  const user = getUser();
  if (!user) return;

  const isSuperAdmin = user.role === 'super_admin';
  const isAdminOrAbove = user.role === 'super_admin' || user.role === 'admin';
  const el = document.getElementById('sidebar');
  if (!el) return;

  el.innerHTML = `
    <div class="sidebar-logo">RMS Panel<span>UDP Custom Manager</span></div>
    <a class="nav-link ${activePage === 'home' ? 'active' : ''}" href="home.html">
      <span class="label">Home</span>
    </a>
    <a class="nav-link ${activePage === 'vpn-users' ? 'active' : ''}" href="vpn-users.html">
      <span class="label">VPN Users</span>
    </a>
    <a class="nav-link ${activePage === 'expired-users' ? 'active' : ''}" href="expired-users.html">
      <span class="label">Expired Users</span>
    </a>
    <a class="nav-link ${activePage === 'statistics' ? 'active' : ''}" href="statistics.html">
      <span class="label">Statistics</span>
    </a>
    <a class="nav-link ${!isAdminOrAbove ? 'hidden' : ''} ${activePage === 'resellers' ? 'active' : ''}" href="resellers.html">
      <span class="label">Resellers</span>
    </a>
    <a class="nav-link ${!isSuperAdmin ? 'hidden' : ''} ${activePage === 'admins' ? 'active' : ''}" href="admins.html">
      <span class="label">Admins</span>
    </a>
    <a class="nav-link ${!isSuperAdmin ? 'hidden' : ''} ${activePage === 'server-config' ? 'active' : ''}" href="server-config.html">
      <span class="label">Server Config</span>
    </a>
    <a class="nav-link ${activePage === 'logs' ? 'active' : ''}" href="logs.html">
      <span class="label">Logs</span>
    </a>
    <div class="sidebar-footer">
      <button class="btn btn-ghost btn-sm" onclick="logout()">Logout</button>
      <div class="copyright-note">© 2026 RMS</div>
    </div>
  `;
}

// Simple generic "blank human" avatar - no upload/storage, just a
// placeholder silhouette so every role has a tappable profile entry point.
function avatarSvg(size) {
  const s = size || 32;
  return `
    <svg width="${s}" height="${s}" viewBox="0 0 40 40" class="avatar-icon">
      <circle cx="20" cy="20" r="20" fill="var(--bg-elevated)" stroke="var(--border)"/>
      <circle cx="20" cy="15.5" r="6.5" fill="var(--text-dim)"/>
      <path d="M6 34c1.5-8 8-11.5 14-11.5S38.5 26 34 34z" fill="var(--text-dim)"/>
    </svg>
  `;
}

function renderTopbar(title) {
  const user = getUser();
  if (!user) return;
  const el = document.getElementById('topbar');
  if (!el) return;

  el.innerHTML = `
    <div style="display:flex; align-items:center; gap:12px;">
      <button class="hamburger-btn" onclick="toggleSidebar()" aria-label="Open menu">
        <span></span><span></span><span></span>
      </button>
      <div class="topbar-title">${title}</div>
    </div>
    <div class="topbar-user">
      ${user.role === 'reseller' ? `<span id="creditsDisplay">Credits: ${user.credits}</span>` : ''}
      <span class="badge">${user.role.replace('_', ' ')}</span>
      <a href="profile.html" class="profile-link" title="View / edit your profile">
        ${avatarSvg(30)}
        <span>Hello, ${user.username}</span>
      </a>
    </div>
  `;

  // Backdrop for the mobile slide-out sidebar (created once, reused across pages)
  if (!document.getElementById('sidebarBackdrop')) {
    const backdrop = document.createElement('div');
    backdrop.id = 'sidebarBackdrop';
    backdrop.className = 'sidebar-backdrop';
    backdrop.onclick = () => closeSidebar();
    document.body.appendChild(backdrop);
  }
}

function toggleSidebar() {
  document.body.classList.toggle('sidebar-open');
}

function closeSidebar() {
  document.body.classList.remove('sidebar-open');
}

async function refreshCreditsDisplay() {
  try {
    const me = await apiFetch('/auth/me');
    const user = getUser();
    user.credits = me.credits;
    setSession(getToken(), user);
    const el = document.getElementById('creditsDisplay');
    if (el) el.textContent = `Credits: ${me.credits}`;
  } catch (err) { /* ignore */ }
}

// ============ SHARED FORMATTERS ============
function formatDate(dateStr) {
  return new Date(dateStr).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

function statusPillClass(status) {
  if (status === 'active') return 'pill-active';
  if (status === 'blocked' || status === 'suspended') return 'pill-blocked';
  return '';
}

function isExpiringSoon(expiresAt) {
  const diff = new Date(expiresAt).getTime() - Date.now();
  return diff > 0 && diff < 3600 * 1000; // less than 1 hour left
}

// ============ CONNECTION STRING / CONFIG BUILDER ============
// Matches the ip:port@user:pass format used by HTTP Custom / similar apps
function buildConnectionString(serverConfig, vpnUser) {
  return `${serverConfig.host}:${serverConfig.port_range}@${vpnUser.username}:${vpnUser.password}`;
}

function buildFullConfigText(serverConfig, vpnUser) {
  return `Server: ${serverConfig.host}
Port: ${serverConfig.port_range}
Username: ${vpnUser.username}
Password: ${vpnUser.password}
Connection String: ${buildConnectionString(serverConfig, vpnUser)}
Type: UDP Custom
Device Limit: ${vpnUser.connection_limit}
Expires: ${formatDate(vpnUser.expires_at)}`;
}

async function copyToClipboard(text, labelForAlert) {
  try {
    await navigator.clipboard.writeText(text);
    if (labelForAlert) showToast(`${labelForAlert} copied to clipboard`);
  } catch (err) {
    // Fallback for browsers/contexts where clipboard API is blocked
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    if (labelForAlert) showToast(`${labelForAlert} copied to clipboard`);
  }
}

function showToast(message) {
  let toast = document.getElementById('rmsToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'rmsToast';
    toast.style.cssText = `
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: #1e2740; color: #e5e9f5; padding: 10px 20px; border-radius: 8px;
      border: 1px solid #2a3450; font-size: 0.85rem; z-index: 9999; box-shadow: 0 4px 16px rgba(0,0,0,0.35);
      opacity: 0; transition: opacity 0.2s ease;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.opacity = '1';
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => { toast.style.opacity = '0'; }, 2000);
}

// ============ RANDOM USERNAME/PASSWORD GENERATORS ============
// Stays within the script's own rules: username 3-12 chars (letters/numbers/
// underscore), password minimum 3 chars (generated a bit longer for safety).
function generateRandomUsername() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const length = 8; // comfortably within the 3-12 char limit
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateRandomPassword() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  const length = 8;
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
