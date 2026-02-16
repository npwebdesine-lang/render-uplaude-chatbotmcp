// mcp/manager.js
const mcps = new Map();

// הופך URL רגיל לנקודת קצה של SSE
// אם המשתמש מכניס https://my-app.onrender.com
// אנחנו רוצים https://my-app.onrender.com/sse
function normalizeMcpUrl(url) {
  let u = String(url || "")
    .trim()
    .replace(/\/+$/, "");
  if (!u) throw new Error("url is required");

  // אם המשתמש כבר שם סיומת, לא ניגע. אחרת נוסיף /sse
  if (u.endsWith("/sse")) return u;
  // אם הוא שם /mcp (מהקוד הקודם), נחליף ל /sse
  if (u.endsWith("/mcp")) return u.replace("/mcp", "/sse");

  return `${u}/sse`;
}

export function listMcps() {
  return Array.from(mcps.values());
}

export function addHttpMcp({ id, label, url }) {
  if (!id || !label || !url) throw new Error("Missing fields");
  const normalized = normalizeMcpUrl(url);
  const obj = { id, label, type: "http", url: normalized, addedAt: Date.now() };
  mcps.set(id, obj);
  return obj;
}

// Local MCPs (stdio) are harder to support in Render directly without child_process
// נשאיר את הפונקציה כדי שהקוד לא ישבר, אבל בפועל נשתמש בעיקר ב-HTTP
export function addLocalMcp(data) {
  const obj = { ...data, type: "stdio", addedAt: Date.now() };
  mcps.set(data.id, obj);
  return obj;
}

export function removeMcp(id) {
  mcps.delete(id);
}
