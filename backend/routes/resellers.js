const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const logAction = require('../utils/logAction');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();

// List resellers - super admin sees all (or filter to one admin's via
// ?admin_id=X for drill-down), admin sees only resellers they created
router.get('/', authRequired, requireRole('super_admin', 'admin'), async (req, res) => {
  let query = `
    SELECT a.id, a.username, a.credits, a.status, a.created_at,
           COUNT(v.id) AS total_vpn_users
    FROM accounts a
    LEFT JOIN vpn_users v ON v.owner_id = a.id
    WHERE a.role = 'reseller'
  `;
  const params = [];
  if (req.user.role === 'admin') {
    query += ' AND a.parent_id = ?';
    params.push(req.user.id);
  } else if (req.query.admin_id) {
    query += ' AND a.parent_id = ?';
    params.push(req.query.admin_id);
  }
  query += ' GROUP BY a.id ORDER BY a.created_at DESC';

  const [rows] = await pool.query(query, params);
  res.json(rows);
});

// Create a new reseller
router.post('/', authRequired, requireRole('super_admin', 'admin'), async (req, res) => {
  const { username, password, credits } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const [existing] = await pool.query('SELECT id FROM accounts WHERE username = ?', [username]);
  if (existing.length) {
    return res.status(409).json({ error: 'Username already exists' });
  }

  const hash = await bcrypt.hash(password, 10);
  const [result] = await pool.query(
    'INSERT INTO accounts (username, password_hash, role, parent_id, credits) VALUES (?, ?, "reseller", ?, ?)',
    [username, hash, req.user.id, credits || 0]
  );

  await logAction(req.user.id, 'create_reseller', username, `Initial credits: ${credits || 0}`, req.ip);
  res.status(201).json({ id: result.insertId, username, credits: credits || 0 });
});

// Adjust a reseller's credits (positive to add, negative to deduct)
router.put('/:id/credits', authRequired, requireRole('super_admin', 'admin'), async (req, res) => {
  const { id } = req.params;
  const { amount, reason } = req.body;
  if (!amount || isNaN(amount)) {
    return res.status(400).json({ error: 'A numeric amount is required' });
  }

  let ownerCheck = 'SELECT * FROM accounts WHERE id = ? AND role = "reseller"';
  const ownerParams = [id];
  if (req.user.role === 'admin') {
    ownerCheck += ' AND parent_id = ?';
    ownerParams.push(req.user.id);
  }
  const [rows] = await pool.query(ownerCheck, ownerParams);
  if (!rows[0]) return res.status(404).json({ error: 'Reseller not found' });

  await pool.query('UPDATE accounts SET credits = credits + ? WHERE id = ?', [amount, id]);
  await pool.query(
    'INSERT INTO credit_transactions (account_id, amount, reason) VALUES (?, ?, ?)',
    [id, amount, reason || null]
  );
  await logAction(req.user.id, 'adjust_credits', rows[0].username, `Amount: ${amount}, Reason: ${reason || 'n/a'}`, req.ip);

  const [updated] = await pool.query('SELECT credits FROM accounts WHERE id = ?', [id]);
  res.json({ id, credits: updated[0].credits });
});

// Suspend / reactivate a reseller
router.put('/:id/status', authRequired, requireRole('super_admin', 'admin'), async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!['active', 'suspended'].includes(status)) {
    return res.status(400).json({ error: 'Status must be active or suspended' });
  }

  let ownerCheck = 'SELECT username FROM accounts WHERE id = ? AND role = "reseller"';
  const ownerParams = [id];
  if (req.user.role === 'admin') {
    ownerCheck += ' AND parent_id = ?';
    ownerParams.push(req.user.id);
  }
  const [rows] = await pool.query(ownerCheck, ownerParams);
  if (!rows[0]) return res.status(404).json({ error: 'Reseller not found' });

  await pool.query('UPDATE accounts SET status = ? WHERE id = ?', [status, id]);
  await logAction(req.user.id, 'update_reseller_status', rows[0].username, `New status: ${status}`, req.ip);

  res.json({ id, status });
});

module.exports = router;
