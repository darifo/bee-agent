---
'@bee-agent/bee': minor
---

Apply the security defaults from architecture §16.4 to the host. CORS no longer reflects any origin — it defaults to a loopback-only policy (`loopbackOrigins`) and both the Fastify routes and the hijacked SSE stream honor it. Binding a non-loopback address now fails closed unless a `BEE_AGENT_SESSION_TOKEN` is set (`unsafeListenReason`); the host generates a fresh one-time session token per startup and enforces it via `Authorization: Bearer` on every route except `/health`.
