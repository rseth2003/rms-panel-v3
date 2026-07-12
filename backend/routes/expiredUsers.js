const express = require('express');
const pool = require('../config/db');
const logAction = require('../utils/logAction');
const { runWrapper } = require('../utils/shellWrapper');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();

function toSeconds(duration_type, duration_value) {
  const val = parseInt(duration_value, 10);
  if (!val || val <= 0) return null;
  switch (duration_type) {
    case 'minutes': return val * 60;
    case 'hours': return val * 3600;
    case 'days': return val * 86400;
    default: return null;
  }
}

// True if `user` is allowed to manage an expired_vpn_user owned by ownerId.
async function isInManagementScope(user, ownerId) {
  if (user.role === 'super_admin') return true;
  if (user.role === 'reseller') return ownerId === user.id;
  if (user.role === 'admin') {
    if (ownerId === user.id) return true;
    const [rows] = await pool.query(
      `SELECT id FROM accounts WHERE id = ? AND parent_id = ? AND role = 'reseller'`,
      [ownerId, user.id]
    );
    return rows.length > 0;
  }
  return false;
}

// List expired (archived) users - super admin sees all, admin sees only
// their own + their resellers', reseller sees only their own
router.get('/', authRequired, requireRole('super_admin', 'admin', 'reseller'), async (req, res) => {
  let query = `
    SELECT e.*, a.username AS owner_username
    FROM expired_vpn_users e
    JOIN accounts a ON a.id = e.owner_id
  `;
  const params = [];
  if (req.user.role === 'reseller') {
    query += ' WHERE e.owner_id = ?';
    params.push(req.user.id);
  } else if (req.user.role === 'admin') {
    query += ` WHERE e.owner_id = ? OR e.owner_id IN (
      SELECT id FROM accounts WHERE parent_id = ? AND role = 'reseller'
    )`;
    params.push(req.user.id, req.user.id);
  }
  query += ' ORDER BY e.expired_at DESC';

  const [rows] = await pool.query(query, params);
  res.json(rows);
});

// Renew (recreate) an expired user - same credit/limit rules as a fresh create
router.post('/:id/renew', authRequired, requireRole('super_admin', 'admin', 'reseller'), async (req, res) => {
  const { id } = req.params;
  const { duration_type, duration_value } = req.body;
  const durationSeconds = toSeconds(duration_type, duration_value);
  if (!durationSeconds) {
    return res.status(400).json({ error: 'Provide a valid duration_type (minutes/hours/days) and duration_value' });
  }

  const [rows] = await pool.query('SELECT * FROM expired_vpn_users WHERE id = ?', [id]);
  const expiredUser = rows[0];
  if (!expiredUser) return res.status(404).json({ error: 'Expired user record not found' });
  if (!(await isInManagementScope(req.user, expiredUser.owner_id))) {
    return res.status(403).json({ error: 'Not your account to renew' });
  }

  // If a username with the same name was already recreated by someone else
  // in the meantime, don't silently collide.
  const [dupe] = await pool.query('SELECT id FROM vpn_users WHERE username = ?', [expiredUser.username]);
  if (dupe.length) {
    return res.status(409).json({ error: 'A VPN user with this username already exists - it may have already been renewed' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (req.user.role === 'reseller') {
      const [acct] = await conn.query('SELECT credits FROM accounts WHERE id = ? FOR UPDATE', [req.user.id]);
      if (acct[0].credits < 1) {
        await conn.rollback();
        return res.status(402).json({ error: 'Insufficient credits' });
      }
      await conn.query('UPDATE accounts SET credits = credits - 1 WHERE id = ?', [req.user.id]);
      await conn.query(
        'INSERT INTO credit_transactions (account_id, amount, reason) VALUES (?, -1, ?)',
        [req.user.id, `Renewed expired VPN user: ${expiredUser.username}`]
      );
    }

    const expiresAt = Math.floor(Date.now() / 1000) + durationSeconds;

    // The system account is gone - this is a fresh 'add', not a 'renew'
    await runWrapper('add', [
      expiredUser.username,
      expiredUser.password,
      String(expiredUser.connection_limit),
      String(expiresAt)
    ]);

    const [result] = await conn.query(
      `INSERT INTO vpn_users (owner_id, service_type, username, password, connection_limit, expires_at)
       VALUES (?, ?, ?, ?, ?, FROM_UNIXTIME(?))`,
      [expiredUser.owner_id, expiredUser.service_type, expiredUser.username, expiredUser.password, expiredUser.connection_limit, expiresAt]
    );

    await conn.query('DELETE FROM expired_vpn_users WHERE id = ?', [id]);

    await conn.commit();
    await logAction(req.user.id, 'renew_expired_vpn_user', expiredUser.username,
      `Recreated for ${duration_value} ${duration_type}`, req.ip);

    res.status(201).json({ id: result.insertId, username: expiredUser.username, expires_at: expiresAt });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: 'Failed to renew expired user', details: err.message });
  } finally {
    conn.release();
  }
});

// Permanently discard an archived expired-user record (no recreation)
router.delete('/:id', authRequired, requireRole('super_admin', 'admin', 'reseller'), async (req, res) => {
  const { id } = req.params;
  const [rows] = await pool.query('SELECT * FROM expired_vpn_users WHERE id = ?', [id]);
  const expiredUser = rows[0];
  if (!expiredUser) return res.status(404).json({ error: 'Expired user record not found' });
  if (!(await isInManagementScope(req.user, expiredUser.owner_id))) {
    return res.status(403).json({ error: 'Not your record to remove' });
  }

  await pool.query('DELETE FROM expired_vpn_users WHERE id = ?', [id]);
  await logAction(req.user.id, 'purge_expired_vpn_user', expiredUser.username, null, req.ip);

  res.json({ success: true });
});

module.exports = router;
