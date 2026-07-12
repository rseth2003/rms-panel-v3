const cron = require('node-cron');
const pool = require('../config/db');
const { runWrapper } = require('../utils/shellWrapper');
const logAction = require('../utils/logAction');

// Parses `ps -eo user= | sort | uniq -c` output into a Map of username -> count
function parseSessionCounts(output) {
  const counts = new Map();
  output.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const match = trimmed.match(/^(\d+)\s+(\S+)$/);
    if (match) {
      counts.set(match[2], parseInt(match[1], 10));
    }
  });
  return counts;
}

// Runs every 20 seconds. For every active VPN user, checks whether their
// current active session count exceeds their allowed connection_limit
// (this is what forces resellers' 1-device users to actually stay at 1
// device, rather than just trusting the closed-source module to enforce
// it). If exceeded, ALL of that user's sessions are disconnected at once -
// they simply reconnect with only one device active.
//
// IMPORTANT CAVEAT: this relies on UDP Custom spawning one process per
// connected session under that Linux username. If it instead multiplexes
// every connection through a single shared process regardless of device
// count, this watchdog has no way to tell devices apart and won't be able
// to enforce anything - the process count will always read as 1
// regardless of how many devices are actually connected.
async function enforceDeviceLimits() {
  let activeUsers;
  try {
    const [rows] = await pool.query(
      `SELECT * FROM vpn_users WHERE status = 'active'`
    );
    activeUsers = rows;
  } catch (err) {
    console.error('[device-limit-watchdog] Failed to query active users:', err.message);
    return;
  }

  if (!activeUsers.length) return;

  let sessionCounts;
  try {
    const output = await runWrapper('list_session_counts', []);
    sessionCounts = parseSessionCounts(output);
  } catch (err) {
    console.error('[device-limit-watchdog] Failed to read session counts:', err.message);
    return;
  }

  for (const user of activeUsers) {
    const activeSessions = sessionCounts.get(user.username) || 0;
    if (activeSessions > user.connection_limit) {
      try {
        await runWrapper('kick_user', [user.username]);
        await logAction(
          user.owner_id,
          'device_limit_enforced',
          user.username,
          `${activeSessions} active sessions exceeded their limit of ${user.connection_limit} - all sessions disconnected, user must reconnect within their limit`,
          null
        );
        console.log(`[device-limit-watchdog] Kicked ${user.username}: ${activeSessions} sessions > limit ${user.connection_limit}`);
      } catch (err) {
        console.error(`[device-limit-watchdog] Failed to kick ${user.username}:`, err.message);
      }
    }
  }
}

function startDeviceLimitWatchdog() {
  cron.schedule('*/20 * * * * *', enforceDeviceLimits);
  console.log('[device-limit-watchdog] Device limit enforcement started (checking every 20s)');
}

module.exports = { startDeviceLimitWatchdog, enforceDeviceLimits };
