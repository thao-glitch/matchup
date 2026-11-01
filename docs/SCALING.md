# Scaling Matchup

This is the practical scaling guide for the current architecture: one
MariaDB/MySQL primary, optional read replica, private Vercel Blob storage, and
stateless HTTP long-poll signaling.

There is no switch that makes one database serve “4.29 billion users forever.”
The controls below buy headroom, make the read path horizontal, and keep media
out of the database. True sharding is a migration project, not an env var.

## 1. Connection pooling

Each serverless instance owns a bounded `mysql2` pool:

| Variable | Default | Meaning |
| --- | --- | --- |
| `MARIADB_POOL_SIZE` | `5` | Connections per instance |
| `MARIADB_QUEUE_LIMIT` | `0` | Queries allowed to wait (0 = unbounded) |
| `MARIADB_IDLE_TIMEOUT_MS` | `30000` | Idle connection eviction |
| `MARIADB_MAX_IDLE` | `10000` | Maximum idle time |
| `MARIADB_CONNECT_TIMEOUT_MS` | `15000` | TCP/TLS connect timeout |

Keep this inequality true:

```
MARIADB_POOL_SIZE × maximum warm instances < max_connections
```

The production database currently reports `max_connections = 76`. With the
default pool of 5, that is about 15 warm instances. Raise `max_connections`
first (or put a proxy such as ProxySQL in front) before raising the pool.

The admin **Database** card shows the local pool (`total/limit`, free, queued),
global connections, and the replica state.

## 2. Read replicas

Set these to route lag-tolerant public reads to a replica:

```dotenv
MARIADB_READ_HOST=replica.example.net
MARIADB_READ_PORT=3306
MARIADB_READ_USER=matchup_reader
MARIADB_READ_PASSWORD=...
MARIADB_READ_SSL=true
MARIADB_READ_POOL_SIZE=5
```

If the replica is missing or unhealthy, the app logs it, reports it in
`/api/admin/db`, and falls back to the primary. It never fails a request just
because the replica is down.

What uses the replica:

- public feed pages (`GET /api/posts`)
- anonymous creator cards (`GET /api/creators/:id`); signed-in viewers read the primary so follow/subscribe state is read-after-write
- comment lists

What deliberately stays on the primary:

- login/session lookups
- charges, wallets, payouts and subscription entitlement
- post detail after a write
- moderation and admin lists
- anything that must be read-after-write correct

This is intentional. A replica is eventually consistent; showing a paid post as
locked for a few seconds after a subscription is worse than reading that one
row from the primary.

## 3. Sharding: what it actually takes

The current schema is a single primary. Sharding it means running multiple
independent databases and routing by a shard key. There is no safe way to hide
that behind a boolean, because these operations cross shards:

- follower/subscriber counts and feeds
- paid-post entitlement and charge settlement
- wallet balances and payouts
- creator cards that count posts/followers
- admin views that need global totals

### Recommended phases

1. **Measure first.** Keep the admin database card and add query latency /
   slow-query logging. Shard only when a single primary is the proven bottleneck.
2. **Move media out.** Already done: new uploads are in Vercel Blob, not
   `media_blobs`. Historical rows can be swept by the lifecycle job.
3. **Add a read replica.** Already supported. This removes most public feed
   reads from the primary.
4. **Partition the hot append-only tables.** `rt_inbox`, `audit_log`, and
   `charges` grow forever. They already have time-based purge jobs where safe;
   next would be monthly partitions and archive tables.
5. **Shard by `account_id`.** Put user-owned tables in shard databases:
   `accounts`, `account_sessions`, `posts`, `post_likes`, `post_comments`,
   `follows`, `creator_subs`, `subscriptions`, `wallets`, `wallet_entries`.
   A directory service maps `account_id → shard`.
6. **Keep a global ledger.** `charges` and payout records should stay in one
   ledger database (or a dedicated payments service). Money must be globally
   reconcilable even when user data is sharded.
7. **Handle cross-shard reads asynchronously.** A creator’s follower count,
   feed fan-out, and global search should be projections built from events, not
   synchronous joins across shards.
8. **Move realtime state.** `rt_queue`/`rt_pairs`/`rt_inbox` need a shared
   low-latency store (Redis or a dedicated realtime database) before the app
   runs many signaling instances.

Until those steps are done, adding `MARIADB_SHARD_*` variables would only
create a false sense of safety. The honest path is: pool, replica, partition,
then shard with a directory and a global ledger.

## 4. Lifecycle policies

Vercel Blob has no native per-object TTL, so the app runs its own sweep:

- **Blob keep-set:** every `posts.media_key` in the database is kept.
- **Orphan grace:** unreferenced Blob objects younger than
  `MEDIA_ORPHAN_GRACE_HOURS` (default 24h) are left alone, so an upload that is
  still being published is never deleted.
- **Legacy DB retention:** unreferenced `media_blobs` rows older than
  `MEDIA_RETENTION_DAYS` (default 30d) are deleted.
- **Local dev files:** unreferenced files older than the same cutoff are
  removed.
- **Cache:** immutable media keys get `MEDIA_CACHE_MAX_AGE_SEC` (default 1 year).

Triggers:

- Vercel Cron daily at 03:00 UTC: `GET /api/cron/media` with
  `Authorization: Bearer ${CRON_SECRET}` (see `vercel.json`).
- Admin Dashboard → Overview → Database → **Dry run cleanup** / **Run media
  cleanup**.

Dry run reports what would be deleted without deleting anything.

## 5. Capacity math

- **Media:** object storage scales independently of the database. The database
  only stores keys.
- **Accounts:** a profile row is a few hundred bytes; the current schema uses
  `INT UNSIGNED` IDs (4,294,967,295 max). Reaching that many *accounts* is a
  schema and sharding project, not a single-table fact.
- **Connections:** usually the first hard limit. See the pool inequality above.
- **Realtime:** HTTP long-poll is stateless, but every poll touches the
  database. At high concurrency, move `rt_*` to Redis or a dedicated service.
- **Money:** keep the ledger on a primary and make settlement idempotent; never
  split a charge across shards.

## 6. Operating checklist

```bash
# Health and media backend
curl -s https://matchup-mu.vercel.app/health | jq '.media'

# Database footprint, pool, replica
curl -s https://matchup-mu.vercel.app/api/admin/db \
  -H "authorization: Bearer $ADMIN_TOKEN" | jq '.database | {pool, replica, connections}'

# Lifecycle dry run (admin)
curl -s -X POST 'https://matchup-mu.vercel.app/api/admin/media/prune?dryRun=1' \
  -H "authorization: Bearer $ADMIN_TOKEN" | jq
```
