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
- `pnpm test` passes with 42 executable tests
- `pnpm build` completes a Wrangler dry-run bundle
- in this sandbox, Wrangler may print an `EPERM` warning while trying to write `~/.wrangler/logs`; if the dry-run bundle completes, treat that log-write failure as non-blocking

Current implementation status:

- Core HTTP routes, auth, registration, push parsing/sending orchestration, KV registry, MCP, and production APNs sender are implemented.
- MCP tests are executable; no MCP `todo` tests remain.
- APNs tests cover top-level custom fields, JOSE ECDSA signature encoding, DER signature compatibility, and numeric `delete=1` background pushes.
- Two code review/fix passes have been applied after the initial scaffold:
  - APNs custom fields are top-level, not nested under `aps`.
  - MCP rejects unknown tool names instead of sending a push.
  - WebCrypto raw ECDSA signatures are accepted without DER parsing.
  - Numeric `delete=1` triggers background push behavior.
  - Wrangler has a `DEVICE_REGISTRY` KV binding.

Remaining work is production validation, not missing business-code implementation.

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
- APNs credentials from Worker environment bindings. These may be Wrangler plaintext `[vars]` or Worker secrets; the code reads both through `env`.

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
- Keep the KV binding name as `DEVICE_REGISTRY`; changing it requires matching changes in `worker/src/index.ts` and `worker/src/types.ts`.
- Production and preview KV namespace IDs are configured in `wrangler.toml`. Using the same ID for `id` and `preview_id` is acceptable for this deployment choice, but separate IDs remain safer if preview testing should not touch production device registrations.

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
- The current production sender is implemented in `worker/src/cloudflare-apns-client.ts`.
- `APNS_TOPIC`, `APNS_KEY_ID`, and `APNS_TEAM_ID` may live in `wrangler.toml` `[vars]` because they are already public in the upstream Bark codebase.
- `APNS_PRIVATE_KEY` must be the full PKCS#8 private key PEM text, including the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines. The `.p8` and `.pem` filenames in the original repo contain the same PEM format.
- If storing `APNS_PRIVATE_KEY` in `wrangler.toml`, use a TOML multiline string:

```toml
[vars]
APNS_PRIVATE_KEY = """-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----
"""
```

- If storing `APNS_PRIVATE_KEY` as a Cloudflare secret instead, `wrangler secret put APNS_PRIVATE_KEY` can be used; no code change is required.

### MCP implementation

- Keep the public endpoints exactly as:
  - `/mcp`
  - `/mcp/:device_key`
- Disable streaming semantics just like the Go server does.
- Prefer a minimal request-response implementation over long-lived SSE behavior.
- The current implementation handles `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`.
- `notifications/initialized` returns HTTP `204` with an empty body.
- `/mcp` exposes `notify` with `device_key` required; `/mcp/:device_key` exposes `notify` without requiring `device_key`.
- `/mcp/:device_key` path value overrides any `device_key` supplied inside tool arguments, matching Go runtime behavior.

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
- Provide an in-memory test sender and dependency boundaries for production APNs.

Status: complete.

### Phase 2: contract hardening

- Fill in remaining edge-case parity gaps discovered from Go behavior.
- Implement MCP compatibility.
- Implement production APNs JWT creation and fetch logic.
- Add more fixtures if any Go behavior is still ambiguous.

Status: complete for the current known contract. APNs and MCP are implemented and covered by tests.

### Phase 3: production readiness

- Wire real Cloudflare secrets and KV binding.
- Run smoke tests with a real device token.
- Validate on a Worker preview or staging deployment.

Status: in progress. KV namespace IDs and APNs environment bindings are configured in `wrangler.toml`. Remaining work is deployment/preview validation and real-device smoke testing.

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
- `worker/test/mcp.test.ts`
- `worker/test/apns.test.ts`

The test suite should remain the primary execution guide for any follow-on AI.

## Remaining Work After This Scaffold

- Deploy or preview the Worker in Cloudflare.
- Register a real device and run end-to-end smoke tests for:
  - `/register`
  - `/push`
  - legacy `/:device_key/...` routes
  - `/mcp` and `/mcp/:device_key`
- Reconcile any real-device or Go-parity mismatches discovered during smoke testing.
- Re-run before handoff:
  - `pnpm test`
  - `pnpm check`
  - `pnpm build`

## Acceptance Criteria

- Public HTTP routes exist in the Worker app.
- Contract tests describe the expected behavior for registration, push, auth, misc routes, and failure modes.
- APNs production code is implemented behind `PushSender`.
- MCP endpoints are implemented.
- No `todo` or skipped tests remain unless there is a concrete external blocker recorded in code comments and the final handoff.
- The scaffold remains organized so another AI can validate, deploy, and fix any discovered parity gaps without redesigning the project.
