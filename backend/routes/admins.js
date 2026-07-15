const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const logAction = require('../utils/logAction');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();

// List all admin-tier accounts (both 'admin' and 'super_admin') - super admin only
router.get('/', authRequired, requireRole('super_admin'), async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, username, role, status, created_at
     FROM accounts WHERE role IN ('super_admin','admin')
     ORDER BY role = 'super_admin' DESC, created_at ASC`
  );
  res.json(rows);
});

// Create a new admin-tier account - only a super admin can do this,
// and only a super admin chooses whether the new account is 'admin' or 'super_admin'
router.post('/', authRequired, requireRole('super_admin'), async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password || !role) {
    return res.status(400).json({ error: 'Username, password, and role are required' });
  }
  if (!['admin', 'super_admin'].includes(role)) {
    return res.status(400).json({ error: 'Role must be either "admin" or "super_admin"' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const [existing] = await pool.query('SELECT id FROM accounts WHERE username = ?', [username]);
  if (existing.length) {
    return res.status(409).json({ error: 'Username already exists' });
  }

  const hash = await bcrypt.hash(password, 10);
  const [result] = await pool.query(
    'INSERT INTO accounts (username, password_hash, role, credits, status) VALUES (?, ?, ?, 0, "active")',
    [username, hash, role]
  );

  await logAction(req.user.id, 'create_admin_account', username, `Role: ${role}`, req.ip);
  res.status(201).json({ id: result.insertId, username, role, status: 'active' });
});

// Suspend / reactivate an admin-tier account - blocked if it would leave zero active super admins
router.put('/:id/status', authRequired, requireRole('super_admin'), async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!['active', 'suspended'].includes(status)) {
    return res.status(400).json({ error: 'Status must be active or suspended' });
  }

  const [rows] = await pool.query(
    `SELECT * FROM accounts WHERE id = ? AND role IN ('super_admin','admin')`, [id]
  );
  const target = rows[0];
  if (!target) return res.status(404).json({ error: 'Account not found' });

  if (status === 'suspended' && target.role === 'super_admin') {
    const [activeAdmins] = await pool.query(
      `SELECT COUNT(*) AS count FROM accounts WHERE role = 'super_admin' AND status = 'active' AND id != ?`,
      [id]
    );
    if (activeAdmins[0].count === 0) {
      return res.status(400).json({ error: 'Cannot suspend the last active super admin - create or reactivate another one first' });
    }
  }

  await pool.query('UPDATE accounts SET status = ? WHERE id = ?', [status, id]);
  await logAction(req.user.id, 'update_admin_account_status', target.username, `Role: ${target.role}, New status: ${status}`, req.ip);

  res.json({ id, status });
});

// Delete an admin and their entire network (resellers + VPN users)
router.delete('/:id', authRequired, requireRole('super_admin'), async (req, res) => {
  const { id } = req.params;

  const [rows] = await pool.query(
    `SELECT * FROM accounts WHERE id = ? AND role IN ('super_admin','admin')`, [id]
  );
  const target = rows[0];
  if (!target) return res.status(404).json({ error: 'Account not found' });

  // Prevent deleting the last active super admin
  if (target.role === 'super_admin') {
    const [activeAdmins] = await pool.query(
      `SELECT COUNT(*) AS count FROM accounts WHERE role = 'super_admin' AND status = 'active' AND id != ?`, [id]
    );
    if (activeAdmins[0].count === 0) {
      return res.status(400).json({ error: 'Cannot delete the last active super admin' });
    }
  }

  // Get all resellers under this admin
  const [resellers] = await pool.query('SELECT id, username FROM accounts WHERE parent_id = ? AND role = "reseller"', [id]);
  const { execSync } = require('child_process');

  for (const reseller of resellers) {
    // Get and delete all VPN users under each reseller
    const [vpnUsers] = await pool.query('SELECT username FROM vpn_users WHERE owner_id = ?', [reseller.id]);
    for (const u of vpnUsers) {
      try {
        execSync(`pkill -u ${u.username} 2>/dev/null; userdel --force ${u.username} 2>/dev/null; rm -f /etc/rms-users/${u.username}.expiry`, { stdio: 'ignore' });
      } catch {}
    }
    await pool.query('DELETE FROM vpn_users WHERE owner_id = ?', [reseller.id]);
    await pool.query('DELETE FROM expired_users WHERE owner_id = ?', [reseller.id]);
    await pool.query('DELETE FROM logs WHERE actor_id = ?', [reseller.id]);
    await pool.query('DELETE FROM credit_transactions WHERE account_id = ?', [reseller.id]);
    await pool.query('DELETE FROM accounts WHERE id = ?', [reseller.id]);
  }

  // Delete the admin's own data
  await pool.query('DELETE FROM logs WHERE actor_id = ?', [id]);
  await pool.query('DELETE FROM accounts WHERE id = ?', [id]);

  await logAction(req.user.id, 'delete_admin', target.username, `Deleted ${target.role} and ${resellers.length} resellers + their networks`, req.ip);
  res.json({ success: true, message: `${target.role} ${target.username} and entire network deleted` });
});

module.exports = router;
