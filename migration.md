# Bark Go -> TypeScript Cloudflare Worker Migration

## Goal

Rebuild the current Go service as a `TypeScript + Hono + Cloudflare Worker + KV` service while keeping the public HTTP API behavior as close as possible to the existing implementation.

The migration target is HTTP/API compatibility, not process-level parity. The new implementation does **not** need to preserve:

- Go CLI flags and process lifecycle
- local file storage via `bbolt`
- MySQL startup flags and TLS bootstrapping
- local TLS listeners and Unix sockets

## Current Scaffold Status

The repository already contains a migration scaffold:

- root `pnpm` workspace files
- Worker runtime entry and route skeleton under `worker/src/**`
- contract-style tests under `worker/test/**`

Current verified state:

- `pnpm install` completed successfully
- `pnpm check` passes
- `pnpm test` passes
- `pnpm build` completes a Wrangler dry-run bundle
- in this sandbox, Wrangler may print an `EPERM` warning while trying to write `~/.wrangler/logs`; if the dry-run bundle completes, treat that log-write failure as non-blocking

Current test status:

- 26 passing tests
- 2 MCP `todo` tests

Known remaining code placeholders:

- `worker/src/cloudflare-apns-client.ts`
- `worker/src/mcp.ts`

These are intentional handoff points for the next AI.

## Source Of Truth

When behavior is ambiguous, the Go implementation wins.

Primary Go source files:

- `route_push.go`
- `route_register.go`
- `route_auth.go`
- `route_misc.go`
- `route_mcp.go`
- `apns/apns.go`
- `docs/API_V2.md`
- `docs/MCP.md`

Primary TypeScript scaffold files:

- `worker/src/app.ts`
- `worker/src/push.ts`
- `worker/src/register.ts`
- `worker/src/auth.ts`
- `worker/src/kv-device-registry.ts`
- `worker/src/cloudflare-apns-client.ts`
- `worker/src/mcp.ts`

## Current Go Behavior That Must Be Preserved

### Public routes

- `GET /`
- `GET /ping`
- `GET /healthz`
- `GET /info`
- `GET /register`
- `POST /register`
- `GET /register/:device_key`
- `POST /push`
- `GET|POST /:device_key`
- `GET|POST /:device_key/:body`
- `GET|POST /:device_key/:title/:body`
- `GET|POST /:device_key/:title/:subtitle/:body`
- `ALL /mcp`
- `ALL /mcp/:device_key`

### Compatibility rules

- JSON `Content-Type` means V2 push parsing. Everything else uses the V1 compatibility parser.
- V1 parameter precedence is: query -> urlencoded body -> multipart form -> path params override all.
- V2 parameter precedence is: JSON body -> query params -> path params override all.
- Path params are URL-decoded before use.
- `sound` values without `.caf` must be normalized to `<value>.caf`.
- Empty alert payloads must be converted to `body = "Empty Message"` before sending to APNs.
- `device_keys` must support both JSON array input and comma-delimited string input.
- Unauthorized requests under auth mode must return HTTP `418` with body `I'm a teapot`.
- Auth bypass must remain for `/ping`, `/register`, and `/healthz`.
- Root `/` must remain accessible even when auth is enabled.
- `GET /register` must support legacy query aliases:
  - `key`
  - `devicetoken`
- `POST /register` must support `device_key` and `device_token`.
- `device_token` longer than 160 chars must fail with HTTP `400`.
- `GET /register/:device_key` returns HTTP `400` when the key is missing or unknown.
- APNs invalid-token failures must trigger key cleanup.
- Push failures caused by APNs still surface from the HTTP layer as HTTP `500`.
- Batch push returns HTTP `200` with per-device result rows in input order.
- `GET /:device_key/:title/:subtitle/:body/extra` must remain unmatched and return `404`.

### Subtle but important behaviors

- The Go comment in `route_mcp.go` says tool args win over context, but the actual code overwrites `device_key` with the URL path value on `/mcp/:device_key`. Preserve the actual behavior, not the comment.
- Most documented fields such as `badge`, `level`, `volume`, `call`, `icon`, `image`, `group`, `markdown`, `isArchive`, `ttl`, `url`, and `copy` are **not** mapped to APNs-native fields in the Go code. They are carried as custom payload fields, lowercased and stringified.
- Only a small subset affects APNs-native behavior:
  - `title`, `subtitle`, `body`
  - `sound`
  - `group` -> thread id
  - `id` -> collapse id
  - `delete` -> background push type plus `content-available`

## Target Architecture

### Runtime

- `Hono` for routing and middleware
- Cloudflare Worker as the runtime host
- Cloudflare KV as the `device_key -> device_token` registry
- APNs credentials from Worker secrets

### Layout

- Root docs: `migration.md`, `spec.md`, `goal-prompt.md`
- New Worker code: `worker/src/**`
- Contract tests: `worker/test/**`

### Dependency inversion

The Worker app must be built around interfaces so tests can use in-memory fakes:

- `DeviceRegistry`
- `PushSender`
- `RuntimeDeps`

This keeps route compatibility testable without real KV or real APNs access.

## Decisions

### Storage

- Use Cloudflare KV for `device_key -> device_token`.
- Accept KV eventual consistency.
- Do not introduce Durable Objects unless later real-world behavior proves KV inadequate.
- `saveDeviceTokenByKey(key, "")` should remove the key mapping, because the scaffold and current cleanup logic rely on deletion semantics.

### Device key generation

- Preserve the current model where registration without an explicit key generates a new device key.
- Use a URL-safe short random key generator in TypeScript.
- Exact byte-for-byte parity with Go `shortuuid` is not required unless a failing contract case proves it matters.

### Error handling

- Preserve response shape:
  - `code`
  - `message`
  - `timestamp`
  - `data` when applicable
- Preserve behavior over exact internal error wording where the original Go implementation varies by backend.
- Protected-route auth failure must stay plain text, not JSON.

### APNs integration

- Production APNs sending must be isolated behind a `PushSender`.
- Contract tests must use a fake sender, not real APNs.
- The production sender should use Worker Web Crypto and standard `fetch`, not Node-only APIs.

### MCP implementation

- Keep the public endpoints exactly as:
  - `/mcp`
  - `/mcp/:device_key`
- Disable streaming semantics just like the Go server does.
- Prefer a minimal request-response implementation over long-lived SSE behavior.

## APNs Mapping Contract

### Auth

Use token-based APNs auth:

- key material from `APNS_PRIVATE_KEY`
- key id from `APNS_KEY_ID`
- team id from `APNS_TEAM_ID`
- topic from `APNS_TOPIC`

JWT requirements:

- algorithm: `ES256`
- header:
  - `alg = ES256`
  - `kid = APNS_KEY_ID`
- payload:
  - `iss = APNS_TEAM_ID`
  - `iat = current unix seconds`

### HTTP request

Send to:

- `https://api.push.apple.com/3/device/{deviceToken}`

Headers:

- `authorization: bearer <jwt>`
- `apns-topic: <topic>`
- `apns-expiration: <unix now + 86400>`
- `apns-push-type: alert` for normal pushes
- `apns-push-type: background` when `delete` indicates silent push
- `apns-collapse-id: <id>` when `id` is present
- `content-type: application/json`

### Payload construction

Base payload must include `aps.mutable-content = 1`.

For regular pushes:

- set `aps.alert.title`
- set `aps.alert.subtitle`
- set `aps.alert.body`
- set `aps.sound`
- set `aps.category = "myNotificationCategory"`
- if `group` exists, set `aps.thread-id = group`

For delete/background pushes:

- set `aps.content-available = 1`
- do not add alert title/subtitle/body/sound/category/thread-id

Custom fields:

- every value in `extParams` must be added to the top-level payload
- custom field names must be lowercased
- custom field values must be stringified the same way Go does via `fmt.Sprintf("%v", v)`

### Error mapping

- network/runtime failure -> throw typed error with `statusCode = 500`
- APNs non-200 response -> parse JSON body if possible and surface `reason`
- invalid token errors must still be recognizable by route code:
  - `410`
  - `400` with reason containing `BadDeviceToken`

## MCP Contract

The Go server exposes one tool: `notify`.

### Generic endpoint

- endpoint: `/mcp`
- caller must provide `device_key` in tool arguments

### Device-specific endpoint

- endpoint: `/mcp/:device_key`
- path `device_key` must override any `device_key` inside tool arguments

### Tool argument contract

Supported tool args come from `getCommonToolOpts()` in `route_mcp.go`:

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

The MCP tool handler should forward these values into the same push path semantics instead of inventing a separate notification implementation.

### Suggested implementation shape

Implement the minimal request-response subset needed for HTTP MCP clients:

- server info / initialize
- tool listing for one `notify` tool
- tool call handling for `notify`

Avoid SSE and long-lived streaming behavior.

## Implementation Phases

### Phase 1: contract skeleton

- Set up `pnpm`, TypeScript, Vitest, Wrangler, and Hono.
- Build the Worker app with dependency injection.
- Implement misc routes, auth gate, registration routes, and push route parsing.
- Provide a placeholder production APNs client and a working in-memory test sender.

Status: complete.

### Phase 2: contract hardening

- Fill in remaining edge-case parity gaps discovered from Go behavior.
- Implement MCP compatibility.
- Implement production APNs JWT creation and fetch logic.
- Add more fixtures if any Go behavior is still ambiguous.

Status: partially complete. Main remaining work is APNs production and MCP.

### Phase 3: production readiness

- Wire real Cloudflare secrets and KV binding.
- Run smoke tests with a real device token.
- Validate on a Worker preview or staging deployment.

Status: not started.

## Test Strategy

Use contract-oriented TDD:

1. Encode current Go behavior into black-box HTTP tests.
2. Keep tests focused on route behavior, parsing precedence, auth semantics, and side effects.
3. Mock external dependencies through `DeviceRegistry` and `PushSender`.
4. Treat failing compatibility tests as the implementation backlog.

Current implemented suites:

- `worker/test/misc.test.ts`
- `worker/test/auth.test.ts`
- `worker/test/register.test.ts`
- `worker/test/push.test.ts`
- `worker/test/mcp.test.ts` with `todo` placeholders

The new test suite should be the primary execution guide for the next AI.

## Remaining Work After This Scaffold

- Complete production APNs integration in `worker/src/cloudflare-apns-client.ts`
- Replace MCP placeholders in `worker/src/mcp.ts` with real behavior
- Replace `it.todo(...)` MCP tests with executable tests
- Reconcile any remaining contract mismatches discovered while running the tests
- Re-run:
  - `pnpm test`
  - `pnpm check`
  - `pnpm build`

## Acceptance Criteria

- Public HTTP routes exist in the Worker app.
- Contract tests describe the expected behavior for registration, push, auth, misc routes, and failure modes.
- APNs production code is implemented behind `PushSender`.
- MCP endpoints are implemented.
- No `todo` or skipped tests remain unless there is a concrete external blocker recorded in code comments and the final handoff.
- The scaffold remains organized so another AI can implement missing business logic without redesigning the project.
