/**
 * MCP Manager
 * ===========
 * תפקיד:
 * - להחזיק חיבורים לכל MCP servers (גם HTTP וגם stdio)
 * - למשוך מהם tools (listTools)
 * - לחשוף את הכלים בפורמט OpenAI "tools"
 * - לבצע callTool לפי בקשת המודל
 *
 * למה צריך את זה?
 * כדי שתוכל לצרף MCPים “בזמן ריצה” מה-UI בלי לשנות קוד.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function normalizeHttpMcpUrl(url) {
  const u = (url || "").trim();
  if (!u) return "";
  // אם המשתמש הדביק רק domain, נוסיף /mcp
  if (u.endsWith("/mcp")) return u;
  return u.replace(/\/$/, "") + "/mcp";
}

export class McpManager {
  constructor() {
    // serverId -> { type, label, url/command/args, client }
    this.servers = new Map();

    // globalToolName -> { serverId, toolName, description, inputSchema }
    // globalToolName = <serverId>__<toolName>
    this.toolIndex = new Map();
  }

  // ===== Servers =====

  listServers() {
    return Array.from(this.servers.entries()).map(([id, s]) => ({
      id,
      type: s.type, // "http" | "stdio"
      label: s.label || id,
      url: s.url || null,
      command: s.command || null,
      args: s.args || [],
      toolCount: s.toolCount || 0,
    }));
  }

  /**
   * מוסיף MCP HTTP (Render) בזמן ריצה
   */
  async addHttpServer({ id, url, label }) {
    if (!id) throw new Error("id is required");
    if (this.servers.has(id)) throw new Error("server id already exists");

    const finalUrl = normalizeHttpMcpUrl(url);
    if (!finalUrl) throw new Error("url is required");

    const client = new Client({ name: "mcp-chatbot", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(finalUrl));
    await client.connect(transport);

    this.servers.set(id, {
      type: "http",
      label: label || id,
      url: finalUrl,
      client,
    });
  }

  /**
   * מוסיף MCP stdio (מקומי) בזמן ריצה
   * NOTE: עובד רק בסביבה מקומית.
   */
  async addStdioServer({ id, command, args = [], label }) {
    if (!id) throw new Error("id is required");
    if (this.servers.has(id)) throw new Error("server id already exists");
    if (!command) throw new Error("command is required");

    const client = new Client({ name: "mcp-chatbot", version: "1.0.0" });

    // StdioClientTransport לרוב יודע להפעיל את התהליך בעצמו
    // עם command + args ולחבר אותו ל-stdin/stdout.
    const transport = new StdioClientTransport({
      command,
      args,
    });

    await client.connect(transport);

    this.servers.set(id, {
      type: "stdio",
      label: label || id,
      command,
      args,
      client,
    });
  }

  /**
   * הסרה/ניתוק שרת MCP (מנקה גם את tools)
   */
  async removeServer(id) {
    const s = this.servers.get(id);
    if (!s) return false;

    // SDK לא תמיד מספק close; אם יש - נשתמש
    try {
      if (typeof s.client?.close === "function") await s.client.close();
    } catch {}

    this.servers.delete(id);

    // להסיר tools של אותו server מה-index
    for (const [toolGlobalName, meta] of this.toolIndex.entries()) {
      if (meta.serverId === id) this.toolIndex.delete(toolGlobalName);
    }

    return true;
  }

  // ===== Tools =====

  /**
   * מושך את רשימת tools מכל השרתים ובונה toolIndex
   */
  async refreshTools() {
    this.toolIndex.clear();

    for (const [serverId, s] of this.servers.entries()) {
      const res = await s.client.listTools();
      const tools = res?.tools || [];
      s.toolCount = tools.length;

      for (const t of tools) {
        const globalName = `${serverId}__${t.name}`;
        this.toolIndex.set(globalName, {
          serverId,
          toolName: t.name,
          description: t.description || "",
          inputSchema: t.inputSchema || { type: "object", properties: {} },
        });
      }
    }

    return this.toolIndex.size;
  }

  /**
   * מחזיר tools בפורמט OpenAI function calling
   */
  getOpenAiTools() {
    const out = [];
    for (const [globalName, meta] of this.toolIndex.entries()) {
      out.push({
        type: "function",
        function: {
          name: globalName,
          description:
            meta.description ||
            `MCP tool ${meta.toolName} from ${meta.serverId}`,
          parameters: meta.inputSchema,
        },
      });
    }
    return out;
  }

  /**
   * מריץ tool בפועל
   */
  async call(globalToolName, args) {
    const meta = this.toolIndex.get(globalToolName);
    if (!meta) throw new Error(`Unknown tool: ${globalToolName}`);

    const s = this.servers.get(meta.serverId);
    if (!s) throw new Error(`Server not found: ${meta.serverId}`);

    return s.client.callTool({
      name: meta.toolName,
      arguments: args || {},
    });
  }

  /**
   * תוצאות MCP בד"כ חוזרות בתור content array.
   * הצ'אט שלנו מציג טקסט, אז מחלצים text בלבד.
   */
  static mcpContentToText(mcpRes) {
    const parts = mcpRes?.content || [];
    return parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
}
