const express = require('express');
const pool = require('../config/db');
const logAction = require('../utils/logAction');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();

// Any logged-in role can view the server host/port (needed to build copy strings)
router.get('/', authRequired, requireRole('super_admin', 'admin', 'reseller'), async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM server_config WHERE id = 1');
  if (!rows[0]) return res.status(404).json({ error: 'Server config not set up yet' });
  res.json(rows[0]);
});

// Only super admin can edit the server host/port
router.put('/', authRequired, requireRole('super_admin'), async (req, res) => {
  const { host, port_range } = req.body;
  if (!host || !port_range) {
    return res.status(400).json({ error: 'host and port_range are required' });
  }

  await pool.query('UPDATE server_config SET host = ?, port_range = ? WHERE id = 1', [host, port_range]);
  await logAction(req.user.id, 'update_server_config', null, `Host: ${host}, Ports: ${port_range}`, req.ip);

  const [rows] = await pool.query('SELECT * FROM server_config WHERE id = 1');
  res.json(rows[0]);
});

module.exports = router;
