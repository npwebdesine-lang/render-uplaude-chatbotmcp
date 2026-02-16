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

// הסרנו את ההנחיה המכריחה ("YOU MUST") כדי למנוע הזיות כשהכלי מנותק
const SYSTEM_PROMPT = `
You are a helpful assistant. 
You have access to external tools (MCP) ONLY if they are provided in the context.
If you see a tool named 'get_weather', use it when asked about weather.
If no tools are available, apologize and say you cannot check right now.
Answer in Hebrew.
`;

function log(msg, ...args) {
  console.log(`[${new Date().toISOString().split("T")[1]}] ${msg}`, ...args);
}

// פונקציית חיבור משופרת עם Timeout ארוך יותר (15 שניות) לטובת Render
async function connectToMcp(mcpConfig) {
  if (mcpConfig.type !== "http") return null;
  log(`Connecting to ${mcpConfig.id}...`);

  try {
    const transport = new SSEClientTransport(new URL(mcpConfig.url));
    const mcpClient = new Client(
      { name: "chat-client", version: "1.0.0" },
      { capabilities: {} },
    );

    // הגדלת זמן המתנה ל-15 שניות
    const connectPromise = mcpClient.connect(transport);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Timeout (Render might be sleeping)")),
        15000,
      ),
    );

    await Promise.race([connectPromise, timeoutPromise]);

    const toolsResult = await mcpClient.listTools();
    log(
      `✅ Connected to ${mcpConfig.id}. Tools:`,
      toolsResult.tools.map((t) => t.name),
    );

    return {
      client: mcpClient,
      tools: toolsResult.tools || [],
      id: mcpConfig.id,
    };
  } catch (err) {
    log(`❌ Failed to connect to ${mcpConfig.id}: ${err.message}`);
    return null;
  }
}

function mapMcpToolToOpenAi(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "External tool",
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

    // 1. ניסיון חיבור ל-MCPs
    const mcpConfigs = listMcps();
    const allTools = [];
    const clientMap = new Map();

    log(`Attempting to connect to ${mcpConfigs.length} servers...`);

    // חיבור לכל השרתים
    const connections = await Promise.all(
      mcpConfigs.map((conf) => connectToMcp(conf)),
    );

    for (const conn of connections) {
      if (conn) {
        for (const tool of conn.tools) {
          allTools.push(mapMcpToolToOpenAi(tool));
          clientMap.set(tool.name, conn.client);
        }
      }
    }

    log(`Total tools available for this run: ${allTools.length}`);

    const usedToolsLog = [];

    // 2. שליחה ל-OpenAI
    // שולחים כלים רק אם באמת הצלחנו להתחבר אליהם!
    let response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: history,
      tools: allTools.length > 0 ? allTools : undefined,
    });

    let msg = response.choices[0].message;

    // 3. לולאת הפעלת כלים
    while (msg.tool_calls) {
      history.push(msg);

      for (const toolCall of msg.tool_calls) {
        const fnName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        usedToolsLog.push({ name: fnName, args });

        const mcpClient = clientMap.get(fnName);
        let resultContent = "";

        if (!mcpClient) {
          // זה המצב שגרם לשגיאה שלך. עכשיו זה לא אמור לקרות כי אנחנו לא שולחים כלי שלא קיים.
          resultContent = "Error: Tool connection lost.";
          log(`CRITICAL: OpenAI asked for ${fnName} but client is missing.`);
        } else {
          try {
            log(`Executing ${fnName}...`);
            const result = await mcpClient.callTool({
              name: fnName,
              arguments: args,
            });
            resultContent = result.content.map((c) => c.text).join("\n");
            log(`Result: ${resultContent}`);
          } catch (e) {
            resultContent = `Error: ${e.message}`;
            log(`Error executing tool: ${e.message}`);
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

    res.json({ reply, usedTools: usedToolsLog });
  } catch (err) {
    console.error("Chat Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// API Endpoints זהים לקודם
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
