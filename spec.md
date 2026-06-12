# Worker Implementation Spec For Follow-on AI

## Mission

Finish the TypeScript Cloudflare Worker migration in this repository without redesigning it.

Your job is to complete the missing production behavior so the Worker can replace the Go HTTP API for normal use. The scaffold and tests already exist. Treat them as the baseline contract, not as optional suggestions.

## Read This First

Read these files before making decisions:

- `migration.md`
- `worker/src/app.ts`
- `worker/src/push.ts`
- `worker/src/register.ts`
- `worker/src/cloudflare-apns-client.ts`
- `worker/src/mcp.ts`
- `worker/test/**/*.test.ts`
- `route_push.go`
- `route_register.go`
- `route_auth.go`
- `route_mcp.go`
- `apns/apns.go`
- `docs/API_V2.md`
- `docs/MCP.md`

Do not ask questions that are already answered by those files.

## Current Starting State

Already done:

- `pnpm` project scaffold exists
- Worker app boots
- misc, auth, register, and push compatibility scaffolding exists
- in-memory fakes exist for route tests
- `pnpm check` passes
- `pnpm test` passes
- `pnpm build` dry-run bundles successfully
- in this sandbox, Wrangler may emit an `EPERM` warning when writing `~/.wrangler/logs`; do not treat that alone as a build failure if bundling itself completed

Not done:

- production APNs sender
- MCP endpoint behavior
- MCP tests

Current placeholder files:

- `worker/src/cloudflare-apns-client.ts`
- `worker/src/mcp.ts`
- `worker/test/mcp.test.ts`

## Scope

You are responsible for:

- completing APNs production sending
- completing MCP route behavior
- adding or tightening tests for those features
- fixing any parity gaps discovered while doing that work

You are **not** responsible for:

- reintroducing Go CLI/process behavior
- adding MySQL or `bbolt` back into the Worker path
- changing package manager away from `pnpm`
- redesigning folder layout or dependency injection boundaries
- “improving” public API behavior in ways that diverge from the Go implementation

## Mandatory Design Decisions

These decisions are already made. Do not reopen them unless a hard blocker makes the scaffold impossible to finish.

- Runtime: Cloudflare Worker
- Router: Hono
- Storage: Cloudflare KV
- Package manager: `pnpm`
- Test runner: Vitest
- Architecture: dependency injection through `RuntimeDeps`, `DeviceRegistry`, and `PushSender`
- Response contract: preserve current JSON/plain-text shapes
- Auth contract: preserve current `418` teapot behavior

## Files You Should Edit

Primary implementation files:

- `worker/src/cloudflare-apns-client.ts`
- `worker/src/mcp.ts`
- `worker/test/mcp.test.ts`

Possible supporting edits if needed:

- `worker/src/types.ts`
- `worker/src/push.ts`
- `worker/src/app.ts`
- `worker/test/helpers/fakes.ts`

Do not rewrite unrelated files just because you prefer a different layout.

## Non-Obvious Compatibility Rules

Preserve these exactly:

- JSON content type chooses V2 push parsing.
- Non-JSON requests choose V1 push parsing.
- Path params override body and query values.
- `/ping`, `/register`, and `/healthz` bypass auth.
- Root `/` stays accessible even when auth is enabled.
- Unauthorized protected requests return HTTP `418` plain text body `I'm a teapot`.
- Push errors caused by APNs still surface as HTTP `500` from the route layer, even if APNs itself returned another status code.
- Bad APNs tokens must trigger key cleanup.
- Batch push returns HTTP `200` with per-device result rows in input order.
- `GET /register` must support legacy `key` and `devicetoken`.
- `device_token` length over 160 must fail.
- `/mcp/:device_key` path value must override any `device_key` provided in tool arguments, even though the Go comment says otherwise.

## APNs Exact Requirements

Implement production APNs in `worker/src/cloudflare-apns-client.ts`.

### Credentials

Take credentials from Worker env:

- `APNS_PRIVATE_KEY`
- `APNS_KEY_ID`
- `APNS_TEAM_ID`
- `APNS_TOPIC`

Treat missing required credentials as configuration errors with explicit messages.

### JWT

Create an ES256 JWT using Worker Web Crypto.

JWT header:

- `alg = ES256`
- `kid = APNS_KEY_ID`

JWT payload:

- `iss = APNS_TEAM_ID`
- `iat = current unix seconds`

Use PKCS#8 import logic for the `.p8` private key text.

### Request

Send `POST` to:

- `https://api.push.apple.com/3/device/{deviceToken}`

Headers:

- `authorization: bearer <jwt>`
- `apns-topic: <APNS_TOPIC>`
- `apns-expiration: <now + 86400>`
- `content-type: application/json`
- `apns-push-type: alert` for normal notifications
- `apns-push-type: background` when `delete` triggers silent behavior
- `apns-collapse-id` only when `id` exists

### Payload

Build payload with Go parity, not “better” APNs semantics.

Always include:

- `aps.mutable-content = 1`

Normal push:

- `aps.alert.title = title`
- `aps.alert.subtitle = subtitle`
- `aps.alert.body = body`
- `aps.sound = sound`
- `aps.category = "myNotificationCategory"`
- `aps.thread-id = group` if group exists

Delete/background push:

- `aps.content-available = 1`
- do not add alert/sound/category/thread-id

Custom fields:

- every `extParams` entry goes on the top-level payload
- custom field names must be lowercased
- custom field values must be stringified like Go `fmt.Sprintf("%v", v)`

Important: do **not** reinterpret fields like `badge`, `level`, `volume`, `url`, `copy`, `image`, or `markdown` as APNs-native features unless the Go code already does so. In the Go implementation they are forwarded as custom fields, not special APNs fields.

### Error Mapping

On non-200 APNs response:

- parse JSON response if possible
- extract `reason` if present
- throw typed error carrying:
  - `statusCode`
  - `reason`
  - useful message text

On network/runtime failure:

- throw typed error with `statusCode = 500`

Route code must continue to detect invalid token failures by:

- `statusCode === 410`
- or `statusCode === 400` with message containing `BadDeviceToken`

## MCP Exact Requirements

Implement MCP behavior in `worker/src/mcp.ts`.

### Public endpoints

- `ALL /mcp`
- `ALL /mcp/:device_key`

### Tool model

Expose one tool:

- `notify`

Supported arguments:

- `device_key` on generic endpoint only
- `title`
- `subtitle`
- `body`
- `markdown`
- `level`
- `volume`
- `badge`
- `call`
- `sound`
- `icon`
- `image`
- `group`
- `isArchive`
- `ttl`
- `url`
- `copy`

### Behavior

- Generic endpoint requires `device_key` in tool args.
- Device-specific endpoint injects `device_key` from the URL path and must override any supplied arg value.
- The tool implementation must call into the existing push path semantics, not create a second notification pipeline.
- Success result text should match the Go behavior: `Notification sent successfully`.
- Failure result text should match the Go behavior shape: `Failed to send notification: <err> (code <n>)`.

### Protocol approach

Implement the minimal HTTP MCP request-response surface necessary for normal clients using non-streaming behavior.

Preferred practical approach:

1. support initialization / server info response
2. support tool listing for `notify`
3. support tool call handling for `notify`
4. keep everything request-response only

Do not add SSE or long-lived streaming.

If you choose to use an MCP library, it must be Worker-compatible and must not force a Node-only runtime. If there is any doubt, implement the small non-streaming subset manually.

## Testing Requirements

Start from the current tests. Do not weaken them.

You must:

- replace `worker/test/mcp.test.ts` todos with executable tests
- add focused APNs sender tests if the sender logic becomes non-trivial
- keep existing auth/register/push/misc tests green

Acceptable additional tests:

- APNs JWT generation smoke tests
- APNs error mapping tests
- MCP initialize/list/call endpoint tests
- device-key override test for `/mcp/:device_key`

Unacceptable shortcuts:

- deleting tests
- converting failing behavior into snapshots
- broadening assertions so much that compatibility is no longer checked

## Execution Order

1. Read the source-of-truth files.
2. Implement `worker/src/cloudflare-apns-client.ts`.
3. Add tests for APNs error mapping if needed.
4. Implement `worker/src/mcp.ts`.
5. Replace MCP `todo` tests with real tests.
6. Run:
   - `pnpm test`
   - `pnpm check`
   - `pnpm build`
7. Fix any discovered parity issues without redesigning the scaffold.

## Guardrails

- Prefer explicit parser code over framework magic.
- Do not hide missing behavior behind broad `try/catch` blocks.
- Do not silently swallow APNs error details.
- Do not add unnecessary dependencies.
- Do not change route names, response shape, or auth semantics unless the Go source and tests both prove the current scaffold is wrong.
- Do not stop at partial implementation. Carry it through to passing tests and build verification.

## Definition Of Done

All of the following must be true:

- production APNs sender is implemented
- MCP endpoints are implemented
- MCP tests are real tests, not todos
- `pnpm test` passes
- `pnpm check` passes
- `pnpm build` passes
- no skipped/todo tests remain unless there is a clearly documented external blocker

## If You Think Something Is Wrong

Before changing behavior, verify in this order:

1. existing TypeScript tests
2. Go source
3. repository docs

If there is still ambiguity, preserve the current scaffold contract unless it clearly contradicts the Go source.
