# Shark / HarmonyOS 推送兼容性源码研究笔记

> 供后续实现 session 使用。本文只记录固定源码快照、可复核推断和落地建议，不代表 fork 的实现已经在本项目中移植或经过真机验证。

脱敏的三点比较原文见 [`docs/hmos-shark-support.diff`](./hmos-shark-support.diff)。

## 0. 比较基准与证据规则

比较对象：

- 上游：`Finb/bark-server` `master`，commit `3df8990fcbc407a3f5638eea8cedc3289d1a405d`（2026-07-07）。[固定 commit](https://github.com/Finb/bark-server/tree/3df8990fcbc407a3f5638eea8cedc3289d1a405d)
- fork：`xiaobingtech/bark-server` `master`，commit `32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2`（2026-06-22）。[固定 commit](https://github.com/xiaobingtech/bark-server/tree/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2)

本地使用完整历史克隆，并确认 GitHub 三点比较的共同祖先为 `478659ecdd75a38185d7275d154d78e9c2b752b`（fork 的 merge commit `cfa0c6e` 的第二父提交）。实际比较是该共同祖先到 fork tip 的三点 diff，而不是把 upstream tip 之后的依赖更新误算为 fork 修改；原始命令等价于：

```sh
git -C /tmp/bark-hmos-full.llgdSU/xiaobingtech-bark-server \
  diff 478659ecdd75a38185d7275d154d78e9c2b752b...32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2
```

比较结果为 17 个路径：7 个修改、10 个新增，无删除或重命名。fork 的最终提交标题虽然是 `Update docker-compose.yaml`，不能据此把变更误读成只改了 compose。

证据标记：

- **事实**：能直接由固定 commit 的源码、配置、测试或随 fork 提交的 Push Kit 资料读出。
- **推断**：由事实推导出的运行时行为或兼容性影响；需要实现时再用测试/真机确认。
- **建议**：面向当前 Cloudflare Worker 项目的设计或实施选择。

本文没有复制任何私钥、JWT、Push Token、APNs 凭证或服务账号凭证值。fork 中的敏感文件仅以路径和结构说明。

## 1. 结论摘要

**事实**：fork 没有新增 HarmonyOS API 路由，也没有修改数据库接口。它在现有 `/register`、`/push` 和 V1 兼容路径上增加一个 `platform` 注册字段，用 `harmony:` 前缀包裹 Harmony Push Token；发送时按此前缀分流到新增 `harmony` 包，否则继续走 APNs。[注册差异](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/route_register.go#L11-L82) · [推送差异](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/route_push.go#L252-L295) · [上游对应实现](https://github.com/Finb/bark-server/blob/3df8990fcbc407a3f5638eea8cedc3289d1a405d/route_push.go#L250-L276)

**事实**：新增 `harmony/harmony.go` 实现了 Huawei Push Kit v3 的 HTTPS 请求、PS256 JWT 生成/缓存、单 token target、Alert（push-type `0`）和后台消息（push-type `6`）payload；服务账号信息和私钥是源码常量，不是部署配置。[Harmony 实现](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L21-L31) · [JWT 与请求](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L117-L143) · [payload/HTTP](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L152-L243)

**推断**：对“能把消息送到 Shark”而言，最小移植面是注册时保留平台信息、一个 Huawei sender 和一个 provider router；但 fork 的实现不能直接作为生产实现：凭证泄露、没有 Harmony 测试、忽略 Huawei 业务响应码/部分成功、错误状态被路由层改成 500，以及客户端池限流实际上没有生效。

**建议**：先以不暴露凭证的契约测试和 provider mock 锁定路由/存储/payload，再以 Cloudflare Secrets + Web Crypto 实现 Huawei JWT；存储先兼容 `harmony:` 方案，稳定后迁移为结构化注册记录。不要复制 fork 的 key 文件、硬编码私钥或其具体服务账号。

## 2. 变更文件总览

相对 GitHub 三点比较的共同祖先，fork 共有 **17 个受影响文件**：7 个修改、10 个新增；没有删除或重命名。

| 状态 | 文件 | 变化与用途 | 证据 |
|---|---|---|---|
| 修改 | `.gitignore` | 只新增 `.DS_Store`，没有忽略 Push Kit key 文件或 `bark-data`。 | [fork `.gitignore`](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/.gitignore#L1-L19) |
| 修改 | `README.md` | 重写为 Shark/HarmonyOS 说明、配置和部署文档；README 的产品描述不是实现证据。 | [fork README](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/README.md#L10-L18) |
| 修改 | `deploy/docker-compose.yaml` | 镜像改为 `xiaobingtech/bark-server:latest`，数据卷改为 `./bark-data:/data`；没有 Harmony 凭证注入。 | [fork compose](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/deploy/docker-compose.yaml#L1-L10) |
| 修改 | `docs/API_V2.md` | 增加 `platform`、注册说明、兼容路径和 MCP/根路径目录项。 | [fork API 文档](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/docs/API_V2.md#L290-L321) |
| 修改 | `main.go` | 引入 `harmony`，启动时无条件 `setupHarmony`；新增 `harmony-domain` 和 `max-harmony-client-count` flags/env。 | [fork main](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/main.go#L49-L58) · [flags](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/main.go#L146-L148) · [flag definitions](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/main.go#L298-L316) |
| 修改 | `route_register.go` | 增加平台字段、三个 Harmony 别名识别、前缀写入和 Harmony token 长度例外。 | [fork register](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/route_register.go#L11-L82) |
| 修改 | `route_push.go` | 保存 `sound` 原值给 Harmony；读取 token 后按 `harmony:` 分流。 | [fork push](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/route_push.go#L217-L242) · [分流](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/route_push.go#L261-L295) |
| 新增 | `harmony/harmony.go` | 完整的 Harmony sender、JWT supplier、两种 payload 及参数转换辅助函数。 | [fork Harmony 包](https://github.com/xiaobingtech/bark-server/tree/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony) |
| 新增 | `HarmonyOS-PushKit/` 下 7 个 Markdown | 随 fork 提交的 Huawei Push Kit v3 功能、请求结构/参数/示例、响应码、频控和 JWT 资料。 | [fork Push Kit 资料目录](https://github.com/xiaobingtech/bark-server/tree/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/HarmonyOS-PushKit) |
| 新增 | `HarmonyOS-PushKit/key/101653523863572770116892607private.json` | 被 Git 跟踪的服务账号 JSON，包含 `private_key` 字段；本文不打开或复制其值。 | [fork Push Kit 资料目录](https://github.com/xiaobingtech/bark-server/tree/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/HarmonyOS-PushKit) |
| 新增 | `bark-data/bark.db` | 32 KiB bbolt 二进制；可见字符串只有 `device` bucket，内容不可像源码一样审查，不能当迁移方案。 | [fork commit tree](https://github.com/xiaobingtech/bark-server/tree/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2) |

其余 Go 文件（APNs、database、MCP、router、`push_test.go` 等）与上游逐文件内容相同；因此 Harmony 能力主要集中在上表的 4 个 Go 文件和随附资料，而不是一次全面重构。

注意：若直接比较 upstream tip `3df8990` 与 fork tip `32cda6d` 的两个工作树，会额外看到 upstream 后续的 `x/net`/`x/sys` 依赖升级；GitHub URL 使用三点比较，这些不是 fork 自身的变更，故未列入上表。

## 3. HarmonyOS 注册与平台识别

### 3.1 fork 已实现的事实

1. `DeviceInfo` 新增 `Platform`，支持 form/JSON/XML/query 绑定；旧字段 `key`、`devicetoken` 保留。[`DeviceInfo`](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/route_register.go#L11-L19)
2. 平台值先 `TrimSpace`、转小写，`harmony`、`harmonyos`、`hmos` 三者都会被识别。[平台识别](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/route_register.go#L45-L66)
3. 非 Harmony token 仍受 `len <= 160` 校验；Harmony token 跳过该校验，然后如果没有前缀就写成 `harmony:<raw-token>`。[长度与前缀](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/route_register.go#L57-L70)
4. `/register` 的响应 `device_token` 是处理后的值，因此 Harmony 注册响应会带 `harmony:` 前缀，而不是原始 Push Token。[注册响应](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/route_register.go#L68-L82)

### 3.2 推断与边界

- 平台没有作为独立字段持久化；平台信息完全编码在 token 字符串里。换言之，这是“token namespace”而不是多平台设备模型。
- 任何未声明 `platform`、但 token 恰好以 `harmony:` 开头的注册值，后续都会被当成 Harmony；这是前缀碰撞风险。
- `harmony:` 本身是非空输入，注册阶段可以写入；发送阶段去掉前缀后为空，再由 sender 返回 400。注册阶段没有验证去前缀后的 token 非空。
- 这种协议没有客户端握手或能力协商；fork 的 README 只链接 Shark 客户端，服务端仓库没有 Harmony 客户端源码。[README 客户端链接](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/README.md#L319-L326)

### 3.3 对当前项目的含义

当前项目的注册 DTO 只有 `device_key`、`device_token`、旧别名，没有 `platform`；并且统一对 token 做 160 字符限制。[当前 `register.ts`](../worker/src/routes/register.ts#L9-L18) · [当前校验](../worker/src/routes/register.ts#L75-L100)

因此最小兼容改动需要同时处理：平台输入、Harmony token 的长度/格式策略、注册响应，以及旧 iOS 注册的行为保持不变。不要只把 Huawei sender 接到 APNs sender 后面，否则 Harmony token 会在注册阶段先被拒绝。

## 4. Token 存储与路由

### 4.1 fork 已实现的事实

- fork 没有修改 `database.Database` 接口；它仍是 `CountAll`、按 key 读取/保存 token、删除、关闭这组单 token 操作。[数据库接口](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/database/database.go#L3-L10)
- bbolt 仍把值存进 `device` bucket；保存与读取的是整个字符串，所以 `harmony:` 前缀会原样持久化。MySQL、memory、env backend 也沿用同一个字符串接口。[bbolt bucket/保存](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/database/bbolt.go#L21-L29) · [bbolt token](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/database/bbolt.go#L51-L92)
- push 先按现有 device key 取 token；此前缀时去掉 `harmony:`，将 title/body/ext params/delete flag 交给 `harmony.Push`，否则把完整 token 交给 APNs。[fork 分流](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/route_push.go#L261-L295)
- Harmony 失败没有像 APNs 分支那样按无效 token 清理数据库；清理逻辑只位于 APNs 调用之后。[上游清理逻辑](https://github.com/Finb/bark-server/blob/3df8990fcbc407a3f5638eea8cedc3289d1a405d/route_push.go#L264-L276)

### 4.2 重要推断

前缀方案的好处是对 bbolt/MySQL/env 无 schema 变更、旧 iOS token 无迁移成本；代价是 provider 类型不能独立查询、前缀可能碰撞、token 会被直接作为注册响应的一部分回显，且未来加入第三个 provider 会继续堆叠字符串协议。

当前项目比 fork 多了一层 Durable Object 权威状态和 KV mirror：状态中的 `token` 是字符串，旧 KV 值也会被读取并迁移到 DO。[当前注册状态](../worker/src/services/device-registry-coordinator.ts#L28-L40) · [当前 legacy read](../worker/src/services/device-registry-coordinator.ts#L91-L109) · [当前 mirror](../worker/src/services/device-registry-coordinator.ts#L197-L205)

**建议**：第一阶段可以采用完全向后兼容的 `harmony:` 前缀，并把 router 放在 `PushSender` 或其上层；但在同一次设计中定义 `RegisteredDevice { token, platform }` 的内部模型。第二阶段再把 DO/KV value 从裸字符串迁移为版本化 JSON，读取旧裸字符串时默认 `ios`，读取 `harmony:` 时兼容识别。删除/无效 token 清理必须带 expected token，沿用当前项目已经实现的 compare-and-delete 语义。

## 5. API 与参数兼容性

### 5.1 API 表面

**事实**：fork 仍使用原 Bark 的 `/register`、`/register/:device_key`、`/push`、V1 `/:device_key...` 兼容路径和 MCP；新增的是注册 `platform` 字段及文档，不是 Harmony 专用端点。[fork API 注册项](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/docs/API_V2.md#L290-L333) · [fork 兼容路径](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/docs/API_V2.md#L53-L64)

当前项目已经保留相同的路由形状和 body/query/path 优先级。[当前 push 路由](../worker/src/routes/push.ts#L214-L239) · [当前 V2 解析](../worker/src/routes/push.ts#L292-L355)

### 5.2 fork 的 Harmony 参数映射

下表是按 `harmony/harmony.go` 代码而不是 README 推出的实际行为：

| 入参/扩展字段 | Harmony payload 行为 | 证据 |
|---|---|---|
| `title`, `body` | 放入 `payload.notification.title/body`；`clickAction.actionType` 固定为 `0`。 | [notification 构造](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L163-L174) |
| `category` | 放入 notification，默认 `WORK`。 | [category](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L169-L174) |
| `image` | 放入 `notification.image`。 | [image](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L175-L177) |
| `badge`, `badge_add`, `badge_set` 等 | 转成 `notification.badge` 的 `addNum`/`setNum`。 | [badge](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L178-L180) · [badge helpers](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L393-L433) |
| `sound` | 原始值被 route 复制进 `ExtParams`；Harmony 侧非空值若没有 `.mp3` 后缀就追加 `.mp3`。 | [route 保存原值](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/route_push.go#L232-L242) · [sound 映射](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L181-L188) |
| `style`, `inboxContent`/`inbox_content`/`inboxcontent` | 映射到通知样式和 `inboxContent`；有 inbox 内容且未指定 style 时默认 style `3`。 | [style/inbox](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L190-L203) · [inbox parsing](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L324-L390) |
| `foreground_show` | 可转成 boolean 后放入 `notification.foregroundShow`。 | [foreground](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L200-L203) · [bool conversion](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L436-L445) |
| `ttl` | 大于 0 才放入 `pushOptions.ttl`；`testMessage` 总是 false。 | [push options](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L206-L215) |
| `delete=1` | 不发送 alert，改成 `push-type: 6`，payload 为 `backgroundPayload{extraData: JSON(all ExtParams)}`。 | [delete branch](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L163-L168) |

**重要兼容缺口（事实）**：`subtitle`、`url`、`group`、`icon`、`ciphertext` 等虽然会进入通用 `ExtParams`，但普通 alert payload 只挑选上表字段，没有把其余字段放进 `extraData`；这些字段对 Harmony 不是自动等价映射。[alert payload 结束位置](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L169-L204) · [结构体字段](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L73-L108)

**建议**：为公共 Bark 参数建立“跨平台语义”和“provider 专属扩展”两层映射。对无法在 Harmony alert 中表达的字段，要么明确返回/记录“不支持”，要么按 Shark 客户端协议放入合法的 `extraData`，不要静默丢弃。

## 6. Huawei Push Kit v3 认证、请求与 payload

### 6.1 fork 已实现的事实

1. 默认请求 URL 是 `https://push-api.cloud.huawei.com/v3/<projectId>/messages:send`，domain 可由 `harmony-domain` 覆盖；默认超时 5 秒。[初始化 URL/客户端](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L117-L145)
2. JWT 使用 `PS256`，header 设置 `kid`、`typ=JWT`、`alg=PS256`；claims 是 `aud=token URI`、`iss=sub_account`、`iat=当前 UTC 秒`、`exp=iat+3600`，并在过期前 30 秒刷新。[JWT supplier](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L245-L286)
3. 请求头为 `Content-Type: application/json; charset=UTF-8`、`Authorization: Bearer <JWT>`、`push-type: 0|6`；target 仅携带一个 token。[请求头](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L211-L243)
4. 随 fork 提交的 Push Kit 资料说明：v3 的请求结构包含 `payload`、`target`、可选 `pushOptions`；`push-type` 0 是 Alert、6 是后台消息；资料还把 v3/v2 与 HarmonyOS Next/5+、HarmonyOS 3/4 的版本对应关系写出。[请求结构资料目录](https://github.com/xiaobingtech/bark-server/tree/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/HarmonyOS-PushKit)

因此，**事实**是 fork 采用了“服务账号签名 JWT 直接作为 v3 Bearer”的路径，代码没有再调用 OAuth token endpoint 交换 access token；这与其随附资料中 v3 JWT 说明一致。是否需要兼容更老的 HarmonyOS 版本，不能仅由 Shark 名称推断，应以客户端 target SDK/设备版本和华为当前文档为准。

### 6.2 payload 覆盖范围

fork 的 `notification` 结构只声明 `category/title/body/clickAction/style/inboxContent/badge/image/sound/foregroundShow/extraData`；实际普通 alert 构造没有给 `notification.extraData` 赋值。[notification 类型](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L64-L93) · [alert 构造](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L169-L204)

Huawei 资料列出更广的 v3 场景（0/1/2/6/7/10），但 fork 只实现 0 和 6；没有卡片刷新、语音播报、实况窗、应用内通话等 payload。[请求体结构资料目录](https://github.com/xiaobingtech/bark-server/tree/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/HarmonyOS-PushKit)

### 6.3 响应处理风险

**事实**：sender 读取 provider response body，但只以 HTTP status 是否为 200 判定成功；非 200 时把整段响应文本作为 error，200 时不解析业务响应码。[响应处理](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L231-L243)

随 fork 的响应资料同时列出 `80000000` 成功、`80100000` 部分 Token 成功、`80200001` 认证错误、`80300007` 所有 Token 无效、`80300008` 消息体超过 4096 Bytes、`80300010` token 数超限等业务码。[响应码资料目录](https://github.com/xiaobingtech/bark-server/tree/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/HarmonyOS-PushKit)

**推断**：fork 可能把 HTTP 200 + 部分失败/业务失败当成完全成功，无法按 token 清理或向调用方准确报告；这比单纯的 HTTP error 更危险，因为调用方会收到成功响应。

此外，`route_push.go` 在 Harmony sender 返回错误时固定返回 `500`，丢失 `harmony.Push` 原本返回的 provider HTTP status。[Harmony 分支错误返回](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/route_push.go#L266-L281)

**建议**：定义结构化 `ProviderResult`（HTTP status、Huawei business code、per-token errors、retryability），只在业务码明确成功时返回成功；把认证/权限/过期/token 无效/频控/消息超限区分为可观测且可测试的错误类别。Worker 中应设置请求超时、限制响应体大小，并避免把供应商原文未经筛选地回显给外部。

## 7. 数据库、配置与部署

### 7.1 fork 已实现的事实

- 没有数据库 schema、migration 或 backend interface 变更；Harmony token 只作为普通字符串保存。
- `main.go` 在数据库初始化后无条件调用 `setupHarmony`。`harmony.Init` 会载入硬编码服务账号并创建 client；初始化失败会阻止服务器启动。[启动顺序](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/main.go#L49-L58) · [Harmony Init](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L117-L145)
- 新增的可配置项是 `BARK_SERVER_HARMONY_DOMAIN`（默认 `push-api.cloud.huawei.com`）和 `BARK_SERVER_MAX_HARMONY_CLIENT_COUNT`（默认 `1`）。[flag/env](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/main.go#L305-L316)
- compose 只启动 fork 镜像、挂载 `bark-data`、暴露 8080，没有通过 environment、secret file 或 Docker secret 注入 Harmony 服务账号。[fork compose](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/deploy/docker-compose.yaml#L1-L10)
- `bark-data/bark.db` 是新增二进制，而现有 bbolt 启动逻辑本来会在 data 目录创建 `bark.db` 和 `device` bucket；这个提交没有定义可审查的迁移步骤。[bbolt setup](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/database/bbolt.go#L104-L129)

### 7.2 对当前 Worker 的适配

当前 Worker 的配置和 binding 目前只有 APNs、Basic Auth、KV/DO 等，没有 Huawei binding；APNs 私钥由 binding 传给 Cloudflare Web Crypto sender。[当前 bindings](../worker/src/types.ts#L19-L48) · [当前 sender wiring](../worker/src/index.ts#L11-L35) · [当前 APNs Web Crypto](../worker/src/services/cloudflare-apns-client.ts#L170-L215)

**建议配置形状**（名称可调整）：

| Binding | 类型 | 用途 |
|---|---|---|
| `HUAWEI_PROJECT_ID` | 普通变量 | v3 URL project ID |
| `HUAWEI_KEY_ID` | 普通变量 | JWT `kid` |
| `HUAWEI_SUB_ACCOUNT` | 普通变量 | JWT `iss` |
| `HUAWEI_PUSH_DOMAIN` | 普通变量 | 默认 Huawei push domain，生产环境不要让请求参数任意改 host |
| `HUAWEI_PRIVATE_KEY` | Secret | PKCS#8 RSA private key，仅运行时读取 |
| `HUAWEI_REQUEST_TIMEOUT_MS` | 普通变量 | 受硬上限保护的请求超时 |

`HUAWEI_PRIVATE_KEY` 不应写进 `wrangler.toml`、仓库、测试 fixture 或日志；当前项目的配置文件已经展示 APNs key 的部署方式，但 Harmony 私钥必须按同样的“运行时 binding”模式处理，不能复制 fork 的硬编码做法。[当前 wrangler 配置](../wrangler.toml#L8-L33)

## 8. 前端/客户端关联

**事实**：fork 没有 Harmony 客户端源码、注册 SDK、前端页面或协议版本协商代码。README 只把 `xiaobingtech/Shark` 作为外部 HarmonyOS 客户端链接，API 文档只增加一个服务端 `platform` 字段示例。[README](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/README.md#L94-L100) · [Shark link](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/README.md#L319-L326)

**推断**：Shark 客户端至少需要把 Harmony Push Token 以 `platform=harmony`（或别名）注册到同一服务，并使用返回的 `device_key` 调用 Bark 兼容推送 API；但固定快照没有客户端源码或集成测试，不能确认它实际使用的字段名、返回值消费方式、设备升级后 token 刷新策略或 v3/v2 目标版本。

**建议**：实现前先从 Shark 客户端固定 commit 取得真实注册请求/响应契约，核对：

- token 获取和刷新是否发生在每次应用启动；
- 注册是 JSON POST 还是旧 GET query；
- 客户端是否把返回的 `device_token` 回存（fork 返回的是带前缀值）；
- HarmonyOS 版本与 Push Kit URL v3/v2 的对应关系；
- token 失效、应用升级和卸载后的重新注册行为。

## 9. 测试覆盖与缺失测试

### 9.1 已有测试的事实

fork 的 `push_test.go` 与上游内容相同，没有 `harmony` 包测试，也没有 Huawei HTTP mock。测试覆盖的是注册、V1/V2 push、ciphertext 和 batch push。[fork 测试](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/push_test.go#L34-L265)

测试默认常量 `deviceToken = ""`，`TestMain` 会在空值时 panic；它要求维护者先手动填写真实/有效 token。[测试前置条件](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/push_test.go#L16-L31)

### 9.2 本地复核结果

在 fork 固定快照目录执行（2026-09-13）：

```text
go test ./...
```

失败，观察到：

- `harmony/harmony.go:240` 和继承的 `apns/apns.go:147` 被 Go vet 报告为 `fmt.Errorf` 使用非 constant format string；
- 随后 root package 的 `TestMain` 因 `deviceToken is not set` panic；
- 因此不能把该 commit 的默认 CI/test 状态描述为通过。

仅执行：

```text
go test -vet=off ./harmony ./apns ./database
```

三个包显示 `[no test files]`，只能证明在该环境下可编译，不能证明能调用 Huawei 或 APNs。另对新增/修改的 Go 文件运行 `gofmt -l`，没有输出；`git diff --check` 的告警来自随 fork 引入的 Push Kit Markdown 资料尾随空格。测试期间没有修改 fork 工作树。

### 9.3 必须补的测试

1. 注册：三种 platform 别名、大小写/空白、重复 `harmony:`、空的 `harmony:`、Harmony 长 token、旧 iOS 长度限制、GET query 与 JSON/form。
2. 路由：带前缀 Harmony token 去前缀一次；普通 iOS token 仍只进 APNs；前缀碰撞策略明确；delete 与 batch 行为明确。
3. JWT：固定 clock 的 claim、PS256 header、`iat/exp`、30 秒刷新窗口、私钥解析失败、缺配置；测试只用专门生成的假 key，禁止真实服务账号。
4. HTTP contract：URL、method、headers、push-type、单 token target、alert/background JSON、sound `.mp3`、badge、ttl、4 KiB 限制。
5. response：HTTP 200 + 各业务码、部分 token 成功、认证/权限/过期/无效 token/限频/超大消息，以及 retryable 与 non-retryable 分类。
6. 并发/超时：并发请求不共享可变 request state；超时、网络失败、响应体上限和 batch 结果顺序。
7. 当前 Worker 的 DO/KV：旧裸字符串兼容、Harmony 前缀/结构化记录、注册与无效 token 清理之间的 compare-and-delete 竞态。

## 10. 安全问题

### 10.1 严重问题：固定 commit 包含可用凭证材料

**事实**：

- `HarmonyOS-PushKit/key/101653523863572770116892607private.json` 被 Git 跟踪，JSON 结构包含 `private_key`；
- `harmony/harmony.go` 的常量区直接包含服务账号标识和完整 RSA private key PEM，`loadServiceAccountKey` 在运行时返回这些常量。[敏感常量所在固定文件（不要复制内容）](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L21-L31) · [加载逻辑](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L277-L301)
- `.gitignore` 没有排除该 key 路径；fork 还跟踪了 APNs `.p8/.pem`（这些文件已在共同祖先中存在，并非本次 Harmony 改动）和新增的 `bark.db`。[fork 忽略规则](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/.gitignore#L1-L19)

**建议（不在本任务中执行外部撤销操作）**：把这些服务账号视为已泄露，通知凭证所有者立即撤销/轮换；清理发布制品、镜像层和 Git 历史；用 secret manager 注入新 key；增加 secret scanning/pre-commit/CI 阻断。本文不提供 key 值，也不把 key 文件作为实现输入。

### 10.2 其他代码级风险

- `max-harmony-client-count` 看似是连接池上限，但 `Push` 从 channel 取出 client 后立即放回，再执行 HTTP 请求；并发请求不会被该 channel 限制。[client channel](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L110-L145) · [借还位置](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L223-L236)
- `io.ReadAll(resp.Body)` 没有响应体上限；非 200 body 还会作为 error 字符串向上层传播。[响应读取](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/harmony/harmony.go#L231-L243)
- `harmony-domain` 可由环境/flag 改变 URL host。它是运维配置，不应向不可信请求暴露；生产配置应固定 allowlist，避免凭证被发送到错误的 HTTPS host。[domain flag](https://github.com/xiaobingtech/bark-server/blob/32cda6d895d0e75be3ef4ee1ad9f157f4bd154e2/main.go#L305-L310)
- provider token、设备 token 和 JWT 不应写日志；当前 fork 的 provider error body 和注册响应设计都需要在 Worker 版本中重新审查回显边界。

## 11. Shark 兼容实现建议、风险与分阶段顺序

### Phase 0 — 先封存兼容契约与凭证边界

**建议**：固定 Shark 客户端 commit、注册示例和目标 HarmonyOS 版本；从服务账号管理侧轮换 fork 已暴露的 key；定义 `platform` 的允许值和公共错误格式。为本项目建立 provider mock，不依赖真实 Huawei/APNs。

**退出条件**：能列出 Shark 实际请求字段、返回字段、token 刷新行为和 v3/v2 目标；仓库与部署配置没有 Harmony 私钥。

### Phase 1 — 最小双 provider 路由

**建议**：

- 保留现有 `/register`、`/push`、V1 paths 和 MCP；注册接受 `platform` 别名；旧记录默认 APNs。
- 内部先使用 `harmony:` 兼容编码，严格禁止空 raw token、重复前缀和未知 platform；把 provider router 放在 sender 层，route 不直接耦合供应商。
- 新增 `HuaweiPushSender`，使用 Cloudflare Web Crypto 的 RSA-PSS/SHA-256（PS256）和 `HUAWEI_PRIVATE_KEY` secret；JWT cache 按 issuer/key/project 维度隔离。
- sender 只发 v3 push-type 0/6，明确记录不支持的参数；初始只承诺 title/body/category/sound/badge/ttl/delete 的已验证子集。

**风险**：前缀碰撞、注册响应回显、Harmony token 无效清理、Huawei 业务码与 HTTP 200 的差异。

**退出条件**：单元/contract 测试覆盖注册、分流、JWT、payload、错误；旧 APNs 测试全绿；没有真实凭证依赖。

### Phase 2 — 结构化结果与存储演进

**建议**：

- 将 registry 内部记录升级为 `{ version, platform, token }`，保留对旧裸字符串和 `harmony:` 的读取兼容。
- 对 DO 的 authoritative state、pending mirror、KV mirror 一起做版本化；写入使用 generation/expected token，避免旧推送失败删除新 token。
- 解析 Huawei 业务码，支持 per-token 清理和 retry policy；批量请求仍由本项目控制并保持输入顺序。

**风险**：DO v1 数据兼容、KV 最终一致、迁移中重复注册和回滚。

**退出条件**：旧 iOS 记录、已注册 Harmony 记录、注册更新、无效 token 清理和 alarm 重试均有测试。

### Phase 3 — 参数扩展与真实设备验证

**建议**：与 Shark 客户端共同确定 `extraData`、声音、badge、前台展示和点击行为；在受控账号/设备上做 v3 alert/background 真机 smoke test，再逐项加入卡片/语音/实况窗等 push-type，而不是把所有 vendor 文档字段直接映射到公共 Bark API。

**风险**：华为业务权益、4 KiB 消息限制、OS 升级导致 Push Token 变化、不同 HarmonyOS 版本的 v3/v2 差异。

**退出条件**：有脱敏的请求快照、供应商响应码矩阵、真机结果和回滚开关；监控不会泄露 token/JWT。

### Phase 4 — 文档与运营化

**建议**：补 `docs/` 下的正式 API/配置说明，加入 secret rotation、限频、告警和 provider health；将 `HUAWEI_*` 配置放入 secret/deployment 文档而不是示例私钥。为每个 provider 明确 SLA、重试、失败清理和支持的参数。

## 12. 后续 session 可直接执行的清单

- [ ] 固定并审阅 Shark 客户端的注册/推送调用 commit；确认 target OS 与 Push Kit URL 版本。
- [ ] 先在测试中定义 platform/token registry 模型和兼容读取，不改现有 APNs 行为。
- [ ] 用生成的临时 RSA key 编写 PS256 JWT/Payload provider contract tests。
- [ ] 增加 Huawei 业务码解析、retryability、无效 token compare-and-delete。
- [ ] 设计并测试 DO/KV 记录迁移；不把 fork 的 `bark.db` 当作数据输入。
- [ ] 只通过 Cloudflare secret binding 部署 Harmony private key，CI 扫描仓库、构建产物和日志。
- [ ] 真机验证完成后，再扩展到额外 push-type 和未覆盖 Bark 参数。
