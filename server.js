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
const MODEL_NAME = "gpt-3.5-turbo";

// אנחנו אומרים לו להסתמך על התיאורים
const SYSTEM_PROMPT = `
You are a smart assistant.
You have access to external tools.
When the user asks a question, analyze the DESCRIPTION of each tool to decide which one fits best.
If a tool's description matches the user's need, USE IT.
Answer in Hebrew.
`;

function log(msg) {
  console.log(`[Chatbot] ${msg}`);
}

// חיבור יציב
async function connectToMcpRobust(mcpConfig) {
  if (mcpConfig.type !== "http") return null;
  try {
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
    const tools = toolsResult.tools || [];

    // >>> לוג סריקה: מראה אילו כלים ותיאורים נמצאו <<<
    if (tools.length > 0) {
      log(`✅ Scanned MCP '${mcpConfig.label}':`);
      tools.forEach((t) =>
        log(
          `   -> Found Tool: [${t.name}] - Desc: "${t.description || "No description"}"`,
        ),
      );
    }

    return { client: mcpClient, tools: tools, id: mcpConfig.id };
  } catch (err) {
    log(`❌ Scan failed for ${mcpConfig.label}: ${err.message}`);
    return null;
  }
}

function getOrCreateChat(chatId) {
  if (!chats.has(chatId))
    chats.set(chatId, [{ role: "system", content: SYSTEM_PROMPT }]);
  return chats.get(chatId);
}

app.post("/api/chat", async (req, res) => {
  try {
    const { chatId, message } = req.body;
    if (!chatId || !message)
      return res.status(400).json({ error: "Missing data" });

    const history = getOrCreateChat(chatId);
    history.push({ role: "user", content: message });

    // 1. סריקת כל השרתים
    const mcpConfigs = listMcps();
    const allTools = [];
    const clientMap = new Map();

    const connections = await Promise.all(
      mcpConfigs.map((c) => connectToMcpRobust(c)),
    );

    for (const conn of connections) {
      if (conn && conn.tools) {
        for (const tool of conn.tools) {
          // אנחנו מעבירים את התיאור המדויק ל-OpenAI
          allTools.push({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description, // התיאור שהגדרנו ב-MCP מועבר לפה!
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

    const toolsPayload = allTools.length > 0 ? allTools : undefined;

    // 2. OpenAI מחליט באיזה כלי להשתמש לפי התיאור
    let response = await client.chat.completions.create({
      model: MODEL_NAME,
      messages: history,
      tools: toolsPayload,
    });

    let msg = response.choices[0].message;
    const usedToolsLog = [];

    if (msg.tool_calls) {
      history.push(msg);
      for (const toolCall of msg.tool_calls) {
        const fnName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        usedToolsLog.push({ name: fnName, args });

        // לוג שמראה שהצ'אט בחר בכלי הספציפי
        log(`🎯 Selected tool based on description: ${fnName}`);

        const mcpClient = clientMap.get(fnName);
        let content = "";

        if (mcpClient) {
          try {
            const result = await mcpClient.callTool({
              name: fnName,
              arguments: args,
            });
            content = result.content[0].text;
          } catch (e) {
            content = `Error: ${e.message}`;
          }
        } else {
          content = "Error: Connection lost";
        }

        history.push({ role: "tool", tool_call_id: toolCall.id, content });
      }
      response = await client.chat.completions.create({
        model: MODEL_NAME,
        messages: history,
        tools: toolsPayload,
      });
      msg = response.choices[0].message;
    }

    history.push({ role: "assistant", content: msg.content });
    res.json({ reply: msg.content, usedTools: usedToolsLog });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// APIs & KeepAlive
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
app.get("/healthz", (req, res) => res.send("OK"));

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`Chatbot listening on port ${port}`);
  const myUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
  setInterval(() => {
    fetch(`${myUrl}/healthz`).catch(() => console.log("ping failed"));
  }, 300000);
});
