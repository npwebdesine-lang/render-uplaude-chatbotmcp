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

// --- שינוי 1: SYSTEM PROMPT אגרסיבי ---
const SYSTEM_PROMPT = `
You are a specialized assistant with access to external tools (MCP).
CRITICAL RULE:
If the user's request is even REMOTELY related to a tool you have, YOU MUST USE THE TOOL.
- Do not answer from your own knowledge.
- Do not say "I can't check".
- Do not ask for clarification if you can try the tool first.
- If the user asks about something that matches a tool's purpose, use it immediately.
- If the tool returns an error, report it to the user and do not attempt to answer without it.
- Always prioritize tool usage over your own knowledge.
If you have tools available, you MUST use them for relevant questions. If you don't use them, the user will not get the correct answer.
Answer the user in Hebrew.
`;

function log(msg, data) {
  console.log(
    `[Chatbot] ${msg}`,
    data ? JSON.stringify(data).slice(0, 150) : "",
  );
}

// פונקציית חיבור (עם Retry למקרה ש-Render ישן)
async function connectToMcpWithRetry(mcpConfig) {
  if (mcpConfig.type !== "http") return null;

  for (let i = 0; i < 2; i++) {
    // 2 ניסיונות
    try {
      log(`Connecting to ${mcpConfig.id}...`);
      const transport = new SSEClientTransport(new URL(mcpConfig.url));
      const mcpClient = new Client(
        { name: "chatbot", version: "1.0.0" },
        { capabilities: {} },
      );

      const connectPromise = mcpClient.connect(transport);
      const timeoutPromise = new Promise((_, r) =>
        setTimeout(() => r(new Error("Timeout")), 10000),
      );

      await Promise.race([connectPromise, timeoutPromise]);

      const toolsResult = await mcpClient.listTools();
      log(
        `✅ Connected to ${mcpConfig.id}! Found tools:`,
        toolsResult.tools.map((t) => t.name),
      );
      return {
        client: mcpClient,
        tools: toolsResult.tools || [],
        id: mcpConfig.id,
      };
    } catch (err) {
      log(`Attempt failed: ${err.message}. Retrying...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return null;
}

// --- שינוי 2: שיפור תיאור הכלי עבור OpenAI ---
function mapTool(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      // אנחנו דורסים את התיאור המקורי ונותנים למודל רמז חזק
      description:
        tool.description ||
        `IMPORTANT: Use this tool whenever the user asks about ${tool.name}.`,
      parameters: tool.inputSchema || { type: "object", properties: {} },
    },
  };
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

    // 1. איסוף כלים (במקביל)
    const mcpConfigs = listMcps();
    const connections = await Promise.all(
      mcpConfigs.map((c) => connectToMcpWithRetry(c)),
    );

    const allTools = [];
    const clientMap = new Map();

    for (const conn of connections) {
      if (conn && conn.tools) {
        for (const tool of conn.tools) {
          allTools.push(mapTool(tool));
          clientMap.set(tool.name, conn.client);
        }
      }
    }

    // לוג קריטי: האם אנחנו בכלל שולחים כלים ל-OpenAI?
    log(
      `Sending request to OpenAI with ${allTools.length} tools:`,
      allTools.map((t) => t.function.name),
    );

    // אם אין כלים מחוברים, המודל לא יוכל להשתמש בהם
    const toolsPayload = allTools.length > 0 ? allTools : undefined;

    // 2. קריאה ל-OpenAI
    let response = await client.chat.completions.create({
      model: "gpt-4o ",
      messages: history,
      tools: toolsPayload,
      // טריק נוסף: tool_choice: "auto" הוא ברירת המחדל, אבל אפשר להכריח אם רוצים
      tool_choice: toolsPayload ? "auto" : undefined,
    });

    let msg = response.choices[0].message;
    const usedToolsLog = [];

    // 3. לולאת ביצוע כלים
    while (msg.tool_calls) {
      log(
        "🤖 OpenAI decided to call tools:",
        msg.tool_calls.map((tc) => tc.function.name),
      );
      history.push(msg);

      for (const toolCall of msg.tool_calls) {
        const fnName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        usedToolsLog.push({ name: fnName, args });

        const mcpClient = clientMap.get(fnName);
        let content = "";

        if (!mcpClient) {
          content = "Error: Tool disconnected.";
          log(`❌ Client for ${fnName} not found.`);
        } else {
          try {
            log(`🚀 Executing ${fnName}...`);
            const result = await mcpClient.callTool({
              name: fnName,
              arguments: args,
            });

            // המרת תוצאה לטקסט
            content = result.content
              ? result.content.map((c) => c.text).join("\n")
              : JSON.stringify(result);

            log(`✅ Tool output: ${content}`);
          } catch (e) {
            content = `Error: ${e.message}`;
            log(`❌ Tool execution error: ${e.message}`);
          }
        }

        history.push({ role: "tool", tool_call_id: toolCall.id, content });
      }

      // קריאה חוזרת עם התשובות
      response = await client.chat.completions.create({
        model: "gpt-4o",
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
    if (err.status === 401) {
      res.json({ reply: "שגיאה 401: מפתח OpenAI לא תקין." });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// ניהול ה-Registry (ללא שינוי)
app.get("/api/mcps", (req, res) => res.json({ servers: listMcps() }));
app.post("/api/mcps/http", (req, res) => {
  try {
    res.json({ ok: true, added: addHttpMcp(req.body) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete("/api/mcps/:id", (req, res) => {
  removeMcp(req.params.id);
  res.json({ ok: true });
});
app.delete("/api/chat/:chatId", (req, res) => {
  chats.delete(req.params.chatId);
  res.json({ ok: true });
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => console.log("Chatbot listening on", port));
