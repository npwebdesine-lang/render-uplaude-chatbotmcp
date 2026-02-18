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

// בדיקה שיש מפתח
if (!process.env.OPENAI_API_KEY) {
  console.error("CRITICAL: OPENAI_API_KEY is missing!");
}
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const chats = new Map();

function log(msg, data) {
  console.log(
    `[Chatbot] ${msg}`,
    data ? JSON.stringify(data).slice(0, 100) : "",
  );
}

// פונקציית חיבור עם ניסיונות חוזרים (Retry)
async function connectToMcpWithRetry(mcpConfig, retries = 3) {
  if (mcpConfig.type !== "http") return null;

  for (let i = 0; i < retries; i++) {
    try {
      log(`Connecting to ${mcpConfig.id} (Attempt ${i + 1}/${retries})...`);

      const transport = new SSEClientTransport(new URL(mcpConfig.url));
      const mcpClient = new Client(
        { name: "chatbot", version: "1.0.0" },
        { capabilities: {} },
      );

      // Timeout של 10 שניות לחיבור
      const connectPromise = mcpClient.connect(transport);
      const timeoutPromise = new Promise((_, r) =>
        setTimeout(() => r(new Error("Timeout")), 10000),
      );

      await Promise.race([connectPromise, timeoutPromise]);

      const toolsResult = await mcpClient.listTools();
      const tools = toolsResult.tools || [];

      log(`✅ Connected! Found ${tools.length} tools.`);
      return { client: mcpClient, tools, id: mcpConfig.id };
    } catch (err) {
      log(`❌ Attempt ${i + 1} failed: ${err.message}`);
      // מחכים 2 שניות לפני ניסיון נוסף
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return null; // נכשל אחרי כל הניסיונות
}

function mapTool(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "tool",
      parameters: tool.inputSchema || { type: "object", properties: {} },
    },
  };
}

function getOrCreateChat(chatId) {
  if (!chats.has(chatId)) {
    // System Prompt דינמי יותר
    chats.set(chatId, [
      {
        role: "system",
        content:
          "You are a helpful assistant. Use the 'get_weather' tool if asked about weather. Answer in Hebrew.",
      },
    ]);
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

    // 1. חיבור ל-MCPs ואיסוף כלים
    const mcpConfigs = listMcps();
    const allTools = [];
    const clientMap = new Map();

    // מנסים לחבר את כל השרתים
    const connections = await Promise.all(
      mcpConfigs.map((c) => connectToMcpWithRetry(c)),
    );

    for (const conn of connections) {
      if (conn && conn.tools) {
        for (const tool of conn.tools) {
          allTools.push(mapTool(tool));
          clientMap.set(tool.name, conn.client);
        }
      }
    }

    log(`Total tools available: ${allTools.length}`);

    // אם אין כלים, לא שולחים ל-OpenAI tools בכלל, כדי שלא ימציא
    const toolsPayload = allTools.length > 0 ? allTools : undefined;

    const usedToolsLog = [];

    // 2. OpenAI Request
    let response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: history,
      tools: toolsPayload,
    });

    let msg = response.choices[0].message;

    // 3. Tool Execution Loop
    while (msg.tool_calls) {
      history.push(msg);

      for (const toolCall of msg.tool_calls) {
        const fnName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        usedToolsLog.push({ name: fnName, args });

        const mcpClient = clientMap.get(fnName);
        let content = "";

        if (!mcpClient) {
          content = `Error: Tool '${fnName}' not found. Available tools: ${Array.from(clientMap.keys()).join(", ")}`;
          log(`CRITICAL: OpenAI called '${fnName}' but we don't have it.`);
        } else {
          try {
            log(`Executing ${fnName}...`);
            const result = await mcpClient.callTool({
              name: fnName,
              arguments: args,
            });
            content = result.content.map((c) => c.text).join("\n");
          } catch (e) {
            content = `Error: ${e.message}`;
          }
        }

        history.push({ role: "tool", tool_call_id: toolCall.id, content });
      }

      response = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: history,
        tools: toolsPayload,
      });
      msg = response.choices[0].message;
    }

    const reply = msg.content || "";
    history.push({ role: "assistant", content: reply });

    res.json({ reply, usedTools: usedToolsLog });
  } catch (err) {
    console.error("Chat Error:", err);
    if (err.status === 401) {
      res.json({
        reply:
          "שגיאה: מפתח ה-API של OpenAI שגוי (401). אנא בדוק ב-Render Dashboard.",
      });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// APIs
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
