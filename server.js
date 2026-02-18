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

// שינוי קריטי: שימוש במודל GPT-3.5-Turbo למניעת שגיאות 400
const MODEL_NAME = "gpt-3.5-turbo";

function log(msg) {
  console.log(`[Chatbot] ${msg}`);
}

// פונקציית חיבור יציבה ל-Render
async function connectToMcpSafe(mcpConfig) {
  if (mcpConfig.type !== "http") return null;

  try {
    log(`Connecting to ${mcpConfig.url}...`);
    const transport = new SSEClientTransport(new URL(mcpConfig.url));
    const mcpClient = new Client(
      { name: "chatbot", version: "1.0.0" },
      { capabilities: {} },
    );

    // 15 שניות Timeout לחיבור
    const connectPromise = mcpClient.connect(transport);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout waiting for MCP")), 15000),
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
    // System Prompt בסיסי, יעודכן דינמית בכל בקשה
    chats.set(chatId, [
      { role: "system", content: "You are a helpful assistant." },
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

    // 1. חיבור ל-MCP
    const mcpConfigs = listMcps();
    const allTools = [];
    const clientMap = new Map();
    let toolNames = [];

    // מנסים להתחבר לכל השרתים
    const connections = await Promise.all(
      mcpConfigs.map((c) => connectToMcpSafe(c)),
    );

    for (const conn of connections) {
      if (conn && conn.tools) {
        for (const tool of conn.tools) {
          // המרה לפורמט של OpenAI
          allTools.push({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description || `Tool: ${tool.name}`,
              parameters: tool.inputSchema || {
                type: "object",
                properties: {},
              },
            },
          });
          // מיפוי קריטי: שם הכלי -> הקליינט שמריץ אותו
          clientMap.set(tool.name, conn.client);
          toolNames.push(tool.name);
        }
      }
    }

    log(`Active tools: ${toolNames.join(", ")}`);

    // עדכון System Prompt דינמי כדי למנוע בלבול בשמות
    // אנחנו אומרים למודל בדיוק אילו כלים קיימים כרגע
    const systemMsg = history[0];
    systemMsg.content = `
      You are a helpful assistant.
      You have access to the following external tools: ${toolNames.join(", ")}.
      IMPORTANT: If the user's request matches a tool, YOU MUST USE IT.
      Do not make up answers.
      Answer in Hebrew.
    `;

    const toolsPayload = allTools.length > 0 ? allTools : undefined;

    // 2. שליחה ל-OpenAI
    let response = await client.chat.completions.create({
      model: MODEL_NAME,
      messages: history,
      tools: toolsPayload,
      tool_choice: toolsPayload ? "auto" : undefined,
    });

    let msg = response.choices[0].message;
    const usedToolsLog = [];

    // 3. טיפול בבקשות כלים (Tool Calls)
    if (msg.tool_calls) {
      history.push(msg); // שומרים את בקשת המודל

      for (const toolCall of msg.tool_calls) {
        const fnName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        usedToolsLog.push({ name: fnName, args });

        log(`OpenAI is calling tool: '${fnName}'`);

        const mcpClient = clientMap.get(fnName);
        let content = "";

        if (!mcpClient) {
          // אם הגענו לפה, יש אי התאמה בשם הכלי
          content = `Error: Tool '${fnName}' not found in active connections. Available: ${toolNames.join(", ")}`;
          log(`❌ ERROR: ${content}`);
        } else {
          try {
            log(`🚀 Executing '${fnName}'...`);
            const result = await mcpClient.callTool({
              name: fnName,
              arguments: args,
            });

            // חילוץ התשובה בצורה בטוחה
            content = result.content
              ? result.content.map((c) => c.text).join("\n")
              : JSON.stringify(result);

            log(`✅ Tool output: ${content}`);
          } catch (e) {
            content = `Tool Error: ${e.message}`;
            log(`❌ Tool execution failed: ${e.message}`);
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
    res.status(500).json({ error: `Server Error: ${err.message}` });
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

// בדיקת שרת
app.get("/healthz", (req, res) => res.send("OK"));

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => console.log("Chatbot listening on", port));
