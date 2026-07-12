-- Run this ONLY if you already created the database with an earlier
-- version of schema.sql. If this is a fresh install, you don't need this -
-- schema.sql already includes these columns.
--
-- Usage: mysql -u rms_panel -p rms_panel < migrate_security.sql

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS session_token VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS failed_login_attempts INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP NULL;
