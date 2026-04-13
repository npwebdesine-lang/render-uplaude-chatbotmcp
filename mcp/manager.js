// mcp/manager.js
// ─────────────────────────────────────────────────────────────────────────────
// מנהל את רישום שרתי ה-MCP לכל משתמש.
// שומר הכל ב-memory (Map) — נמחק אם השרת מתאפס, לכן המשתמש צריך להוסיף מחדש.
// ─────────────────────────────────────────────────────────────────────────────

// מבנה: Map<userId (string), mcpConfig[]>
// כל userId מחזיק מערך של שרתים שהוסיף
const userMcps = new Map();

// ─── URL Normalization ────────────────────────────────────────────────────────
// מוודאת שהכתובת מסתיימת ב-/sse — זהו ה-endpoint שה-MCP SDK מתחבר אליו.
// מאפשרת למשתמש להדביק כתובות בפורמטים שונים:
//   "https://my-mcp.onrender.com"      → "https://my-mcp.onrender.com/sse"
//   "https://my-mcp.onrender.com/mcp"  → "https://my-mcp.onrender.com/sse"
//   "https://my-mcp.onrender.com/sse"  → ללא שינוי
function normalizeMcpUrl(url) {
  let u = String(url || "")
    .trim()
    .replace(/\/+$/, ""); // מסיר slash בסוף: "url/" → "url"
  if (!u) throw new Error("url is required");
  if (u.endsWith("/sse")) return u;                      // כבר תקין
  if (u.endsWith("/mcp")) return u.replace("/mcp", "/sse"); // המרה אוטומטית
  return `${u}/sse`;                                     // הוספת /sse
}

// ─── List ─────────────────────────────────────────────────────────────────────
// מחזירה את כל שרתי ה-MCP של משתמש ספציפי.
// נקראת ב-server.js בכל בקשת צ'אט כדי לדעת אילו שרתים לחבר
export function listMcps(userId) {
  if (!userId) return []; // userId לא תקין → רשימה ריקה (לא שגיאה)
  return userMcps.get(userId) || []; // משתמש חדש → []
}

// ─── Add HTTP MCP ─────────────────────────────────────────────────────────────
// מוסיפה שרת MCP חדש (סוג HTTP/SSE) לרשימת המשתמש.
// מנרמלת את ה-URL לפני שמירה כדי שהחיבור יעבוד תמיד
export function addHttpMcp(userId, { id, label, url }) {
  // ולידציה בסיסית — כל השדות נדרשים
  if (!userId || !id || !label || !url) throw new Error("Missing fields");

  // נרמול ה-URL (מוסיף /sse בסוף אם חסר)
  const normalized = normalizeMcpUrl(url);

  // אובייקט השרת שנשמר
  const obj = {
    id,               // מזהה ייחודי שהמשתמש בחר (e.g. "my-weather-server")
    label,            // שם תצוגה (e.g. "שרת מזג אוויר")
    type: "http",     // סוג התחבורה — רק HTTP נתמך כרגע
    url: normalized,  // הכתובת המנורמלת (עם /sse)
    addedAt: Date.now(), // חותמת זמן להצגה
  };

  // שולפים את הרשימה הקיימת (או [] אם חדש), מוסיפים, ושומרים חזרה
  const mcps = userMcps.get(userId) || [];
  mcps.push(obj);
  userMcps.set(userId, mcps);

  return obj; // מוחזר ל-server.js ואז ללקוח כאישור
}

// ─── Remove MCP ───────────────────────────────────────────────────────────────
// מוחקת שרת מרשימת המשתמש לפי ID.
// הסגירה של ה-transport (network connection) מבוצעת ב-server.js לפני הקריאה לזה
export function removeMcp(userId, mcpId) {
  if (!userId) return;
  let mcps = userMcps.get(userId) || [];
  // filter מחזיר מערך חדש בלי הפריט שרוצים למחוק
  mcps = mcps.filter((m) => m.id !== mcpId);
  userMcps.set(userId, mcps);
}
