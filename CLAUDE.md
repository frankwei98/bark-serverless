# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A TypeScript + Hono + Cloudflare Worker reimplementation of the original Go `bark-server`. The goal is **HTTP API compatibility** with the Bark iOS app and existing clients — not internal parity with the Go process model. The original Go source still lives on the `master` branch and is the reference implementation (see "Resolving ambiguous behavior" below).

## Commands

```sh
pnpm test            # run all tests (vitest)
pnpm test:watch      # vitest watch mode
pnpm check           # type-check (tsc --noEmit)
pnpm build           # wrangler deploy --dry-run (validates the build/bundle)
pnpm dev             # local dev server (wrangler dev)
pnpm exec wrangler deploy   # deploy to Cloudflare
```

Run a single test file or case:

```sh
pnpm exec vitest run worker/test/push.test.ts
pnpm exec vitest run -t "handles a V1 path-based push"
```

CI (`.github/workflows/ci.yaml`) runs `pnpm test`, `pnpm check`, and `pnpm build`. All three should pass before merging.

## Architecture

### Dependency injection is the core design

Everything is built around `createApp({ config, deps })` in `worker/src/app.ts`. `deps` is a `RuntimeDeps` object (`registry`, `pushSender`, `now()`, `buildInfo`) that every route handler receives. This is what makes the entire app testable without KV, APNs, or network.

- **`worker/src/index.ts`** is the *only* place that wires real implementations: it builds `KVDeviceRegistry`, `CloudflareApnsClient`, and the real clock, then caches the assembled Hono app in a `WeakMap` keyed on `env`. That cache means the APNs client (and its imported crypto key + cached JWT) persists across requests within a Worker isolate — don't move client construction into the request path.
- **Tests** wire fakes instead, via `createHarness()` in `worker/test/helpers/fakes.ts` (`InMemoryDeviceRegistry`, `RecordingPushSender`). Tests drive the app with `app.request(...)` and assert on recorded side effects.

Two interfaces in `worker/src/types.ts` define the seams: `DeviceRegistry` (KV abstraction) and `PushSender` (APNs abstraction). When adding behavior, prefer extending these rather than calling KV/`fetch` directly from handlers.

### Request flow

`index.ts` (fetch + app cache) → `app.ts` `createApp`:
1. middleware sets `Server: Bark` header,
2. `createBasicAuthMiddleware` (`auth.ts`),
3. the route group is mounted at `config.urlPrefix` (or `/`),
4. route modules register handlers: `register.ts`, `mcp.ts`, `push.ts`, plus the misc routes (`/`, `/ping`, `/healthz`, `/info`) defined inline in `app.ts`.

Static routes (`/ping`, `/register`, `/mcp`, ...) win over the catch-all push params (`/:device_key`, ...) because Hono prioritizes static segments — that precedence is load-bearing for compatibility.

### Push parameter parsing (the trickiest compat surface — `push.ts`)

- Content-Type decides the parser: `application/json` → V2 (JSON body), otherwise → V1 (query + form + path).
- Precedence: **path params > form/body > query params**.
- `buildPushMessage` maps the merged param map to a `PushMessage`, applying compat quirks: `sound` normalized to `*.caf`, empty alert → `"Empty Message"`, unknown keys collected into `extParams`.
- Batch push (`device_keys`) runs with bounded concurrency (`BATCH_PUSH_CONCURRENCY = 50`) and preserves input order in results.

### APNs client (`cloudflare-apns-client.ts`)

Hand-rolled because there's no Node APNs library in the Worker runtime:
- PKCS#8 PEM → WebCrypto `ECDSA P-256`, signs an `ES256` JWT.
- `normalizeEcdsaSignature` converts DER/ASN.1 signatures to raw 64-byte JOSE form (some runtimes return DER).
- The provider JWT is cached and reused for 30 minutes (`JWT_REUSE_SECONDS`) — Apple rejects over-frequent token refresh; do not regenerate per request.
- Bark custom params are emitted at the **top level** of the payload (not inside `aps`), stringified and lower-cased. This matches the Go server exactly; clients depend on it.

## Compatibility contract

This is the central principle of the codebase. Quirks are preserved on purpose, e.g.: `418 I'm a teapot` for failed auth, `/ping` + `/register` + `/healthz` bypass auth, path params override everything, ext params are stringified. The behavior tests in `worker/test/` exist to *lock* these — treat a failing contract test as a real compatibility regression, not a test to update.

### Resolving ambiguous behavior

When unsure how something should behave, the source of truth is, in order:
1. The upstream Bark project and its public API docs.
2. **The original Go implementation, still on the `master` branch.** Read it directly, e.g.:
   ```sh
   git show master:route_push.go
   git show master:apns/apns.go
   git show master:route_auth.go
   ```
   The current branch deleted these files; `master` retains them as the reference.

## Configuration

Config is env-driven (`BarkBindings` in `types.ts`, assembled by `config.ts`). `wrangler.toml` holds `[vars]` (APNS_*, optional `URL_PREFIX`, `BASIC_AUTH_*`, `MAX_BATCH_PUSH_COUNT`, `MAX_REQUEST_BODY_BYTES`) and the `DEVICE_REGISTRY` KV binding. Devices are stored as `device:<key> -> <token>`.

The committed `APNS_*` values are the **public upstream Bark app key** (documented in `README.md`, not an accidental leak). For a different app/topic, replace them — and prefer `wrangler secret put APNS_PRIVATE_KEY` over committing a real private key to `[vars]`.

## Path aliases

`@/*` maps to `worker/src/*` (configured in both `tsconfig.json` and `vitest.config.ts` — keep them in sync).
