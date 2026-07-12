const jwt = require('jsonwebtoken');
const pool = require('../config/db');

async function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = header.split(' ')[1];

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Single-session enforcement: this token is only valid if it matches
  // the account's CURRENT session_token in the database. Logging in
  // anywhere else immediately invalidates this one.
  try {
    const [rows] = await pool.query('SELECT session_token, status FROM accounts WHERE id = ?', [payload.id]);
    const account = rows[0];
    if (!account) {
      return res.status(401).json({ error: 'Account no longer exists' });
    }
    if (account.status === 'suspended') {
      return res.status(403).json({ error: 'Account suspended' });
    }
    if (!account.session_token || account.session_token !== payload.sid) {
      return res.status(401).json({ error: 'Session ended - you were logged in somewhere else' });
    }
  } catch (err) {
    console.error('[auth] Session validation failed:', err.message);
    return res.status(500).json({ error: 'Authentication check failed' });
  }

  req.user = payload; // { id, username, role, parent_id, sid }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { authRequired, requireRole };
