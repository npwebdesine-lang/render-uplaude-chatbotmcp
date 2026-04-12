// mcp/manager.js

// היומן הראשי: שומר לכל משתמש (User ID) את רשימת השרתים שלו
const userMcps = new Map();

/**
 * פונקציית עזר: מוודאת שהכתובת מסתיימת ב-/sse כנדרש בתקשורת מול שרת
 */
function normalizeMcpUrl(url) {
  let u = String(url || "")
    .trim()
    .replace(/\/+$/, "");
  if (!u) throw new Error("url is required");
  if (u.endsWith("/sse")) return u;
  if (u.endsWith("/mcp")) return u.replace("/mcp", "/sse");
  return `${u}/sse`;
}

/**
 * שולפת את כל השרתים המחוברים עבור משתמש ספציפי
 */
export function listMcps(userId) {
  if (!userId) return [];
  // מחזירים את הרשימה של המשתמש, או רשימה ריקה אם הוא חדש
  return userMcps.get(userId) || [];
}

/**
 * מוסיפה שרת חדש לתיקייה האישית של המשתמש
 */
export function addHttpMcp(userId, { id, label, url }) {
  if (!userId || !id || !label || !url) throw new Error("Missing fields");
  const normalized = normalizeMcpUrl(url);
  const obj = { id, label, type: "http", url: normalized, addedAt: Date.now() };

  // שולפים את הרשימה הקיימת, מוסיפים לה, ושומרים חזרה
  const mcps = userMcps.get(userId) || [];
  mcps.push(obj);
  userMcps.set(userId, mcps);

  return obj;
}

/**
 * מוחקת שרת מרשימת המשתמש לפי ID
 */
export function removeMcp(userId, mcpId) {
  if (!userId) return;
  let mcps = userMcps.get(userId) || [];
  mcps = mcps.filter((m) => m.id !== mcpId);
  userMcps.set(userId, mcps);
}

/**
 * מוסיפה שרת MCP מקומי עם tunnel — config נשמר, tunnelUrl מוגדר לאחר מכן
 */
export function addLocalMcp(userId, { id, label, command, args = [] }) {
  if (!userId || !id || !label || !command) throw new Error("Missing fields");
  const parsedArgs = Array.isArray(args)
    ? args
    : String(args).split(/\s+/).filter(Boolean);
  const obj = {
    id,
    label,
    type: "local",
    command: command.trim(),
    args: parsedArgs,
    tunnelUrl: null,
    addedAt: Date.now(),
  };
  const mcps = userMcps.get(userId) || [];
  mcps.push(obj);
  userMcps.set(userId, mcps);
  return obj;
}

/**
 * מעדכנת את ה-tunnel URL של שרת מקומי
 */
export function setLocalMcpTunnel(userId, mcpId, tunnelUrl) {
  const mcps = userMcps.get(userId) || [];
  const mcp = mcps.find((m) => m.id === mcpId);
  if (!mcp) throw new Error("MCP not found");
  mcp.tunnelUrl = tunnelUrl ? String(tunnelUrl).trim() : null;
  userMcps.set(userId, mcps);
  return mcp;
}

/**
 * מוסיפה שרת STDIO מקומי — מריץ פקודה כתהליך-ילד
 */
export function addStdioMcp(userId, { id, label, command, args = [] }) {
  if (!userId || !id || !label || !command) throw new Error("Missing fields");
  // args יכול להגיע כ-string מרווחים — נמיר למערך
  const parsedArgs = Array.isArray(args)
    ? args
    : String(args).split(/\s+/).filter(Boolean);
  const obj = {
    id,
    label,
    type: "stdio",
    command: command.trim(),
    args: parsedArgs,
    addedAt: Date.now(),
  };
  const mcps = userMcps.get(userId) || [];
  mcps.push(obj);
  userMcps.set(userId, mcps);
  return obj;
}
