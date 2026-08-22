// PM2 process manager configuration.
//
// Usage:
//   pm2 start ecosystem.config.js --env production
//   pm2 save                # persist the process list across reboots
//   pm2 startup             # generate the OS-level boot script (run once)
//   pm2 logs pingpong        # tail logs
//   pm2 reload pingpong      # zero-downtime reload (see note below)
//
// Single instance, NOT cluster mode: this app keeps its state (users,
// rooms, sockets, admin sessions, approval requests, ban records) in
// in-memory JS objects backed by JSON files (see perf/writeQueue.js),
// not a shared external store. Running more than one instance (cluster
// mode or multiple `instances`) would split that state across processes
// with no coordination — two instances would each think they own the
// full user base and both write to the same JSON files, corrupting data.
// Scale this app by giving the single Node process more resources, not
// by adding instances, unless/until the storage layer is migrated to a
// real shared database (out of scope for this phase — see
// RBAC_MIGRATION_NOTES.md).
module.exports = {
    apps: [
        {
            name: "pingpong",
            script: "server.js",
            instances: 1,
            exec_mode: "fork",
            watch: false, // don't restart on file changes in production
            max_memory_restart: "500M", // restart if a leak grows past this — automatic restart on crash is on by default in PM2 (autorestart: true)
            autorestart: true,
            min_uptime: "10s", // treat a crash-loop (<10s uptime) as failing, not a clean restart
            max_restarts: 15,
            restart_delay: 2000,
            // Graceful shutdown: server.js/writeQueue.js flush pending debounced
            // disk writes on SIGINT/SIGTERM and then exit. kill_timeout gives
            // that flush (and any in-flight request) time to finish before PM2
            // sends SIGKILL. This does NOT yet drain open Socket.IO connections
            // gracefully before exit — see RBAC_MIGRATION_NOTES.md Phase 13
            // "known limitations" for the honest caveat and why it wasn't
            // changed here (avoiding touching the existing, working shutdown
            // code in perf/writeQueue.js).
            kill_timeout: 8000,
            env: {
                NODE_ENV: "development"
            },
            env_production: {
                NODE_ENV: "production"
            },
            error_file: "logs/pm2-error.log",
            out_file: "logs/pm2-out.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss Z",
            merge_logs: true,
            // PM2's own log rotation — install once on the host:
            //   pm2 install pm2-logrotate
            //   pm2 set pm2-logrotate:max_size 10M
            //   pm2 set pm2-logrotate:retain 14
            //   pm2 set pm2-logrotate:compress true
        }
    ]
};
