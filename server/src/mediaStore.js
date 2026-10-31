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

function describe() {
  return {
    backend: enabled ? 'vercel-blob' : 'database',
    objectStorage: enabled,
    private: enabled,
    directUpload: enabled,
  };
}

async function save(key, mime, buffer) {
  if (!enabled) return false;
  await blob.put(key, buffer, {
    access: 'private',
    contentType: mime,
    addRandomSuffix: false,
    allowOverwrite: true,
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

module.exports = { describe, save, read, exists, remove, enabled: () => enabled };
