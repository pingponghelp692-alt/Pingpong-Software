# Middleware

Built. `index.js` contains only reusable transport-level helpers: request IDs,
no-store headers, JSON content enforcement, and safe middleware composition.
It contains no authentication or business logic and does not replace the
existing security middleware.
