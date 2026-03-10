# qclaw-wechat-client

[English](./README.md)

逆向工程实现的 QClaw 微信接入 API TypeScript 客户端。

QClaw（管家 OpenClaw）是腾讯的一款 Electron 桌面应用，封装了 OpenClaw AI 网关服务。它通过微信 OAuth2 扫码登录进行认证，并通过 jprx 网关协议与腾讯后端服务器通信。本库将该协议实现为独立的 TypeScript 模块。

## 来源

从 `QClaw.app` -> `Contents/Resources/app.asar`（未加密）中提取。API 服务类（`tS` / `openclawApiService`）位于打包后的渲染进程文件 `out/renderer/assets/platform-QEsQ5tXh.js` 中。

## 安装

```bash
npm install qclaw-wechat-client
# 或
pnpm add qclaw-wechat-client
```

## 开发

```bash
pnpm install      # 安装依赖
pnpm build        # 使用 tsdown 构建
pnpm typecheck    # 仅类型检查
```

## 快速开始

```typescript
import { QClawClient } from "qclaw-wechat-client";
import type { WxLoginStateData, WxLoginData } from "qclaw-wechat-client";

const client = new QClawClient({ env: "production" });

// 第 1 步 - 获取登录状态（CSRF token）
const stateRes = await client.getWxLoginState({ guid: "machine-id" });
const state = QClawClient.unwrap<WxLoginStateData>(stateRes)?.state;

// 第 2 步 - 向用户展示二维码
const qrUrl = client.buildWxLoginUrl(state!);
console.log("请扫描:", qrUrl);

// 第 3 步 - 用微信回调的授权码换取会话
const loginRes = await client.wxLogin({ guid: "machine-id", code: authCode, state: state! });

// 第 4 步 - 构建 OpenClaw 配置补丁
const channelToken = QClawClient.unwrap<WxLoginData>(loginRes)?.openclaw_channel_token;
const config = await client.buildPostLoginConfig(channelToken!);
// -> { channels: { "wechat-access": { token } }, models: { providers: { qclaw: { apiKey } } } }
```

## 示例

内置示例演示完整的微信登录流程及回声机器人：

```bash
pnpm demo          # 交互式完整流程示例（登录 + AGP 回声机器人）
```

## API

### `new QClawClient(options?)`

| 选项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `env` | `"production" \| "test"` | `"production"` | 目标环境 |
| `jwtToken` | `string` | -- | 从上一次会话恢复 JWT |
| `userInfo` | `UserInfo` | -- | 从上一次会话恢复用户信息 |
| `webVersion` | `string` | `"1.4.0"` | 每次请求体中携带的版本号 |

### 属性

| 属性 | 类型 | 说明 |
|---|---|---|
| `client.envUrls` | `EnvUrls` | 当前环境的 URL 配置 |
| `client.wxLoginConfig` | `WxLoginConfig` | 微信 OAuth appid 和重定向地址 |
| `client.currentUser` | `UserInfo \| null` | 已登录用户（`wxLogin` 后自动设置） |
| `client.token` | `string \| null` | 当前 JWT（自动续期） |

### 方法

#### 认证

| 方法 | 端点 | 说明 |
|---|---|---|
| `getWxLoginState({ guid })` | `data/4050/forward` | 获取 QR 登录的 CSRF state |
| `wxLogin({ guid, code, state })` | `data/4026/forward` | 用微信授权码换取 JWT + channel token |
| `getUserInfo({ guid })` | `data/4027/forward` | 获取用户信息 |
| `wxLogout({ guid })` | `data/4028/forward` | 注销会话 |
| `buildWxLoginUrl(state)` | -- | 构建微信 OAuth 二维码 URL |

#### 密钥与令牌

| 方法 | 端点 | 返回值 | 说明 |
|---|---|---|---|
| `createApiKey()` | `data/4055/forward` | `ApiResponse<ApiKeyData>` | 创建 qclaw 模型提供者的 API 密钥 |
| `refreshChannelToken()` | `data/4058/forward` | `string \| null` | 刷新 wechat-access channel token（直接返回 token 字符串，不是 `ApiResponse` 包装） |

#### 邀请码

| 方法 | 端点 | 说明 |
|---|---|---|
| `checkInviteCode({ guid })` | `data/4056/forward` | 检查邀请码状态 |
| `submitInviteCode({ guid, invite_code })` | `data/4057/forward` | 提交邀请码 |

#### 设备管理

| 方法 | 端点 | 说明 |
|---|---|---|
| `queryDeviceByGuid(params)` | `data/4019/forward` | 查询设备状态 |
| `disconnectDevice(params)` | `data/4020/forward` | 断开设备连接 |
| `generateContactLink(params)` | `data/4018/forward` | 生成专属链接 |

#### 更新检查

| 方法 | 端点 | 说明 |
|---|---|---|
| `checkUpdate(version?, system?)` | `data/4066/forward` | 检查应用更新 |

#### 配置辅助

| 方法 | 说明 |
|---|---|
| `buildConfigPatch(channelToken, apiKey)` | 构建 OpenClaw 配置对象 |
| `buildPostLoginConfig(channelToken)` | 创建 API 密钥 + 构建配置（便捷方法） |

### 静态方法

```typescript
QClawClient.getEnvUrls("production")      // 无需实例化即可获取环境 URL
QClawClient.getWxLoginConfig("production") // 微信 OAuth 配置
QClawClient.Endpoints                      // 所有端点路径常量
QClawClient.unwrap<T>(response)            // 解包腾讯嵌套响应
```

## AGP WebSocket 客户端

本库还包含完整的 **AGP（Agent Gateway Protocol，智能体网关协议）** 实现——用于智能体与微信用户之间实时消息交换的 WebSocket 协议。

这是一个**服务器推送通道**：当微信用户向你的智能体发送消息时，服务器发送 `session.prompt`，你通过 `session.update` + `session.promptResponse` 流式返回 AI 响应。

### 快速开始（WebSocket）

```typescript
import { AGPClient } from "qclaw-wechat-client";
import type { PromptMessage, CancelMessage } from "qclaw-wechat-client";

const client = new AGPClient(
  {
    url: "wss://mmgrcalltoken.3g.qq.com/agentwss",
    token: channelToken,  // 来自 wxLogin 或 refreshChannelToken
  },
  {
    onConnected() {
      console.log("已连接！等待消息...");
    },
    onPrompt(msg: PromptMessage) {
      const { session_id, prompt_id, content } = msg.payload;
      const text = content.map(b => b.text).join("");
      console.log(`用户说: ${text}`);

      // 流式返回响应
      client.sendMessageChunk(session_id, prompt_id, "Hello ");
      client.sendMessageChunk(session_id, prompt_id, "World!");

      // 结束本轮对话
      client.sendTextResponse(session_id, prompt_id, "Hello World!");
    },
    onCancel(msg: CancelMessage) {
      const { session_id, prompt_id } = msg.payload;
      client.sendCancelledResponse(session_id, prompt_id);
    },
    onError(err) {
      console.error(err);
    },
  },
);

client.start();
```

### `new AGPClient(config, callbacks?)`

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `url` | `string` | -- | WebSocket 端点（参见环境 URL） |
| `token` | `string` | -- | Channel 认证令牌 |
| `guid` | `string` | `""` | 设备 GUID（回传到上行消息中） |
| `userId` | `string` | `""` | 用户 ID（回传到上行消息中） |
| `reconnectInterval` | `number` | `3000` | 基础重连延迟（毫秒） |
| `maxReconnectAttempts` | `number` | `0` | 最大重试次数（0 = 无限） |
| `heartbeatInterval` | `number` | `20000` | WS ping 间隔（毫秒） |

### 回调

| 回调 | 参数 | 说明 |
|---|---|---|
| `onConnected` | -- | WebSocket 已连接 |
| `onDisconnected` | `reason?: string` | 连接断开 |
| `onPrompt` | `PromptMessage` | 用户发送了消息 |
| `onCancel` | `CancelMessage` | 对话被取消 |
| `onError` | `Error` | 发生错误 |

### 发送方法

| 方法 | 说明 |
|---|---|
| `sendMessageChunk(sessionId, promptId, text, guid?, userId?)` | 流式发送增量文本片段 |
| `sendToolCall(sessionId, promptId, toolCall, guid?, userId?)` | 通知工具调用已开始 |
| `sendToolCallUpdate(sessionId, promptId, toolCall, guid?, userId?)` | 更新工具调用状态 |
| `sendPromptResponse(payload, guid?, userId?)` | 发送本轮最终响应（原始格式） |
| `sendTextResponse(sessionId, promptId, text, guid?, userId?)` | 便捷方法：以文本结束对话 |
| `sendErrorResponse(sessionId, promptId, errorMessage, guid?, userId?)` | 便捷方法：错误响应 |
| `sendCancelledResponse(sessionId, promptId, guid?, userId?)` | 便捷方法：取消确认 |

### 生命周期方法

| 方法 | 说明 |
|---|---|
| `start()` | 打开 WebSocket 连接 |
| `stop()` | 关闭连接并阻止自动重连 |
| `getState()` | `"disconnected" \| "connecting" \| "connected" \| "reconnecting"` |
| `setToken(token)` | 更新认证令牌（下次连接时生效） |
| `setCallbacks(callbacks)` | 合并新的回调（已有的不会被覆盖） |

### AGP 协议

所有消息均为 JSON 文本帧，使用统一的信封格式：

```json
{
  "msg_id": "uuid-v4",
  "guid": "device-id",
  "user_id": "user-id",
  "method": "session.prompt",
  "payload": { ... }
}
```

**下行（服务器 -> 客户端）：**
- `session.prompt` -- 用户消息，包含 `session_id`、`prompt_id`、`agent_app`、`content`
- `session.cancel` -- 中止进行中的对话轮次

**上行（客户端 -> 服务器）：**
- `session.update` -- 流式片段：`message_chunk`、`tool_call`、`tool_call_update`
- `session.promptResponse` -- 最终回复，`stop_reason`：`end_turn | cancelled | error | refusal`

### 连接特性

- **自动重连**：指数退避（基础 3 秒，1.5 倍增长，上限 25 秒）
- **心跳检测**：原生 WS ping，每 20 秒一次，pong 超时 = 2 倍间隔
- **系统唤醒检测**：定时器偏移 > 15 秒时触发重连
- **消息去重**：已处理 msg_id 集合，每 5 分钟清理（上限 1000 条）

---

## HTTP 协议细节

### 请求格式

所有端点均为 **POST** 请求，地址为 `{jprxGateway}{endpoint}`。

**请求头：**
```
Content-Type     : application/json
X-Version        : 1
X-Token          : <userInfo 中的 loginKey，兜底值 "m83qdao0AmE5">
X-Guid           : <设备 GUID>
X-Account        : <userId>
X-Session        : ""
X-OpenClaw-Token : <JWT>（已登录时携带）
```

**请求体：**
```json
{
  "...端点特定参数",
  "web_version": "1.4.0",
  "web_env": "release"
}
```

### 响应处理

1. **令牌续期** - 如果响应包含 `X-New-Token` 头，客户端自动更新存储的 JWT
2. **会话过期** - 如果嵌套响应中 `common.code === 21004`，清除所有认证状态
3. **成功判定** - `ret === 0` 且 `common.code === 0`
4. **数据提取** - 实际载荷位于 `data.resp.data` || `data.data` || `data`（腾讯响应信封）

### 环境 URL

| 字段（`EnvUrls`） | 生产环境 | 测试环境 |
|---|---|---|
| `jprxGateway` | `https://jprx.m.qq.com/` | `https://jprx.sparta.html5.qq.com/` |
| `qclawBaseUrl` | `https://mmgrcalltoken.3g.qq.com/aizone/v1` | `https://jprx.sparta.html5.qq.com/aizone/v1` |
| `wechatWsUrl` | `wss://mmgrcalltoken.3g.qq.com/agentwss` | `wss://jprx.sparta.html5.qq.com/agentwss` |
| `wxLoginRedirectUri` | `https://security.guanjia.qq.com/login` | `https://security-test.guanjia.qq.com/login` |
| `beaconUrl` | `https://pcmgrmonitor.3g.qq.com/datareport` | `https://pcmgrmonitor.3g.qq.com/test/datareport` |

### 微信 OAuth

`WxLoginConfig` 接口暴露各环境的 OAuth 配置：

| 字段 | 生产环境 | 测试环境 |
|---|---|---|
| `appid` | `wx9d11056dd75b7240` | `wx3dd49afb7e2cf957` |
| `redirect_uri` | `https://security.guanjia.qq.com/login` | `https://security-test.guanjia.qq.com/login` |

OAuth scope（`snsapi_login`）硬编码在 `buildWxLoginUrl()` 方法中。

### OpenClaw 配置路径

登录后，Electron 应用将以下内容写入网关配置：

```yaml
channels:
  wechat-access:
    token: <openclaw_channel_token>   # 来自 wxLogin 响应
    wsUrl: <wss://...>                # 由主进程根据环境注入

models:
  providers:
    qclaw:
      apiKey: <key>                   # 来自 createApiKey 响应
      baseUrl: <https://...>          # 由主进程根据环境注入
```

受保护路径（配置模板合并时不会被覆盖）：
- `channels.wechat-access.token`
- `channels.wechat-access.wsUrl`
- `models.providers.qclaw.apiKey`

## 许可证

MIT
