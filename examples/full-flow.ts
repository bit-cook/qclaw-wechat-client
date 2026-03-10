/**
 * Full Standalone Flow: WeChat Login -> Channel Token -> Contact Link -> Echo Bot
 *
 * Works without the QClaw desktop app installed. The complete chain:
 *
 *   1. WeChat OAuth QR login -> JWT session
 *   2. refreshChannelToken   -> channel token (for WebSocket auth)
 *   3. generateContactLink   -> scannable QR URL (for WeChat users to message you)
 *   4. AGP WebSocket connect  -> receive messages, echo them back
 *
 * Usage:
 *   pnpm demo:full
 *
 * Optional env vars:
 *   QCLAW_ENV=test           Use test environment (default: production)
 *   QCLAW_GUID=<guid>        Use a specific GUID (default: auto-generated)
 *   AGP_TOKEN=<token>         Skip login, use this channel token directly
 */

import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import QClawClient from "../src/index.js";
import { AGPClient } from "../src/agp-client.js";
import type {
  PromptMessage,
  CancelMessage,
  Environment,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** WeCom customer service agent ID (hardcoded in QClaw app) */
const WECOM_OPEN_KFID = "wkzLlJLAAAfbxEV3ZcS-lHZxkaKmpejQ";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function separator(title: string) {
  console.log(`\n${"=".repeat(64)}`);
  console.log(` ${title}`);
  console.log("=".repeat(64));
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function openBrowser(url: string): void {
  exec(`open "${url}"`, (err) => {
    if (err) console.log("  (Could not open browser automatically.)");
  });
}

function extractCode(input: string): string {
  try {
    const url = new URL(input);
    return url.searchParams.get("code") ?? input;
  } catch {
    return input;
  }
}

// ---------------------------------------------------------------------------
// Echo bot
// ---------------------------------------------------------------------------

function startEchoBot(agpClient: AGPClient) {
  const activeTurns = new Set<string>();

  agpClient.setCallbacks({
    onConnected() {
      separator("Connected! Echo bot running");
      console.log("  Waiting for WeChat messages... (Ctrl+C to stop)\n");
    },

    onDisconnected(reason) {
      console.log(`\n[ws] Disconnected: ${reason ?? "unknown"}`);
    },

    onError(error) {
      console.error(`[ws] Error: ${error.message}`);
    },

    onPrompt(message: PromptMessage) {
      const { session_id, prompt_id, agent_app, content } = message.payload;
      const userText = content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");

      console.log(`[prompt] session=${session_id.slice(0, 8)}... app=${agent_app}`);
      console.log(`[prompt] from guid=${message.guid} user=${message.user_id}`);
      console.log(`[prompt] text: "${userText}"`);

      activeTurns.add(prompt_id);

      // Stream the echo back in chunks
      const echoText = `Echo: ${userText}`;
      const chunkSize = 20;
      let offset = 0;

      const streamNext = () => {
        if (!activeTurns.has(prompt_id)) return;
        if (offset < echoText.length) {
          const chunk = echoText.slice(offset, offset + chunkSize);
          agpClient.sendMessageChunk(session_id, prompt_id, chunk, message.guid, message.user_id);
          process.stdout.write(`  [chunk] "${chunk}"\n`);
          offset += chunkSize;
          setTimeout(streamNext, 50);
        } else {
          agpClient.sendTextResponse(session_id, prompt_id, echoText, message.guid, message.user_id);
          activeTurns.delete(prompt_id);
          console.log(`  [done] end_turn sent\n`);
        }
      };
      streamNext();
    },

    onCancel(message: CancelMessage) {
      const { session_id, prompt_id } = message.payload;
      console.log(`[cancel] prompt=${prompt_id.slice(0, 8)}...`);
      activeTurns.delete(prompt_id);
      agpClient.sendCancelledResponse(session_id, prompt_id, message.guid, message.user_id);
      console.log(`  [done] cancelled\n`);
    },
  });

  agpClient.start();
}

// ---------------------------------------------------------------------------
// Step 1: WeChat OAuth login -> JWT
// ---------------------------------------------------------------------------

async function doLogin(client: QClawClient, guid: string): Promise<void> {
  separator("Step 1: Get login state");
  console.log(`  GUID: ${guid}`);

  const stateRes = await client.getWxLoginState({ guid });
  if (!stateRes.success) {
    console.error("  Failed:", stateRes.message);
    console.error("  Response:", JSON.stringify(stateRes, null, 2));
    process.exit(1);
  }

  let state = QClawClient.unwrap<{ state: string }>(stateRes)?.state;
  if (!state) {
    const raw = stateRes.data as any;
    state = raw?.data?.resp?.data?.state ?? raw?.resp?.data?.state ?? raw?.data?.state ?? raw?.state;
  }
  if (!state) {
    console.error("  Could not extract state.");
    console.error("  Response:", JSON.stringify(stateRes, null, 2));
    process.exit(1);
  }
  console.log(`  State: ${state}`);

  // Open QR in browser
  separator("Step 2: Scan WeChat QR code");
  const wxCfg = client.wxLoginConfig;
  const params = new URLSearchParams({
    appid: wxCfg.appid,
    redirect_uri: wxCfg.redirect_uri,
    response_type: "code",
    scope: "snsapi_login",
    state,
  });
  const qrUrl = `https://open.weixin.qq.com/connect/qrconnect?${params}#wechat_redirect`;

  console.log(`  Opening browser...\n`);
  console.log(`  ${qrUrl}\n`);
  openBrowser(qrUrl);

  console.log("  1. Scan the QR code with WeChat on your phone");
  console.log("  2. Confirm the login");
  console.log("  3. Browser redirects to a URL containing ?code=XXXXX");
  console.log("  4. Paste the full URL or just the code value below\n");

  const rawInput = await prompt("  Code or URL: ");
  if (!rawInput) { console.error("  Empty input."); process.exit(1); }

  const code = extractCode(rawInput);
  console.log(`  Code: ${code.slice(0, 8)}...`);

  // Exchange code for JWT
  separator("Step 3: Exchange code for session");
  const loginRes = await client.wxLogin({ guid, code, state });
  if (!loginRes.success) {
    console.error("  Login failed:", loginRes.message);
    console.error("  Response:", JSON.stringify(loginRes, null, 2));
    process.exit(1);
  }

  // Debug: show what unwrap found vs raw response
  const unwrapped = QClawClient.unwrap<Record<string, unknown>>(loginRes);
  console.log("  Login OK!");
  console.log(`  JWT:      ${client.token?.slice(0, 20)}...`);
  console.log(`  Nickname: ${client.currentUser?.nickname || "(none)"}`);
  console.log(`  GUID:     ${client.currentUser?.guid || "(none)"}`);
  console.log(`  UserID:   ${client.currentUser?.userId || "(none)"}`);
  console.log(`  Unwrapped keys: ${unwrapped ? Object.keys(unwrapped).join(", ") : "(null)"}`);

  // If user info is empty, try getUserInfo explicitly
  if (!client.currentUser?.userId || !client.currentUser?.nickname) {
    console.log("\n  User info sparse, calling getUserInfo...");
    const userRes = await client.getUserInfo({ guid: client.currentUser?.guid ?? guid });
    if (userRes.success) {
      const userData = QClawClient.unwrap<Record<string, unknown>>(userRes);
      console.log(`  getUserInfo keys: ${userData ? Object.keys(userData).join(", ") : "(null)"}`);
      if (userData) {
        // Update the client's user info with whatever we found
        const nickname = (userData.nickname ?? userData.nick_name ?? "") as string;
        const userId = (userData.userId ?? userData.user_id ?? "") as string;
        const avatar = (userData.avatar ?? userData.head_img_url ?? userData.head_img ?? "") as string;
        const userGuid = (userData.guid ?? client.currentUser?.guid ?? guid) as string;
        console.log(`  Nickname: ${nickname || "(none)"}`);
        console.log(`  UserID:   ${userId || "(none)"}`);
        console.log(`  GUID:     ${userGuid}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Step 2: Get channel token
// ---------------------------------------------------------------------------

async function getChannelToken(client: QClawClient): Promise<string> {
  separator("Step 4: Get channel token");

  // First check if the login response already had one
  // (the wxLogin call stores it internally, but we also try refreshing)
  console.log("  Calling refreshChannelToken...");
  const token = await client.refreshChannelToken();

  if (token) {
    console.log(`  Channel token: ${token.slice(0, 16)}...`);
    return token;
  }

  console.error("  Could not obtain channel token.");
  console.error("  The account may not have WeChat access enabled,");
  console.error("  or may need an invite code first.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 3: Generate contact link (QR for WeChat users to message the bot)
// ---------------------------------------------------------------------------

async function getContactLink(
  client: QClawClient,
  guid: string,
  userId: string,
): Promise<string | null> {
  separator("Step 5: Generate contact link");
  console.log("  Calling generateContactLink...");

  try {
    const res = await client.generateContactLink({
      guid,
      user_id: userId,
      open_id: WECOM_OPEN_KFID,
      contact_type: "open_kfid",
    });

    if (!res.success) {
      console.log(`  Failed: ${res.message}`);
      console.log(`  (This is non-fatal. You can still connect to the WebSocket.)`);
      return null;
    }

    // Extract URL from nested response
    let url = QClawClient.unwrap<{ url: string }>(res)?.url;
    if (!url) {
      const d = res.data as any;
      url = d?.data?.resp?.url ?? d?.resp?.url ?? d?.url;
    }

    if (url) {
      console.log(`\n  Contact URL:\n`);
      console.log(`  ${url}\n`);
      console.log("  Open this URL on your phone (or scan its QR) with WeChat.");
      console.log("  It opens a WeCom customer service chat -- messages you send");
      console.log("  there will arrive on the WebSocket as session.prompt.\n");
      return url;
    }

    console.log("  Response had no URL.");
    console.log("  Raw:", JSON.stringify(res.data, null, 2));
    return null;
  } catch (err) {
    console.log(`  Error: ${err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const env = (process.env.QCLAW_ENV ?? "production") as Environment;

  separator("QClaw Standalone Echo Bot");
  console.log(`  Environment: ${env}`);
  console.log(`  No QClaw desktop app required.\n`);

  const client = new QClawClient({ env });
  const guid = process.env.QCLAW_GUID ?? `cli-${randomUUID().slice(0, 12)}`;
  let channelToken: string;

  if (process.env.AGP_TOKEN) {
    // Shortcut: use provided token
    channelToken = process.env.AGP_TOKEN;
    console.log(`  Using provided AGP_TOKEN: ${channelToken.slice(0, 12)}...`);
  } else {
    // Full flow: OAuth -> JWT -> channel token
    await doLogin(client, guid);
    channelToken = await getChannelToken(client);
  }

  // Generate contact link (need JWT for this, so skip if using raw token)
  if (client.token) {
    const contactUrl = await getContactLink(
      client,
      client.currentUser?.guid ?? guid,
      client.currentUser?.userId ?? "",
    );
    if (contactUrl) {
      openBrowser(contactUrl);
    }
  } else {
    console.log("\n  No JWT session -- skipping contact link generation.");
    console.log("  You'll need to message the bot through an existing WeChat contact.\n");
  }

  // Connect to WebSocket
  separator("Step 6: Connect to AGP WebSocket");
  const wsUrl = client.envUrls.wechatWsUrl;
  console.log(`  URL:   ${wsUrl}`);
  console.log(`  Token: ${channelToken.slice(0, 16)}...`);

  const agp = new AGPClient({
    url: wsUrl,
    token: channelToken,
    guid: client.currentUser?.guid ?? guid,
    userId: client.currentUser?.userId ?? "",
  });

  startEchoBot(agp);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  process.exit(0);
});
