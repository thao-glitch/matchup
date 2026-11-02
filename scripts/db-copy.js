#!/usr/bin/env node
/**
 * Copy Matchup's primary database to a new, larger MySQL/MariaDB primary.
 *
 * The app already stores user data in one central database; this script is the
 * safe way to move that data when the current plan runs out of disk. It is a
 * one-shot operator tool and is never loaded by the running server.
 *
 * Usage:
 *   SOURCE_MARIADB_HOST=… SOURCE_MARIADB_PORT=… \
 *   SOURCE_MARIADB_USER=… SOURCE_MARIADB_PASSWORD=… SOURCE_MARIADB_DATABASE=… \
 *   TARGET_MARIADB_HOST=… TARGET_MARIADB_PORT=… \
 *   TARGET_MARIADB_USER=… TARGET_MARIADB_PASSWORD=… TARGET_MARIADB_DATABASE=… \
 *   node scripts/db-copy.js --dry-run
 *
 * Then run without --dry-run. Add --force only when the target already has
 * rows from a previous attempt and you want to replace them.
 *
 * TLS: set SOURCE_MARIADB_SSL=true (verify), =insecure (no verification), or
 * SOURCE_MARIADB_SSL_CA=/path/ca.pem. The same TARGET_* variables apply.
 *
 * The copy reads from a single InnoDB consistent snapshot, so the source can
 * stay online. Writes made after the snapshot are not included; stop taking
 * payments/registrations for the few minutes the copy takes, or re-run after
 * the target has been switched in.
 */

const fs = require('fs');
const path = require('path');

const mysql = require(
  require.resolve('mysql2/promise', { paths: [path.join(__dirname, '..', 'server')] }),
);

const BATCH = Math.min(1000, Math.max(1, Number(process.env.DB_COPY_BATCH) || 200));
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const force = args.has('--force');

if (args.has('--help') || args.has('-h')) {
  console.log('See the header of scripts/db-copy.js for usage.');
  process.exit(0);
}

const safeId = (name) => {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Refusing unsafe identifier: ${name}`);
  return `\`${name}\``;
};

function config(prefix) {
  const read = (suffix) => String(process.env[`${prefix}_MARIADB_${suffix}`] || '').trim();
  const out = {
    host: read('HOST'),
    port: Number(read('PORT')) || 3306,
    user: read('USER'),
    password: read('PASSWORD'),
    database: read('DATABASE'),
    ssl: undefined,
  };
  const ca = read('SSL_CA');
  const sslMode = read('SSL').toLowerCase();
  if (ca) {
    out.ssl = { ca: fs.readFileSync(ca), rejectUnauthorized: sslMode !== 'insecure' };
  } else if (sslMode === 'insecure') {
    out.ssl = { rejectUnauthorized: false };
  } else if (sslMode === 'true' || sslMode === '1') {
    out.ssl = { rejectUnauthorized: true };
  }
  return out;
}

async function connect(cfg, withDatabase) {
  return mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: withDatabase ? cfg.database : undefined,
    ssl: cfg.ssl,
    connectTimeout: 15000,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
}

const count = async (conn, table) => {
  const [[row]] = await conn.query(`SELECT COUNT(*) AS n FROM ${safeId(table)}`);
  return Number(row.n) || 0;
};

const identity = (cfg) => `${cfg.host}:${cfg.port}/${cfg.database}`;

async function main() {
  const srcCfg = config('SOURCE');
  const tgtCfg = config('TARGET');

  for (const [name, cfg] of [['SOURCE', srcCfg], ['TARGET', tgtCfg]]) {
    const missing = ['host', 'user', 'database'].filter((key) => !cfg[key]);
    if (missing.length) {
      throw new Error(`${name}_MARIADB_${missing.join(', ').toUpperCase()} is not set`);
    }
  }
  if (identity(srcCfg) === identity(tgtCfg)) {
    throw new Error('Source and target are the same database — nothing to do.');
  }

  console.log(`source: ${identity(srcCfg)}`);
  console.log(`target: ${identity(tgtCfg)}`);

  const src = await connect(srcCfg, true);
  const tgt = await connect(tgtCfg, false);

  try {
    const [[srcVersion]] = await src.query('SELECT VERSION() AS v');
    console.log(`source version: ${srcVersion.v}`);

    await tgt.query(
      `CREATE DATABASE IF NOT EXISTS ${safeId(tgtCfg.database)}
       CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await tgt.query(`USE ${safeId(tgtCfg.database)}`);

    const [tableRows] = await src.query(
      `SELECT table_name AS name
         FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    );
    const tables = tableRows.map((row) => row.name);
    if (!tables.length) throw new Error('Source database has no tables.');

    const existing = [];
    for (const table of tables) {
      const [rows] = await tgt.query(
        `SELECT COUNT(*) AS n FROM information_schema.tables
          WHERE table_schema = DATABASE() AND table_name = ?`,
        [table],
      );
      if (Number(rows[0].n) > 0) existing.push(table);
    }
    if (existing.length && !force) {
      throw new Error(
        `Target already has ${existing.length} table(s). Re-run with --force to replace their rows.`,
      );
    }

    const plan = [];
    for (const table of tables) {
      const [[create]] = await src.query(`SHOW CREATE TABLE ${safeId(table)}`);
      const ddl = String(create['Create Table']).replace(
        /^CREATE TABLE /i,
        'CREATE TABLE IF NOT EXISTS ',
      );
      plan.push({ table, ddl, sourceRows: 0 });
    }

    if (dryRun) {
      for (const item of plan) item.sourceRows = await count(src, item.table);
      const total = plan.reduce((sum, item) => sum + item.sourceRows, 0);
      console.log(`tables: ${plan.length}, rows: ${total} (live estimate)`);
      for (const item of plan) console.log(`  ${item.table}: ${item.sourceRows}`);
      console.log('dry run only — nothing was written to the target.');
      return;
    }

    await tgt.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const item of plan) await tgt.query(item.ddl);
    if (existing.length) {
      for (const item of plan) await tgt.query(`TRUNCATE TABLE ${safeId(item.table)}`);
    }

    // One snapshot for every table, so counts and rows come from the same
    // point in time even while the source is still serving writes.
    await src.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await src.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');

    try {
      for (const item of plan) item.sourceRows = await count(src, item.table);
      const total = plan.reduce((sum, item) => sum + item.sourceRows, 0);
      console.log(`tables: ${plan.length}, rows: ${total}`);
      for (const item of plan) console.log(`  ${item.table}: ${item.sourceRows}`);

      for (const item of plan) {
        const { table } = item;
        const [columns] = await src.query(`SHOW COLUMNS FROM ${safeId(table)}`);
        const names = columns.map((col) => col.Field);
        if (!names.length) continue;
        const columnSql = names.map(safeId).join(', ');

        const [keys] = await src.query(
          `SHOW KEYS FROM ${safeId(table)} WHERE Key_name = 'PRIMARY'`,
        );
        const primary = keys
          .sort((a, b) => Number(a.Seq_in_index) - Number(b.Seq_in_index))
          .map((key) => key.Column_name);
        const keyset = primary.length === 1 ? primary[0] : null;
        const order = primary.length
          ? ` ORDER BY ${primary.map(safeId).join(', ')}`
          : '';

        let copied = 0;
        let last = null;
        let offset = 0;
        for (;;) {
          let rows;
          if (keyset) {
            if (last === null) {
              [rows] = await src.query(
                `SELECT * FROM ${safeId(table)}${order} LIMIT ?`,
                [BATCH],
              );
            } else {
              [rows] = await src.query(
                `SELECT * FROM ${safeId(table)} WHERE ${safeId(keyset)} > ?${order} LIMIT ?`,
                [last, BATCH],
              );
            }
          } else {
            [rows] = await src.query(
              `SELECT * FROM ${safeId(table)}${order} LIMIT ? OFFSET ?`,
              [BATCH, offset],
            );
          }
          if (!rows.length) break;

          const placeholders = rows
            .map(() => `(${names.map(() => '?').join(',')})`)
            .join(',');
          const values = rows.flatMap((row) =>
            names.map((name) => {
              const value = row[name];
              // mysql2 decodes JSON columns (including MariaDB's JSON-alias
              // LONGTEXT) into objects; the driver will not re-encode them.
              if (
                value !== null &&
                typeof value === 'object' &&
                !Buffer.isBuffer(value) &&
                !(value instanceof Date)
              ) {
                return JSON.stringify(value);
              }
              return value;
            }),
          );
          await tgt.query(
            `INSERT INTO ${safeId(table)} (${columnSql}) VALUES ${placeholders}`,
            values,
          );

          copied += rows.length;
          offset += rows.length;
          if (keyset) last = rows[rows.length - 1][keyset];
          if (rows.length < BATCH) break;
        }

        if (copied !== item.sourceRows) {
          throw new Error(
            `${table}: copied ${copied} rows but the source snapshot reported ${item.sourceRows}`,
          );
        }
        console.log(`  copied ${table}: ${copied}`);
      }
      await src.query('COMMIT');
    } catch (err) {
      await src.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      await tgt.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => undefined);
    }

    let failed = 0;
    for (const item of plan) {
      const targetCount = await count(tgt, item.table);
      if (item.sourceRows !== targetCount) {
        failed += 1;
        console.error(
          `  MISMATCH ${item.table}: snapshot ${item.sourceRows}, target ${targetCount}`,
        );
      }
    }
    if (failed) throw new Error(`${failed} table(s) did not match after the copy.`);

    console.log('copy verified — every table matches the snapshot row count.');
    console.log(
      'Next: point MARIADB_* at the target, redeploy, and keep the old database for rollback.',
    );
  } finally {
    await src.end().catch(() => undefined);
    await tgt.end().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(`db-copy failed: ${err.message}`);
  process.exitCode = 1;
});
