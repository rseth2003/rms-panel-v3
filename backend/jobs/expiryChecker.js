const cron = require('node-cron');
const pool = require('../config/db');
const { runWrapper } = require('../utils/shellWrapper');
const logAction = require('../utils/logAction');

// Runs every 30 seconds. For each expired user:
//   1. Kick that user's active sessions and delete their system account -
//      scoped to only that one username (pkill -u + userdel), so every
//      other currently-connected user is left completely undisturbed.
//   2. Archive their details into expired_vpn_users so a super admin,
//      admin, or reseller can quickly renew (recreate) them later.
//   3. Log it, attributed to whoever owns that user.
async function enforceExpiry() {
  let expiredUsers;
  try {
    const [rows] = await pool.query(
      `SELECT * FROM vpn_users WHERE expires_at <= NOW() AND status != 'blocked'`
    );
    expiredUsers = rows;
  } catch (err) {
    console.error('[expiry-checker] Failed to query expired users:', err.message);
    return;
  }

  for (const user of expiredUsers) {
    try {
      // Only this user is kicked/removed - no service restart, so nobody
      // else's active connection is affected.
      await runWrapper('expire', [user.username]);
    } catch (err) {
      console.error(`[expiry-checker] Failed to remove system user ${user.username}:`, err.message);
      // Continue anyway - still archive and log so the panel stays accurate
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `INSERT INTO expired_vpn_users (owner_id, service_type, username, password, connection_limit)
         VALUES (?, ?, ?, ?, ?)`,
        [user.owner_id, user.service_type, user.username, user.password, user.connection_limit]
      );
      await conn.query('DELETE FROM vpn_users WHERE id = ?', [user.id]);
      await conn.commit();

      await logAction(
        user.owner_id,
        'auto_expired_deleted',
        user.username,
        'Expiry reached - user was automatically disconnected and deleted. Available in Expired Users for renewal.',
        null
      );
      console.log(`[expiry-checker] Expired and archived: ${user.username}`);
    } catch (err) {
      await conn.rollback();
      console.error(`[expiry-checker] Failed to archive/clean up DB record for ${user.username}:`, err.message);
    } finally {
      conn.release();
    }
  }
}

function startExpiryChecker() {
  // Every 30 seconds - strict enforcement without hammering the VPS
  cron.schedule('*/30 * * * * *', enforceExpiry);
  console.log('[expiry-checker] Strict expiry enforcement started (checking every 30s, per-user only - no service restarts)');
}

module.exports = { startExpiryChecker, enforceExpiry };
