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

