const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const logAction = require('../utils/logAction');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

const MAX_FAILED_ATTEMPTS = 2;
const LOCKOUT_MINUTES = 10; // locked out after 2 attempts, try again after 10 mins

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const [rows] = await pool.query('SELECT * FROM accounts WHERE username = ?', [username]);
  const account = rows[0];

  // Same generic error whether the username doesn't exist or the password
  // is wrong - don't leak which one it was.
  const genericError = () => res.status(401).json({ error: 'Invalid credentials' });

  if (!account) return genericError();
  if (account.status === 'suspended') {
    return res.status(403).json({ error: 'Account suspended' });
  }

  if (account.locked_until && new Date(account.locked_until) > new Date()) {
    const minutesLeft = Math.ceil((new Date(account.locked_until) - new Date()) / 60000);
    return res.status(423).json({ error: `Too many failed attempts. Try again in ${minutesLeft} minute(s).` });
  }

  const match = await bcrypt.compare(password, account.password_hash);
  if (!match) {
    const attempts = (account.failed_login_attempts || 0) + 1;
    if (attempts >= MAX_FAILED_ATTEMPTS) {
      const lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60000);
      await pool.query(
        'UPDATE accounts SET failed_login_attempts = ?, locked_until = ? WHERE id = ?',
        [attempts, lockedUntil, account.id]
      );
      await logAction(account.id, 'account_locked', account.username, `${attempts} failed attempts`, req.ip);
      return res.status(423).json({ error: `Too many failed attempts. Please try again later.` });
    }
    await pool.query('UPDATE accounts SET failed_login_attempts = ? WHERE id = ?', [attempts, account.id]);
    return genericError();
  }

  // Successful login - reset lockout counters and issue a fresh session token.
  // This immediately invalidates any token issued to a previous login
  // (i.e. logging in elsewhere logs the other session out).
  const sessionToken = crypto.randomBytes(32).toString('hex');
  await pool.query(
    'UPDATE accounts SET session_token = ?, failed_login_attempts = 0, locked_until = NULL WHERE id = ?',
    [sessionToken, account.id]
  );

  const token = jwt.sign(
    { id: account.id, username: account.username, role: account.role, parent_id: account.parent_id, sid: sessionToken },
    process.env.JWT_SECRET,
    { expiresIn: '30m' }
  );

  await logAction(account.id, 'login', null, null, req.ip);

  res.json({
    token,
    user: {
      id: account.id,
      username: account.username,
      role: account.role,
      credits: account.credits
    }
  });
});

router.get('/me', authRequired, async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, username, role, credits, status, created_at FROM accounts WHERE id = ?',
    [req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Account not found' });
  res.json(rows[0]);
});

// Explicit logout - clears the session token server-side so the token
// can't be reused even if someone still has it saved somewhere.
router.post('/logout', authRequired, async (req, res) => {
  await pool.query('UPDATE accounts SET session_token = NULL WHERE id = ?', [req.user.id]);
  res.json({ success: true });
});

// Self-service password change - any logged-in role can change their own password
router.put('/change-password', authRequired, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Current and new password are required' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  const [rows] = await pool.query('SELECT * FROM accounts WHERE id = ?', [req.user.id]);
  const account = rows[0];
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const match = await bcrypt.compare(current_password, account.password_hash);
  if (!match) return res.status(401).json({ error: 'Current password is incorrect' });

  const newHash = await bcrypt.hash(new_password, 10);
  // Changing password also rotates the session token, forcing re-login
  // everywhere - standard practice so a stolen-but-still-valid token
  // doesn't survive a password change.
  const sessionToken = crypto.randomBytes(32).toString('hex');
  await pool.query(
    'UPDATE accounts SET password_hash = ?, session_token = ? WHERE id = ?',
    [newHash, sessionToken, req.user.id]
  );
  await logAction(req.user.id, 'change_own_password', account.username, null, req.ip);

  // Issue a fresh token for THIS session since the old one just got invalidated
  const token = jwt.sign(
    { id: account.id, username: account.username, role: account.role, parent_id: account.parent_id, sid: sessionToken },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );

  res.json({ success: true, token });
});

module.exports = router;
