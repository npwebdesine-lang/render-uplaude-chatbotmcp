/**
 * server.js
 * ----------
 * כולל תיקון: החזרת רשימת הכלים שהופעלו ללקוח + System Prompt חזק יותר
 */
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

// חיזקתי את ההנחיה כדי שהמודל ידע להשתמש בכלים
const SYSTEM_PROMPT =
  "You are a helpful assistant. You have access to external tools (MCP). " +
  "ALWAYS checks if a tool can answer the user's request before saying you don't know. " +
  "If the user asks about weather, use the 'get_weather' tool. Answer in Hebrew.";

async function connectToMcp(mcpConfig) {
  if (mcpConfig.type !== "http") return null;
  try {
    const transport = new SSEClientTransport(new URL(mcpConfig.url));
    const mcpClient = new Client(
      { name: "chatbot-client", version: "1.0.0" },
      { capabilities: {} },
    );
    await mcpClient.connect(transport);
    const toolsResult = await mcpClient.listTools();
    return {
      client: mcpClient,
      tools: toolsResult.tools || [],
      id: mcpConfig.id,
    };
  } catch (err) {
    console.error(`Failed to connect to MCP ${mcpConfig.id}:`, err.message);
    return null;
  }
}

function mapMcpToolToOpenAi(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.inputSchema || {},
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

    // 1. חיבור ל-MCPs
    const mcpConfigs = listMcps();
    const allTools = [];
    const clientMap = new Map();

    for (const conf of mcpConfigs) {
      const connection = await connectToMcp(conf);
      if (connection) {
        for (const tool of connection.tools) {
          allTools.push(mapMcpToolToOpenAi(tool));
          clientMap.set(tool.name, connection.client);
        }
      }
    }

    console.log(`Sending to OpenAI with ${allTools.length} tools`);

    // משתנה לשמירת הכלים שהופעלו בפועל
    const usedToolsLog = [];

    let response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: history,
      tools: allTools.length > 0 ? allTools : undefined,
    });

    let msg = response.choices[0].message;

    // לולאת הפעלת כלים
    while (msg.tool_calls) {
      history.push(msg);

      for (const toolCall of msg.tool_calls) {
        const fnName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);

        // רישום ללוג שהכלי הופעל
        usedToolsLog.push({ name: fnName, args });

        const mcpClient = clientMap.get(fnName);
        let resultContent = "Error: Tool not found";

        if (mcpClient) {
          try {
            console.log(`Executing tool ${fnName}...`);
            const result = await mcpClient.callTool({
              name: fnName,
              arguments: args,
            });
            resultContent = result.content.map((c) => c.text).join("\n");
          } catch (e) {
            resultContent = `Error: ${e.message}`;
          }
        }

        history.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: resultContent,
        });
      }

      response = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: history,
        tools: allTools.length > 0 ? allTools : undefined,
      });
      msg = response.choices[0].message;
    }

    const reply = msg.content || "";
    history.push({ role: "assistant", content: reply });

    // שולחים חזרה גם את התשובה וגם את הכלים שהיו בשימוש
    res.json({ reply, usedTools: usedToolsLog });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Server error: " + err.message });
  }
});

// שאר ה-API נשאר זהה...
app.get("/api/mcps", (req, res) => res.json({ servers: listMcps() }));
app.post("/api/mcps/http", (req, res) => {
  try {
    res.json({ ok: true, added: addHttpMcp(req.body) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post("/api/mcps/local", (req, res) => {
  try {
    res.json({ ok: true, added: addLocalMcp(req.body) });
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
