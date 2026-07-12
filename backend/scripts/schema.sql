-- RMS Panel Database Schema (v2)
-- Run this once: mysql -u root -p rms_panel < schema.sql

CREATE TABLE IF NOT EXISTS accounts (
  id INT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('super_admin','admin','reseller','customer') NOT NULL,
  parent_id INT NULL,
  credits INT DEFAULT 0,
  status ENUM('active','suspended') DEFAULT 'active',
  session_token VARCHAR(64) NULL,
  failed_login_attempts INT DEFAULT 0,
  locked_until TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (parent_id) REFERENCES accounts(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS vpn_users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  owner_id INT NOT NULL,
  service_type ENUM('udp_custom','hysteria2') NOT NULL DEFAULT 'udp_custom',
  username VARCHAR(20) NOT NULL,
  password VARCHAR(100) NOT NULL,
  connection_limit INT DEFAULT 1,
  expires_at TIMESTAMP NOT NULL,
  status ENUM('active','blocked') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES accounts(id) ON DELETE CASCADE,
  INDEX idx_expires_at (expires_at)
);

CREATE TABLE IF NOT EXISTS credit_transactions (
  id INT PRIMARY KEY AUTO_INCREMENT,
  account_id INT NOT NULL,
  amount INT NOT NULL,
  reason VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS logs (
  id INT PRIMARY KEY AUTO_INCREMENT,
  actor_id INT NULL,
  action VARCHAR(50) NOT NULL,
  target_username VARCHAR(50),
  details TEXT,
  ip_address VARCHAR(45),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_id) REFERENCES accounts(id) ON DELETE SET NULL
);

-- Global server connection settings (single row, id = 1).
-- Set once by a super admin; every VPN user's copyable connection
-- string is built from this. This panel is UDP Custom only.
CREATE TABLE IF NOT EXISTS server_config (
  id INT PRIMARY KEY DEFAULT 1,
  host VARCHAR(255) NOT NULL DEFAULT 'your.server.ip',
  port_range VARCHAR(50) NOT NULL DEFAULT '1-65535',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

INSERT INTO server_config (id) VALUES (1) ON DUPLICATE KEY UPDATE id = id;

-- Archive of users whose system account has been strictly deleted on
-- expiry. Kept here purely for convenience so a super admin, admin, or
-- reseller can "renew" (recreate) the same user later without retyping
-- their details. The actual Linux account is gone the moment they expire -
-- this table does not represent an active VPN account.
CREATE TABLE IF NOT EXISTS expired_vpn_users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  owner_id INT NOT NULL,
  service_type ENUM('udp_custom','hysteria2') NOT NULL DEFAULT 'udp_custom',
  username VARCHAR(20) NOT NULL,
  password VARCHAR(100) NOT NULL,
  connection_limit INT DEFAULT 1,
  expired_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES accounts(id) ON DELETE CASCADE
);
