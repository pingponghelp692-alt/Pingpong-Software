# Admin Panel Extensions

Built as an additive manifest layer. `index.js` exposes the currently
concrete admin extensions (Merchants, AI, and SFU) and resolves visibility
from existing RBAC permission names. The actual business routes remain owned
by their existing modules, avoiding duplicate engines.
