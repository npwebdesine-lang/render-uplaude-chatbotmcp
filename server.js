/**
 * server.js
 * =========
 * ארכיטקטורה:
 * - Express מגיש UI (public/)
 * - MCP Manager מחזיק חיבור ל-MCP servers + tools
 * - OpenAI מקבל tools, ואם המודל מבקש tool -> השרת מריץ MCP ומחזיר תשובה
 *
 * API:
 * - GET  /healthz
 * - GET  /api/mcps
 * - POST /api/mcps/add-http
 * - POST /api/mcps/add-stdio   (מוגן ע"י ALLOW_STDIO=true)
 * - POST /api/mcps/refresh
 * - DELETE /api/mcps/:id
 * - POST /api/chat
 */

import express from "express";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";
import { McpManager } from "./mcp/manager.js";

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Frontend
app.use(express.static(path.join(__dirname, "public")));

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// MCP
const mcp = new McpManager();

// flags
const ALLOW_STDIO = (process.env.ALLOW_STDIO || "").toLowerCase() === "true";

app.get("/healthz", (req, res) => res.status(200).send("ok"));

// סטטוס MCP
app.get("/api/mcps", (req, res) => {
  res.json({
    allowStdio: ALLOW_STDIO,
    servers: mcp.listServers(),
    tools: Array.from(mcp.toolIndex.keys()),
  });
});

// צרף MCP לפי URL (Render / HTTP)
app.post("/api/mcps/add-http", async (req, res) => {
  try {
    const id = (req.body?.id || "").trim();
    const url = (req.body?.url || "").trim();
    const label = (req.body?.label || "").trim();

    if (!id) return res.status(400).json({ error: "id is required" });
    if (!url) return res.status(400).json({ error: "url is required" });

    await mcp.addHttpServer({ id, url, label });
    await mcp.refreshTools();

    res.json({
      ok: true,
      servers: mcp.listServers(),
      tools: Array.from(mcp.toolIndex.keys()),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// צרף MCP מקומי stdio (DEV בלבד)
app.post("/api/mcps/add-stdio", async (req, res) => {
  try {
    if (!ALLOW_STDIO) {
      return res.status(403).json({
        error: "stdio disabled. Set ALLOW_STDIO=true (local dev only).",
      });
    }

    const id = (req.body?.id || "").trim();
    const command = (req.body?.command || "").trim();
    const args = Array.isArray(req.body?.args) ? req.body.args : [];
    const label = (req.body?.label || "").trim();

    if (!id) return res.status(400).json({ error: "id is required" });
    if (!command) return res.status(400).json({ error: "command is required" });

    await mcp.addStdioServer({ id, command, args, label });
    await mcp.refreshTools();

    res.json({
      ok: true,
      servers: mcp.listServers(),
      tools: Array.from(mcp.toolIndex.keys()),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// רענון tools
app.post("/api/mcps/refresh", async (req, res) => {
  try {
    const count = await mcp.refreshTools();
    res.json({
      ok: true,
      toolCount: count,
      servers: mcp.listServers(),
      tools: Array.from(mcp.toolIndex.keys()),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// הסרת MCP
app.delete("/api/mcps/:id", async (req, res) => {
  try {
    const ok = await mcp.removeServer(req.params.id);
    await mcp.refreshTools();
    res.json({
      ok,
      servers: mcp.listServers(),
      tools: Array.from(mcp.toolIndex.keys()),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// צ'אט
app.post("/api/chat", async (req, res) => {
  try {
    const userText = (req.body?.message || "").trim();
    if (!userText)
      return res.status(400).json({ error: "message is required" });

    // system prompt קצר וברור
    const system = {
      role: "system",
      content:
        "אתה עוזר בעברית. אם יש כלים זמינים (MCP), השתמש בהם כשצריך. תשובות קצרות וברורות.",
    };

    const messages = [system, { role: "user", content: userText }];
    const tools = mcp.getOpenAiTools();

    // 1) קריאה ראשונה - המודל מחליט אם צריך tool
    const r1 = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? "auto" : undefined,
    });

    const msg1 = r1.choices?.[0]?.message;

    // בלי tool_calls => תשובה רגילה
    if (!msg1?.tool_calls?.length) {
      return res.json({ reply: (msg1?.content || "").trim() });
    }

    // כרגע: מריצים tool ראשון (אפשר להרחיב למספר כלים)
    const call = msg1.tool_calls[0];
    const toolName = call.function.name;
    const args = JSON.parse(call.function.arguments || "{}");

    // 2) מריצים MCP tool בפועל
    const mcpRes = await mcp.call(toolName, args);
    const toolText =
      McpManager.mcpContentToText(mcpRes) || "MCP returned no text";

    // 3) קריאה שנייה - נותנים למודל את תוצאת הכלי שינסח תשובה
    const messages2 = [
      ...messages,
      msg1,
      { role: "tool", tool_call_id: call.id, content: toolText },
    ];

    const r2 = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messages2,
    });

    const finalText = (r2.choices?.[0]?.message?.content || "").trim();
    res.json({ reply: finalText });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

// Start
const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => console.log("Server listening on", port));
