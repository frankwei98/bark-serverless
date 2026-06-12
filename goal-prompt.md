# Goal Prompt For Follow-on AI

Read `migration.md` and `spec.md` first, then inspect the current Worker scaffold under `worker/src/**` and tests under `worker/test/**`.

Your goal is to finish the TypeScript Cloudflare Worker migration for this Bark server without redesigning the project. The scaffold already exists and most compatibility tests already pass. You must complete the remaining business logic so the Worker is production-ready for the current scope.

Concrete objectives:

1. Implement the production APNs sender in `worker/src/cloudflare-apns-client.ts`.
2. Implement MCP endpoint compatibility in `worker/src/mcp.ts`.
3. Replace the MCP `todo` tests with real tests in `worker/test/mcp.test.ts`.
4. Add any focused APNs/MCP tests needed to lock behavior.
5. Keep all existing tests green.
6. Finish with `pnpm test`, `pnpm check`, and `pnpm build` all passing.

Constraints:

- Preserve the current HTTP API contract from the Go code.
- Do not redesign folder layout, dependency injection, or package management.
- Do not add MySQL, bbolt, CLI behavior, or unrelated refactors.
- Preserve auth behavior, teapot responses, parameter precedence, batch push semantics, and invalid-token cleanup.
- For `/mcp/:device_key`, the path device key must override any tool-argument device key.
- Do not reinterpret Bark custom fields as APNs-native fields unless the Go implementation already does so.

Working style:

- Start from the existing tests and source files, not from assumptions.
- Make the smallest correct changes that satisfy the documented contract.
- If you believe there is an ambiguity, check `migration.md`, `spec.md`, the Go source, and the existing TypeScript tests before changing behavior.
- Only ask questions if you hit a real blocker that is not answerable from the repository.
- Do not stop at a partial implementation. Carry the task through to passing tests and build verification.

Deliverable:

- committed code changes are not required, but the repository working tree should contain a finished implementation with all tests/build checks passing for the scoped migration.
