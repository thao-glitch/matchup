/**
 * Object storage for post media.
 *
 * Production uploads no longer belong in MariaDB: a LONGBLOB per image/video
 * makes the database grow with every byte users publish, and no single
 * database can hold "unlimited" media. When a Vercel Blob store is connected
 * (`BLOB_READ_WRITE_TOKEN` present) new files go there, while MariaDB keeps
 * only the post row and its key.
 *
 * The private store is deliberate: media is still served exclusively through
 * `GET /api/posts/:id/media`, which enforces the paywall and the 18+ gate.
 * Historical files in `media_blobs` remain readable through the fallback in
 * `commerce.readPostMedia`.
 *
 * With no token (local dev, or a host without object storage) every method
 * reports "not handled" and commerce falls back to the database/filesystem.
 */
const blob = require('@vercel/blob');

const TOKEN = String(process.env.BLOB_READ_WRITE_TOKEN || '').trim();
const enabled = Boolean(TOKEN);

const intEnv = (value, fallback, min, max) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};
const ORPHAN_GRACE_HOURS = intEnv(process.env.MEDIA_ORPHAN_GRACE_HOURS, 24, 1, 24 * 30);
const RETENTION_DAYS = intEnv(process.env.MEDIA_RETENTION_DAYS, 30, 1, 3650);
const CACHE_MAX_AGE_SEC = intEnv(process.env.MEDIA_CACHE_MAX_AGE_SEC, 31536000, 60, 31536000);

/** Lifecycle knobs shared with the dashboard and direct-upload token route. */
function lifecycle() {
  return {
    orphanGraceHours: ORPHAN_GRACE_HOURS,
    retentionDays: RETENTION_DAYS,
    cacheMaxAgeSec: CACHE_MAX_AGE_SEC,
    nativeObjectTtl: false,
  };
}

function describe() {
  return {
    backend: enabled ? 'vercel-blob' : 'database',
    objectStorage: enabled,
    private: enabled,
    directUpload: enabled,
    lifecycle: lifecycle(),
  };
}

async function save(key, mime, buffer) {
  if (!enabled) return false;
  await blob.put(key, buffer, {
    access: 'private',
    contentType: mime,
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: CACHE_MAX_AGE_SEC,
    token: TOKEN,
  });
  return true;
}

/** Returns `{ data: Buffer, mime }` or null when this backend has no such key. */
async function read(key) {
  if (!enabled) return null;
  try {
    const result = await blob.get(key, { access: 'private', token: TOKEN });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    const data = Buffer.from(await new Response(result.stream).arrayBuffer());
    return { data, mime: result.blob?.contentType || '' };
  } catch (err) {
    // A missing object is a normal fallback case (historical DB file).
    if (err && /not.?found|404/i.test(String(err.message || err.name || ''))) return null;
    throw err;
  }
}

async function exists(key) {
  if (!enabled) return false;
  try {
    await blob.head(key, { token: TOKEN });
    return true;
  } catch (err) {
    if (err && /not.?found|404/i.test(String(err.message || err.name || ''))) return false;
    throw err;
  }
}

async function remove(key) {
  if (!enabled) return false;
  await blob.del(key, { token: TOKEN });
  return true;
}

/**
 * Delete Blob objects that no database row references and that are older than
 * the orphan grace window. The caller supplies the keep-set from the database;
 * if that query failed, do not call this at all.
 *
 * Pagination is explicit: a store with millions of objects is never loaded in
 * one request. `dryRun` reports what would happen without deleting.
 */
async function prune({ keepKeys = new Set(), minAgeMs = 24 * 60 * 60 * 1000, dryRun = false } = {}) {
  const result = {
    backend: enabled ? 'vercel-blob' : 'database',
    scanned: 0,
    deleted: 0,
    skipped: 0,
    errors: 0,
    dryRun: Boolean(dryRun),
  };
  if (!enabled) return result;

  const cutoff = Date.now() - Math.max(0, Number(minAgeMs) || 0);
  let cursor;
  do {
    const page = await blob.list({ token: TOKEN, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const item of page.blobs || []) {
      result.scanned += 1;
      if (keepKeys.has(item.pathname)) continue;
      const uploaded = item.uploadedAt instanceof Date ? item.uploadedAt.getTime() : Date.parse(item.uploadedAt);
      if (!Number.isFinite(uploaded) || uploaded > cutoff) {
        result.skipped += 1;
        continue;
      }
      try {
        if (!dryRun) await blob.del(item.pathname, { token: TOKEN });
        result.deleted += 1;
      } catch (err) {
        result.errors += 1;
        console.warn(`[media] lifecycle delete failed for ${item.pathname}:`, err.message);
      }
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  return result;
}

module.exports = {
  describe,
  lifecycle,
  save,
  read,
  exists,
  remove,
  prune,
  enabled: () => enabled,
};
