// Lightweight Prometheus exposition with zero runtime dependencies.
// Metrics are derived from existing application state; this module never
// mutates rooms, users, sockets, or voice state.
function escapeLabel(v) { return String(v).replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\n/g,'\\n'); }
function metric(name, help, type, value, labels = {}) {
  const labelText = Object.keys(labels).map(k => `${k}="${escapeLabel(labels[k])}"`).join(',');
  return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name}${labelText ? `{${labelText}}` : ''} ${Number.isFinite(Number(value)) ? Number(value) : 0}`;
}
function createMetrics({ rooms = {}, socketsByUserId = {}, voiceHealth = null } = {}) {
  return function render() {
    const roomCount = Object.keys(rooms).length;
    const onlineUsers = Object.keys(socketsByUserId).length;
    let activeSeats = 0;
    for (const room of Object.values(rooms)) activeSeats += (room.seats || []).filter(Boolean).length;
    let voiceRooms = 0, voiceParticipants = 0;
    try {
      const summary = voiceHealth && typeof voiceHealth.getGlobalSummary === 'function' ? voiceHealth.getGlobalSummary() : null;
      voiceRooms = Number(summary?.activeRooms || 0);
      voiceParticipants = Number(summary?.participants || summary?.connectedUsers || 0);
    } catch (_) {}
    return [
      metric('pingpong_rooms_active','Active room count','gauge',roomCount),
      metric('pingpong_users_online','Users with an active local socket','gauge',onlineUsers),
      metric('pingpong_seats_occupied','Occupied room seats','gauge',activeSeats),
      metric('pingpong_voice_rooms_active','Voice-health active rooms','gauge',voiceRooms),
      metric('pingpong_voice_participants','Voice-health participant count','gauge',voiceParticipants),
      metric('pingpong_process_uptime_seconds','Node process uptime','gauge',process.uptime()),
    ].join('\n') + '\n';
  };
}
module.exports = { createMetrics };
