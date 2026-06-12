# Bark Serverless Worker

This repository is a `TypeScript + Hono + Cloudflare Worker` reimplementation of the original Go `bark-server`.

The goal is public HTTP API compatibility with the Bark iOS app and existing Bark clients, while replacing the self-hosted Go server model with a serverless deployment on Cloudflare Workers.

## Status

The Worker implementation is usable in production for the main Bark flows.

- Legacy push routes are working.
- `POST /push` is working.
- `ALL /mcp` and `ALL /mcp/:device_key` are working.
- APNs delivery has been validated with real-device smoke tests.
- Compatibility behavior is covered by automated contract tests.

Current validation coverage:

- `42` automated tests passing with `pnpm test`
- TypeScript checks passing with `pnpm check`
- Wrangler dry-run build passing with `pnpm build`
- Live smoke tests confirmed for legacy push, `/push`, `/mcp`, and `/mcp/:device_key`

## Migration Approach

The migration strategy was to preserve HTTP behavior first, not to preserve the original process model.

Key decisions:

- Keep the public API shape compatible with the original Bark server.
- Replace Go runtime and storage with Worker-native components.
- Use contract-style tests to lock route behavior, parsing precedence, auth semantics, and push side effects.
- Prefer explicit compatibility over framework magic.

For ambiguous behavior, the source of truth is the upstream Bark project and its public API documentation.

## Architecture

- Runtime: Cloudflare Worker
- Router: Hono
- Storage: Cloudflare KV
- Push transport: APNs over `fetch` + Worker Web Crypto
- Package manager: `pnpm`
- Tests: Vitest

Device registration is stored as `device_key -> device_token` in KV. Push sending is abstracted behind interfaces so route behavior can be tested without real APNs or real KV.

## API Compatibility

Implemented route surface:

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

Compatibility behaviors intentionally preserved:

- JSON `Content-Type` uses the V2 `/push` parser. Non-JSON requests use the legacy parser.
- Path params override query and body params.
- Legacy `sound` values are normalized to `*.caf`.
- Empty alerts are converted to `Empty Message`.
- Auth mode still returns plain-text `418 I'm a teapot`.
- `/ping`, `/register`, and `/healthz` still bypass auth.
- Invalid APNs device tokens trigger key cleanup.
- Batch push keeps input order in its per-device results.
- MCP generic and device-specific endpoints preserve the original `notify` tool behavior.

Compatibility status:

- The main production API surface is implemented and validated.
- The project targets HTTP/API compatibility, not byte-for-byte internal parity.
- Rare legacy edge cases still depend on test coverage and upstream parity review rather than exhaustive production soak testing.

## Tradeoffs Vs Original Go Server

What is preserved:

- Bark HTTP API
- Legacy push URL patterns
- `/push` V2 semantics
- MCP `notify` integration
- APNs payload behavior that existing Bark clients rely on

What is intentionally not preserved:

- Go CLI flags and standalone binary packaging
- `bbolt` local file storage
- MySQL backend mode
- Local TLS listeners
- Unix socket mode
- Long-lived process concerns such as connection pool tuning from the Go runtime

Cloudflare-specific tradeoffs:

- KV is eventually consistent, unlike local in-process storage.
- Deployment becomes much simpler, but all runtime state must fit the Worker model.
- MCP is implemented as request-response HTTP only; no streaming transport is provided.

## APNs Configuration

The Worker reads these bindings:

- `APNS_TOPIC`
- `APNS_KEY_ID`
- `APNS_TEAM_ID`
- `APNS_PRIVATE_KEY`

`APNS_PRIVATE_KEY` must be the full PKCS#8 PEM text, including:

```text
-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----
```

The current repository keeps the upstream Bark app APNs configuration for compatibility with the public Bark iOS app.

Important note:

- These `APNS_*` values are intentionally public in the upstream Bark project and author documentation. They are not accidental secret leakage in this repository.
- Source: [Bark服务端部署文档](https://day.app/2018/06/bark-server-document/)
- If you are deploying for a different app or topic, replace all `APNS_*` values accordingly.

## Deploy To Cloudflare Worker

### Prerequisites

- Node.js 20+
- `pnpm`
- A Cloudflare account with Workers and KV enabled
- Wrangler authenticated via `pnpm exec wrangler login`

### 1. Install dependencies

```sh
pnpm install
```

### 2. Create KV namespaces

Create a production KV namespace:

```sh
pnpm exec wrangler kv namespace create DEVICE_REGISTRY
```

Create a preview KV namespace if you want preview isolation:

```sh
pnpm exec wrangler kv namespace create DEVICE_REGISTRY --preview
```

Then update `wrangler.toml`:

- `name`
- `[[kv_namespaces]].id`
- `[[kv_namespaces]].preview_id`

Using the same namespace ID for both `id` and `preview_id` is valid, but separate namespaces are safer if you do not want preview traffic touching production registrations.

### 3. Configure Worker variables

Update the `[vars]` section in `wrangler.toml`:

- `APNS_TOPIC`
- `APNS_KEY_ID`
- `APNS_TEAM_ID`
- `APNS_PRIVATE_KEY`

Optional hardening variables:

- `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` protect all non-compatibility-free routes. `/`, `/ping`, `/healthz`, and `/register` still bypass auth for Bark compatibility.
- `MAX_BATCH_PUSH_COUNT` limits V2 batch fan-out when `device_keys` is provided.
- `MAX_REQUEST_BODY_BYTES` limits parsed request bodies for JSON/form/MCP requests. The default is `4194304` bytes.

If you prefer, `APNS_PRIVATE_KEY` can be stored as a Cloudflare secret instead of plaintext config:

```sh
pnpm exec wrangler secret put APNS_PRIVATE_KEY
```

### 4. Verify locally

```sh
pnpm test
pnpm check
pnpm build
```

`pnpm build` runs `wrangler deploy --dry-run`.

### 5. Deploy

```sh
pnpm exec wrangler deploy
```

### 6. Apply production protections

After deployment, configure the protections that sit in front of the Worker:

- Set `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` unless you explicitly want an open push endpoint.
- Add Cloudflare Rate Limiting rules for `/register`, `/push`, `/mcp`, and `/mcp/*`. IP-based limits are the usual starting point.

After deployment, you can smoke-test the service:

```sh
curl https://<your-worker>.workers.dev/ping
curl "https://<your-worker>.workers.dev/<device_key>/Title/Hello"
```

## MCP Usage

The Worker exposes Bark push as an MCP tool so AI agents can notify you when tasks finish or need attention.

- `POST /mcp` exposes `notify` and requires `device_key`
- `POST /mcp/:device_key` exposes `notify` without requiring `device_key`

This is useful for long-running agents such as Claude Code or Codex that should send a Bark notification at task completion.

## Development

Useful commands:

```sh
pnpm install
pnpm test
pnpm check
pnpm dev
pnpm build
```

## API Docs

- [API V2](docs/API_V2.md)
- [MCP](docs/MCP.md)
- Upstream project: [Finb/Bark](https://github.com/Finb/Bark)
