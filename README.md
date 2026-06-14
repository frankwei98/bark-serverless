# Bark Serverless Worker

This repository is a `TypeScript + Hono + Cloudflare Worker` reimplementation of the original Go version [`bark-server`](https://github.com/Finb/bark-server).

The goal is public HTTP API compatibility with the Bark iOS app and existing Bark clients, while replacing the self-hosted Go server model with a serverless deployment on Cloudflare Workers.

> 本仓库是原版 Go [`bark-server`](https://github.com/Finb/bark-server) 的 `TypeScript + Hono + Cloudflare Worker` 重写。
> 目标是与 Bark iOS 应用及现有客户端保持公开 HTTP API 兼容，同时将自托管 Go 服务器替换为 Cloudflare Workers 无服务器部署。

## Deploy / 部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/frankwei98/bark-serverless)

## Status

The Worker implementation is usable in production for the main Bark flows.

- Legacy push routes are working.
- `POST /push` is working.
- `ALL /mcp` and `ALL /mcp/:device_key` are working.
- APNs delivery has been validated with real-device smoke tests.
- Compatibility behavior is covered by automated contract tests.

Current validation coverage:

- `111` automated tests passing with `pnpm test`
- TypeScript checks passing with `pnpm check`
- Wrangler dry-run build passing with `pnpm build`
- Live smoke tests confirmed for legacy push, `/push`, `/mcp`, and `/mcp/:device_key`

> **中文说明：** Worker 实现已可用于生产环境，覆盖主要 Bark 推送流程。旧版推送路由、`POST /push`、MCP 端点均已可用，APNs 推送经过真机验证，兼容性行为由自动化合约测试覆盖。当前 111 个自动化测试全部通过。

## Migration Approach

The migration strategy was to preserve HTTP behavior first, not to preserve the original process model.

Key decisions:

- Keep the public API shape compatible with the original Bark server.
- Replace Go runtime and storage with Worker-native components.
- Use contract-style tests to lock route behavior, parsing precedence, auth semantics, and push side effects.
- Prefer explicit compatibility over framework magic.

For ambiguous behavior, the source of truth is the upstream Bark project and its public API documentation.

> **中文说明：** 迁移策略是优先保留 HTTP 行为，而非保留原始进程模型。关键决策：保持公开 API 与原版 Bark 服务器兼容；用 Worker 原生组件替换 Go 运行时和存储；使用合约式测试锁定路由行为、解析优先级、认证语义和推送副作用。遇到歧义时，以上游 Bark 项目及其公开 API 文档为准。

## Architecture

- Runtime: Cloudflare Worker
- Router: Hono
- Storage: Cloudflare KV
- Push transport: APNs over `fetch` + Worker Web Crypto
- Package manager: `pnpm`
- Tests: Vitest

Device registration is stored as `device_key -> device_token` in KV. Push sending is abstracted behind interfaces so route behavior can be tested without real APNs or real KV.

> **中文说明：** 运行时为 Cloudflare Worker，路由使用 Hono，存储使用 Cloudflare KV，推送通过 `fetch` + Worker Web Crypto 实现 APNs 通信。设备注册以 `device_key -> device_token` 存储在 KV 中，推送通过接口抽象，无需真实 APNs 或 KV 即可测试路由行为。

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

> **中文说明：** 有意保留的兼容性行为：JSON `Content-Type` 使用 V2 `/push` 解析器，非 JSON 使用旧版解析器；路径参数优先于查询和 body 参数；旧版 `sound` 值标准化为 `*.caf`；空消息转为 `Empty Message`；认证失败返回纯文本 `418 I'm a teapot`；`/ping`、`/register`、`/healthz` 绕过认证；无效 APNs 设备令牌触发密钥清理；批量推送保持输入顺序。

Compatibility status:

- The main production API surface is implemented and validated.
- The project targets HTTP/API compatibility, not byte-for-byte internal parity.
- Rare legacy edge cases still depend on test coverage and upstream parity review rather than exhaustive production soak testing.

> **中文说明：** 兼容性状态：主要生产 API 已实现并验证；项目目标是 HTTP/API 兼容，而非逐字节内部一致；罕见的旧版边界情况仍依赖测试覆盖和上游一致性审查，而非详尽的生产环境浸泡测试。

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
- MCP follows the modern Streamable HTTP transport semantics, but this Worker only returns JSON responses and does not expose an SSE stream.

> **中文说明：** 有意不保留的部分：Go CLI 参数、独立二进制打包、`bbolt` 本地存储、MySQL 后端模式、本地 TLS 监听、Unix socket 模式、长连接进程相关调优。Cloudflare 特有权衡：KV 是最终一致性的（不同于本地进程内存储）；部署更简单，但所有运行时状态必须适配 Worker 模型；MCP 采用现代 Streamable HTTP 语义，但当前只返回 JSON，不提供 SSE 流。

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

The Worker also tolerates deployment systems that flatten this value into a single line or store it with literal `\n` escapes, including the Cloudflare one-click deploy flow.

The current repository keeps the upstream Bark app APNs configuration for compatibility with the public Bark iOS app.

Important note:

- These `APNS_*` values are intentionally public in the upstream Bark project and author documentation. They are not accidental secret leakage in this repository.
- Source: [Bark服务端部署文档](https://day.app/2018/06/bark-server-document/)
- If you are deploying for a different app or topic, replace all `APNS_*` values accordingly.

> **中文说明：** 这些 `APNS_*` 值在上游 Bark 项目和作者文档中是公开的，并非本仓库意外泄露的密钥。来源：[Bark服务端部署文档](https://day.app/2018/06/bark-server-document/)。如果你为不同的应用或 topic 部署，请替换所有 `APNS_*` 值。
>
> `APNS_PRIVATE_KEY` 也兼容被部署系统压成单行，或保存为带字面量 `\n` 的字符串；Cloudflare 一键部署这类情况也能正常解析。

## Deploy To Cloudflare Worker

### One Click To Deploy | 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/frankwei98/bark-serverless)

### Deploy Manually ｜ 手动部署

#### Prerequisites ｜ 前置条件

- Node.js 20+
- `pnpm`
- A Cloudflare account with Workers and KV enabled / 已启用 Workers 和 KV 的 Cloudflare 账户
- Wrangler authenticated via `pnpm exec wrangler login` / 已通过 `pnpm exec wrangler login` 完成 Wrangler 认证

#### 1. Install dependencies ｜ 安装依赖

```sh
pnpm install
```

#### 2. Create KV namespaces ｜ 创建 KV 命名空间

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

#### 3. Configure Worker variables ｜ 配置 Worker 变量

Update the `[vars]` section in `wrangler.toml`:

- `APNS_TOPIC`
- `APNS_KEY_ID`
- `APNS_TEAM_ID`
- `APNS_PRIVATE_KEY`

Optional hardening variables ｜ 可选安全加固变量:

- `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` protect all non-compatibility-free routes. `/`, `/ping`, `/healthz`, and `/register` still bypass auth for Bark compatibility.
- `MAX_BATCH_PUSH_COUNT` limits V2 batch fan-out when `device_keys` is provided. The default is `1000`; set `-1` only if you intentionally want no application-level cap.
- `MAX_REQUEST_BODY_BYTES` limits parsed request bodies for JSON/form/MCP requests. The default is `4194304` bytes.
- `MCP_SESSION_SECRET` signs optional MCP session IDs. It is not an access-control boundary: requests without `Mcp-Session-Id` are still accepted for compatibility, so use Basic Auth to restrict MCP access.
- `CLOSE_REGISTER` disables new device registration when set to `"true"`. `POST /register` and `GET /register` return `403`, while `GET /register/:device_key` (key lookup) still works. Default is open.

> **中文说明：** `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` 保护所有非兼容性免费路由（`/`、`/ping`、`/healthz`、`/register` 仍绕过认证以保持 Bark 兼容）。`MAX_BATCH_PUSH_COUNT` 限制 `device_keys` 批量推送数量，默认 `1000`；只有在你明确接受无应用层上限时才应设为 `-1`。`MAX_REQUEST_BODY_BYTES` 限制 JSON/form/MCP 请求体大小，默认 4MB。`MCP_SESSION_SECRET` 用于签名可选 MCP session ID，但它不是访问控制边界；为了兼容，未携带 `Mcp-Session-Id` 的请求仍会被接受，限制 MCP 访问请使用 Basic Auth。`CLOSE_REGISTER` 设为 `"true"` 时关闭新设备注册，`POST /register` 和 `GET /register` 返回 `403`，`GET /register/:device_key`（密钥查询）不受影响；默认开放。

If you prefer, `APNS_PRIVATE_KEY` can be stored as a Cloudflare secret instead of plaintext config:

```sh
pnpm exec wrangler secret put APNS_PRIVATE_KEY
```

#### 4. Verify locally ｜ 本地验证

```sh
pnpm test
pnpm check
pnpm build
```

`pnpm build` runs `wrangler deploy --dry-run`.

#### 5. Deploy ｜ 部署

```sh
pnpm exec wrangler deploy
```

## Apply production protections ｜ 保护措施

After deployment, configure the protections that sit in front of the Worker:

- Set `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` unless you explicitly want an open push endpoint.
- Add Cloudflare Rate Limiting rules for `/register`, `/push`, `/mcp`, and `/mcp/*`. IP-based limits are the usual starting point.

> **中文说明：** 部署后需配置防护措施：设置 `BASIC_AUTH_USER` 和 `BASIC_AUTH_PASSWORD`（除非你明确需要开放推送端点）；为 `/register`、`/push`、`/mcp` 和 `/mcp/*` 添加 Cloudflare 速率限制规则，通常以 IP 为基础。

After deployment, you can set up your Bark App and smoke-test the service:

```sh
curl https://<your-worker>.workers.dev/ping
curl "https://<your-worker>.workers.dev/<device_key>/Title/Hello"
```

## MCP Usage

The Worker exposes Bark push as an MCP tool so AI agents can notify you when tasks finish or need attention.

- `POST /mcp` exposes `notify` and requires `device_key`
- `POST /mcp/:device_key` exposes `notify` without requiring `device_key`
- `GET` and `DELETE` on MCP endpoints return `405 Method Not Allowed`

The transport follows the MCP Streamable HTTP rules for version negotiation and optional sessions, but this deployment model intentionally does not keep a standalone SSE stream open.

If `MCP_SESSION_SECRET` is configured, `initialize` returns `Mcp-Session-Id` and clients may reuse it on later requests. Existing clients may still skip `initialize` and call tools directly for backward compatibility, so the session secret is not a replacement for Basic Auth.

The MCP endpoint accepts one JSON-RPC message per POST. JSON-RPC batch arrays are rejected with `400`.

This is useful for long-running agents such as Claude Code or Codex that should send a Bark notification at task completion.

> **中文说明：** Worker 将 Bark 推送暴露为 MCP 工具，供 AI 代理在任务完成或需要关注时通知你。`POST /mcp` 需要 `device_key`，`POST /mcp/:device_key` 则不需要；MCP 端点的 `GET` / `DELETE` 会返回 `405 Method Not Allowed`。传输层遵循现代 Streamable HTTP 的版本协商和可选 session 语义，但当前部署不会保持独立 SSE 流。若配置 `MCP_SESSION_SECRET`，`initialize` 会返回 `Mcp-Session-Id` 供后续请求复用；为了兼容现有客户端，仍允许跳过 `initialize` 直接调用工具，因此 session secret 不能替代 Basic Auth。MCP 端点每个 POST 接受一条 JSON-RPC 消息，JSON-RPC 批量数组会返回 `400`。

## Development ｜ 开发

Useful commands ｜ 常用命令:

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
