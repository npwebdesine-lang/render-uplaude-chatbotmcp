import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { EventSource } from "eventsource";
global.EventSource = EventSource;

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { listMcps, addHttpMcp, removeMcp } from "./mcp/manager.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const chats = new Map();

const MODEL_NAME = "gpt-4o";

const SYSTEM_PROMPT = `
You are a helpful assistant.
Do not answer from your own knowledge.
If the tool works, tell the user the result.
Answer in Hebrew.
`;

function log(msg) {
  console.log(`[Chatbot] ${msg}`);
}

/**
 * מנקה שמות של כלים (מוחק קווים תחתונים ורווחים) כדי למנוע בלבול של ה-AI
 */
function normalizeName(name) {
  return name.toLowerCase().replace(/_/g, "").replace(/-/g, "");
}

/**
 * פונקציה חכמה שמתחברת לשרת ה-MCP המרוחק עם מגבלת זמן (Timeout)
 * כדי למנוע תקיעות אם השרת המרוחק נפל.
 */
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
      setTimeout(() => reject(new Error("Timeout (60s)")), 60000),
    );

    // ממתינים עד שהשרת יתחבר או עד שיעברו 60 שניות
    await Promise.race([connectPromise, timeoutPromise]);

    const toolsResult = await mcpClient.listTools();
    const tools = toolsResult.tools || [];
    return { client: mcpClient, tools: tools, id: mcpConfig.id };
  } catch (err) {
    log(`❌ Connection failed to ${mcpConfig.id}: ${err.message}`);
    return null;
  }
}

/**
 * מנהל את היסטוריית הצ'אט בזיכרון השרת
 */
function getOrCreateChat(chatId) {
  if (!chats.has(chatId)) {
    chats.set(chatId, [{ role: "system", content: SYSTEM_PROMPT }]);
  }
  return chats.get(chatId);
}

// --- ה-API של הצ'אט ---
app.post("/api/chat", async (req, res) => {
  try {
    // משיכת זיהוי המשתמש מה-Headers (נשלח מהדפדפן)
    const userId = req.headers["x-user-id"];
    if (!userId)
      return res.status(401).json({ error: "Unauthorized: Missing User ID" });

    const { chatId, message } = req.body;
    if (!chatId || !message)
      return res.status(400).json({ error: "Missing data" });

    const history = getOrCreateChat(chatId);
    history.push({ role: "user", content: message });

    // מביאים רק את הכלים של המשתמש הספציפי הזה!
    const mcpConfigs = listMcps(userId);
    const allTools = [];
    const clientMap = new Map();

    // התחברות לכל השרתים במקביל
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
          clientMap.set(tool.name, conn.client);
        }
      }
    }

    // קריאה למודל ה-AI
    let response = await client.chat.completions.create({
      model: MODEL_NAME,
      messages: history,
      tools: allTools.length > 0 ? allTools : undefined,
      tool_choice: allTools.length > 0 ? "auto" : undefined,
    });

    let msg = response.choices[0].message;
    const usedToolsLog = [];

    // טיפול בכלים (Tool Calling) עם Fuzzy Match
    if (msg.tool_calls) {
      history.push(msg);

      for (const toolCall of msg.tool_calls) {
        const requestedName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        usedToolsLog.push({ name: requestedName, args });

        let mcpClient = clientMap.get(requestedName);
        let realToolName = requestedName;

        // חיפוש גמיש אם ה-AI עשה שגיאת כתיב קלה בשם הכלי
        if (!mcpClient) {
          const normalizedReq = normalizeName(requestedName);
          for (const [key, client] of clientMap.entries()) {
            if (normalizeName(key) === normalizedReq) {
              mcpClient = client;
              realToolName = key;
              break;
            }
          }
        }

        let content = "";
        if (!mcpClient) {
          content = `Error: Tool '${requestedName}' not found.`;
        } else {
          try {
            const result = await mcpClient.callTool({
              name: realToolName,
              arguments: args,
            });
            content = result.content
              ? result.content.map((c) => c.text).join("\n")
              : JSON.stringify(result);
          } catch (e) {
            content = `Tool Error: ${e.message}`;
          }
        }
        history.push({ role: "tool", tool_call_id: toolCall.id, content });
      }

      // קריאה חוזרת עם התשובה מהכלי
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

// --- ניהול MCPs מבוסס משתמשים ---
app.get("/api/mcps", (req, res) => {
  const userId = req.headers["x-user-id"];
  res.json({ servers: listMcps(userId) });
});

app.post("/api/mcps/http", (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ ok: true, added: addHttpMcp(userId, req.body) });
});

app.delete("/api/mcps/:id", (req, res) => {
  const userId = req.headers["x-user-id"];
  removeMcp(userId, req.params.id);
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
});
