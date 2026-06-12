# Goal Prompt For Follow-on AI

Read `migration.md` and `spec.md` first, then inspect the current Worker scaffold under `worker/src/**` and tests under `worker/test/**`.

Your goal is to validate and production-harden the TypeScript Cloudflare Worker migration for this Bark server without redesigning the project. The core business logic is already implemented: HTTP routes, KV registry, APNs sender, MCP endpoints, and compatibility tests exist.

Concrete objectives:

1. Run `pnpm test`, `pnpm check`, and `pnpm build` before changing behavior.
2. Review the migration diff with `git diff 478659ecdd75a38185d7275d154d78e9c2b752b4`.
3. Confirm Cloudflare bindings: `DEVICE_REGISTRY`, `APNS_PRIVATE_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`, and `APNS_TOPIC`.
4. Verify `APNS_PRIVATE_KEY` is full PKCS#8 PEM text with `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----`.
5. Run Worker preview/staging smoke tests if deployment access is available.
6. Fix only concrete parity or production-readiness issues, and add focused regression tests for every fix.
7. Finish with `pnpm test`, `pnpm check`, and `pnpm build` all passing.

Constraints:

- Preserve the current HTTP API contract from the Go code.
- Do not redesign folder layout, dependency injection, or package management.
- Do not add MySQL, bbolt, CLI behavior, or unrelated refactors.
- Preserve auth behavior, teapot responses, parameter precedence, batch push semantics, and invalid-token cleanup.
- For `/mcp/:device_key`, the path device key must override any tool-argument device key.
- Do not reinterpret Bark custom fields as APNs-native fields unless the Go implementation already does so.
- Do not reimplement APNs or MCP from scratch unless a specific failing case proves the current implementation wrong.

Working style:

- Start from the existing tests and source files, not from assumptions.
- Make the smallest correct changes that satisfy the documented contract.
- If you believe there is an ambiguity, check `migration.md`, `spec.md`, the Go source, and the existing TypeScript tests before changing behavior.
- Only ask questions if you hit a real blocker that is not answerable from the repository.
- Do not stop at a partial validation. Carry fixes through to passing tests and build verification.

Deliverable:

- committed code changes are not required, but the repository working tree should contain a validated implementation with all tests/build checks passing for the scoped migration.
