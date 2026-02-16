/**
 * server.js (Debug Version)
 * -------------------------
 * גרסה זו מדפיסה לוגים לתוך ה-Console של Render
 * ומכריחה את המודל לדווח על שגיאות טכניות בצ'אט.
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

// הנחיה חזקה למודל להשתמש בכלים ולדווח על שגיאות
const SYSTEM_PROMPT = `
You are a helpful assistant capable of using external MCP tools.
1. If the user asks for weather, YOU MUST use the 'get_weather' tool.
2. If the tool execution fails, tell the user exactly what the error was (e.g., "Connection failed", "Tool not found").
3. Do not apologize or say "I don't have access" without trying the tool first.
4. Answer in Hebrew.
`;

// פונקציית עזר ללוגים
function log(msg, data = "") {
  console.log(
    `[${new Date().toISOString()}] ${msg}`,
    data ? JSON.stringify(data).slice(0, 200) : "",
  );
}

async function connectToMcp(mcpConfig) {
  if (mcpConfig.type !== "http") return null;
  log(`Connecting to MCP: ${mcpConfig.id} at ${mcpConfig.url}`);

  try {
    const transport = new SSEClientTransport(new URL(mcpConfig.url));
    const mcpClient = new Client(
      { name: "chatbot-client", version: "1.0.0" },
      { capabilities: {} },
    );

    // ניסיון חיבור עם Timeout
    const connectPromise = mcpClient.connect(transport);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout connecting to MCP")), 5000),
    );

    await Promise.race([connectPromise, timeoutPromise]);

    const toolsResult = await mcpClient.listTools();
    log(
      `Connected to ${mcpConfig.id}. Tools found:`,
      toolsResult.tools.map((t) => t.name),
    );

    return {
      client: mcpClient,
      tools: toolsResult.tools || [],
      id: mcpConfig.id,
    };
  } catch (err) {
    log(`ERROR connecting to MCP ${mcpConfig.id}:`, err.message);
    return null;
  }
}

function mapMcpToolToOpenAi(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "A tool",
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

    log(`New message in chat ${chatId}: ${message}`);
    const history = getOrCreateChat(chatId);
    history.push({ role: "user", content: message });

    // 1. חיבור ל-MCPs
    const mcpConfigs = listMcps();
    const allTools = [];
    const clientMap = new Map();

    log(`Loading ${mcpConfigs.length} MCP configs...`);

    for (const conf of mcpConfigs) {
      const connection = await connectToMcp(conf);
      if (connection) {
        for (const tool of connection.tools) {
          allTools.push(mapMcpToolToOpenAi(tool));
          clientMap.set(tool.name, connection.client);
        }
      }
    }

    log(`Tools sent to OpenAI: ${allTools.length}`);

    // משתנה לשמירת הכלים שהופעלו
    const usedToolsLog = [];

    // 2. קריאה ראשונה ל-OpenAI
    let response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: history,
      tools: allTools.length > 0 ? allTools : undefined,
    });

    let msg = response.choices[0].message;

    // 3. לולאת טיפול ב-Function Calling
    while (msg.tool_calls) {
      log("Model requested tool calls:", msg.tool_calls);
      history.push(msg);

      for (const toolCall of msg.tool_calls) {
        const fnName = toolCall.function.name;
        const argsStr = toolCall.function.arguments;
        let args;
        try {
          args = JSON.parse(argsStr);
        } catch {
          args = {};
        }

        usedToolsLog.push({ name: fnName, args });
        log(`Executing tool: ${fnName} with args:`, args);

        const mcpClient = clientMap.get(fnName);
        let resultContent = "";

        if (!mcpClient) {
          resultContent = `Error: Tool '${fnName}' not found in connected MCP clients. Available tools: ${Array.from(clientMap.keys()).join(", ")}`;
          log(resultContent);
        } else {
          try {
            const result = await mcpClient.callTool({
              name: fnName,
              arguments: args,
            });
            // בדיקה אם התוצאה היא טעות
            if (result.isError) {
              resultContent = `Tool Error: ${JSON.stringify(result)}`;
            } else {
              resultContent = result.content.map((c) => c.text).join("\n");
            }
            log(
              `Tool success. Result preview: ${resultContent.slice(0, 50)}...`,
            );
          } catch (e) {
            resultContent = `System Error executing tool: ${e.message}`;
            log(`Tool execution failed: ${e.message}`);
          }
        }

        history.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: resultContent,
        });
      }

      // קריאה חוזרת ל-OpenAI עם התוצאות
      response = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: history,
        tools: allTools.length > 0 ? allTools : undefined,
      });
      msg = response.choices[0].message;
    }

    const reply = msg.content || "";
    log(`Final reply length: ${reply.length}`);
    history.push({ role: "assistant", content: reply });

    res.json({ reply, usedTools: usedToolsLog });
  } catch (err) {
    console.error("CRITICAL Chat error:", err);
    res.status(500).json({ error: "Server error: " + err.message });
  }
});

// API Endpoints לניהול MCP
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
