const pool = require('../config/db');

async function logAction(actorId, action, targetUsername, details, ip) {
  try {
    await pool.query(
      `INSERT INTO logs (actor_id, action, target_username, details, ip_address) VALUES (?, ?, ?, ?, ?)`,
      [actorId, action, targetUsername || null, details || null, ip || null]
    );
  } catch (err) {
    console.error('Failed to write log:', err.message);
  }
}

module.exports = logAction;
