const express = require('express');
const pool = require('../config/db');
const { runWrapper } = require('../utils/shellWrapper');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();

async function getOnlineUsernameSet() {
  try {
    const output = await runWrapper('list_online_users', []);
    return new Set(output.split('\n').map(s => s.trim()).filter(Boolean));
  } catch (err) {
    console.error('[statistics] Failed to check online users:', err.message);
    return new Set(); // fail safe - everyone shows offline rather than erroring the page
  }
}

router.get('/', authRequired, requireRole('super_admin', 'admin', 'reseller'), async (req, res) => {
  const onlineSet = await getOnlineUsernameSet();

  if (req.user.role === 'reseller') {
    const [users] = await pool.query(
      'SELECT * FROM vpn_users WHERE owner_id = ? ORDER BY created_at DESC',
      [req.user.id]
    );
    const [[{ expiredCount }]] = await pool.query(
      'SELECT COUNT(*) AS expiredCount FROM expired_vpn_users WHERE owner_id = ?',
      [req.user.id]
    );

    const myUsers = users.map(u => ({ ...u, online: onlineSet.has(u.username) }));
    const online = myUsers.filter(u => u.online).length;

    return res.json({
      scope: 'reseller',
      summary: {
        totalUsers: users.length,
        online,
        offline: users.length - online,
        expiredArchived: expiredCount
      },
      myUsers
    });
  }

  // admin: scoped to themselves + their own resellers. super_admin: everything.
  let usersQuery = `
    SELECT v.*, a.username AS owner_username
    FROM vpn_users v JOIN accounts a ON a.id = v.owner_id
  `;
  let expiredQuery = 'SELECT COUNT(*) AS expiredCount FROM expired_vpn_users';
  let resellerQuery = `SELECT COUNT(*) AS resellerCount FROM accounts WHERE role = 'reseller'`;
  const scopeParams = [];

  if (req.user.role === 'admin') {
    const scopeClause = ` WHERE v.owner_id = ? OR v.owner_id IN (
      SELECT id FROM accounts WHERE parent_id = ? AND role = 'reseller'
    )`;
    usersQuery += scopeClause;
    scopeParams.push(req.user.id, req.user.id);

    expiredQuery = `SELECT COUNT(*) AS expiredCount FROM expired_vpn_users
      WHERE owner_id = ? OR owner_id IN (
        SELECT id FROM accounts WHERE parent_id = ? AND role = 'reseller'
      )`;
    resellerQuery = `SELECT COUNT(*) AS resellerCount FROM accounts WHERE role = 'reseller' AND parent_id = ?`;
  }

  usersQuery += ' ORDER BY v.created_at DESC';
  const [users] = await pool.query(usersQuery, scopeParams);
  const [[{ expiredCount }]] = await pool.query(
    expiredQuery,
    req.user.role === 'admin' ? [req.user.id, req.user.id] : []
  );
  const [[{ resellerCount }]] = await pool.query(
    resellerQuery,
    req.user.role === 'admin' ? [req.user.id] : []
  );

  const withOnline = users.map(u => ({ ...u, online: onlineSet.has(u.username) }));
  const online = withOnline.filter(u => u.online).length;

  // Group by owner (reseller/admin/super_admin who created them)
  const byOwner = {};
  for (const u of withOnline) {
    if (!byOwner[u.owner_id]) {
      byOwner[u.owner_id] = { ownerId: u.owner_id, ownerUsername: u.owner_username, totalUsers: 0, online: 0, offline: 0 };
    }
    byOwner[u.owner_id].totalUsers++;
    if (u.online) byOwner[u.owner_id].online++;
    else byOwner[u.owner_id].offline++;
  }

  const summary = {
    totalUsers: users.length,
    online,
    offline: users.length - online,
    expiredArchived: expiredCount,
    totalResellers: resellerCount
  };

  if (req.user.role === 'super_admin') {
    const [[{ adminCount }]] = await pool.query(`SELECT COUNT(*) AS adminCount FROM accounts WHERE role = 'admin'`);
    summary.totalAdmins = adminCount;
  }

  res.json({
    scope: req.user.role,
    summary,
    perOwnerBreakdown: Object.values(byOwner).sort((a, b) => b.totalUsers - a.totalUsers)
  });
});

module.exports = router;
