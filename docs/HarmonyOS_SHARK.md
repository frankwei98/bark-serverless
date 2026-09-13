# Shark / HarmonyOS on Cloudflare Workers

This Worker supports the Shark fork's registration convention and Huawei Push Kit v3 transport. Automated tests use mock providers; real Shark device compatibility still needs validation. Existing Bark iOS registrations continue to use APNs.

## Configure Huawei credentials

Use a service account authorized for the project that issued the Shark app's Push Token. A service account for an unrelated application cannot deliver to those tokens. Obtain authorized credentials from the application/project owner; the fork's committed credentials and database are not deployment inputs.

Configure these Worker bindings:

| Binding | Purpose |
| --- | --- |
| `HUAWEI_PROJECT_ID` | Project used in the v3 request URL |
| `HUAWEI_KEY_ID` | JWT header `kid` |
| `HUAWEI_SUB_ACCOUNT` | JWT issuer `iss` |
| `HUAWEI_PRIVATE_KEY` | Full PKCS#8 RSA PEM private key, stored as a Secret |
| `HUAWEI_REQUEST_TIMEOUT_MS` | Optional HTTP request timeout including response-body reading; default 10000 ms, maximum 60000 ms |

Store account configuration through Cloudflare's encrypted secret bindings, using the interactive prompts:

```sh
pnpm exec wrangler secret put HUAWEI_PROJECT_ID
pnpm exec wrangler secret put HUAWEI_KEY_ID
pnpm exec wrangler secret put HUAWEI_SUB_ACCOUNT
pnpm exec wrangler secret put HUAWEI_PRIVATE_KEY
```

Do not paste credential values into shell command arguments, source files, test fixtures, or logs. The sender uses a fixed Huawei HTTPS endpoint and signs PS256 JWTs directly; there is no OAuth token exchange or local key file dependency. Huawei configuration is checked when sending a Harmony message, so an iOS-only deployment does not need these bindings.

`HUAWEI_REQUEST_TIMEOUT_MS` can be set in `[vars]` in `wrangler.toml`. Invalid values fall back to 10000 ms. Keep the existing KV namespace and Durable Object binding/migration. After configuration, use the repository's normal `pnpm build` and `pnpm deploy` workflow.

> 中文：先配置有权向 Shark 客户端所属项目发送推送的服务账号，再部署 Worker。四项账号配置可通过上面的交互式 Secret 命令输入；不要使用 fork 仓库里的账号或密钥。原有 iOS 注册无需迁移，也不依赖 Huawei 配置。

## Registration and storage

Shark can use the existing registration endpoint:

```http
POST /register
Content-Type: application/json

{"device_token":"<device-push-token>","platform":"harmony"}
```

`harmony`, `harmonyos`, and `hmos` are recognized case-insensitively with surrounding whitespace ignored. GET query registration and form registration support the same field. Existing `key` / `devicetoken` aliases remain supported.

The response keeps `key`, `device_key`, and `device_token`. Harmony `device_token` values are returned and stored with one `harmony:` prefix. Re-registering the returned value does not add another prefix. Empty raw tokens and repeated prefixes are rejected.

Missing or unknown platform values retain legacy behavior for ordinary tokens. The reserved `harmony:` prefix selects Huawei even without a platform field, matching the fork's routing convention. Ordinary tokens continue to select APNs.

Explicit Harmony registration accepts raw tokens up to 4096 UTF-8 bytes, a Worker resource bound. Without a recognized Harmony platform, the existing 160-character validation still applies, including the prefix if supplied. Send `platform=harmony` on token refreshes as well as initial registration.

No storage migration is required. The existing per-device Durable Object remains authoritative, and KV mirrors retain string values under `device:<device_key>`. Registration updates and conditional deletion continue through the coordinator; the original stored token is the comparison value.

## Push compatibility

Use the same V1 URLs, `POST /push`, `device_keys` batch requests, and MCP `notify` tool as Bark. Each recipient selects its own provider; batch results retain input order. Existing APNs sound normalization and payload behavior are preserved.

Huawei uses `POST https://push-api.cloud.huawei.com/v3/<project-id>/messages:send` with a single token per request:

- Normal notifications use `push-type: 0`.
- `delete=1` uses `push-type: 6`, with extension data encoded as a JSON string in `payload.extraData`. Whether Shark acts on it requires device testing.
- A successful API response means Huawei accepted the request, not that the device displayed the notification.

Implemented Harmony mappings:

| Bark input | Huawei behavior |
| --- | --- |
| `title`, `body` | Notification title and body; click opens the app |
| `category` | Forwarded when nonempty; defaults to `WORK` |
| `sound` | Explicit nonempty sound gets `.mp3` unless already suffixed; omitted sound uses the system default |
| `badge` | Integer 0–99 maps to `setNum`, including explicit zero to clear |
| `badge_set` / `badgeSet` / `setNum` | Set count; takes precedence over additive count |
| `badge_add` / `badgeAdd` / `addNum` | Add 1–99; nested badge objects are also handled through the existing parser |
| `image` | Notification image URL; use an HTTPS image acceptable to Huawei |
| `foreground_show` / `foregroundShow` | Boolean or string `true/false`, `t/f`, `1/0` |
| `inboxContent` / `inbox_content` | Array or `\|` / newline / comma-delimited text; keeps up to three nonempty lines of at most 1024 characters, selects style 3 |
| `style=1` | Large-text style, using title/body for the required large-text fields |
| `ttl` | Positive integer up to 1296000 seconds; invalid/out-of-range values are omitted |
| `delete=1` | Background message with serialized extension fields, including explicitly supplied raw sound |

Huawei requests are limited to 4096 UTF-8 bytes excluding the target token. Provider responses are capped at 64 KiB. Public push failures retain the existing Bark `500` response convention, with a safe Huawei business code when available. The sender does not automatically retry, avoiding duplicate messages when delivery is uncertain.

Ordinary alerts do not forward `subtitle`, `url`, `group`, `icon`, `ciphertext`, or arbitrary extension fields. They are currently ignored for Harmony as in the fork's limited alert mapping; do not rely on them for encrypted delivery or click behavior. APNs still receives its existing fields. Invalid optional badge/TTL values are omitted, and oversized inbox lines are skipped. These boundaries are deliberate first-version behavior, not a claim of full client parity.

The sender checks HTTP and Huawei business responses. Partial success, unknown codes, malformed responses, authentication errors, and permission errors are not reported as successful delivery. Huawei error `80300007` alone does not prove permanent token failure: its documented causes include project and permission mismatches. Such errors must not erase a registration.

This version conservatively retains registrations on all Huawei failures. Existing APNs invalid-token cleanup still uses compare-and-delete, including when the device has since registered a Harmony replacement.

## Device validation

1. Configure an authorized project account and deploy the Worker.
2. Add the Worker URL in Shark and verify registration returns a device key. Confirm the target device uses the v3-compatible HarmonyOS version.
3. Send a title/body message through a V1 URL and JSON `/push`; check foreground and background behavior.
4. Check sounds, badge updates/clearing, notification taps, and `delete=1` separately.
5. Re-register after a token refresh, then verify both the new Harmony token and an existing iOS registration still receive messages.
6. Exercise a mixed iOS/Harmony batch and MCP notification. Check per-device results without recording tokens or JWTs.

Encrypted messages and client-specific fields require additional Shark protocol verification. This implementation does not claim full parity for every Bark extension or support for Push Kit v2, cards, voice broadcasts, live views, or calls.

## Validation for this implementation

- 245 automated tests passed, including registration, provider routing, independently verified PS256 signatures, payloads, business errors, response limits, timeout cancellation, mixed batches, MCP, and conditional deletion.
- TypeScript checking and Wrangler dry-run build passed.
- Local workerd smoke tests used generated RSA/EC keys and mocked providers, with real local Durable Object/KV bindings. Registration, V1, mixed batch, and MCP passed, and four provider request signatures were independently verified.
- No deployment or real Huawei/APNs sends were performed for this change. Real-device validation is the next step.

References: [Huawei v3 request structure](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/push-scenariozed-api-request-struct), [service-account JWT](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-jwt-token), [business response codes](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/push-scenariozed-api-response), [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/).
