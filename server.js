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

// הנחיה ברורה למודל
const SYSTEM_PROMPT = `
You are a helpful assistant.
You have a tool called 'get_weather'.
If the user mentions weather, city, or temperature -> YOU MUST use 'get_weather'.
Do not say "I will check". Just run the tool.
If the tool works, show the result.
Answer in Hebrew.
`;

function log(msg) {
  console.log(`[Chatbot Log] ${msg}`);
}

// פונקציית המתנה
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- פונקציית החיבור ה"עקשנית" ---
async function connectToMcpWithRetry(mcpConfig) {
  if (mcpConfig.type !== "http") return null;

  const MAX_RETRIES = 3; // ננסה 3 פעמים

  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      log(`Attempt ${i}/${MAX_RETRIES}: Connecting to ${mcpConfig.url}...`);

      const transport = new SSEClientTransport(new URL(mcpConfig.url));
      const mcpClient = new Client(
        { name: "chatbot", version: "1.0.0" },
        { capabilities: {} },
      );

      // נותנים ל-Render 15 שניות לכל ניסיון חיבור
      const connectPromise = mcpClient.connect(transport);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Connection Timeout")), 15000),
      );

      await Promise.race([connectPromise, timeoutPromise]);

      const toolsResult = await mcpClient.listTools();
      log(`✅ Connected successfully to ${mcpConfig.id}!`);
      return { client: mcpClient, tools: toolsResult.tools || [] };
    } catch (err) {
      log(`❌ Attempt ${i} failed: ${err.message}`);
      if (i < MAX_RETRIES) {
        log("Waiting 5 seconds for Render to wake up...");
        await sleep(5000); // מחכים 5 שניות לפני ניסיון נוסף
      }
    }
  }

  log(`All connection attempts failed for ${mcpConfig.id}`);
  return null;
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

    // 1. שלב החיבור (הארוך)
    const mcpConfigs = listMcps();
    const allTools = [];
    const clientMap = new Map();

    // מנסים לחבר את כל השרתים עם ה-Retry
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

    const usedToolsLog = [];

    // 2. קריאה ל-OpenAI
    let response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: history,
      tools: allTools.length > 0 ? allTools : undefined,
    });

    let msg = response.choices[0].message;

    // 3. ביצוע הכלים (אם התבקשו)
    while (msg.tool_calls) {
      history.push(msg); // שומרים את הבקשה

      for (const toolCall of msg.tool_calls) {
        const fnName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        usedToolsLog.push({ name: fnName, args });

        const mcpClient = clientMap.get(fnName);
        let content = "";

        if (!mcpClient) {
          content = "Error: Connection to tool server lost.";
        } else {
          try {
            log(`Executing tool: ${fnName}...`);
            const result = await mcpClient.callTool({
              name: fnName,
              arguments: args,
            });
            content = result.content.map((c) => c.text).join("\n");
          } catch (e) {
            content = `Error executing tool: ${e.message}`;
          }
        }

        history.push({ role: "tool", tool_call_id: toolCall.id, content });
      }

      // קריאה חוזרת עם התוצאה
      response = await client.chat.completions.create({
        model: "gpt-4o",
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
    res.status(500).json({ error: err.message });
  }
});

// --- שאר ה-Endpoints ---
app.get("/api/mcps", (req, res) => res.json({ servers: listMcps() }));
app.post("/api/mcps/http", (req, res) => {
  res.json({ ok: true, added: addHttpMcp(req.body) });
});
app.post("/api/mcps/local", (req, res) => {
  res.json({ ok: true, added: addLocalMcp(req.body) });
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
