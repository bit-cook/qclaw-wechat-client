# qclaw-wechat-client

[中文文档](./README.zh-CN.md)

Reverse-engineered TypeScript client for QClaw's WeChat Access API.

QClaw (管家 OpenClaw) is a Tencent Electron desktop app that wraps an OpenClaw AI Gateway service. It authenticates exclusively through WeChat OAuth2 QR-code login and communicates with Tencent backend servers via a jprx gateway protocol. This library implements that protocol as a standalone TypeScript module.

## Origin

Extracted from `QClaw.app` -> `Contents/Resources/app.asar` (unencrypted). The API service class (`tS` / `openclawApiService`) was found in the bundled renderer at `out/renderer/assets/platform-QEsQ5tXh.js`.

## Install

```bash
npm install qclaw-wechat-client
# or
pnpm add qclaw-wechat-client
```

## Development

```bash
pnpm install      # install dependencies
pnpm build        # bundle with tsdown
pnpm typecheck    # type-check only
```

## Quick start

```typescript
import { QClawClient } from "qclaw-wechat-client";
import type { WxLoginStateData, WxLoginData } from "qclaw-wechat-client";

const client = new QClawClient({ env: "production" });

// Step 1 - get login state (CSRF token)
const stateRes = await client.getWxLoginState({ guid: "machine-id" });
const state = QClawClient.unwrap<WxLoginStateData>(stateRes)?.state;

// Step 2 - show QR code to user
const qrUrl = client.buildWxLoginUrl(state!);
console.log("Scan this:", qrUrl);

// Step 3 - exchange auth code (from WeChat redirect) for session
const loginRes = await client.wxLogin({ guid: "machine-id", code: authCode, state: state! });

// Step 4 - build OpenClaw config patch
const channelToken = QClawClient.unwrap<WxLoginData>(loginRes)?.openclaw_channel_token;
const config = await client.buildPostLoginConfig(channelToken!);
// -> { channels: { "wechat-access": { token } }, models: { providers: { qclaw: { apiKey } } } }
```

## Demo

The included example walks through the full WeChat login flow with an echo bot:

```bash
pnpm demo          # interactive full-flow demo (login + AGP echo bot)
```

## API

### `new QClawClient(options?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `env` | `"production" \| "test"` | `"production"` | Target environment |
| `jwtToken` | `string` | -- | Restore a JWT from a previous session |
| `userInfo` | `UserInfo` | -- | Restore user info from a previous session |
| `webVersion` | `string` | `"1.4.0"` | Version string sent in every request body |

### Properties

| Property | Type | Description |
|---|---|---|
| `client.envUrls` | `EnvUrls` | Current environment URLs |
| `client.wxLoginConfig` | `WxLoginConfig` | WeChat OAuth appid & redirect |
| `client.currentUser` | `UserInfo \| null` | Logged-in user (auto-set after `wxLogin`) |
| `client.token` | `string \| null` | Current JWT (auto-renewed) |

### Methods

#### Authentication

| Method | Endpoint | Description |
|---|---|---|
| `getWxLoginState({ guid })` | `data/4050/forward` | Get CSRF state for QR login |
| `wxLogin({ guid, code, state })` | `data/4026/forward` | Exchange WeChat auth code for JWT + channel token |
| `getUserInfo({ guid })` | `data/4027/forward` | Fetch user profile |
| `wxLogout({ guid })` | `data/4028/forward` | Invalidate session |
| `buildWxLoginUrl(state)` | -- | Build the WeChat OAuth QR-code URL |

#### Keys & tokens

| Method | Endpoint | Returns | Description |
|---|---|---|---|
| `createApiKey()` | `data/4055/forward` | `ApiResponse<ApiKeyData>` | Create API key for qclaw model provider |
| `refreshChannelToken()` | `data/4058/forward` | `string \| null` | Refresh the wechat-access channel token (returns token string directly, not wrapped in `ApiResponse`) |

#### Invite codes

| Method | Endpoint | Description |
|---|---|---|
| `checkInviteCode({ guid })` | `data/4056/forward` | Check invite code status |
| `submitInviteCode({ guid, invite_code })` | `data/4057/forward` | Submit an invite code |

#### Device management

| Method | Endpoint | Description |
|---|---|---|
| `queryDeviceByGuid(params)` | `data/4019/forward` | Query device status |
| `disconnectDevice(params)` | `data/4020/forward` | Disconnect a device |
| `generateContactLink(params)` | `data/4018/forward` | Generate contact link |

#### Updates

| Method | Endpoint | Description |
|---|---|---|
| `checkUpdate(version?, system?)` | `data/4066/forward` | Check for app updates |

#### Config helpers

| Method | Description |
|---|---|
| `buildConfigPatch(channelToken, apiKey)` | Build the OpenClaw config object |
| `buildPostLoginConfig(channelToken)` | Create API key + build config (convenience) |

### Static methods

```typescript
QClawClient.getEnvUrls("production")      // environment URLs without instantiation
QClawClient.getWxLoginConfig("production") // WeChat OAuth config
QClawClient.Endpoints                      // all endpoint path constants
QClawClient.unwrap<T>(response)            // unwrap Tencent nested envelope
```

## AGP WebSocket Client

The library also includes a full implementation of the **AGP (Agent Gateway Protocol)** -- the WebSocket protocol used for real-time message exchange between your agent and WeChat users.

This is a **server-push channel**: the server sends `session.prompt` when a WeChat user messages your agent, and you stream back AI responses via `session.update` + `session.promptResponse`.

### Quick start (WebSocket)

```typescript
import { AGPClient } from "qclaw-wechat-client";
import type { PromptMessage, CancelMessage } from "qclaw-wechat-client";

const client = new AGPClient(
  {
    url: "wss://mmgrcalltoken.3g.qq.com/agentwss",
    token: channelToken,  // from wxLogin or refreshChannelToken
  },
  {
    onConnected() {
      console.log("Connected! Waiting for messages...");
    },
    onPrompt(msg: PromptMessage) {
      const { session_id, prompt_id, content } = msg.payload;
      const text = content.map(b => b.text).join("");
      console.log(`User says: ${text}`);

      // Stream a response
      client.sendMessageChunk(session_id, prompt_id, "Hello ");
      client.sendMessageChunk(session_id, prompt_id, "World!");

      // Finalize the turn
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

| Config option | Type | Default | Description |
|---|---|---|---|
| `url` | `string` | -- | WebSocket endpoint (see Environment URLs) |
| `token` | `string` | -- | Channel auth token |
| `guid` | `string` | `""` | Device GUID (echoed in uplink messages) |
| `userId` | `string` | `""` | User ID (echoed in uplink messages) |
| `reconnectInterval` | `number` | `3000` | Base reconnect delay (ms) |
| `maxReconnectAttempts` | `number` | `0` | Max retries (0 = infinite) |
| `heartbeatInterval` | `number` | `20000` | WS ping interval (ms) |

### Callbacks

| Callback | Argument | Description |
|---|---|---|
| `onConnected` | -- | WebSocket connected |
| `onDisconnected` | `reason?: string` | Connection lost |
| `onPrompt` | `PromptMessage` | User sent a message |
| `onCancel` | `CancelMessage` | Turn cancelled |
| `onError` | `Error` | Error occurred |

### Send methods

| Method | Description |
|---|---|
| `sendMessageChunk(sessionId, promptId, text, guid?, userId?)` | Stream an incremental text chunk |
| `sendToolCall(sessionId, promptId, toolCall, guid?, userId?)` | Notify tool invocation started |
| `sendToolCallUpdate(sessionId, promptId, toolCall, guid?, userId?)` | Update tool call status |
| `sendPromptResponse(payload, guid?, userId?)` | Send final turn response (raw) |
| `sendTextResponse(sessionId, promptId, text, guid?, userId?)` | Convenience: end_turn with text |
| `sendErrorResponse(sessionId, promptId, errorMessage, guid?, userId?)` | Convenience: error response |
| `sendCancelledResponse(sessionId, promptId, guid?, userId?)` | Convenience: cancelled ack |

### Lifecycle methods

| Method | Description |
|---|---|
| `start()` | Open the WebSocket connection |
| `stop()` | Close and prevent reconnection |
| `getState()` | `"disconnected" \| "connecting" \| "connected" \| "reconnecting"` |
| `setToken(token)` | Update auth token (takes effect on next connect) |
| `setCallbacks(callbacks)` | Merge in new callbacks |

### AGP Protocol

All messages are JSON text frames with a unified envelope:

```json
{
  "msg_id": "uuid-v4",
  "guid": "device-id",
  "user_id": "user-id",
  "method": "session.prompt",
  "payload": { ... }
}
```

**Downlink (server -> client):**
- `session.prompt` -- user message with `session_id`, `prompt_id`, `agent_app`, `content`
- `session.cancel` -- abort an in-progress turn

**Uplink (client -> server):**
- `session.update` -- streaming chunks: `message_chunk`, `tool_call`, `tool_call_update`
- `session.promptResponse` -- final answer with `stop_reason`: `end_turn | cancelled | error | refusal`

### Connection features

- **Auto-reconnect**: exponential backoff (3s base, 1.5x multiplier, 25s cap)
- **Heartbeat**: native WS ping every 20s, pong timeout = 2x interval
- **System wakeup detection**: timer drift > 15s triggers reconnect
- **Message dedup**: Set of processed msg_ids, cleaned every 5min (max 1000)

---

## HTTP Protocol details

### Request format

All endpoints are **POST** requests to `{jprxGateway}{endpoint}`.

**Headers:**
```
Content-Type     : application/json
X-Version        : 1
X-Token          : <loginKey from userInfo, fallback "m83qdao0AmE5">
X-Guid           : <machine GUID>
X-Account        : <userId>
X-Session        : ""
X-OpenClaw-Token : <JWT> (when logged in)
```

**Body:**
```json
{
  "...endpoint-specific params",
  "web_version": "1.4.0",
  "web_env": "release"
}
```

### Response handling

1. **Token renewal** - if the response contains an `X-New-Token` header, the client auto-updates the stored JWT
2. **Session expiry** - if `common.code === 21004` anywhere in the nested response, all auth state is cleared
3. **Success** - `ret === 0` and `common.code === 0`
4. **Data extraction** - actual payload is at `data.resp.data` || `data.data` || `data` (Tencent envelope)

### Environment URLs

| Field (`EnvUrls`) | Production | Test |
|---|---|---|
| `jprxGateway` | `https://jprx.m.qq.com/` | `https://jprx.sparta.html5.qq.com/` |
| `qclawBaseUrl` | `https://mmgrcalltoken.3g.qq.com/aizone/v1` | `https://jprx.sparta.html5.qq.com/aizone/v1` |
| `wechatWsUrl` | `wss://mmgrcalltoken.3g.qq.com/agentwss` | `wss://jprx.sparta.html5.qq.com/agentwss` |
| `wxLoginRedirectUri` | `https://security.guanjia.qq.com/login` | `https://security-test.guanjia.qq.com/login` |
| `beaconUrl` | `https://pcmgrmonitor.3g.qq.com/datareport` | `https://pcmgrmonitor.3g.qq.com/test/datareport` |

### WeChat OAuth

The `WxLoginConfig` interface exposes per-environment OAuth settings:

| Field | Production | Test |
|---|---|---|
| `appid` | `wx9d11056dd75b7240` | `wx3dd49afb7e2cf957` |
| `redirect_uri` | `https://security.guanjia.qq.com/login` | `https://security-test.guanjia.qq.com/login` |

The OAuth scope (`snsapi_login`) is hardcoded in `buildWxLoginUrl()`.

### OpenClaw config paths

After login, the Electron app writes these to the gateway config:

```yaml
channels:
  wechat-access:
    token: <openclaw_channel_token>   # from wxLogin response
    wsUrl: <wss://...>                # injected by main process per environment

models:
  providers:
    qclaw:
      apiKey: <key>                   # from createApiKey response
      baseUrl: <https://...>          # injected by main process per environment
```

Protected paths (not overwritten during config template merges):
- `channels.wechat-access.token`
- `channels.wechat-access.wsUrl`
- `models.providers.qclaw.apiKey`

## License

MIT
