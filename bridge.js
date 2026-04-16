/**
 * bridge.js — MCP Local Bridge
 *
 * מריץ שרת MCP מקומי (STDIO) ומחשף אותו כ-HTTP/SSE
 * כך שהצ'אטבוט על Render יכול להתחבר אליו דרך ngrok.
 *
 * שימוש:
 *   node bridge.js <command> [args...]
 *
 * דוגמאות:
 *   node bridge.js python C:\Users\me\scripts\my_server.py
 *   node bridge.js python3 -m my_mcp_module
 *   node bridge.js npx -y @modelcontextprotocol/server-filesystem ./docs
 *
 * לאחר ההרצה:
 *   1. הרץ: npx ngrok http 3100
 *   2. קבל URL כמו: https://abc123.ngrok-free.app
 *   3. הוסף ב-chatbot כ-HTTP/SSE עם ה-URL הזה
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import cors from "cors";

const cmdArgs = process.argv.slice(2);

if (cmdArgs.length === 0) {
  console.error(`
╔══════════════════════════════════════════════════════╗
║             MCP Local Bridge — שגיאת הפעלה          ║
╚══════════════════════════════════════════════════════╝

שימוש:  node bridge.js <command> [args...]

דוגמאות:
  node bridge.js python C:\\Users\\me\\my_server.py
  node bridge.js python3 -m my_mcp_module
  node bridge.js npx -y @modelcontextprotocol/server-filesystem ./docs
`);
  process.exit(1);
}

const [command, ...args] = cmdArgs;
const PORT = process.env.BRIDGE_PORT || 3100;

// ─── 1. חיבור לתהליך STDIO המקומי ───────────────────────────────────────────
console.log(`\n🔌 מפעיל תהליך STDIO...`);
console.log(`   פקודה: ${command} ${args.join(" ")}\n`);

const stdioTransport = new StdioClientTransport({ command, args });
const localClient = new Client(
  { name: "bridge-client", version: "1.0.0" },
  { capabilities: {} },
);

try {
  await localClient.connect(stdioTransport);
} catch (err) {
  console.error(`❌ לא ניתן להפעיל את הפקודה: ${err.message}`);
  console.error(`   בדוק שהפקודה מותקנת ושהנתיב נכון.`);
  process.exit(1);
}

const { tools } = await localClient.listTools();
console.log(`✅ חובר ל-STDIO! ${tools.length} כלים זמינים:`);
tools.forEach((t) => console.log(`   • ${t.name}`));

// ─── 2. שרת SSE שמפנה קריאות ל-STDIO ────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

const mcpServer = new Server(
  { name: "bridge-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// listTools — מחזיר את הכלים של ה-STDIO
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

// callTool — מעביר את הקריאה ל-STDIO ומחזיר תוצאה
mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
  const result = await localClient.callTool({
    name: req.params.name,
    arguments: req.params.arguments ?? {},
  });
  return result;
});

// ─── SSE Connections ─────────────────────────────────────────────────────────
const sessions = new Map(); // sessionId -> SSEServerTransport

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  sessions.set(transport.sessionId, transport);

  res.on("close", () => {
    sessions.delete(transport.sessionId);
  });

  try {
    await mcpServer.connect(transport);
  } catch (err) {
    console.error("SSE connection error:", err.message);
  }
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sessions.get(sessionId);
  if (!transport) {
    return res.status(404).json({ error: "Session not found" });
  }
  try {
    await transport.handlePostMessage(req, res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/healthz", (_req, res) => res.send("OK"));

// ─── הפעלה ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║           ✅ MCP Bridge פועל בהצלחה!                ║
╚══════════════════════════════════════════════════════╝

🌐 כתובת מקומית:  http://localhost:${PORT}

📡 כדי לחשוף לרנדר — הרץ בטרמינל נפרד:
   npx ngrok http ${PORT}

לאחר מכן קח את ה-URL של ngrok (https://...ngrok-free.app)
והוסף אותו ב-chatbot כ-HTTP/SSE MCP.
`);
});

// ─── ניקוי כשהתהליך נסגר ────────────────────────────────────────────────────
process.on("SIGINT", () => {
  console.log("\n🛑 סוגר את ה-bridge...");
  stdioTransport.close().catch(() => {});
  process.exit(0);
});
process.on("SIGTERM", () => {
  stdioTransport.close().catch(() => {});
  process.exit(0);
});
