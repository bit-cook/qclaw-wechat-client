/**
 * AGP (Agent Gateway Protocol) type definitions.
 *
 * Reverse-engineered from the wechat-access plugin at:
 *   QClaw.app/Contents/Resources/openclaw/config/extensions/wechat-access/websocket/types.ts
 *
 * AGP is the WebSocket protocol between an OpenClaw agent client and the
 * WeChat gateway backend.  All messages use a unified JSON "envelope" format.
 *
 * Message directions:
 *   Downlink (server -> client): session.prompt, session.cancel
 *   Uplink   (client -> server): session.update, session.promptResponse
 */

// ============================================
// Envelope
// ============================================

/** Unified AGP message envelope.  Every WS text frame is one of these. */
export interface AGPEnvelope<T = unknown> {
  /** Globally unique message ID (UUID v4), used for idempotent dedup */
  msg_id: string;
  /** Device identifier (carried in downlink, echo back in uplink) */
  guid?: string;
  /** User identifier (carried in downlink, echo back in uplink) */
  user_id?: string;
  /** Message type / RPC method */
  method: AGPMethod;
  /** Message payload (shape depends on method) */
  payload: T;
}

// ============================================
// Method enum
// ============================================

/**
 * AGP method discriminator.
 *
 * - session.prompt:         server sends user message to client
 * - session.cancel:         server cancels an in-progress turn
 * - session.update:         client streams intermediate chunks to server
 * - session.promptResponse: client sends final answer to server
 * - ping:                   application-level keepalive (rare, native ws ping preferred)
 */
export type AGPMethod =
  | "session.prompt"
  | "session.cancel"
  | "session.update"
  | "session.promptResponse"
  | "ping";

// ============================================
// Shared data structures
// ============================================

/** Content block.  Currently only text is supported. */
export interface ContentBlock {
  type: "text";
  text: string;
}

/** Tool call lifecycle status. */
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/** Semantic kind of tool operation, used for UI iconography. */
export type ToolCallKind =
  | "read"
  | "edit"
  | "delete"
  | "execute"
  | "search"
  | "fetch"
  | "think"
  | "other";

/** File/directory path associated with a tool call. */
export interface ToolLocation {
  /** Absolute path to the file or directory */
  path: string;
}

/**
 * Describes a single tool invocation.
 *
 * A tool call lifecycle produces multiple session.update messages:
 *   1. update_type=tool_call       (status=in_progress  -- tool starts)
 *   2. update_type=tool_call_update (status=in_progress  -- optional intermediate state)
 *   3. update_type=tool_call_update (status=completed|failed -- final)
 */
export interface ToolCall {
  /** Unique ID linking all updates for this tool invocation */
  tool_call_id: string;
  /** Human-readable title (e.g. "read_file") */
  title?: string;
  /** Semantic kind, for UI display */
  kind?: ToolCallKind;
  /** Current lifecycle status */
  status: ToolCallStatus;
  /** Tool output content (present when completed) */
  content?: ContentBlock[];
  /** File paths touched by this tool call */
  locations?: ToolLocation[];
}

// ============================================
// Downlink payloads (server -> client)
// ============================================

/**
 * session.prompt payload -- server sends a user's message to the agent.
 * The client must eventually reply with session.promptResponse.
 */
export interface PromptPayload {
  /** Session identifier (a conversation) */
  session_id: string;
  /** Turn identifier (one user message + AI reply) */
  prompt_id: string;
  /** Target agent application identifier */
  agent_app: string;
  /** User's message content (array of ContentBlock, currently text only) */
  content: ContentBlock[];
}

/**
 * session.cancel payload -- server requests cancellation of an in-progress turn.
 * Client should abort processing and send promptResponse with stop_reason=cancelled.
 */
export interface CancelPayload {
  session_id: string;
  prompt_id: string;
  agent_app: string;
}

// ============================================
// Uplink payloads (client -> server)
// ============================================

/**
 * session.update sub-type discriminator.
 *
 * - message_chunk:    incremental text fragment (streaming output)
 * - tool_call:        tool invocation started
 * - tool_call_update: tool invocation status changed
 */
export type UpdateType = "message_chunk" | "tool_call" | "tool_call_update";

/**
 * session.update payload -- streaming intermediate state.
 *
 * Depending on update_type:
 *   - message_chunk: uses `content` (single ContentBlock, NOT an array)
 *   - tool_call / tool_call_update: uses `tool_call`
 */
export interface UpdatePayload {
  session_id: string;
  prompt_id: string;
  update_type: UpdateType;
  /** Text chunk (for update_type=message_chunk).  Single block, not an array. */
  content?: ContentBlock;
  /** Tool call info (for update_type=tool_call or tool_call_update) */
  tool_call?: ToolCall;
}

/**
 * Reason the agent stopped generating.
 *
 * - end_turn:   normal completion
 * - cancelled:  user/server cancelled
 * - refusal:    agent policy refusal
 * - error:      technical error
 */
export type StopReason = "end_turn" | "cancelled" | "refusal" | "error";

/**
 * session.promptResponse payload -- final answer for a turn.
 * Must be sent for every prompt, even on cancellation/error.
 * The server won't accept a new prompt until this is received.
 */
export interface PromptResponsePayload {
  session_id: string;
  prompt_id: string;
  stop_reason: StopReason;
  /** Final response content (present when stop_reason=end_turn) */
  content?: ContentBlock[];
  /** Error description (present when stop_reason=error|refusal) */
  error?: string;
}

// ============================================
// Typed message aliases
// ============================================

/** Downlink: session.prompt */
export type PromptMessage = AGPEnvelope<PromptPayload>;
/** Downlink: session.cancel */
export type CancelMessage = AGPEnvelope<CancelPayload>;
/** Uplink: session.update */
export type UpdateMessage = AGPEnvelope<UpdatePayload>;
/** Uplink: session.promptResponse */
export type PromptResponseMessage = AGPEnvelope<PromptResponsePayload>;

// ============================================
// Client configuration
// ============================================

/** Connection state machine states. */
export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

/** Configuration for AGPClient. */
export interface AGPClientConfig {
  /**
   * WebSocket endpoint URL.
   * Production: wss://mmgrcalltoken.3g.qq.com/agentwss
   * Test:       wss://jprx.sparta.html5.qq.com/agentwss
   */
  url: string;

  /** Authentication token (appended as ?token=<value> query param) */
  token: string;

  /** Device GUID -- echoed back in uplink messages */
  guid?: string;

  /** User ID -- echoed back in uplink messages */
  userId?: string;

  /**
   * Base reconnect interval in ms (default 3000).
   * Actual delay uses exponential backoff: base * 1.5^(attempt-1), capped at 25s.
   */
  reconnectInterval?: number;

  /**
   * Maximum reconnect attempts (default 0 = infinite).
   */
  maxReconnectAttempts?: number;

  /**
   * Heartbeat (ws ping) interval in ms (default 20000).
   * Should be less than the server's idle timeout (~60s).
   */
  heartbeatInterval?: number;
}

/** Event callbacks for AGPClient. */
export interface AGPClientCallbacks {
  /** WebSocket connection established */
  onConnected?: () => void;
  /** WebSocket connection lost */
  onDisconnected?: (reason?: string) => void;
  /** Received session.prompt (user sent a message) */
  onPrompt?: (message: PromptMessage) => void;
  /** Received session.cancel (user cancelled) */
  onCancel?: (message: CancelMessage) => void;
  /** An error occurred */
  onError?: (error: Error) => void;
}
