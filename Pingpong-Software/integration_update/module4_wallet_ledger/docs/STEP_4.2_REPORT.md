# Module 4 — Step 4.2 Report: Cross-Instance Socket Routing

## What was built

Topology-agnostic Redis layer (own connections, no `redis/client.js`
dependency), plus the first migrated entity from the Step 4.1 plan
(`socketsByUserId` routing).

| File | Purpose |
|---|---|
| `module4/redis/connectionFactory.js` | Builds an ioredis client for `single` (default), `cluster`, or `sentinel` topology from env vars. Every other file below only calls command methods on the returned client — never constructs a connection or branches on topology itself. |
| `module4/redis/keyspace.js` | Cluster-safe key naming via Redis hash tags (`{room:42}`), so keys that must co-locate in the same hash slot always do — required for Cluster correctness, inert/no-op on a single instance. |
| `module4/redis/lock.js` | Single-key distributed lock (`SET NX PX` acquire, Lua compare-and-delete release/extend). Deliberately not Redlock — single-key ops are Cluster-safe by construction and Redlock's multi-master quorum model doesn't match this deployment. |
| `module4/redis/routing.js` | Redis-authoritative `userId -> {instanceId, socketId}` routing, replacing what `socketsByUserId` would need to become for cross-instance targeted emits. Self-expiring (TTL + heartbeat refresh), same pattern `redis/roomState.js` already uses. |

## How the Cluster/Sentinel requirement was met

- No file other than `connectionFactory.js` knows or cares which topology is active — they only call `.get/.set/.hset/.eval` etc.
- `keyspace.js` enforces hash-tagged keys so anything requiring multi-key atomicity later stays in one hash slot.
- `lock.js` only ever touches one key per operation — single-key Lua/commands don't have a CROSSSLOT failure mode, so this file is unchanged whether the deployment is single-instance or Cluster.
- Moving from single to Cluster/Sentinel later is: set `REDIS_TOPOLOGY=cluster` (or `sentinel`) + the corresponding node list env var. No code in any consumer of `connectionFactory.js` needs to change.

## Isolation check

- Confirmed via filesystem timestamp diff: zero files under the original uploaded project were modified.
- `module4/redis/*.js` does not `require()` anything from `redis/` or `server.js`. It has its own connections, so it can run (or not run) entirely independently of the existing Redis layer.

## Verified (actually run this session)

- `node --check` passed on all 4 new files (syntax valid).
- Ran `routing.js` directly with no Redis/ioredis present: `init()`, `setRoute()`, `getRoute()`, `clearRoute()`, `shutdown()` all executed, degraded to safe no-ops (`false`/`null`), did not throw. This confirms the "never crash the app" safety contract actually holds, not just that it's commented as intended.

## Assumed

- Cluster/Sentinel branches in `connectionFactory.js` are written against ioredis's documented `Redis.Cluster` / sentinels constructor API but have never been exercised — there's no cluster or sentinel infrastructure in this sandbox to test against.
- `MODULE4_ROUTE_TTL_MS` (45s) and refresh interval (15s) are reasonable-default guesses, not tuned against real traffic patterns.

## Not Verified

- No real Redis instance, Cluster, or Sentinel was available to test against in this session — `setRoute`/`getRoute`/`clearRoute`/lock acquire-release were only exercised in the "Redis absent" no-op path, not against a live connection.
- No multi-instance test (two Node processes routing to each other) has been run.
- `ioredis` is not installed in this sandbox, so `Redis.Cluster` construction itself was never actually invoked — only read for correctness against ioredis's public API shape.

## Backward compatibility

- Zero risk to Module 3 or the current project: no shared files, no shared `require()` graph, no server.js changes, no `redis/` changes.
- Nothing in this step is wired into the running app. `socketsByUserId` in `server.js` is exactly as it was — this step doesn't change app behavior at all yet.
- When you're ready to merge, the integration point will be small and explicit: server.js's connect/disconnect handlers call `module4/redis/routing.js`'s `setRoute`/`clearRoute` alongside (not instead of) the existing local map, until you're ready to cut over reads too.

## Next (Step 4.3, not started)

Room seat/host/mute state migration, using `keyspace.roomKey()` + `lock.js`'s `withLock()` around seat writes — per the Step 4.1 order.
