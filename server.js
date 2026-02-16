/**
 * server.js
 * ----------
 * שרת הצ'אט שמחבר בין המשתמש, OpenAI ושרתי MCP מרוחקים.
 */
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { EventSource } from "eventsource"; // חובה ל-SSE Client
global.EventSource = EventSource; // Polyfill ל-Node

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
const SYSTEM_PROMPT =
  "אתה עוזר חכם שיכול להשתמש בכלים חיצוניים (MCP). ענה בעברית.";

// --- פונקציות עזר ל-OpenAI ---

// 1. חיבור לשרת MCP וקבלת רשימת הכלים שלו
async function connectToMcp(mcpConfig) {
  if (mcpConfig.type !== "http") return null; // תומכים כרגע רק ב-HTTP ב-Render

  try {
    const transport = new SSEClientTransport(new URL(mcpConfig.url));
    const mcpClient = new Client(
      { name: "chatbot-client", version: "1.0.0" },
      { capabilities: {} },
    );

    await mcpClient.connect(transport);

    const toolsResult = await mcpClient.listTools();
    const tools = toolsResult.tools || [];

    return { client: mcpClient, tools, id: mcpConfig.id };
  } catch (err) {
    console.error(`Failed to connect to MCP ${mcpConfig.id}:`, err.message);
    return null;
  }
}

// 2. המרת כלי MCP לפורמט של OpenAI
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

// --- ניהול צ'אט ---

function getOrCreateChat(chatId) {
  if (!chats.has(chatId)) {
    chats.set(chatId, [{ role: "system", content: SYSTEM_PROMPT }]);
  }
  return chats.get(chatId);
}

// --- API Endpoints ---

app.post("/api/chat", async (req, res) => {
  try {
    const { chatId, message } = req.body;
    if (!chatId || !message)
      return res.status(400).json({ error: "Missing data" });

    const history = getOrCreateChat(chatId);
    history.push({ role: "user", content: message });

    // 1. איסוף כל ה-MCPs הפעילים
    const mcpConfigs = listMcps();
    const activeClients = []; // נשמור את הקליינטים הפתוחים כדי לסגור בסוף
    const allTools = [];
    const clientMap = new Map(); // מיפוי שם כלי -> קליינט

    // 2. חיבור דינמי לכל השרתים (בפרודקשן כדאי לשמור חיבורים פתוחים, כאן נפתח ונסגור)
    for (const conf of mcpConfigs) {
      const connection = await connectToMcp(conf);
      if (connection) {
        activeClients.push(connection.client);

        for (const tool of connection.tools) {
          allTools.push(mapMcpToolToOpenAi(tool));
          clientMap.set(tool.name, connection.client); // כדי שנדע איזה קליינט מריץ איזה כלי
        }
      }
    }

    // 3. שליחה ל-OpenAI עם הכלים
    console.log(`Sending to OpenAI with ${allTools.length} tools`);

    let response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: history,
      tools: allTools.length > 0 ? allTools : undefined,
    });

    let msg = response.choices[0].message;

    // 4. לולאת טיפול ב-Function Calling (אם המודל ביקש להריץ כלי)
    while (msg.tool_calls) {
      history.push(msg); // מוסיפים את בקשת המודל להיסטוריה

      for (const toolCall of msg.tool_calls) {
        const fnName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        const mcpClient = clientMap.get(fnName);

        let resultContent = "Error: Tool not found or client disconnected";

        if (mcpClient) {
          try {
            console.log(`Executing tool ${fnName} on MCP...`);
            const result = await mcpClient.callTool({
              name: fnName,
              arguments: args,
            });
            // MCP מחזיר מערך של content, אנחנו צריכים טקסט ל-OpenAI
            resultContent = result.content.map((c) => c.text).join("\n");
          } catch (e) {
            resultContent = `Error executing tool: ${e.message}`;
          }
        }

        // מחזירים את התוצאה להיסטוריה
        history.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: resultContent,
        });
      }

      // שולחים שוב ל-OpenAI עם התוצאות
      response = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: history,
        tools: allTools.length > 0 ? allTools : undefined,
      });
      msg = response.choices[0].message;
    }

    // 5. תשובה סופית
    const reply = msg.content || "";
    history.push({ role: "assistant", content: reply });

    // ניקוי משאבים (סגירת חיבורי SSE)
    // הערה: בפרודקשן עדיף להשאיר פתוח, אבל ב-Render חינמי עדיף לנקות
    /* activeClients.forEach(c => c.close().catch(() => {})); */
    // ה-SDK הנוכחי לא תמיד חושף close בצורה נקייה בגרסאות מסוימות, ניתן להשאיר לגארבג' קולקטור

    res.json({ reply });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Server error: " + err.message });
  }
});

// MCP Management API
app.get("/api/mcps", (req, res) => res.json({ servers: listMcps() }));
app.post("/api/mcps/http", (req, res) => {
  try {
    const added = addHttpMcp(req.body);
    res.json({ ok: true, added });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post("/api/mcps/local", (req, res) => {
  try {
    const added = addLocalMcp(req.body);
    res.json({ ok: true, added });
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
