/**
 * Profile persistence.
 *
 * First one configured wins:
 *   1. `MARIADB_DATABASE` + `MARIADB_USER` → MariaDB on this machine
 *      (see `scripts/mariadb-init.sql`; survives restarts and grows on disk).
 *   2. `MONGODB_URI`                       → MongoDB (e.g. Atlas).
 *   3. neither                             → in-memory Map (dev / ephemeral).
 *
 * The store is deliberately fire-and-forget: a database blip must never block
 * a user from entering the queue. Every backend therefore degrades to the
 * in-memory store instead of failing startup.
 */

/** @type {'memory' | 'mongo' | 'maria'} */
let mode = 'memory';

/** sessionId -> profile (memory mode) */
const sessions = new Map();

/** mongoose model (mongo mode) */
let Profile = null;
let mongooseRef = null;

/** local MariaDB backend (maria mode) */
const mariaStore = require('./mariaStore');

async function initStore() {
  // ── 1. Local MariaDB ───────────────────────────────────────────────────────
  if (mariaStore.configured()) {
    try {
      await mariaStore.init();
      mode = 'maria';
      return mode;
    } catch (err) {
      console.error(`[store] MariaDB unavailable (${err.message}) — trying next backend`);
      await mariaStore.close().catch(() => undefined);
    }
  }

  // ── 2. MongoDB ─────────────────────────────────────────────────────────────
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    mode = 'memory';
    console.info(
      '[store] no database configured (MARIADB_* / MONGODB_URI) — using the in-memory store',
    );
    return mode;
  }

  try {
    const mongoose = require('mongoose');
    mongooseRef = mongoose;

    const schema = new mongoose.Schema(
      {
        sessionId: { type: String, required: true },
        username: { type: String, required: true, trim: true },
        age: { type: Number, required: true },
        gender: { type: String, required: true },
        country: { type: String, required: true },
        preferredGenders: { type: [String], default: ['any'] },
        ageMin: { type: Number, default: 18 },
        ageMax: { type: Number, default: 99 },
        lastSeen: { type: Date, default: Date.now },
      },
      { timestamps: true },
    );

    // One document per session, queryable by user and country.
    schema.index({ sessionId: 1 }, { unique: true });
    schema.index({ username: 1, country: 1 });
    // Auto-expire sessions untouched for 30 days (keeps the collection lean).
    schema.index({ lastSeen: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

    Profile = mongoose.model('Profile', schema);

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 4000 });
    mode = 'mongo';
    console.info('[store] connected to MongoDB');
  } catch (err) {
    console.error(`[store] MongoDB unavailable (${err.message}) — falling back to memory`);
    mode = 'memory';
    Profile = null;
  }
  return mode;
}

function saveProfile(socketId, profile) {
  const doc = { ...profile, lastSeen: new Date() };

  if (mode === 'maria') {
    mariaStore.save(socketId, profile); // logs its own failures
    return;
  }

  if (mode === 'mongo' && Profile) {
    Profile.updateOne(
      { sessionId: socketId },
      { $set: doc, $setOnInsert: { sessionId: socketId } },
      { upsert: true },
    ).catch((err) => console.error('[store] save failed:', err.message));
    return;
  }

  sessions.set(socketId, doc);
}

async function stats() {
  if (mode === 'maria') {
    try {
      const s = await mariaStore.stats();
      return { ...s, mode };
    } catch (err) {
      console.error('[store] stats failed:', err.message);
      return { users: 0, sessions: 0, mode };
    }
  }

  if (mode === 'mongo' && Profile) {
    try {
      const [users, profiles] = await Promise.all([
        Profile.distinct('username'),
        Profile.countDocuments(),
      ]);
      return { users: users.length, sessions: profiles, mode };
    } catch (err) {
      console.error('[store] stats failed:', err.message);
      return { users: 0, sessions: 0, mode };
    }
  }

  const usernames = new Set();
  for (const doc of sessions.values()) usernames.add(doc.username);
  return { users: usernames.size, sessions: sessions.size, mode };
}

async function closeStore() {
  if (mode === 'maria') {
    await mariaStore.close().catch(() => undefined);
  }
  if (mode === 'mongo' && mongooseRef) {
    await mongooseRef.disconnect().catch(() => undefined);
  }
  sessions.clear();
}

module.exports = { initStore, saveProfile, stats, closeStore, getMode: () => mode };
