/**
 * mcp/manager.js
 * ---------------
 * זה registry שמנהל רשימת MCPs שנוספו מה-UI.
 *
 * למה זה קיים?
 * - כדי לאפשר "צרף MCP URL" ואז להציג אותו בממשק
 * - כדי לשמור structure קבוע (id/label/type/url וכו')
 *
 * כרגע זה נשמר ב-RAM בלבד:
 * - אם Render עושה restart => הרשימה תימחק.
 * אפשר בעתיד להחליף ל-DB/Redis/קובץ.
 */

const mcps = new Map();

/**
 * normalize:
 * המשתמש יכניס לרוב:
 *   https://render-uplaude.onrender.com
 * אבל MCP endpoint בפועל הוא:
 *   https://render-uplaude.onrender.com/mcp
 */
function normalizeMcpUrl(url) {
  const u = String(url || "")
    .trim()
    .replace(/\/+$/, "");
  if (!u) throw new Error("url is required");
  return u.endsWith("/mcp") ? u : `${u}/mcp`;
}

export function listMcps() {
  return Array.from(mcps.values());
}

export function addHttpMcp({ id, label, url }) {
  if (!id || typeof id !== "string") throw new Error("id is required");
  if (!label || typeof label !== "string") throw new Error("label is required");
  if (!url || typeof url !== "string") throw new Error("url is required");

  const normalized = normalizeMcpUrl(url);

  const obj = {
    id,
    label,
    type: "http",
    url: normalized,
    addedAt: Date.now(),
  };

  mcps.set(id, obj);
  return obj;
}

export function addLocalMcp({ id, label, command, args }) {
  if (!id || typeof id !== "string") throw new Error("id is required");
  if (!label || typeof label !== "string") throw new Error("label is required");
  if (!command || typeof command !== "string")
    throw new Error("command is required");

  const obj = {
    id,
    label,
    type: "stdio",
    command,
    args: Array.isArray(args) ? args : [],
    addedAt: Date.now(),
  };

  mcps.set(id, obj);
  return obj;
}

export function removeMcp(id) {
  if (!mcps.has(id)) throw new Error("MCP not found");
  mcps.delete(id);
}
