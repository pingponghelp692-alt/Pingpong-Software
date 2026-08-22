// Minimal in-memory mock of a node-pg Pool, JUST enough to exercise
// wallet/index.js's real query strings (BEGIN/COMMIT/ROLLBACK, the exact
// INSERT/UPDATE/SELECT statements it issues) without needing a real
// Postgres server, which isn't reachable in this sandbox. This is not a
// general SQL engine — it pattern-matches the specific statement shapes
// wallet/index.js actually sends, on purpose, so a passing test here means
// "the real SQL those functions send does the right thing against
// Postgres-like transactional semantics," not "some unrelated mock logic
// happened to agree."
function createMockPool() {
    const ledger = new Map(); // txn_id -> row
    const balances = new Map(); // `${userId}:${currency}` -> balance

    function balKey(userId, currency) { return `${userId}:${currency}`; }

    function snapshot() {
        return { ledger: new Map([...ledger].map(([k, v]) => [k, { ...v }])), balances: new Map(balances) };
    }
    function restore(snap) {
        ledger.clear(); for (const [k, v] of snap.ledger) ledger.set(k, v);
        balances.clear(); for (const [k, v] of snap.balances) balances.set(k, v);
    }

    async function connect() {
        let txSnapshot = null;
        return {
            async query(text, params = []) {
                const sql = text.trim();

                if (sql.startsWith("-- module4/wallet/schema.sql") || sql.startsWith("CREATE TABLE")) {
                    return {}; // schema.sql itself — mock pool has no real tables to create, just no-op
                }

                if (sql === "BEGIN") { txSnapshot = snapshot(); return {}; }
                if (sql === "COMMIT") { txSnapshot = null; return {}; }
                if (sql === "ROLLBACK") { if (txSnapshot) restore(txSnapshot); txSnapshot = null; return {}; }

                if (sql.startsWith("INSERT INTO module4_wallet_ledger") && sql.includes("ON CONFLICT (txn_id) DO NOTHING") && sql.includes("RETURNING txn_id")) {
                    // Two shapes: the 6-col pending insert, and the 8-col clamp insert (with balance_after/completed_at).
                    const isClamp = sql.includes("balance_after, completed_at");
                    let row;
                    if (isClamp) {
                        const [txn_id, user_id, currency, amount, context, balance_after] = params;
                        row = { txn_id, user_id, currency, amount, status: "completed", reason: "ceiling-clamp-adjustment", context, balance_after, created_at: new Date(), completed_at: new Date() };
                    } else {
                        const [txn_id, user_id, currency, amount, reason, context] = params;
                        row = { txn_id, user_id, currency, amount, status: "pending", reason, context, balance_after: null, created_at: new Date(), completed_at: null };
                    }
                    if (ledger.has(row.txn_id)) return { rowCount: 0, rows: [] };
                    ledger.set(row.txn_id, row);
                    return { rowCount: 1, rows: [{ txn_id: row.txn_id }] };
                }

                if (sql.startsWith("INSERT INTO module4_wallet_ledger") && sql.includes("'completed'") && !sql.includes("ON CONFLICT")) {
                    // transfer's direct-completed credit insert
                    const [txn_id, user_id, currency, amount, reason, context] = params;
                    ledger.set(txn_id, { txn_id, user_id, currency, amount, status: "completed", reason, context, balance_after: null, created_at: new Date(), completed_at: new Date() });
                    return { rowCount: 1, rows: [] };
                }

                if (sql.startsWith("SELECT status, balance_after FROM module4_wallet_ledger")) {
                    const [txn_id] = params;
                    const row = ledger.get(txn_id);
                    return { rows: row ? [{ status: row.status, balance_after: row.balance_after }] : [] };
                }

                if (sql.startsWith("SELECT txn_id, status, balance_after FROM module4_wallet_ledger")) {
                    const rows = params.map((id) => ledger.get(id)).filter(Boolean).map((r) => ({ txn_id: r.txn_id, status: r.status, balance_after: r.balance_after }));
                    return { rows };
                }

                if (sql.startsWith("INSERT INTO module4_wallet_balances") && sql.includes("VALUES ($1, $2, 0)") && sql.includes("DO NOTHING")) {
                    const [user_id, currency] = params;
                    const k = balKey(user_id, currency);
                    if (!balances.has(k)) balances.set(k, 0);
                    return {};
                }

                if (sql.startsWith("UPDATE module4_wallet_balances") && sql.includes("SET balance = balance + $1") && sql.includes(">= 0") && sql.includes("RETURNING balance")) {
                    const [amount, user_id, currency] = params;
                    const k = balKey(user_id, currency);
                    const cur = balances.get(k) || 0;
                    const next = cur + amount;
                    if (next < 0) return { rowCount: 0, rows: [] };
                    balances.set(k, next);
                    return { rowCount: 1, rows: [{ balance: next }] };
                }

                if (sql.startsWith("UPDATE module4_wallet_balances") && sql.includes("SET balance = balance - $1") && sql.includes(">= 0") && sql.includes("RETURNING balance")) {
                    const [amount, user_id, currency] = params;
                    const k = balKey(user_id, currency);
                    const cur = balances.get(k) || 0;
                    const next = cur - amount;
                    if (next < 0) return { rowCount: 0, rows: [] };
                    balances.set(k, next);
                    return { rowCount: 1, rows: [{ balance: next }] };
                }

                if (sql.startsWith("UPDATE module4_wallet_balances") && sql.includes("SET balance = balance + $1") && sql.includes("RETURNING balance")) {
                    const [amount, user_id, currency] = params;
                    const k = balKey(user_id, currency);
                    const next = (balances.get(k) || 0) + amount;
                    balances.set(k, next);
                    return { rowCount: 1, rows: [{ balance: next }] };
                }

                if (sql.startsWith("UPDATE module4_wallet_balances") && sql.includes("SET balance = $1") && sql.includes("RETURNING balance")) {
                    const [balance, user_id, currency] = params;
                    balances.set(balKey(user_id, currency), balance);
                    return { rowCount: 1, rows: [{ balance }] };
                }

                if (sql.startsWith("UPDATE module4_wallet_ledger SET status = 'rejected'")) {
                    const [txn_id] = params;
                    const row = ledger.get(txn_id);
                    if (row) { row.status = "rejected"; row.completed_at = new Date(); }
                    return {};
                }

                if (sql.startsWith("UPDATE module4_wallet_ledger SET status = 'completed', balance_after")) {
                    const [balance_after, txn_id] = params;
                    const row = ledger.get(txn_id);
                    if (row) { row.status = "completed"; row.balance_after = balance_after; row.completed_at = new Date(); }
                    return {};
                }

                if (sql.startsWith("SELECT COALESCE(SUM(amount), 0) AS total FROM module4_wallet_ledger")) {
                    const [user_id, currency] = params;
                    let total = 0;
                    for (const row of ledger.values()) {
                        if (row.user_id === user_id && row.currency === currency && row.status === "completed") total += row.amount;
                    }
                    return { rows: [{ total }] };
                }

                if (sql.startsWith("SELECT balance FROM module4_wallet_balances")) {
                    const [user_id, currency] = params;
                    const k = balKey(user_id, currency);
                    return balances.has(k) ? { rows: [{ balance: balances.get(k) }] } : { rows: [] };
                }

                if (sql.startsWith("INSERT INTO module4_wallet_balances") && sql.includes("DO UPDATE SET balance")) {
                    const [user_id, currency, balance] = params;
                    balances.set(balKey(user_id, currency), balance);
                    return {};
                }

                if (sql.startsWith("SELECT * FROM module4_wallet_ledger WHERE txn_id")) {
                    const [txn_id] = params;
                    const row = ledger.get(txn_id);
                    return { rows: row ? [row] : [] };
                }

                throw new Error("mockPg: unhandled query shape: " + sql.slice(0, 120));
            },
            release() {},
        };
    }

    return {
        connect,
        async query(text, params) { const c = await connect(); try { return await c.query(text, params); } finally { c.release(); } },
        on() {},
        _debug: { ledger, balances },
    };
}

module.exports = { createMockPool };
