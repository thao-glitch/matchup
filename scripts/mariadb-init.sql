-- ─────────────────────────────────────────────────────────────────────────────
-- One-time setup: creates the application database and a dedicated user that
-- ONLY this app uses. Run it as the database root:
--
--     sudo mariadb < scripts/mariadb-init.sql
--
-- (Debian/Kali authenticate the OS root user through the unix socket, so no
--  database password is asked for. Windows/macOS: open the MariaDB monitor
--  and paste this file's contents.)
--
-- Replace CHANGE_ME_PASSWORD below — or let the command in the README generate
-- a random one and write it to server/.env for you in the same step.
--
-- The database lives in /var/lib/mysql on THIS machine: it survives reboots
-- and grows with the app until the disk is full.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE DATABASE IF NOT EXISTS matchup
  CHARACTER SET utf8mb4          -- 4-byte UTF-8: usernames carry flag emoji
  COLLATE utf8mb4_unicode_ci;

-- Two entries on purpose: the app connects over TCP (127.0.0.1) but some
-- installs resolve that back to 'localhost'. Creating both removes the
-- classic "Access denied for user 'matchup'@'localhost'" ambiguity.
CREATE USER IF NOT EXISTS 'matchup'@'localhost' IDENTIFIED BY 'CHANGE_ME_PASSWORD';
CREATE USER IF NOT EXISTS 'matchup'@'127.0.0.1' IDENTIFIED BY 'CHANGE_ME_PASSWORD';

-- Least privilege: this user may touch nothing but the matchup database.
GRANT ALL PRIVILEGES ON matchup.* TO 'matchup'@'localhost';
GRANT ALL PRIVILEGES ON matchup.* TO 'matchup'@'127.0.0.1';
FLUSH PRIVILEGES;
