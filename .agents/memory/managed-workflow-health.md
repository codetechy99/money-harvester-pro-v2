---
name: Managed workflow health
description: Non-obvious Replit artifact workflow behavior around startup probes and managed shutdowns.
---

The API artifact's startup probe must use an endpoint that returns 200 from the artifact path, such as `/api/health`; probing the router prefix `/api` can report a false startup failure even while the server is healthy.

**Why:** The deployment sidecar probes the configured path before and during startup, while the Express router intentionally has no response at its prefix. A previous mockup workflow reached Vite's ready message and then received SIGTERM from the managed process supervisor; that is not evidence of a Vite compile failure.

**How to apply:** Verify the exact artifact health path with curl after restarting the managed workflow. Treat a SIGTERM only after a ready line as supervisor lifecycle behavior unless the workflow restarts into an error or fails to open its port.