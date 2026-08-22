// ai/ai-recovery.js
// Deliberately minimal. Per the spec's own "AI Permissions" section, the AI
// must never perform destructive operations automatically — and a Node
// process genuinely cannot safely "restart itself" from inside itself.
// What it CAN safely do without any admin approval is retry a transient,
// idempotent async operation (e.g. one failed Gemini call) a couple of
// times before giving up and logging it for the admin to see.
//
// If you want real "restart crashed services" behavior (Socket.IO server,
// worker processes, etc.), that has to be done by a process manager sitting
// OUTSIDE this Node process (e.g. PM2 with `pm2 start server.js -i max
// --max-memory-restart 500M`, or your host's equivalent) — a process can't
// reliably resurrect itself after it crashes.
const logger = require("./ai-logger");

function retryJob(jobFn, retries = 2) {
    return new Promise((resolve, reject) => {
        let attempt = 0;
        function tryOnce() {
            attempt++;
            Promise.resolve().then(jobFn).then(resolve).catch((err) => {
                logger.log({ module: "ai-recovery", action: "retry", attempt, result: attempt <= retries ? "retrying" : "gave-up", error: err.message });
                if (attempt <= retries) tryOnce(); else reject(err);
            });
        }
        tryOnce();
    });
}

module.exports = { retryJob };
