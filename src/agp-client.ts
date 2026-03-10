/**
 * AGP WebSocket Client
 *
 * Reverse-engineered from the wechat-access plugin's websocket-client.ts (739 lines).
 * Implements the full AGP (Agent Gateway Protocol) over WebSocket:
 *
 *   - Connection with token auth (?token= query param)
 *   - Auto-reconnect with exponential backoff (3s base, 1.5x, 25s cap)
 *   - Heartbeat via native ws ping/pong (20s default, 2x timeout detection)
 *   - System wakeup detection (timer drift > 15s triggers reconnect)
 *   - Message dedup (Set<msg_id>, cleaned every 5min, max 1000 entries)
 *   - Full send API: sendMessageChunk, sendToolCall, sendToolCallUpdate, sendPromptResponse
 *   - Event callbacks: onConnected, onDisconnected, onPrompt, onCancel, onError
 *
 * This is a server-push channel: the server sends session.prompt when a WeChat
 * user messages your agent, and you stream back responses via session.update +
 * session.promptResponse.
 */

import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type {
  AGPEnvelope,
  AGPMethod,
  AGPClientConfig,
  AGPClientCallbacks,
  ConnectionState,
  PromptMessage,
  CancelMessage,
  ContentBlock,
  ToolCall,
  UpdatePayload,
  PromptResponsePayload,
} from "./agp-types.js";

// ============================================
// Defaults
// ============================================

const DEFAULT_RECONNECT_INTERVAL = 3000;
const DEFAULT_HEARTBEAT_INTERVAL = 20000;
const MAX_RECONNECT_DELAY = 25000;
const BACKOFF_MULTIPLIER = 1.5;

const WAKEUP_CHECK_INTERVAL = 5000;
const WAKEUP_THRESHOLD = 15000;

const MAX_MSG_ID_CACHE = 1000;
const MSG_ID_CLEANUP_INTERVAL = 5 * 60 * 1000;

// ============================================
// Client
// ============================================

export class AGPClient {
  // -- Config (resolved with defaults) --
  private readonly url: string;
  private token: string;
  private readonly guid: string;
  private readonly userId: string;
  private readonly reconnectInterval: number;
  private readonly maxReconnectAttempts: number;
  private readonly heartbeatInterval: number;

  // -- Callbacks --
  private callbacks: AGPClientCallbacks;

  // -- Connection state --
  private ws: WebSocket | null = null;
  private state: ConnectionState = "disconnected";

  // -- Timers --
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private wakeupCheckTimer: ReturnType<typeof setInterval> | null = null;
  private msgIdCleanupTimer: ReturnType<typeof setInterval> | null = null;

  // -- Reconnect tracking --
  private reconnectAttempts = 0;

  // -- Heartbeat tracking --
  private lastPongTime = Date.now();

  // -- Wakeup detection --
  private lastTickTime = Date.now();

  // -- Message dedup --
  private processedMsgIds = new Set<string>();

  constructor(config: AGPClientConfig, callbacks: AGPClientCallbacks = {}) {
    this.url = config.url;
    this.token = config.token;
    this.guid = config.guid ?? "";
    this.userId = config.userId ?? "";
    this.reconnectInterval =
      config.reconnectInterval ?? DEFAULT_RECONNECT_INTERVAL;
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? 0;
    this.heartbeatInterval =
      config.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL;
    this.callbacks = callbacks;
  }

  // -----------------------------------------------------------------------
  // Public lifecycle
  // -----------------------------------------------------------------------

  /** Start the WebSocket connection.  No-op if already connected/connecting. */
  start(): void {
    if (this.state === "connected" || this.state === "connecting") {
      return;
    }
    this.connect();
    this.startMsgIdCleanup();
  }

  /**
   * Gracefully stop.  Closes the socket, cancels all timers,
   * and prevents automatic reconnection.
   */
  stop(): void {
    this.state = "disconnected";
    this.clearReconnectTimer();
    this.clearHeartbeat();
    this.clearWakeupDetection();
    this.clearMsgIdCleanup();
    this.processedMsgIds.clear();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /** Current connection state. */
  getState(): ConnectionState {
    return this.state;
  }

  /** Replace the auth token (e.g. after a refresh).  Takes effect on next connect. */
  setToken(token: string): void {
    this.token = token;
  }

  /** Merge in new callbacks (existing ones are preserved if not overridden). */
  setCallbacks(callbacks: Partial<AGPClientCallbacks>): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  // -----------------------------------------------------------------------
  // Send methods (uplink: client -> server)
  // -----------------------------------------------------------------------

  /**
   * Send a streaming text chunk (session.update, update_type=message_chunk).
   *
   * Call this repeatedly as your agent generates text.  Each call sends
   * only the *new* incremental text, not the full accumulated response.
   */
  sendMessageChunk(
    sessionId: string,
    promptId: string,
    text: string,
    guid?: string,
    userId?: string,
  ): void {
    const content: ContentBlock = { type: "text", text };
    const payload: UpdatePayload = {
      session_id: sessionId,
      prompt_id: promptId,
      update_type: "message_chunk",
      content,
    };
    this.sendEnvelope("session.update", payload, guid, userId);
  }

  /**
   * Notify that a tool call has started (session.update, update_type=tool_call).
   */
  sendToolCall(
    sessionId: string,
    promptId: string,
    toolCall: ToolCall,
    guid?: string,
    userId?: string,
  ): void {
    const payload: UpdatePayload = {
      session_id: sessionId,
      prompt_id: promptId,
      update_type: "tool_call",
      tool_call: toolCall,
    };
    this.sendEnvelope("session.update", payload, guid, userId);
  }

  /**
   * Update a tool call's status (session.update, update_type=tool_call_update).
   */
  sendToolCallUpdate(
    sessionId: string,
    promptId: string,
    toolCall: ToolCall,
    guid?: string,
    userId?: string,
  ): void {
    const payload: UpdatePayload = {
      session_id: sessionId,
      prompt_id: promptId,
      update_type: "tool_call_update",
      tool_call: toolCall,
    };
    this.sendEnvelope("session.update", payload, guid, userId);
  }

  /**
   * Send the final response for a turn (session.promptResponse).
   *
   * This MUST be sent for every prompt -- even on cancellation or error.
   * The server will not send a new prompt until it receives this.
   */
  sendPromptResponse(
    payload: PromptResponsePayload,
    guid?: string,
    userId?: string,
  ): void {
    this.sendEnvelope("session.promptResponse", payload, guid, userId);
  }

  /**
   * Convenience: send a successful end-turn response with text content.
   */
  sendTextResponse(
    sessionId: string,
    promptId: string,
    text: string,
    guid?: string,
    userId?: string,
  ): void {
    this.sendPromptResponse(
      {
        session_id: sessionId,
        prompt_id: promptId,
        stop_reason: "end_turn",
        content: [{ type: "text", text }],
      },
      guid,
      userId,
    );
  }

  /**
   * Convenience: send an error response for a turn.
   */
  sendErrorResponse(
    sessionId: string,
    promptId: string,
    errorMessage: string,
    guid?: string,
    userId?: string,
  ): void {
    this.sendPromptResponse(
      {
        session_id: sessionId,
        prompt_id: promptId,
        stop_reason: "error",
        error: errorMessage,
      },
      guid,
      userId,
    );
  }

  /**
   * Convenience: send a cancellation acknowledgement for a turn.
   */
  sendCancelledResponse(
    sessionId: string,
    promptId: string,
    guid?: string,
    userId?: string,
  ): void {
    this.sendPromptResponse(
      {
        session_id: sessionId,
        prompt_id: promptId,
        stop_reason: "cancelled",
      },
      guid,
      userId,
    );
  }

  // -----------------------------------------------------------------------
  // Connection management (private)
  // -----------------------------------------------------------------------

  private connect(): void {
    if (!this.url) {
      this.state = "disconnected";
      this.callbacks.onError?.(new Error("AGPClient: url is empty"));
      return;
    }
    if (!this.token) {
      this.state = "disconnected";
      this.callbacks.onError?.(new Error("AGPClient: token is empty"));
      return;
    }

    this.state = "connecting";
    const wsUrl = this.buildConnectionUrl();

    try {
      this.ws = new WebSocket(wsUrl);
      this.setupEventHandlers();
    } catch (error) {
      this.handleConnectionError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private buildConnectionUrl(): string {
    const url = new URL(this.url);
    url.searchParams.set("token", this.token);
    return url.toString();
  }

  private setupEventHandlers(): void {
    if (!this.ws) return;
    this.ws.on("open", this.handleOpen);
    this.ws.on("message", this.handleRawMessage);
    this.ws.on("close", this.handleClose);
    this.ws.on("error", this.handleError);
    this.ws.on("pong", this.handlePong);
  }

  // -----------------------------------------------------------------------
  // Event handlers
  // -----------------------------------------------------------------------

  private handleOpen = (): void => {
    this.state = "connected";
    this.reconnectAttempts = 0;
    this.lastPongTime = Date.now();
    this.startHeartbeat();
    this.startWakeupDetection();
    this.callbacks.onConnected?.();
  };

  private handleRawMessage = (data: WebSocket.RawData): void => {
    try {
      const raw = typeof data === "string" ? data : data.toString();
      const envelope = JSON.parse(raw) as AGPEnvelope;

      // Dedup by msg_id
      if (this.processedMsgIds.has(envelope.msg_id)) {
        return;
      }
      this.processedMsgIds.add(envelope.msg_id);

      // Dispatch by method
      switch (envelope.method) {
        case "session.prompt":
          this.callbacks.onPrompt?.(envelope as PromptMessage);
          break;
        case "session.cancel":
          this.callbacks.onCancel?.(envelope as CancelMessage);
          break;
        case "ping":
          // Application-level ping -- no action needed, ws-level pong handles keepalive
          break;
        default:
          // Unknown method -- silently ignore
          break;
      }
    } catch (error) {
      this.callbacks.onError?.(
        error instanceof Error
          ? error
          : new Error(`Message parse failed: ${String(error)}`),
      );
    }
  };

  private handleClose = (code: number, reason: Buffer): void => {
    const reasonStr = reason.toString() || `code=${code}`;
    this.clearHeartbeat();
    this.clearWakeupDetection();
    this.ws = null;

    if (this.state !== "disconnected") {
      this.callbacks.onDisconnected?.(reasonStr);
      this.scheduleReconnect();
    }
  };

  private handlePong = (): void => {
    this.lastPongTime = Date.now();
  };

  private handleError = (error: Error): void => {
    this.callbacks.onError?.(error);
  };

  private handleConnectionError(error: Error): void {
    this.callbacks.onError?.(error);
    this.scheduleReconnect();
  }

  // -----------------------------------------------------------------------
  // Reconnect (exponential backoff)
  // -----------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (
      this.maxReconnectAttempts > 0 &&
      this.reconnectAttempts >= this.maxReconnectAttempts
    ) {
      this.state = "disconnected";
      this.callbacks.onDisconnected?.("max reconnect attempts reached");
      return;
    }

    this.state = "reconnecting";
    this.reconnectAttempts++;

    const delay = Math.min(
      this.reconnectInterval *
        Math.pow(BACKOFF_MULTIPLIER, this.reconnectAttempts - 1),
      MAX_RECONNECT_DELAY,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Heartbeat (ws native ping/pong)
  // -----------------------------------------------------------------------

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.state === "connected") {
        // Pong timeout: if no pong received within 2x heartbeat interval,
        // the connection is considered dead (e.g. after system sleep).
        const pongTimeout = this.heartbeatInterval * 2;
        if (Date.now() - this.lastPongTime > pongTimeout) {
          this.ws.terminate();
          return;
        }

        try {
          this.ws.ping();
        } catch {
          this.ws?.terminate();
        }
      }
    }, this.heartbeatInterval);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // System wakeup detection
  // -----------------------------------------------------------------------

  private startWakeupDetection(): void {
    this.clearWakeupDetection();
    this.lastTickTime = Date.now();

    this.wakeupCheckTimer = setInterval(() => {
      const now = Date.now();
      const elapsed = now - this.lastTickTime;
      this.lastTickTime = now;

      if (elapsed > WAKEUP_THRESHOLD) {
        // Timer drift detected -- system likely slept.
        // Reset reconnect counter and force a reconnect.
        this.reconnectAttempts = 0;
        if (this.ws && this.state === "connected") {
          this.ws.terminate();
        }
      }
    }, WAKEUP_CHECK_INTERVAL);
  }

  private clearWakeupDetection(): void {
    if (this.wakeupCheckTimer) {
      clearInterval(this.wakeupCheckTimer);
      this.wakeupCheckTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Message sending (internal)
  // -----------------------------------------------------------------------

  private sendEnvelope<T>(
    method: AGPMethod,
    payload: T,
    guid?: string,
    userId?: string,
  ): void {
    if (!this.ws || this.state !== "connected") {
      this.callbacks.onError?.(
        new Error(
          `Cannot send message: not connected (state=${this.state})`,
        ),
      );
      return;
    }

    const envelope: AGPEnvelope<T> = {
      msg_id: randomUUID(),
      guid: guid ?? this.guid,
      user_id: userId ?? this.userId,
      method,
      payload,
    };

    try {
      this.ws.send(JSON.stringify(envelope));
    } catch (error) {
      this.callbacks.onError?.(
        error instanceof Error
          ? error
          : new Error(`Send failed: ${String(error)}`),
      );
    }
  }

  // -----------------------------------------------------------------------
  // Message ID cache cleanup
  // -----------------------------------------------------------------------

  private startMsgIdCleanup(): void {
    this.clearMsgIdCleanup();
    this.msgIdCleanupTimer = setInterval(() => {
      if (this.processedMsgIds.size > MAX_MSG_ID_CACHE) {
        // Keep the newest half (Set iterates in insertion order)
        const entries = [...this.processedMsgIds];
        this.processedMsgIds.clear();
        for (const id of entries.slice(-Math.floor(MAX_MSG_ID_CACHE / 2))) {
          this.processedMsgIds.add(id);
        }
      }
    }, MSG_ID_CLEANUP_INTERVAL);
  }

  private clearMsgIdCleanup(): void {
    if (this.msgIdCleanupTimer) {
      clearInterval(this.msgIdCleanupTimer);
      this.msgIdCleanupTimer = null;
    }
  }
}
