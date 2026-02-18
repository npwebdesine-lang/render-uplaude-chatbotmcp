import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { EventSource } from "eventsource";
global.EventSource = EventSource;

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { listMcps, addHttpMcp, addLocalMcp, removeMcp } from "./mcp/manager.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const chats = new Map();

// מודל 3.5 הוא הכי צייתן מבחינת קריאה לכלים
const MODEL_NAME = "gpt-3.5-turbo";

const SYSTEM_PROMPT = `
You are a helpful assistant.
You have access to a tool named 'get_weather'.
If the user asks about weather anywhere, YOU MUST CALL 'get_weather'.
Do not answer from your own knowledge.
If the tool works, tell the user the result.
Answer in Hebrew.
`;

function log(msg) {
  console.log(`[Chatbot] ${msg}`);
}

// פונקציית עזר לניקוי שמות (למנוע אי התאמות)
function normalizeName(name) {
  return name.toLowerCase().replace(/_/g, "").replace(/-/g, "");
}

// פונקציית חיבור יציבה
async function connectToMcpSafe(mcpConfig) {
  if (mcpConfig.type !== "http") return null;

  try {
    log(`Connecting to ${mcpConfig.url}...`);
    const transport = new SSEClientTransport(new URL(mcpConfig.url));
    const mcpClient = new Client(
      { name: "chatbot", version: "1.0.0" },
      { capabilities: {} },
    );

    const connectPromise = mcpClient.connect(transport);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout (15s)")), 15000),
    );

    await Promise.race([connectPromise, timeoutPromise]);

    const toolsResult = await mcpClient.listTools();
    const tools = toolsResult.tools || [];

    log(
      `✅ Connected to ${mcpConfig.id}. Found tools: ${tools.map((t) => t.name).join(", ")}`,
    );
    return { client: mcpClient, tools: tools, id: mcpConfig.id };
  } catch (err) {
    log(`❌ Connection failed to ${mcpConfig.id}: ${err.message}`);
    return null;
  }
}

function getOrCreateChat(chatId) {
  if (!chats.has(chatId)) {
    chats.set(chatId, [{ role: "system", content: SYSTEM_PROMPT }]);
  }
  return chats.get(chatId);
}

app.post("/api/chat", async (req, res) => {
  try {
    const { chatId, message } = req.body;
    if (!chatId || !message)
      return res.status(400).json({ error: "Missing data" });

    const history = getOrCreateChat(chatId);
    history.push({ role: "user", content: message });

    // 1. חיבור ל-MCP
    const mcpConfigs = listMcps();
    const allTools = [];
    const clientMap = new Map();

    const connections = await Promise.all(
      mcpConfigs.map((c) => connectToMcpSafe(c)),
    );

    for (const conn of connections) {
      if (conn && conn.tools) {
        for (const tool of conn.tools) {
          allTools.push({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description || `Get info about ${tool.name}`,
              parameters: tool.inputSchema || {
                type: "object",
                properties: {},
              },
            },
          });
          // שומרים את הקליינט במפה
          clientMap.set(tool.name, conn.client);
        }
      }
    }

    log(`Available tools in map: ${Array.from(clientMap.keys()).join(", ")}`);

    // 2. קריאה ל-OpenAI
    let response = await client.chat.completions.create({
      model: MODEL_NAME,
      messages: history,
      tools: allTools.length > 0 ? allTools : undefined,
      tool_choice: allTools.length > 0 ? "auto" : undefined,
    });

    let msg = response.choices[0].message;
    const usedToolsLog = [];

    // 3. ביצוע כלים (עם מנגנון Fuzzy Match)
    if (msg.tool_calls) {
      history.push(msg);

      for (const toolCall of msg.tool_calls) {
        const requestedName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        usedToolsLog.push({ name: requestedName, args });

        log(`OpenAI requested: '${requestedName}'`);

        // --- כאן התיקון הגדול: חיפוש גמיש ---
        let mcpClient = clientMap.get(requestedName);
        let realToolName = requestedName;

        // אם לא מצאנו התאמה מדוייקת, נחפש בערך
        if (!mcpClient) {
          log(
            `⚠️ Exact match not found for '${requestedName}'. Trying fuzzy search...`,
          );
          const normalizedReq = normalizeName(requestedName);

          for (const [key, client] of clientMap.entries()) {
            if (normalizeName(key) === normalizedReq) {
              mcpClient = client;
              realToolName = key;
              log(
                `✅ Fuzzy match found! '${requestedName}' mapped to '${realToolName}'`,
              );
              break;
            }
          }
        }

        let content = "";

        if (!mcpClient) {
          content = `Error: Tool '${requestedName}' not found. Available: ${Array.from(clientMap.keys()).join(", ")}`;
          log(`❌ FATAL: Could not find client for tool.`);
        } else {
          try {
            log(`🚀 Executing '${realToolName}'...`);
            // אנחנו קוראים לפונקציה בשם האמיתי שלה בשרת (realToolName)
            const result = await mcpClient.callTool({
              name: realToolName,
              arguments: args,
            });

            content = result.content
              ? result.content.map((c) => c.text).join("\n")
              : JSON.stringify(result);

            log(`✅ Tool output: ${content}`);
          } catch (e) {
            content = `Tool Error: ${e.message}`;
            log(`❌ Execution failed: ${e.message}`);
          }
        }

        history.push({ role: "tool", tool_call_id: toolCall.id, content });
      }

      // קריאה חוזרת עם התשובות
      response = await client.chat.completions.create({
        model: MODEL_NAME,
        messages: history,
        tools: allTools.length > 0 ? allTools : undefined,
      });
      msg = response.choices[0].message;
    }

    const reply = msg.content || "";
    history.push({ role: "assistant", content: reply });

    res.json({ reply, usedTools: usedToolsLog });
  } catch (err) {
    console.error("Server Error:", err);
    res.status(500).json({ error: `Server Error: ${err.message}` });
  }
});

// APIs & KeepAlive
app.get("/api/mcps", (req, res) => res.json({ servers: listMcps() }));
app.post("/api/mcps/http", (req, res) => {
  res.json({ ok: true, added: addHttpMcp(req.body) });
});
app.delete("/api/mcps/:id", (req, res) => {
  removeMcp(req.params.id);
  res.json({ ok: true });
});
app.delete("/api/chat/:chatId", (req, res) => {
  chats.delete(req.params.chatId);
  res.json({ ok: true });
});
app.get("/healthz", (req, res) => res.send("OK"));

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`Chatbot listening on port ${port}`);
  const myUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
  setInterval(() => {
    fetch(`${myUrl}/healthz`).catch(() => {});
  }, 300000);
});
