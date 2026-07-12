const express = require('express');
const pool = require('../config/db');
const logAction = require('../utils/logAction');
const { runWrapper } = require('../utils/shellWrapper');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();

// Converts { duration_type: 'minutes'|'hours'|'days', duration_value: n } into seconds
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

// Resellers can never issue/renew a VPN user for longer than this
const RESELLER_MAX_DURATION_SECONDS = 30 * 86400; // 30 days

// True if `user` is allowed to manage a vpn_user/expired_vpn_user owned by ownerId.
// super_admin: always. reseller: only their own. admin: themselves + their own resellers.
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

// Matches the original script's exact validation rules (new_user function)
function validateUsername(username) {
  if (!username) return 'Username required';
  if (username.length < 3) return 'Username must be at least 3 characters';
  if (username.length > 12) return 'Username must be at most 12 characters';
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return 'Username can only contain letters, numbers, and underscores';
  return null;
}

function validatePassword(password) {
  if (!password) return 'Password required';
  if (password.length < 3) return 'Password must be at least 3 characters';
  return null;
}

// List vpn users - super admin sees all, admin sees only their own +
// the resellers they created, reseller sees only their own.
//
// Drill-down support (super_admin, and admin within their own scope):
//   ?owner_id=X    -> just that one owner's users (e.g. tap a reseller)
//   ?network_of=X  -> that admin's own users + all their resellers' users
//                     (super_admin only - e.g. tap an admin to see their whole network)
router.get('/', authRequired, requireRole('super_admin', 'admin', 'reseller'), async (req, res) => {
  let query = 'SELECT v.*, a.username AS owner_username FROM vpn_users v JOIN accounts a ON a.id = v.owner_id';
  const params = [];
  const { owner_id, network_of } = req.query;

  if (req.user.role === 'reseller') {
    query += ' WHERE v.owner_id = ?';
    params.push(req.user.id);
  } else if (network_of) {
    if (req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only a super admin can view another admin\'s full network' });
    }
    query += ` WHERE v.owner_id = ? OR v.owner_id IN (
      SELECT id FROM accounts WHERE parent_id = ? AND role = 'reseller'
    )`;
    params.push(network_of, network_of);
  } else if (owner_id) {
    if (req.user.role === 'admin' && !(await isInManagementScope(req.user, parseInt(owner_id, 10)))) {
      return res.status(403).json({ error: 'That account is outside your network' });
    }
    query += ' WHERE v.owner_id = ?';
    params.push(owner_id);
  } else if (req.user.role === 'admin') {
    query += ` WHERE v.owner_id = ? OR v.owner_id IN (
      SELECT id FROM accounts WHERE parent_id = ? AND role = 'reseller'
    )`;
    params.push(req.user.id, req.user.id);
  }
  query += ' ORDER BY v.created_at DESC';

  const [rows] = await pool.query(query, params);
  res.json(rows);
});

// Create a vpn user - deducts 1 credit if caller is a reseller
router.post('/', authRequired, requireRole('super_admin', 'admin', 'reseller'), async (req, res) => {
  const { username, password, duration_type, duration_value, service_type } = req.body;
  let { connection_limit } = req.body;

  const usernameError = validateUsername(username);
  if (usernameError) return res.status(400).json({ error: usernameError });

  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).json({ error: passwordError });

  const durationSeconds = toSeconds(duration_type, duration_value);
  if (!durationSeconds) {
    return res.status(400).json({ error: 'Provide a valid duration_type (minutes/hours/days) and duration_value' });
  }

  if (req.user.role === 'reseller' && durationSeconds > RESELLER_MAX_DURATION_SECONDS) {
    return res.status(403).json({ error: 'Resellers cannot create a VPN user for more than 30 days' });
  }

  // Resellers can only ever create single-device users.
  // Only a super admin or admin is allowed to set a higher connection limit.
  if (req.user.role === 'reseller') {
    connection_limit = 1;
  } else {
    connection_limit = parseInt(connection_limit, 10) || 1;
  }
  if (connection_limit < 1 || !Number.isInteger(connection_limit)) {
    return res.status(400).json({ error: 'Connection limit must be a whole number of 1 or more' });
  }

  // Matches the original script's own duplicate check (show_users | grep)
  const [dupe] = await pool.query('SELECT id FROM vpn_users WHERE username = ?', [username]);
  if (dupe.length) {
    return res.status(409).json({ error: 'A VPN user with this username already exists' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (req.user.role === 'reseller') {
      const [rows] = await conn.query('SELECT credits FROM accounts WHERE id = ? FOR UPDATE', [req.user.id]);
      if (rows[0].credits < 1) {
        await conn.rollback();
        return res.status(402).json({ error: 'Insufficient credits' });
      }
      await conn.query('UPDATE accounts SET credits = credits - 1 WHERE id = ?', [req.user.id]);
      await conn.query(
        'INSERT INTO credit_transactions (account_id, amount, reason) VALUES (?, -1, ?)',
        [req.user.id, `Created VPN user: ${username}`]
      );
    }

    const expiresAt = Math.floor(Date.now() / 1000) + durationSeconds;

    await runWrapper('add', [
      username,
      password,
      String(connection_limit || 1),
      String(expiresAt)
    ]);

    const [result] = await conn.query(
      `INSERT INTO vpn_users (owner_id, service_type, username, password, connection_limit, expires_at)
       VALUES (?, ?, ?, ?, ?, FROM_UNIXTIME(?))`,
      [req.user.id, service_type || 'udp_custom', username, password, connection_limit || 1, expiresAt]
    );

    await conn.commit();
    await logAction(req.user.id, 'create_vpn_user', username,
      `Limit: ${connection_limit || 1}, Duration: ${duration_value} ${duration_type}`, req.ip);

    res.status(201).json({ id: result.insertId, username, expires_at: expiresAt });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: 'Failed to create VPN user', details: err.message });
  } finally {
    conn.release();
  }
});

// Renew a vpn user - deducts 1 credit if caller is a reseller
router.put('/:id/renew', authRequired, requireRole('super_admin', 'admin', 'reseller'), async (req, res) => {
  const { id } = req.params;
  const { duration_type, duration_value } = req.body;
  const durationSeconds = toSeconds(duration_type, duration_value);
  if (!durationSeconds) {
    return res.status(400).json({ error: 'Provide a valid duration_type (minutes/hours/days) and duration_value' });
  }

  if (req.user.role === 'reseller' && durationSeconds > RESELLER_MAX_DURATION_SECONDS) {
    return res.status(403).json({ error: 'Resellers cannot renew a VPN user for more than 30 days' });
  }

  const [rows] = await pool.query('SELECT * FROM vpn_users WHERE id = ?', [id]);
  const vpnUser = rows[0];
  if (!vpnUser) return res.status(404).json({ error: 'VPN user not found' });
  if (!(await isInManagementScope(req.user, vpnUser.owner_id))) {
    return res.status(403).json({ error: 'Not your account to manage' });
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
        [req.user.id, `Renewed VPN user: ${vpnUser.username}`]
      );
    }

    // Renewing always extends from "now", not from old expiry - matches strict re-issue behavior
    const newExpiry = Math.floor(Date.now() / 1000) + durationSeconds;
    await runWrapper('renew', [vpnUser.username, String(newExpiry)]);

    await conn.query(
      'UPDATE vpn_users SET expires_at = FROM_UNIXTIME(?), status = "active" WHERE id = ?',
      [newExpiry, id]
    );

    await conn.commit();
    await logAction(req.user.id, 'renew_vpn_user', vpnUser.username,
      `Extended by ${duration_value} ${duration_type}`, req.ip);
    res.json({ id, expires_at: newExpiry });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: 'Failed to renew VPN user', details: err.message });
  } finally {
    conn.release();
  }
});

// Block / unblock a vpn user
router.put('/:id/block', authRequired, requireRole('super_admin', 'admin', 'reseller'), async (req, res) => {
  const { id } = req.params;
  const [rows] = await pool.query('SELECT * FROM vpn_users WHERE id = ?', [id]);
  const vpnUser = rows[0];
  if (!vpnUser) return res.status(404).json({ error: 'VPN user not found' });
  if (!(await isInManagementScope(req.user, vpnUser.owner_id))) {
    return res.status(403).json({ error: 'Not your account to manage' });
  }

  const newStatus = vpnUser.status === 'blocked' ? 'active' : 'blocked';
  await runWrapper('block', [vpnUser.username, newStatus]);
  await pool.query('UPDATE vpn_users SET status = ? WHERE id = ?', [newStatus, id]);
  await logAction(req.user.id, 'toggle_block_vpn_user', vpnUser.username, `New status: ${newStatus}`, req.ip);

  res.json({ id, status: newStatus });
});

// Delete a vpn user
router.delete('/:id', authRequired, requireRole('super_admin', 'admin', 'reseller'), async (req, res) => {
  const { id } = req.params;
  const [rows] = await pool.query('SELECT * FROM vpn_users WHERE id = ?', [id]);
  const vpnUser = rows[0];
  if (!vpnUser) return res.status(404).json({ error: 'VPN user not found' });
  if (!(await isInManagementScope(req.user, vpnUser.owner_id))) {
    return res.status(403).json({ error: 'Not your account to manage' });
  }

  await runWrapper('delete', [vpnUser.username]);
  await pool.query('DELETE FROM vpn_users WHERE id = ?', [id]);
  await logAction(req.user.id, 'delete_vpn_user', vpnUser.username, 'Manually deleted', req.ip);

  res.json({ success: true });
});

module.exports = router;
