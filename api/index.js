'use strict';

/**
 * Vercel function entry — the exact same Express app `server/server.js` runs
 * locally, wrapped as a serverless function. There is no socket layer to
 * carry over: signaling, matchmaking and room rosters are HTTP long-poll
 * against the database (see `server/src/realtime.js`), which is what makes a
 * stateless, autoscaling host possible at all.
 *
 * `boot()` runs once per warm instance (database pool, schema, settings) and
 * is cached; a failed boot is never cached, so the next request retries it.
 */
const { app, boot } = require('../server/server');

let ready = null;

async function handler(req, res) {
  if (!ready) {
    ready = boot().catch((err) => {
      ready = null;
      throw err;
    });
  }
  try {
    await ready;
  } catch (err) {
    console.error('[api] boot failed:', err.message);
    if (!res.headersSent) {
      res.status(503).json({
        error: { code: 'boot', message: 'The server is waking up — try again in a moment.' },
      });
    }
    return;
  }
  app(req, res);
}

module.exports = handler;
// maxDuration must exceed the long-poll hold (25s cap) plus overhead.
// bodyParser off: Express parses bodies itself (json + the raw media upload).
module.exports.config = {
  maxDuration: 30,
  api: { bodyParser: false },
};
