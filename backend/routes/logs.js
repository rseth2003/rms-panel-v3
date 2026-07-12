const express = require('express');
const pool = require('../config/db');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', authRequired, requireRole('super_admin', 'admin', 'reseller'), async (req, res) => {
  let query = `
    SELECT l.*, a.username AS actor_username
    FROM logs l
    LEFT JOIN accounts a ON a.id = l.actor_id
  `;
  const params = [];
  if (req.user.role === 'reseller') {
    query += ' WHERE l.actor_id = ?';
    params.push(req.user.id);
  }
  query += ' ORDER BY l.created_at DESC LIMIT 500';

  const [rows] = await pool.query(query, params);
  res.json(rows);
});

module.exports = router;
