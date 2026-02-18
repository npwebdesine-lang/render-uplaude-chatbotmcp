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

// משתמשים במודל הכי יציב כדי למנוע שגיאות
const MODEL_NAME = "gpt-3.5-turbo";

const SYSTEM_PROMPT = `
You are a helpful assistant.
You have access to external tools via MCP.
RULES:
1. If the user asks about weather, you MUST use the 'get_weather' tool.
2. Do not answer from your own knowledge.
3. If the tool fails, tell the user "Connection to MCP server failed".
Answer in Hebrew.
`;

function log(msg) {
  console.log(`[Chatbot] ${msg}`);
}

// פונקציית המתנה
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// חיבור עקשן ל-MCP
async function connectToMcpRobust(mcpConfig) {
  if (mcpConfig.type !== "http") return null;

  log(`Attempting to connect to MCP: ${mcpConfig.url}`);

  try {
    const transport = new SSEClientTransport(new URL(mcpConfig.url));
    const mcpClient = new Client(
      { name: "chatbot", version: "1.0.0" },
      { capabilities: {} },
    );

    // אנחנו נותנים לו 60 שניות להתחבר! (Render לוקח זמן להתעורר)
    const connectPromise = mcpClient.connect(transport);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Connection Timeout (60s)")), 60000),
    );

    await Promise.race([connectPromise, timeoutPromise]);

    // משיכת כלים
    const toolsResult = await mcpClient.listTools();
    const tools = toolsResult.tools || [];

    if (tools.length === 0) {
      log(`WARNING: Connected to ${mcpConfig.id} but found 0 tools.`);
    } else {
      log(
        `✅ SUCCESS: Connected to ${mcpConfig.id}. Tools: ${tools.map((t) => t.name).join(", ")}`,
      );
    }

    return { client: mcpClient, tools: tools, id: mcpConfig.id };
  } catch (err) {
    log(`❌ Failed to connect to ${mcpConfig.id}: ${err.message}`);
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

    // 1. חיבור ל-MCP (בזמן אמת)
    const mcpConfigs = listMcps();
    const clientMap = new Map();
    const openaiTools = [];

    // מחברים את כל השרתים
    const connections = await Promise.all(
      mcpConfigs.map((c) => connectToMcpRobust(c)),
    );

    for (const conn of connections) {
      if (conn && conn.tools && conn.tools.length > 0) {
        for (const tool of conn.tools) {
          // מיפוי ל-OpenAI
          openaiTools.push({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description || "External Tool",
              parameters: tool.inputSchema || {
                type: "object",
                properties: {},
              },
            },
          });
          // מיפוי לביצוע
          clientMap.set(tool.name, conn.client);
        }
      }
    }

    log(`Total active tools sent to OpenAI: ${openaiTools.length}`);

    // אם אין כלים - שולחים בלי כלים
    const toolsPayload = openaiTools.length > 0 ? openaiTools : undefined;

    // 2. שליחה ל-OpenAI
    let response = await client.chat.completions.create({
      model: MODEL_NAME,
      messages: history,
      tools: toolsPayload,
      tool_choice: toolsPayload ? "auto" : undefined,
    });

    let msg = response.choices[0].message;
    const usedToolsLog = [];

    // 3. ביצוע כלים (אם OpenAI ביקש)
    if (msg.tool_calls) {
      history.push(msg); // שומרים את הבקשה בהיסטוריה

      for (const toolCall of msg.tool_calls) {
        const fnName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        usedToolsLog.push({ name: fnName, args });

        const mcpClient = clientMap.get(fnName);
        let content = "";

        if (!mcpClient) {
          log(
            `CRITICAL ERROR: OpenAI tried to call '${fnName}' but client is missing.`,
          );
          content = "Error: Tool execution failed - connection lost.";
        } else {
          try {
            log(`🚀 Executing external tool: ${fnName}...`);
            const result = await mcpClient.callTool({
              name: fnName,
              arguments: args,
            });

            // המרת התשובה לטקסט
            content = result.content
              ? result.content.map((c) => c.text).join("\n")
              : JSON.stringify(result);

            log(`✅ Tool Result: ${content}`);
          } catch (e) {
            log(`❌ Tool Error: ${e.message}`);
            content = `Error: ${e.message}`;
          }
        }

        history.push({ role: "tool", tool_call_id: toolCall.id, content });
      }

      // קריאה חוזרת ל-OpenAI עם התוצאות
      response = await client.chat.completions.create({
        model: MODEL_NAME,
        messages: history,
        tools: toolsPayload,
      });
      msg = response.choices[0].message;
    }

    const reply = msg.content || "";
    history.push({ role: "assistant", content: reply });

    res.json({ reply, usedTools: usedToolsLog });
  } catch (err) {
    console.error("Server Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// APIs
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

// נקודת ביקורת לבריאות השרת (נוספה בשביל הפינג העצמי)
app.get("/healthz", (req, res) => {
  res.status(200).send("OK");
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`Chatbot listening on port ${port}`);

  // >>> מנגנון מניעת הירדמות לצ'אטבוט <<<
  const myUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;

  // מריצים פינג עצמי כל 5 דקות
  setInterval(() => {
    console.log(`[KeepAlive-Chat] Pinging myself at ${myUrl}/healthz...`);
    fetch(`${myUrl}/healthz`)
      .then((res) => {
        if (res.ok) console.log(`[KeepAlive-Chat] Success!`);
        else console.error(`[KeepAlive-Chat] Error: ${res.status}`);
      })
      .catch((err) => console.error(`[KeepAlive-Chat] Failed: ${err.message}`));
  }, 300000); // 5 דקות
});
