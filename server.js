import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { EventSource } from "eventsource";
global.EventSource = EventSource;

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { listMcps, addHttpMcp, addStdioMcp, removeMcp } from "./mcp/manager.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const chats = new Map(); // chatId -> messages[]

const MODEL_NAME = "gpt-4o";
const MAX_HISTORY = 30;        // כמה הודעות לשמור בזיכרון
const MAX_TOOL_LOOPS = 5;      // מקסימום סבבי tool calling
const MCP_TIMEOUT_MS = 60_000; // timeout לחיבור MCP
const MCP_CACHE_TTL_MS = 10 * 60_000; // כמה זמן לשמור חיבור ב-cache (10 דקות)

// Rate Limiter פשוט (20 בקשות לדקה למשתמש)
const rateLimitMap = new Map();
function checkRateLimit(userId) {
  const now = Date.now();
  const prev = (rateLimitMap.get(userId) || []).filter(
    (t) => now - t < 60_000
  );
  if (prev.length >= 20) return false;
  prev.push(now);
  rateLimitMap.set(userId, prev);
  return true;
}

const SYSTEM_PROMPT = `
You are a helpful assistant.
Do not answer from your own knowledge.
If the tool works, tell the user the result.
If the user asks you to generate a file (like CSV, HTML, Python, TXT), DO NOT use external tools. Instead, output the exact content they requested inside a Markdown code block, and clearly specify the language/extension (for example: \`\`\`csv or \`\`\`html). The chat interface will automatically convert this block into a downloadable file for the user.
Answer in Hebrew.
`;

function log(msg) {
  console.log(`[Chatbot] ${msg}`);
}

function normalizeName(name) {
  return name.toLowerCase().replace(/[_\-]/g, "");
}

// ─── MCP Connection Cache ───────────────────────────────────────────────────
// Map<userId, Map<mcpId, { client, tools, transport, status, connectedAt }>>
const mcpCache = new Map();

function getUserCache(userId) {
  if (!mcpCache.has(userId)) mcpCache.set(userId, new Map());
  return mcpCache.get(userId);
}

async function connectToMcp(mcpConfig) {
  let transport;
  if (mcpConfig.type === "http") {
    log(`Connecting (HTTP) to ${mcpConfig.url}...`);
    transport = new SSEClientTransport(new URL(mcpConfig.url));
  } else if (mcpConfig.type === "stdio") {
    log(`Connecting (STDIO) command: ${mcpConfig.command} ${mcpConfig.args?.join(" ")}`);
    transport = new StdioClientTransport({
      command: mcpConfig.command,
      args: mcpConfig.args || [],
    });
  } else {
    return null;
  }

  try {
    const mcpClient = new Client(
      { name: "chatbot", version: "1.0.0" },
      { capabilities: {} }
    );
    await Promise.race([
      mcpClient.connect(transport),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), MCP_TIMEOUT_MS)
      ),
    ]);
    const { tools } = await mcpClient.listTools();
    log(`✅ Connected to ${mcpConfig.id} (${tools?.length ?? 0} tools)`);
    return { client: mcpClient, tools: tools || [], id: mcpConfig.id, transport };
  } catch (err) {
    log(`❌ Failed ${mcpConfig.id}: ${err.message}`);
    // הרג תהליך STDIO אם נוצר לפני הכישלון
    transport?.close?.().catch(() => {});
    return null;
  }
}

/**
 * מחזיר חיבור מה-cache אם תקף, אחרת מתחבר מחדש.
 */
async function getOrConnectMcp(userId, mcpConfig) {
  const cache = getUserCache(userId);
  const cached = cache.get(mcpConfig.id);
  const now = Date.now();

  if (
    cached &&
    cached.status === "ready" &&
    now - cached.connectedAt < MCP_CACHE_TTL_MS
  ) {
    return cached;
  }

  // פג תוקף ה-cache — הרג תהליך STDIO ישן לפני reconnect
  if (cached?.transport) cached.transport.close().catch(() => {});

  const conn = await connectToMcp(mcpConfig);
  if (conn) {
    const entry = { ...conn, status: "ready", connectedAt: now };
    cache.set(mcpConfig.id, entry);
    return entry;
  }

  cache.set(mcpConfig.id, {
    status: "error",
    connectedAt: now,
    id: mcpConfig.id,
    tools: [],
  });
  return null;
}

// ─── Chat History ───────────────────────────────────────────────────────────
function getOrCreateChat(chatId) {
  if (!chats.has(chatId)) {
    chats.set(chatId, [{ role: "system", content: SYSTEM_PROMPT }]);
  }
  return chats.get(chatId);
}

function trimHistory(history) {
  const system = history[0];
  const rest = history.slice(1);
  if (rest.length <= MAX_HISTORY) return history;
  return [system, ...rest.slice(rest.length - MAX_HISTORY)];
}

// ─── SSE Helper ─────────────────────────────────────────────────────────────
function setupSSE(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  return (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ─── Chat API (Streaming + Multi-step Tool Calling) ─────────────────────────
app.post("/api/chat", async (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  if (!checkRateLimit(userId))
    return res.status(429).json({ error: "יותר מדי בקשות, המתן דקה" });

  const { chatId, message } = req.body;
  if (!chatId || !message)
    return res.status(400).json({ error: "Missing data" });

  const send = setupSSE(res);

  try {
    let history = getOrCreateChat(chatId);
    history.push({ role: "user", content: message });
    chats.set(chatId, trimHistory(history));
    history = chats.get(chatId);

    // חיבור לכל שרתי ה-MCP של המשתמש עם cache
    const mcpConfigs = listMcps(userId);
    const allTools = [];
    const clientMap = new Map();

    const connections = await Promise.all(
      mcpConfigs.map((c) => getOrConnectMcp(userId, c))
    );

    for (const conn of connections) {
      if (conn?.tools) {
        for (const tool of conn.tools) {
          allTools.push({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description || `Get info about ${tool.name}`,
              parameters: tool.inputSchema || { type: "object", properties: {} },
            },
          });
          clientMap.set(tool.name, conn.client);
        }
      }
    }

    const usedToolsLog = [];
    let iteration = 0;

    // לולאת Multi-step Tool Calling
    while (iteration < MAX_TOOL_LOOPS) {
      iteration++;

      const stream = await openai.chat.completions.create({
        model: MODEL_NAME,
        messages: history,
        tools: allTools.length > 0 ? allTools : undefined,
        tool_choice: allTools.length > 0 ? "auto" : undefined,
        stream: true,
      });

      let chunkText = "";
      const pendingToolCalls = [];

      // קריאת ה-stream token by token
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;

        if (delta?.content) {
          chunkText += delta.content;
          send({ type: "chunk", text: delta.content });
        }

        // צבירת tool calls (מגיעים בחלקים)
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!pendingToolCalls[tc.index]) {
              pendingToolCalls[tc.index] = {
                id: tc.id || "",
                type: "function",
                function: { name: "", arguments: "" },
              };
            }
            const p = pendingToolCalls[tc.index];
            if (tc.id) p.id = tc.id;
            if (tc.function?.name) p.function.name += tc.function.name;
            if (tc.function?.arguments)
              p.function.arguments += tc.function.arguments;
          }
        }
      }

      const activeTools = pendingToolCalls.filter(Boolean);

      if (activeTools.length === 0) {
        // אין יותר tool calls — השיחה נגמרה
        history.push({ role: "assistant", content: chunkText });
        break;
      }

      // ה-AI רוצה להפעיל כלים
      history.push({
        role: "assistant",
        content: chunkText || null,
        tool_calls: activeTools,
      });

      for (const toolCall of activeTools) {
        let args = {};
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {}

        const requestedName = toolCall.function.name;
        usedToolsLog.push({ name: requestedName, args });

        let mcpClient = clientMap.get(requestedName);
        let realToolName = requestedName;

        // Fuzzy match אם ה-AI שגה קצת בשם
        if (!mcpClient) {
          const normalizedReq = normalizeName(requestedName);
          for (const [key, c] of clientMap.entries()) {
            if (normalizeName(key) === normalizedReq) {
              mcpClient = c;
              realToolName = key;
              break;
            }
          }
        }

        send({ type: "tool", name: requestedName, args });

        let content = "";
        if (!mcpClient) {
          content = `Error: Tool '${requestedName}' not found.`;
        } else {
          try {
            const result = await mcpClient.callTool({
              name: realToolName,
              arguments: args,
            });
            content = result.content
              ? result.content.map((c) => c.text).join("\n")
              : JSON.stringify(result);
          } catch (e) {
            content = `Tool Error: ${e.message}`;
          }
        }

        history.push({ role: "tool", tool_call_id: toolCall.id, content });
      }
    }

    chats.set(chatId, history);
    send({ type: "done", usedTools: usedToolsLog });
    res.end();
  } catch (err) {
    console.error("Server Error:", err);
    send({ type: "error", message: err.message });
    res.end();
  }
});

// ─── MCP CRUD ───────────────────────────────────────────────────────────────
app.get("/api/mcps", (req, res) => {
  const userId = req.headers["x-user-id"];
  res.json({ servers: listMcps(userId) });
});

app.post("/api/mcps/http", (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json({ ok: true, added: addHttpMcp(userId, req.body) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/mcps/:id", (req, res) => {
  const userId = req.headers["x-user-id"];
  // הרג תהליך STDIO לפני מחיקה מה-cache
  const entry = getUserCache(userId).get(req.params.id);
  if (entry?.transport) entry.transport.close().catch(() => {});
  getUserCache(userId).delete(req.params.id);
  removeMcp(userId, req.params.id);
  res.json({ ok: true });
});

// ─── MCP STDIO endpoint ──────────────────────────────────────────────────────
app.post("/api/mcps/stdio", (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json({ ok: true, added: addStdioMcp(userId, req.body) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── MCP Ping — בדיקת מוכנות שרת (חשוב ל-Render Free) ─────────────────────
app.get("/api/mcps/:id/ping", async (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const mcpId = req.params.id;
  const configs = listMcps(userId);
  const config = configs.find((m) => m.id === mcpId);
  if (!config) return res.status(404).json({ error: "MCP not found" });

  // הרג תהליך STDIO ישן ואלץ חיבור מחדש
  const oldEntry = getUserCache(userId).get(mcpId);
  if (oldEntry?.transport) oldEntry.transport.close().catch(() => {});
  getUserCache(userId).delete(mcpId);
  const conn = await getOrConnectMcp(userId, config);

  if (conn) {
    res.json({ status: "ready", toolCount: conn.tools.length });
  } else {
    res.json({ status: "error" });
  }
});

// ─── Other ──────────────────────────────────────────────────────────────────
app.delete("/api/chat/:chatId", (req, res) => {
  chats.delete(req.params.chatId);
  res.json({ ok: true });
});

app.get("/healthz", (req, res) => res.send("OK"));

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () =>
  console.log(`Chatbot listening on port ${port}`)
);
