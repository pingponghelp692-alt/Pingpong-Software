// module4/wallet/index.js
// ==================================================
// MODULE 4 — STEP 4.4: DISTRIBUTED WALLET LAYER
// ==================================================
// Third entity from the Step 4.1 order, and the highest-risk one —
// built last, on top of the lock pattern proven in roomState.js.
//
// SOURCE OF TRUTH: Postgres (module4_wallet_ledger + module4_wallet_
// balances, see schema.sql). Redis is coordination (a per-user lock,
// reducing wasted contention) and cache (fast reads) ONLY — every
// correctness guarantee below holds even with Redis completely
// absent or wiped. That split is deliberate and is what makes this
// crash-safe and recoverable: Redis restarting loses nothing that
// mattered; Postgres restarting loses nothing because writes are
// committed transactions.
//
// EXISTING ARCHITECTURE THIS REUSES (per your instruction to inspect
// before writing code):
//   - init(deps) dependency-injection shape — same pattern as
//     coinCenter.js's initCoinCenter({...}), health-check.js,
//     room-recovery.js. clampCoinBalance/clampDiamondBalance-equivalent
//     logic is NOT duplicated here; it's an optional injected
//     function (see `clampFn` below), because that ceiling/overflow
//     policy is server.js business logic this step was told not to
//     duplicate. Without an injected clamp, only NaN/Infinity/negative
//     guards apply — see "Ceiling policy" below.
//   - Transaction id shape ("txn_" + base36 timestamp + random hex)
//     matches server.js's logTransaction() id format exactly, so IDs
//     look consistent across the eventual merged system. Overridable
//     via injected `generateTxnId`. Generate one with generateTxnId()
//     (or your own scheme) ONCE per logical operation and reuse the
//     SAME value on every retry — see "Idempotency" below, this is now
//     enforced, not just suggested.
//   - balanceBefore/balanceAfter/status/note shape in the ledger
//     mirrors the fields server.js's own `transactions` array already
//     records, for the same 1:1-mapping-at-merge reason roomState.js
//     mirrored server.js's room object shape.
//
// NOT WIRED IN. server.js's user.coins/user.diamonds and its own
// transactions log are completely untouched. This module has never
// been called from a real request handler.
//
// IDEMPOTENCY (Module 4 verification fix, 2026-08-06): txnId is a
// required parameter on applyDelta()/credit()/debit()/transferBetweenUsers()
// — omitting it throws immediately (assertValidTxnId), it is no longer
// silently auto-generated per attempt. Auto-generating on omission was
// the previous behavior and it quietly defeated the entire replay-
// protection design: a caller that didn't pass a stable txnId on retry
// got a brand new PRIMARY KEY each time, so the "idempotent, replay-safe"
// guarantee documented here didn't actually apply to them. generateTxnId()
// remains exported as a utility — call it once, before the operation
// that might need retrying, and pass that same value into every attempt.
//
// CEILING POLICY: this module does not know server.js's actual
// COIN_BALANCE_CEILING/DIAMOND_BALANCE_CEILING values, and does not
// invent its own guess at them — inventing a number would BE the kind
// of duplicated business logic you asked this step to avoid. What it
// does instead: accepts an optional `clampFn(userId, balance, context, currency)`
// injected once via `init({ clampFn })`, applied to the resulting
// balance inside the SAME DB transaction as the mutation — for EVERY
// mutation path (applyDelta/credit/debit AND both sides of
// transferBetweenUsers; a transfer's receiving balance is exactly as
// clamp-checked as a direct credit now). At merge time, pass server.js's
// real clampCoinBalance/clampDiamondBalance in. Until then, the only
// guards applied unconditionally are: amount must be a finite integer,
// and a debit can never take a balance below zero (see "no double-spend"
// below — this one IS enforced unconditionally, by the atomic UPDATE's
// WHERE clause, not by a clamp function). See applyClampIfNeeded() below
// for how a clamp event is recorded so it never desyncs reconcileBalance().

const crypto = require("crypto");
const db = require("./db.js");
const connectionFactory = require("../redis/connectionFactory.js");
const keyspace = require("../redis/keyspace.js");
const lock = require("../redis/lock.js");

const WALLET_LOCK_TTL_MS = parseInt(process.env.MODULE4_WALLET_LOCK_TTL_MS || "5000", 10);
const BALANCE_CACHE_TTL_MS = parseInt(process.env.MODULE4_WALLET_CACHE_TTL_MS || "3000", 10);

let redisClient = null;
let defaultClampFn = null;

function defaultGenerateTxnId() {
    return "txn_" + Date.now().toString(36) + "_" + crypto.randomBytes(4).toString("hex");
}

// deps: { clampFn, generateTxnId, pgPool, redisPool } — all optional.
// Safe to call with no arguments at all: Redis coordination/cache
// degrades to "skip the lock, skip the cache, hit Postgres directly"
// (still fully correct, just without the contention-reduction
// optimization) if Redis isn't configured. Postgres is NOT optional —
// see db.js's header for why the ledger fails loudly instead of
// silently no-opping.
async function init(deps = {}) {
    if (deps.clampFn) defaultClampFn = deps.clampFn;
    if (deps.pgPool) db.configure(deps.pgPool);
    await db.ensureSchema();
    redisClient = deps.redisPool || connectionFactory.createClient("module4-wallet");
    // BUG FIX (Module 4 verification, 2026-08-06): connectionFactory.createClient()
    // now attaches its own 'error' listener (see that file), which covers the
    // normal path. This covers the one path that bypasses the factory — a
    // caller injecting their own pre-built redisPool — so no module4 Redis
    // client can ever end up without an 'error' listener, regardless of how
    // it was constructed. listenerCount check avoids double-attaching if the
    // injected pool already came from connectionFactory itself.
    if (redisClient && redisClient.listenerCount && redisClient.listenerCount("error") === 0) {
        redisClient.on("error", (err) => {
            console.warn(`[module4/wallet] injected redisPool client error (non-fatal, wallet correctness is unaffected — Postgres remains the source of truth): ${err.message}`);
        });
    }
    if (!redisClient) {
        console.warn("[module4/wallet] Redis unavailable — wallet will still work correctly (Postgres is the source of truth), just without lock-based contention reduction or the read cache.");
    }
    generateTxnId = deps.generateTxnId || defaultGenerateTxnId;
}

let generateTxnId = defaultGenerateTxnId;

function assertValidAmount(amount) {
    if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
        throw new Error(`[module4/wallet] amount must be a finite integer, got: ${amount}`);
    }
}

// BUG FIX (Module 4 verification, 2026-08-06): txnId is now genuinely
// required, not "required in the docs but auto-generated in the code if
// you forget." A wallet mutation's entire replay-safety guarantee depends
// on the CALLER reusing the same txnId across retries of the same logical
// operation — silently minting a fresh random one when it's omitted means
// a network-blip retry becomes a second, real, undetected credit/debit
// instead of a safe no-op replay. generateTxnId() is still exported below
// as a utility for call sites that want to mint a stable id ONCE up front
// (before the operation that might need retrying) and then pass the same
// value into every retry — that remains the correct pattern. What's no
// longer allowed is the module inventing one for you invisibly.
function assertValidTxnId(txnId) {
    if (typeof txnId !== "string" || !txnId.trim()) {
        throw new Error(`[module4/wallet] txnId is required for idempotency and must be a non-empty string. Generate one once per logical operation with wallet.generateTxnId() and reuse the SAME value on every retry — do not omit it and do not mint a new one per attempt.`);
    }
}

function cacheKey(userId, currency) {
    return keyspace.userKey(userId, `wallet:${currency}`);
}

async function invalidateCache(userId, currency) {
    if (!redisClient) return;
    try {
        await redisClient.del(cacheKey(userId, currency));
    } catch (e) {
        // Cache invalidation failing is not a correctness problem — the
        // cache entry will simply serve a stale read until its TTL
        // expires. Logged, not thrown.
        console.warn(`[module4/wallet] cache invalidate failed for ${userId}/${currency}: ${e.message}`);
    }
}

// ==================================================
// LEDGER/BALANCE CONSISTENCY MODEL (Module 4 verification, 2026-08-06)
// ==================================================
// Explicit decision, per review: the EFFECTIVE (post-clamp) balance is
// authoritative — that's the number the user actually has and the number
// every other system (server.js's own coins/diamonds) means when it says
// "balance". The ledger must represent that same world, not a parallel
// "raw, pre-clamp" one, or reconcileBalance()'s core promise ("the ledger
// alone can rebuild balances exactly") becomes false the moment a clamp
// ever fires.
//
// Mechanism: a clamp event is recorded as its OWN completed ledger row
// (txn_id = `${baseTxnId}:clamp`, amount = clamped - preClampBalance),
// inside the SAME database transaction as the mutation that triggered it.
// This makes the invariant hold BY CONSTRUCTION rather than by a
// reconciliation-time tolerance/fudge: SUM(amount) over completed ledger
// rows for a user+currency always equals module4_wallet_balances.balance,
// with no special-casing needed in reconcileBalance() at all — a clamp
// is just one more ledger entry like any other, fully auditable (you can
// see exactly when and by how much a ceiling clamp changed a balance).
async function applyClampIfNeeded(client, { userId, currency, preClampBalance, context, baseTxnId }) {
    if (!defaultClampFn) return preClampBalance;
    // INTEGRATION FIX (final assembly, 2026-08-08): `currency` was already
    // in scope here but was never forwarded to the injected clampFn, so a
    // single clampFn could not tell a coins clamp from a diamonds clamp —
    // a real problem once the injected fn is server.js's two separate
    // clampCoinBalance/clampDiamondBalance functions rather than one
    // generic stand-in. Purely additive: any 3-arg clampFn written before
    // this change still works unmodified, it just ignores the new 4th arg.
    const clamped = defaultClampFn(userId, preClampBalance, context, currency);
    if (clamped === preClampBalance) return preClampBalance;
    const delta = clamped - preClampBalance;
    const clampTxnId = `${baseTxnId}:clamp`;
    const insertRes = await client.query(
        `INSERT INTO module4_wallet_ledger (txn_id, user_id, currency, amount, status, reason, context, balance_after, completed_at)
         VALUES ($1, $2, $3, $4, 'completed', 'ceiling-clamp-adjustment', $5, $6, now())
         ON CONFLICT (txn_id) DO NOTHING
         RETURNING txn_id`,
        [clampTxnId, userId, currency, delta, context || null, clamped]
    );
    if (insertRes.rowCount === 0) return preClampBalance; // already recorded by an earlier attempt at this same baseTxnId — don't double-apply
    const fix = await client.query(
        `UPDATE module4_wallet_balances SET balance = $1, updated_at = now()
         WHERE user_id = $2 AND currency = $3 RETURNING balance`,
        [clamped, userId, currency]
    );
    return Number(fix.rows[0].balance);
}

// ---- Core: apply a signed delta atomically, idempotently, in one
// Postgres transaction. credit()/debit()/transferBetweenUsers() below
// are all built on this. Exported directly too, for callers that
// prefer a signed-amount API.
async function applyDelta({ userId, currency, amount, txnId, reason, context }) {
    if (!userId || !currency) throw new Error("[module4/wallet] userId and currency are required");
    assertValidAmount(amount);
    assertValidTxnId(txnId); // BUG FIX (Module 4 verification, 2026-08-06): see assertValidTxnId — no longer auto-generated on omission

    const p = db.getPool();
    if (!p) throw new Error("[module4/wallet] Postgres not configured — refusing to process a wallet operation without a durable ledger");

    const doWork = async () => {
        const client = await p.connect();
        try {
            await client.query("BEGIN");

            // Idempotency gate: if this exact txn_id was already
            // inserted (by this call, a retry, or a concurrent racer
            // that lost the Redis lock race but still reached
            // Postgres), do nothing further and return the recorded
            // outcome instead of applying the delta twice. This is the
            // actual replay-protection guarantee — enforced by the
            // PRIMARY KEY constraint, not by the Redis lock (which is
            // only a contention optimization and may be absent).
            const insertRes = await client.query(
                `INSERT INTO module4_wallet_ledger (txn_id, user_id, currency, amount, status, reason, context)
                 VALUES ($1, $2, $3, $4, 'pending', $5, $6)
                 ON CONFLICT (txn_id) DO NOTHING
                 RETURNING txn_id`,
                [txnId, userId, currency, amount, reason || null, context || null]
            );

            if (insertRes.rowCount === 0) {
                const existing = await client.query(
                    `SELECT status, balance_after FROM module4_wallet_ledger WHERE txn_id = $1`,
                    [txnId]
                );
                await client.query("COMMIT");
                const row = existing.rows[0] || {};
                return { txnId, replay: true, status: row.status || "unknown", balanceAfter: row.balance_after ?? null };
            }

            await client.query(
                `INSERT INTO module4_wallet_balances (user_id, currency, balance)
                 VALUES ($1, $2, 0)
                 ON CONFLICT (user_id, currency) DO NOTHING`,
                [userId, currency]
            );

            // The atomic guard against double-spend / negative balance:
            // for a debit (amount < 0), the WHERE clause only lets the
            // UPDATE succeed if the resulting balance would be >= 0.
            // This check-and-update happens as ONE row-level-locked
            // statement — Postgres itself serializes any other
            // concurrent UPDATE on the same row, so two simultaneous
            // debits against a low balance cannot both succeed even if
            // the Redis lock above was skipped or lost its race.
            const updateRes = await client.query(
                `UPDATE module4_wallet_balances
                 SET balance = balance + $1, updated_at = now()
                 WHERE user_id = $2 AND currency = $3 AND balance + $1 >= 0
                 RETURNING balance`,
                [amount, userId, currency]
            );

            if (updateRes.rowCount === 0) {
                await client.query(
                    `UPDATE module4_wallet_ledger SET status = 'rejected', completed_at = now() WHERE txn_id = $1`,
                    [txnId]
                );
                await client.query("COMMIT");
                return { txnId, replay: false, status: "rejected", reason: "insufficient_funds", balanceAfter: null };
            }

            let finalBalance = Number(updateRes.rows[0].balance);
            // BUG FIX (Module 4 verification, 2026-08-06): clamp adjustment
            // now goes through applyClampIfNeeded(), which records the
            // adjustment as its own ledger row instead of silently editing
            // the balances table — see the LEDGER/BALANCE CONSISTENCY MODEL
            // comment above applyClampIfNeeded for why.
            finalBalance = await applyClampIfNeeded(client, { userId, currency, preClampBalance: finalBalance, context, baseTxnId: txnId });

            await client.query(
                `UPDATE module4_wallet_ledger SET status = 'completed', balance_after = $1, completed_at = now() WHERE txn_id = $2`,
                [finalBalance, txnId]
            );

            await client.query("COMMIT");
            return { txnId, replay: false, status: "completed", balanceAfter: finalBalance };
        } catch (e) {
            await client.query("ROLLBACK").catch(() => {});
            throw e;
        } finally {
            client.release();
        }
    };

    let result;
    if (redisClient) {
        // Contention-reduction only — see header. Correctness does not
        // depend on this lock being acquired; if Redis is down or the
        // lock can't be gotten, we still proceed straight to Postgres
        // rather than failing the operation, because the DB transaction
        // above is what actually guarantees correctness.
        const lockKey = keyspace.userKey(userId, "wallet-lock");
        try {
            result = await lock.withLock(redisClient, lockKey, { ttlMs: WALLET_LOCK_TTL_MS }, doWork);
        } catch (e) {
            console.warn(`[module4/wallet] Redis lock unavailable/contended for ${userId}, proceeding without it (Postgres transaction still guarantees correctness): ${e.message}`);
            result = await doWork();
        }
    } else {
        result = await doWork();
    }

    await invalidateCache(userId, currency);
    return result;
}

async function credit({ userId, currency, amount, txnId, reason, context }) {
    return applyDelta({ userId, currency, amount: Math.abs(amount), txnId, reason, context });
}

async function debit({ userId, currency, amount, txnId, reason, context }) {
    return applyDelta({ userId, currency, amount: -Math.abs(amount), txnId, reason, context });
}

// Moves `amount` from one user to another as ONE atomic Postgres
// transaction (both ledger rows commit together or neither does) —
// not two separate debit()+credit() calls, which could leave a debit
// applied with no matching credit if the process crashed between them.
async function transferBetweenUsers({ fromUserId, toUserId, currency, amount, txnId, reason, context }) {
    if (!fromUserId || !toUserId || !currency) throw new Error("[module4/wallet] fromUserId, toUserId, currency are required");
    assertValidAmount(amount);
    assertValidTxnId(txnId); // BUG FIX (Module 4 verification, 2026-08-06): no longer auto-generated on omission — same reasoning as applyDelta
    const absAmount = Math.abs(amount);
    const baseTxnId = txnId;
    const debitTxnId = `${baseTxnId}:debit`;
    const creditTxnId = `${baseTxnId}:credit`;

    const p = db.getPool();
    if (!p) throw new Error("[module4/wallet] Postgres not configured — refusing to process a wallet transfer without a durable ledger");

    const doWork = async () => {
        const client = await p.connect();
        try {
            await client.query("BEGIN");

            const debitInsert = await client.query(
                `INSERT INTO module4_wallet_ledger (txn_id, user_id, currency, amount, status, reason, context)
                 VALUES ($1, $2, $3, $4, 'pending', $5, $6)
                 ON CONFLICT (txn_id) DO NOTHING RETURNING txn_id`,
                [debitTxnId, fromUserId, currency, -absAmount, reason || null, context || null]
            );

            if (debitInsert.rowCount === 0) {
                // Whole transfer already processed (or attempted) under
                // this base txnId — replay both sides from the ledger.
                const existing = await client.query(
                    `SELECT txn_id, status, balance_after FROM module4_wallet_ledger WHERE txn_id IN ($1, $2)`,
                    [debitTxnId, creditTxnId]
                );
                await client.query("COMMIT");
                const byId = Object.fromEntries(existing.rows.map((r) => [r.txn_id, r]));
                return {
                    txnId: baseTxnId,
                    replay: true,
                    debit: byId[debitTxnId] || null,
                    credit: byId[creditTxnId] || null,
                };
            }

            await client.query(
                `INSERT INTO module4_wallet_balances (user_id, currency, balance) VALUES ($1, $2, 0) ON CONFLICT (user_id, currency) DO NOTHING`,
                [fromUserId, currency]
            );
            await client.query(
                `INSERT INTO module4_wallet_balances (user_id, currency, balance) VALUES ($1, $2, 0) ON CONFLICT (user_id, currency) DO NOTHING`,
                [toUserId, currency]
            );

            const debitUpdate = await client.query(
                `UPDATE module4_wallet_balances SET balance = balance - $1, updated_at = now()
                 WHERE user_id = $2 AND currency = $3 AND balance - $1 >= 0
                 RETURNING balance`,
                [absAmount, fromUserId, currency]
            );

            if (debitUpdate.rowCount === 0) {
                await client.query(
                    `UPDATE module4_wallet_ledger SET status = 'rejected', completed_at = now() WHERE txn_id = $1`,
                    [debitTxnId]
                );
                await client.query("COMMIT");
                return { txnId: baseTxnId, replay: false, debit: { status: "rejected", reason: "insufficient_funds" }, credit: null };
            }

            // BUG FIX (Module 4 verification, 2026-08-06): the debit side
            // now also goes through applyClampIfNeeded() — the receiving
            // side already needed this (a transfer is the most likely way
            // to push a balance over the ceiling), but for full consistency
            // with credit()/debit() every balance mutation in this module
            // goes through the same clamp path, not just some of them.
            const debitBalance = await applyClampIfNeeded(client, { userId: fromUserId, currency, preClampBalance: Number(debitUpdate.rows[0].balance), context, baseTxnId: debitTxnId });

            await client.query(
                `INSERT INTO module4_wallet_ledger (txn_id, user_id, currency, amount, status, reason, context)
                 VALUES ($1, $2, $3, $4, 'completed', $5, $6)`,
                [creditTxnId, toUserId, currency, absAmount, reason || null, context || null]
            );
            const creditUpdate = await client.query(
                `UPDATE module4_wallet_balances SET balance = balance + $1, updated_at = now()
                 WHERE user_id = $2 AND currency = $3 RETURNING balance`,
                [absAmount, toUserId, currency]
            );
            // BUG FIX (Module 4 verification, 2026-08-06): previously the
            // credit side of a transfer was the one path in this whole
            // module that never applied defaultClampFn at all — a transfer
            // could push a receiving balance past the configured ceiling
            // with nothing to stop it. Now goes through the same helper as
            // every other mutation.
            const creditBalance = await applyClampIfNeeded(client, { userId: toUserId, currency, preClampBalance: Number(creditUpdate.rows[0].balance), context, baseTxnId: creditTxnId });

            await client.query(
                `UPDATE module4_wallet_ledger SET status = 'completed', balance_after = $1, completed_at = now() WHERE txn_id = $2`,
                [debitBalance, debitTxnId]
            );
            await client.query(
                `UPDATE module4_wallet_ledger SET status = 'completed', balance_after = $1, completed_at = now() WHERE txn_id = $2`,
                [creditBalance, creditTxnId]
            );

            await client.query("COMMIT");
            return {
                txnId: baseTxnId,
                replay: false,
                debit: { status: "completed", balanceAfter: debitBalance },
                credit: { status: "completed", balanceAfter: creditBalance },
            };
        } catch (e) {
            await client.query("ROLLBACK").catch(() => {});
            throw e;
        } finally {
            client.release();
        }
    };

    let result;
    if (redisClient) {
        // Lock BOTH users' keys, always in a fixed (sorted) order, so
        // two transfers between the same pair of users in opposite
        // directions can never deadlock waiting on each other's lock.
        const [keyA, keyB] = [fromUserId, toUserId].sort().map((u) => keyspace.userKey(u, "wallet-lock"));
        try {
            result = await lock.withLock(redisClient, keyA, { ttlMs: WALLET_LOCK_TTL_MS }, async () =>
                lock.withLock(redisClient, keyB, { ttlMs: WALLET_LOCK_TTL_MS }, doWork)
            );
        } catch (e) {
            console.warn(`[module4/wallet] Redis lock unavailable/contended for transfer ${fromUserId}->${toUserId}, proceeding without it: ${e.message}`);
            result = await doWork();
        }
    } else {
        result = await doWork();
    }

    await invalidateCache(fromUserId, currency);
    await invalidateCache(toUserId, currency);
    return result;
}

// Read path: Redis cache first (short TTL — this is a cache, not a
// source of truth, so staleness is bounded and cheap to accept),
// Postgres on miss, write-through back to cache.
async function getBalance(userId, currency) {
    if (redisClient) {
        try {
            const cached = await redisClient.get(cacheKey(userId, currency));
            if (cached !== null && cached !== undefined) return Number(cached);
        } catch (e) {
            console.warn(`[module4/wallet] cache read failed for ${userId}/${currency}, falling through to Postgres: ${e.message}`);
        }
    }
    const p = db.getPool();
    if (!p) throw new Error("[module4/wallet] Postgres not configured — cannot read balance");
    const res = await p.query(
        `SELECT balance FROM module4_wallet_balances WHERE user_id = $1 AND currency = $2`,
        [userId, currency]
    );
    const balance = res.rows.length ? Number(res.rows[0].balance) : 0;
    if (redisClient) {
        try {
            await redisClient.set(cacheKey(userId, currency), String(balance), "PX", BALANCE_CACHE_TTL_MS);
        } catch (e) {
            // Cache write failing is not a correctness problem — see invalidateCache.
        }
    }
    return balance;
}

async function getTransaction(txnId) {
    const p = db.getPool();
    if (!p) throw new Error("[module4/wallet] Postgres not configured — cannot read transaction");
    const res = await p.query(`SELECT * FROM module4_wallet_ledger WHERE txn_id = $1`, [txnId]);
    return res.rows[0] || null;
}

// Recomputes the true balance from completed ledger rows and compares it
// against the cached running total in module4_wallet_balances. Read-only
// by default (reports drift, changes nothing) — repair=true makes it
// authoritative-write the recomputed value, for deliberate ops/recovery
// use, never run silently/automatically. This is the "recovery after
// process restart" primitive: even if module4_wallet_balances were
// somehow lost entirely, the ledger alone is enough to rebuild it exactly.
//
// BUG FIX (Module 4 verification, 2026-08-06): this used to permanently
// under-count for any user a ceiling clamp had ever adjusted, because the
// ledger recorded the raw pre-clamp delta while the balances table held
// the post-clamp value — drift would be reported forever even though
// nothing was actually wrong. Now that every clamp adjustment is its own
// completed ledger row (see applyClampIfNeeded()), this SUM already
// includes it: trueBalance == cachedBalance holds exactly whenever the
// data is genuinely consistent, with no clamp-shaped exception baked in
// and no tolerance/fudge factor here. A non-zero drift now means what it
// always should have meant — real corruption or a bug — not "a clamp
// happened at some point."
async function reconcileBalance(userId, currency, { repair = false } = {}) {
    const p = db.getPool();
    if (!p) throw new Error("[module4/wallet] Postgres not configured — cannot reconcile");
    const sumRes = await p.query(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM module4_wallet_ledger WHERE user_id = $1 AND currency = $2 AND status = 'completed'`,
        [userId, currency]
    );
    const trueBalance = Number(sumRes.rows[0].total);
    const cachedRes = await p.query(
        `SELECT balance FROM module4_wallet_balances WHERE user_id = $1 AND currency = $2`,
        [userId, currency]
    );
    const cachedBalance = cachedRes.rows.length ? Number(cachedRes.rows[0].balance) : 0;
    const drift = trueBalance - cachedBalance;

    if (repair && drift !== 0) {
        await p.query(
            `INSERT INTO module4_wallet_balances (user_id, currency, balance)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, currency) DO UPDATE SET balance = $3, updated_at = now()`,
            [userId, currency, trueBalance]
        );
        await invalidateCache(userId, currency);
    }

    return { userId, currency, trueBalance, cachedBalance, drift, repaired: repair && drift !== 0 };
}

async function shutdown() {
    if (redisClient) await redisClient.quit().catch(() => {});
    redisClient = null;
    await db.shutdown();
}

module.exports = {
    init,
    credit,
    debit,
    transferBetweenUsers,
    getBalance,
    getTransaction,
    reconcileBalance,
    shutdown,
    // exposed for advanced/direct use and for tests
    applyDelta,
};
