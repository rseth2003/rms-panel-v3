const express = require('express');
const pool = require('../config/db');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', authRequired, requireRole('super_admin', 'admin', 'reseller'), async (req, res) => {
  let query = `
    SELECT l.*, a.username AS actor_username, a.role AS actor_role
    FROM logs l
    LEFT JOIN accounts a ON a.id = l.actor_id
  `;
  const params = [];

  if (req.user.role === 'reseller') {
    // Resellers see only their own login and user creation logs
    query += ' WHERE l.actor_id = ? AND l.action IN ("login", "create_vpn_user", "auto_expired_deleted")';
    params.push(req.user.id);
  } else if (req.user.role === 'admin') {
    // Admins see their own logs + their resellers logs, but NOT super_admin actions
    query += `
      WHERE (
        l.actor_id = ?
        OR l.actor_id IN (
          SELECT id FROM accounts WHERE parent_id = ? AND role = 'reseller'
        )
      )
      AND a.role != 'super_admin'
    `;
    params.push(req.user.id, req.user.id);
  }
  // super_admin sees everything — no filter

  query += ' ORDER BY l.created_at DESC LIMIT 500';
  const [rows] = await pool.query(query, params);
  res.json(rows);
});

module.exports = router;
