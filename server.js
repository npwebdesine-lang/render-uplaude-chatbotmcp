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

const SYSTEM_PROMPT = `
You are a helpful assistant.
You have access to external tools via MCP.
If the user asks for weather, YOU MUST use the 'get_weather' tool.
If the tool call fails, explain the error to the user.
Answer in Hebrew.
`;

// לוגר עם זמן
function log(msg, data) {
  console.log(
    `[${new Date().toLocaleTimeString()}] ${msg}`,
    data ? JSON.stringify(data) : "",
  );
}

async function connectToMcp(mcpConfig) {
  if (mcpConfig.type !== "http") return null;
  log(`Connecting to MCP: ${mcpConfig.url}`);

  try {
    const transport = new SSEClientTransport(new URL(mcpConfig.url));
    const mcpClient = new Client(
      { name: "chatbot", version: "1.0.0" },
      { capabilities: {} },
    );

    // הגדלת Timeout לחיבור
    const connectPromise = mcpClient.connect(transport);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout connecting to MCP")), 10000),
    );
    await Promise.race([connectPromise, timeoutPromise]);

    const toolsResult = await mcpClient.listTools();
    const tools = toolsResult.tools || [];

    log(
      `Successfully connected to ${mcpConfig.id}. Tools found: ${tools.length}`,
    );
    return { client: mcpClient, tools, id: mcpConfig.id };
  } catch (err) {
    log(`ERROR connecting to ${mcpConfig.url}: ${err.message}`);
    return null;
  }
}

function mapMcpToolToOpenAi(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "Tool",
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

    // 1. חיבור לשרתים
    const mcpConfigs = listMcps();
    const allTools = [];
    const clientMap = new Map(); // מיפוי שם כלי -> קליינט

    // מחכים שכל החיבורים יסתיימו
    const connections = await Promise.all(
      mcpConfigs.map((c) => connectToMcp(c)),
    );

    for (const conn of connections) {
      if (conn && conn.tools) {
        for (const tool of conn.tools) {
          allTools.push(mapMcpToolToOpenAi(tool));
          clientMap.set(tool.name, conn.client);
          log(`Mapped tool '${tool.name}' to client '${conn.id}'`);
        }
      }
    }

    const usedToolsLog = [];

    // 2. קריאה ראשונה ל-OpenAI
    log("Sending request to OpenAI...");
    let response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: history,
      tools: allTools.length > 0 ? allTools : undefined,
    });

    let msg = response.choices[0].message;

    // 3. טיפול בבקשות להפעלת כלים
    while (msg.tool_calls) {
      log("OpenAI requested tool execution:", msg.tool_calls);
      history.push(msg);

      for (const toolCall of msg.tool_calls) {
        const fnName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        usedToolsLog.push({ name: fnName, args });

        // בדיקה קריטית: האם הכלי קיים במפה?
        const mcpClient = clientMap.get(fnName);
        let resultContent = "";

        if (!mcpClient) {
          log(
            `CRITICAL ERROR: Tool '${fnName}' NOT found in clientMap. Available keys:`,
            [...clientMap.keys()],
          );
          resultContent = `System Error: Tool '${fnName}' connection lost or not found.`;
        } else {
          try {
            log(`Executing tool '${fnName}'...`);
            const result = await mcpClient.callTool({
              name: fnName,
              arguments: args,
            });
            resultContent = result.content.map((c) => c.text).join("\n");
            log(`Tool execution success. Result: ${resultContent}`);
          } catch (e) {
            log(`Tool execution failed: ${e.message}`);
            resultContent = `Tool Error: ${e.message}`;
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
    history.push({ role: "assistant", content: reply });

    res.json({ reply, usedTools: usedToolsLog });
  } catch (err) {
    console.error("SERVER ERROR:", err);
    // אם זו שגיאת API KEY, נחזיר הודעה ברורה
    if (err.status === 401) {
      return res.json({
        reply:
          "שגיאה: מפתח ה-API של OpenAI שגוי (401). אנא בדוק את ההגדרות ב-Render.",
      });
    }
    res.status(500).json({ error: err.message });
  }
});

// MCP Registry API
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
