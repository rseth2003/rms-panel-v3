require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const pool = require('./config/db');
const { startExpiryChecker } = require('./jobs/expiryChecker');
const { startDeviceLimitWatchdog } = require('./jobs/deviceLimitWatchdog');

const authRoutes = require('./routes/auth');
const resellerRoutes = require('./routes/resellers');
const vpnUserRoutes = require('./routes/vpnUsers');
const logRoutes = require('./routes/logs');
const adminRoutes = require('./routes/admins');
const serverConfigRoutes = require('./routes/serverConfig');
const expiredUsersRoutes = require('./routes/expiredUsers');
const statisticsRoutes = require('./routes/statistics');

const app = express();

// Trust the Nginx reverse proxy in front of this so req.ip and rate
// limiting see the real client IP instead of 127.0.0.1
app.set('trust proxy', 1);

// Security headers (CSP, X-Frame-Options, HSTS when behind HTTPS, etc.)
app.use(helmet());

// Only allow the panel's own frontend origin to call this API.
// Set FRONTEND_ORIGIN in .env to your real domain once deployed.
const allowedOrigin = process.env.FRONTEND_ORIGIN || '*';
app.use(cors({
  origin: allowedOrigin === '*' ? true : allowedOrigin,
  credentials: false
}));

app.use(express.json({ limit: '100kb' }));

// Global rate limit across the whole API - blunt protection against abuse/scraping
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' }
});
app.use('/api/', globalLimiter);

// Tighter limit specifically on login - the real brute-force target
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts from this network, please try again later.' }
});
app.use('/api/auth/login', loginLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/resellers', resellerRoutes);
app.use('/api/vpn-users', vpnUserRoutes);
app.use('/api/logs', logRoutes);
app.use('/api/admins', adminRoutes);
app.use('/api/server-config', serverConfigRoutes);
app.use('/api/expired-users', expiredUsersRoutes);
app.use('/api/statistics', statisticsRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

async function bootstrapSuperAdmin() {
  const [rows] = await pool.query('SELECT id FROM accounts WHERE role = "super_admin" LIMIT 1');
  if (rows.length > 0) return;

  const username = process.env.SUPER_ADMIN_USERNAME;
  const password = process.env.SUPER_ADMIN_PASSWORD;
  if (!username || !password) {
    console.warn('No super admin exists yet, and SUPER_ADMIN_USERNAME/PASSWORD are not set in .env');
    return;
  }
  if (password.length < 8) {
    console.error('SUPER_ADMIN_PASSWORD must be at least 8 characters. Refusing to create a weak super admin.');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    'INSERT INTO accounts (username, password_hash, role, credits, status) VALUES (?, ?, "super_admin", 0, "active")',
    [username, hash]
  );
  console.log(`Super admin account "${username}" created.`);
}

const PORT = process.env.PORT || 3000;
bootstrapSuperAdmin()
  .then(() => {
    app.listen(PORT, () => console.log(`RMS Panel API running on port ${PORT}`));
    startExpiryChecker();
    startDeviceLimitWatchdog();
  })
  .catch((err) => {
    console.error('Failed to bootstrap super admin:', err.message);
    process.exit(1);
  });
