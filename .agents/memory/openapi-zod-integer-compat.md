---
name: OpenAPI integer compatibility
description: Compatibility constraint between Orval's Zod output and the workspace's installed Zod runtime.
---

Use numeric OpenAPI schemas for integer-like API fields when this workspace's generated Zod client targets Zod 3; Orval can emit zod.int(), which Zod 3 does not expose.

**Why:** A generated client can succeed while the chained library typecheck fails if the OpenAPI schema uses integer and the generator emits a newer Zod API.

**How to apply:** If integer validation is important, validate it explicitly at the server boundary or revisit the workspace Zod/Orval versions together instead of changing only the generated files.