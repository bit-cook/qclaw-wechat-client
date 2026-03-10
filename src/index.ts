/**
 * QClaw WeChat Access API Client
 *
 * Reverse-engineered from QClaw.app (Electron, asar unencrypted).
 * Implements the full jprx gateway protocol used by the renderer's
 * `openclawApiService` class (tS) found in platform-QEsQ5tXh.js.
 *
 * Usage:
 *   const client = new QClawClient({ env: "production" });
 *   const state  = await client.getWxLoginState({ guid: "..." });
 *   const login  = await client.wxLogin({ guid: "...", code: "...", state: "..." });
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Environment = "production" | "test";

export interface EnvUrls {
  jprxGateway: string;
  wxLoginRedirectUri: string;
  beaconUrl: string;
  qclawBaseUrl: string;
  wechatWsUrl: string;
}

export interface WxLoginConfig {
  appid: string;
  redirect_uri: string;
  wxLoginStyleBase64: string;
}

export interface ClientOptions {
  /** "production" (default) or "test" */
  env?: Environment;
  /** Persisted JWT from a previous session */
  jwtToken?: string;
  /** User info restored from a previous session */
  userInfo?: UserInfo | null;
  /** Override the web_version sent in every request body (default "1.4.0") */
  webVersion?: string;
}

export interface UserInfo {
  nickname: string;
  avatar: string;
  guid: string;
  userId: string;
  loginKey?: string;
  [key: string]: unknown;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  code?: number;
  message: string;
  data: T | null;
}

export interface WxLoginStateData {
  state: string;
  [key: string]: unknown;
}

export interface WxLoginUserInfo {
  nickname?: string;
  avatar?: string;
  avatar_url?: string;
  user_id?: string;
  [key: string]: unknown;
}

export interface WxLoginData {
  token: string;
  openclaw_channel_token: string;
  user_info?: WxLoginUserInfo;
  /** @deprecated Flat fields may not exist; use user_info instead */
  nickname?: string;
  avatar?: string;
  userId?: string;
  guid?: string;
  loginKey?: string;
  [key: string]: unknown;
}

export interface UserInfoData {
  nickname: string;
  avatar?: string;
  head_img_url?: string;
  head_img?: string;
  nick_name?: string;
  guid: string;
  userId?: string;
  user_id?: string;
  [key: string]: unknown;
}

export interface ApiKeyData {
  key: string;
  [key: string]: unknown;
}

export interface InviteCodeStatus {
  verified: boolean;
  [key: string]: unknown;
}

export interface ChannelTokenData {
  openclaw_channel_token: string;
  [key: string]: unknown;
}

export interface UpdateInfo {
  update_strategy: number;
  download_url?: string;
  version?: string;
  release_notes?: string;
  [key: string]: unknown;
}

export interface DeviceInfo {
  [key: string]: unknown;
}

export interface ContactLinkData {
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENV_URLS: Record<Environment, EnvUrls> = {
  test: {
    jprxGateway: "https://jprx.sparta.html5.qq.com/",
    wxLoginRedirectUri: "https://security-test.guanjia.qq.com/login",
    beaconUrl: "https://pcmgrmonitor.3g.qq.com/test/datareport",
    qclawBaseUrl: "https://jprx.sparta.html5.qq.com/aizone/v1",
    wechatWsUrl: "wss://jprx.sparta.html5.qq.com/agentwss",
  },
  production: {
    jprxGateway: "https://jprx.m.qq.com/",
    wxLoginRedirectUri: "https://security.guanjia.qq.com/login",
    beaconUrl: "https://pcmgrmonitor.3g.qq.com/datareport",
    qclawBaseUrl: "https://mmgrcalltoken.3g.qq.com/aizone/v1",
    wechatWsUrl: "wss://mmgrcalltoken.3g.qq.com/agentwss",
  },
};

const WX_LOGIN_CONFIG: Record<Environment, WxLoginConfig> = {
  production: {
    appid: "wx9d11056dd75b7240",
    redirect_uri: "https://security.guanjia.qq.com/login",
    wxLoginStyleBase64: "", // base64 CSS, omitted for brevity
  },
  test: {
    appid: "wx3dd49afb7e2cf957",
    redirect_uri: "https://security-test.guanjia.qq.com/login",
    wxLoginStyleBase64: "",
  },
};

/** Fallback X-Token when no user is logged in */
const DEFAULT_LOGIN_KEY = "m83qdao0AmE5";

const WEB_VERSION = "1.4.0";
const WEB_ENV = "release";

/**
 * API endpoint mapping.
 * Every call is a POST to `${jprxGateway}data/<id>/forward`.
 */
const Endpoint = {
  GENERATE_CONTACT_LINK: "data/4018/forward",
  QUERY_DEVICE_BY_GUID: "data/4019/forward",
  DISCONNECT_DEVICE: "data/4020/forward",
  WX_LOGIN: "data/4026/forward",
  GET_USER_INFO: "data/4027/forward",
  WX_LOGOUT: "data/4028/forward",
  GET_WX_LOGIN_STATE: "data/4050/forward",
  CREATE_API_KEY: "data/4055/forward",
  CHECK_INVITE_CODE: "data/4056/forward",
  SUBMIT_INVITE_CODE: "data/4057/forward",
  REFRESH_CHANNEL_TOKEN: "data/4058/forward",
  CHECK_UPDATE: "data/4066/forward",
} as const;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class QClawClient {
  private env: Environment;
  private urls: EnvUrls;
  private jwtToken: string | null;
  private userInfo: UserInfo | null;
  private webVersion: string;

  constructor(opts: ClientOptions = {}) {
    this.env = opts.env ?? "production";
    this.urls = ENV_URLS[this.env];
    this.jwtToken = opts.jwtToken ?? null;
    this.userInfo = opts.userInfo ?? null;
    this.webVersion = opts.webVersion ?? WEB_VERSION;
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  get envUrls(): Readonly<EnvUrls> {
    return this.urls;
  }

  get wxLoginConfig(): Readonly<WxLoginConfig> {
    return WX_LOGIN_CONFIG[this.env];
  }

  get currentUser(): Readonly<UserInfo> | null {
    return this.userInfo;
  }

  get token(): string | null {
    return this.jwtToken;
  }

  /** Returns the login key (X-Token header), falls back to the hardcoded default. */
  private get loginKey(): string {
    return this.userInfo?.loginKey ?? DEFAULT_LOGIN_KEY;
  }

  // -----------------------------------------------------------------------
  // Low-level transport
  // -----------------------------------------------------------------------

  /**
   * Build the full URL for a gateway endpoint.
   */
  private buildUrl(endpoint: string): string {
    return `${this.urls.jprxGateway}${endpoint}`;
  }

  /**
   * Build the standard request headers expected by the jprx gateway.
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Version": "1",
      "X-Token": this.loginKey,
      "X-Guid": this.userInfo?.guid ?? "1",
      "X-Account": this.userInfo?.userId ?? "1",
      "X-Session": "",
    };
    if (this.jwtToken) {
      headers["X-OpenClaw-Token"] = this.jwtToken;
    }
    return headers;
  }

  /**
   * Core request method.  Every API call is a POST with JSON body that
   * includes `web_version` and `web_env` alongside caller-supplied params.
   *
   * Handles:
   *  - Automatic JWT renewal via `X-New-Token` response header
   *  - Session expiration (code 21004) → clears local auth state
   *  - Nested Tencent response envelope unwrapping
   */
  private async request<T = unknown>(
    endpoint: string,
    body: Record<string, unknown> = {},
  ): Promise<ApiResponse<T>> {
    const url = this.buildUrl(endpoint);
    const headers = this.buildHeaders();
    const payload = {
      ...body,
      web_version: this.webVersion,
      web_env: WEB_ENV,
    };

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        redirect: "follow",
      });
    } catch (err) {
      return {
        success: false,
        code: undefined,
        message: `Network request failed: ${String(err)}`,
        data: null,
      };
    }

    // ---------- token auto-renewal ----------
    const newToken = res.headers.get("X-New-Token");
    if (newToken) {
      this.jwtToken = newToken;
    }

    // ---------- parse response body ----------
    let parsed: any = null;
    try {
      const text = await res.text();
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON response
    }

    // ---------- session expired (code 21004) ----------
    const commonCode =
      parsed?.data?.resp?.common?.code ??
      parsed?.data?.common?.code ??
      parsed?.resp?.common?.code ??
      parsed?.common?.code;

    if (commonCode === 21004) {
      this.jwtToken = null;
      this.userInfo = null;
      return {
        success: false,
        code: 21004,
        message: "Session expired, please re-login",
        data: null,
      };
    }

    // ---------- HTTP-level error ----------
    if (!res.ok) {
      return {
        success: false,
        code: res.status,
        message: parsed?.message ?? res.statusText ?? `HTTP ${res.status}`,
        data: parsed as T,
      };
    }

    // ---------- business-level success check ----------
    const ret = parsed?.ret;
    const bizCode =
      parsed?.data?.common?.code ??
      parsed?.data?.resp?.common?.code ??
      parsed?.resp?.common?.code ??
      parsed?.common?.code;

    if (ret !== undefined && ret !== 0) {
      return {
        success: false,
        code: ret,
        message: parsed?.message ?? "Business request failed",
        data: (parsed?.data?.resp ?? parsed?.data ?? parsed) as T,
      };
    }

    if (bizCode !== undefined && bizCode !== 0) {
      return {
        success: false,
        code: bizCode,
        message: parsed?.message ?? "Business request failed",
        data: (parsed?.data?.resp ?? parsed?.data ?? parsed) as T,
      };
    }

    return {
      success: true,
      code: 0,
      message: "ok",
      data: parsed as T,
    };
  }

  /**
   * Unwrap the deeply-nested Tencent response envelope.
   *
   * Real responses have varying nesting depths, observed patterns:
   *   { ret, data: { resp: { common, data: PAYLOAD } } }     ← getWxLoginState
   *   { ret, resp: { common, data: PAYLOAD } }                ← some endpoints
   *   { data: PAYLOAD }                                       ← simple responses
   *
   * This method walks the known wrapper keys until it finds the innermost
   * `data` that doesn't itself contain another `resp` or `data` wrapper.
   */
  private static unwrapData<T>(apiRes: ApiResponse<any>): T | null {
    if (!apiRes.success || !apiRes.data) return null;
    let d = apiRes.data as any;

    // Walk through up to 4 levels of { data } / { resp } nesting
    for (let i = 0; i < 4; i++) {
      if (d?.resp?.data !== undefined) {
        d = d.resp.data;
      } else if (d?.data !== undefined && typeof d.data === "object") {
        d = d.data;
      } else {
        break;
      }
    }
    return d as T;
  }

  // -----------------------------------------------------------------------
  // WeChat OAuth helpers
  // -----------------------------------------------------------------------

  /**
   * Get the WeChat OAuth QR-code login URL (for embedding in a webview / iframe).
   * The official SDK at https://res.wx.qq.com/connect/zh_CN/htmledition/js/wxLogin.js
   * normally renders this, but you can also construct it manually.
   */
  buildWxLoginUrl(state: string): string {
    const cfg = this.wxLoginConfig;
    const params = new URLSearchParams({
      appid: cfg.appid,
      redirect_uri: cfg.redirect_uri,
      response_type: "code",
      scope: "snsapi_login",
      state,
    });
    return `https://open.weixin.qq.com/connect/qrconnect?${params.toString()}#wechat_redirect`;
  }

  // -----------------------------------------------------------------------
  // Public API methods
  // -----------------------------------------------------------------------

  /**
   * Step 1 of login: obtain a CSRF `state` parameter for the QR login flow.
   * Endpoint: data/4050/forward
   */
  async getWxLoginState(params: {
    guid: string;
  }): Promise<ApiResponse<WxLoginStateData>> {
    return this.request<WxLoginStateData>(
      Endpoint.GET_WX_LOGIN_STATE,
      params,
    );
  }

  /**
   * Step 2 of login: exchange the WeChat authorization `code` for a session.
   * Returns a JWT (`token`) and an `openclaw_channel_token`.
   * Endpoint: data/4026/forward
   */
  async wxLogin(params: {
    guid: string;
    code: string;
    state: string;
  }): Promise<ApiResponse<WxLoginData>> {
    const res = await this.request<WxLoginData>(Endpoint.WX_LOGIN, params);
    if (res.success) {
      const d = QClawClient.unwrapData<WxLoginData>(res);
      if (d?.token) this.jwtToken = d.token;
      if (d) {
        // user_info is nested: { user_info: { nickname, avatar_url, user_id } }
        // Mirrors the QClaw app's extraction at WXLoginView-Dzks_Y2M.js
        const ui = d.user_info;
        this.userInfo = {
          nickname: ui?.nickname ?? d.nickname ?? "",
          avatar: ui?.avatar_url ?? ui?.avatar ?? d.avatar ?? "",
          guid: d.guid ?? params.guid,
          userId: ui?.user_id ?? d.userId ?? "",
          loginKey: d.loginKey,
        };
      }
    }
    return res;
  }

  /**
   * Fetch the currently logged-in user's profile.
   * Endpoint: data/4027/forward
   */
  async getUserInfo(params: {
    guid: string;
  }): Promise<ApiResponse<UserInfoData>> {
    return this.request<UserInfoData>(Endpoint.GET_USER_INFO, params);
  }

  /**
   * Log out and invalidate the current session.
   * Endpoint: data/4028/forward
   */
  async wxLogout(params: { guid: string }): Promise<ApiResponse> {
    const res = await this.request(Endpoint.WX_LOGOUT, params);
    // Clear local state regardless of server response
    this.jwtToken = null;
    this.userInfo = null;
    return res;
  }

  /**
   * Create an API key for the qclaw model provider.
   * Endpoint: data/4055/forward
   */
  async createApiKey(): Promise<ApiResponse<ApiKeyData>> {
    return this.request<ApiKeyData>(Endpoint.CREATE_API_KEY, {});
  }

  /**
   * Check whether the current user has verified an invite code.
   * Endpoint: data/4056/forward
   */
  async checkInviteCode(params: {
    guid: string;
  }): Promise<ApiResponse<InviteCodeStatus>> {
    return this.request<InviteCodeStatus>(Endpoint.CHECK_INVITE_CODE, params);
  }

  /**
   * Submit an invite code for verification.
   * Endpoint: data/4057/forward
   */
  async submitInviteCode(params: {
    guid: string;
    invite_code: string;
  }): Promise<ApiResponse> {
    return this.request(Endpoint.SUBMIT_INVITE_CODE, params);
  }

  /**
   * Refresh the `openclaw_channel_token` used by the wechat-access channel.
   * Endpoint: data/4058/forward
   */
  async refreshChannelToken(): Promise<string | null> {
    const res = await this.request<ChannelTokenData>(
      Endpoint.REFRESH_CHANNEL_TOKEN,
      {},
    );
    if (!res.success) return null;
    const d = QClawClient.unwrapData<ChannelTokenData>(res);
    return d?.openclaw_channel_token ?? null;
  }

  /**
   * Check for app updates.
   * Endpoint: data/4066/forward
   */
  async checkUpdate(
    currentVersion = "",
    systemType = "mac",
  ): Promise<ApiResponse<UpdateInfo>> {
    return this.request<UpdateInfo>(Endpoint.CHECK_UPDATE, {
      last_update_time: 0,
      current_version: currentVersion,
      system_type: systemType,
    });
  }

  /**
   * Generate a contact link (专属链接).
   * Endpoint: data/4018/forward
   */
  async generateContactLink(
    params: Record<string, unknown>,
  ): Promise<ApiResponse<ContactLinkData>> {
    return this.request<ContactLinkData>(
      Endpoint.GENERATE_CONTACT_LINK,
      params,
    );
  }

  /**
   * Query device status by GUID.
   * Endpoint: data/4019/forward
   */
  async queryDeviceByGuid(
    params: Record<string, unknown>,
  ): Promise<ApiResponse<DeviceInfo>> {
    return this.request<DeviceInfo>(Endpoint.QUERY_DEVICE_BY_GUID, params);
  }

  /**
   * Disconnect a device.
   * Endpoint: data/4020/forward
   */
  async disconnectDevice(
    params: Record<string, unknown>,
  ): Promise<ApiResponse> {
    return this.request(Endpoint.DISCONNECT_DEVICE, params);
  }

  // -----------------------------------------------------------------------
  // OpenClaw config helpers
  // -----------------------------------------------------------------------

  /**
   * Build the config patch object that the Electron app writes via IPC
   * after a successful login.  This is what goes into the OpenClaw
   * gateway's YAML/JSON config file.
   */
  buildConfigPatch(
    channelToken: string | null,
    apiKey: string | null,
  ): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    if (channelToken) {
      patch.channels = { "wechat-access": { token: channelToken } };
    }
    if (apiKey) {
      patch.models = { providers: { qclaw: { apiKey } } };
    }
    return patch;
  }

  /**
   * Convenience: run the full post-login config update sequence
   * (create API key + build config patch).
   */
  async buildPostLoginConfig(
    channelToken: string,
  ): Promise<Record<string, unknown>> {
    let apiKey: string | null = null;
    try {
      const res = await this.createApiKey();
      const d = QClawClient.unwrapData<ApiKeyData>(res);
      apiKey = d?.key ?? null;
    } catch {
      // non-fatal
    }
    return this.buildConfigPatch(channelToken, apiKey);
  }

  // -----------------------------------------------------------------------
  // Static helpers
  // -----------------------------------------------------------------------

  /** Get environment URLs without instantiating a client. */
  static getEnvUrls(env: Environment): Readonly<EnvUrls> {
    return ENV_URLS[env];
  }

  /** Get WeChat login config without instantiating a client. */
  static getWxLoginConfig(env: Environment): Readonly<WxLoginConfig> {
    return WX_LOGIN_CONFIG[env];
  }

  /** All known endpoint paths. */
  static readonly Endpoints = Endpoint;

  /** Unwrap a Tencent-style nested response. */
  static unwrap<T>(res: ApiResponse<any>): T | null {
    return QClawClient.unwrapData<T>(res);
  }
}

// ---------------------------------------------------------------------------
// AGP WebSocket re-exports
// ---------------------------------------------------------------------------

export { AGPClient } from "./agp-client.js";
export type {
  AGPEnvelope,
  AGPMethod,
  ContentBlock,
  ToolCallStatus,
  ToolCallKind,
  ToolLocation,
  ToolCall,
  PromptPayload,
  CancelPayload,
  UpdateType,
  UpdatePayload,
  StopReason,
  PromptResponsePayload,
  PromptMessage,
  CancelMessage,
  UpdateMessage,
  PromptResponseMessage,
  ConnectionState,
  AGPClientConfig,
  AGPClientCallbacks,
} from "./agp-types.js";

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------

export default QClawClient;
