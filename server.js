// ─── ייבואים ─────────────────────────────────────────────────────────────────
// express — framework לשרת HTTP. כל endpoint מוגדר כאן (POST /api/chat וכד׳)
import express from "express";
// path + fileURLToPath — עוזרים לנו למצוא את תיקיית "public" בדיסק (ES Modules לא מכירים __dirname)
import path from "path";
import { fileURLToPath } from "url";
// openai — ספריית הלקוח הרשמית של OpenAI. דרכה שולחים בקשות ל-GPT-4o
import OpenAI from "openai";
// eventsource — Node.js לא מכיר EventSource מטבעו (זה API של דפדפן).
// הספרייה הזו מוסיפה אותו כ-global כדי שה-MCP SDK יוכל להשתמש בו
import { EventSource } from "eventsource";
global.EventSource = EventSource;

// Client + SSEClientTransport — אלו חלקי ה-SDK של MCP שמאפשרים לנו
// לדבר עם שרתי MCP חיצוניים דרך HTTP/SSE (Server-Sent Events)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
// manager — מודול פנימי שמנהל את רשימת שרתי ה-MCP לכל משתמש
import { listMcps, addHttpMcp, removeMcp } from "./mcp/manager.js";

// ─── אתחול השרת ───────────────────────────────────────────────────────────────
const app = express();
// מאפשר לקרוא JSON מה-body של בקשות POST (מוגבל ל-1MB כהגנה מפני payloads גדולים)
app.use(express.json({ limit: "1mb" }));

// __dirname לא קיים ב-ES Modules — מחשבים אותו ידנית
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// כל קובץ ב-public/ מוגש ישירות לדפדפן (index.html, app.js, style.css)
app.use(express.static(path.join(__dirname, "public")));

// לקוח OpenAI — קורא את ה-API key מ-environment variable (לא קוד רגיל!)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Map ששומר את היסטוריית השיחה של כל chatId
// מבנה: chatId (string) → messages[] (מערך הודעות בפורמט OpenAI)
const chats = new Map();

// ─── קבועי תצורה ─────────────────────────────────────────────────────────────
const MODEL_NAME = "gpt-4o"; // המודל של OpenAI שנשתמש בו
const MAX_HISTORY = 30; // כמה הודעות לשמור בזיכרון (הישנות נמחקות)
const MAX_TOOL_LOOPS = 5; // מקסימום סיבובי tool calling לפני עצירה
const MCP_TIMEOUT_MS = 60_000; // 60 שניות — Render Free לוקח זמן להתעורר
const MCP_CACHE_TTL_MS = 10 * 60_000; // חיבורי MCP נשמרים 10 דקות לפני reconnect

// ─── Rate Limiter ─────────────────────────────────────────────────────────────
// מונע spam: כל משתמש מוגבל ל-20 בקשות לדקה
// עובד עם "sliding window" — שומר חותמות זמן ומסנן את אלה שעברו 60 שניות
const rateLimitMap = new Map(); // userId → timestamps[]

function checkRateLimit(userId) {
  const now = Date.now();
  // שולף את הבקשות הקודמות ומסנן רק אלה שהן בתוך הדקה האחרונה
  const prev = (rateLimitMap.get(userId) || []).filter((t) => now - t < 60_000);
  // אם כבר 20 בקשות — חוסם
  if (prev.length >= 20) return false;
  // מוסיף את הבקשה הנוכחית לרשימה ושומר
  prev.push(now);
  rateLimitMap.set(userId, prev);
  return true;
}

// ─── System Prompt ────────────────────────────────────────────────────────────
// ה"הוראות עבודה" שה-AI מקבל בתחילת כל שיחה.
// זהו ה-API האמיתי שלנו עם GPT-4o — כאן אנחנו מגדירים את אופי ההתנהגות שלו.
// שיעור חשוב: פשוט וישיר עובד טוב יותר מ-"CRITICAL RULE" אגרסיבי
const SYSTEM_PROMPT = `
You are a helpful assistant.
Do not answer from your own knowledge.
If the tool works, tell the user the result.
If the user asks you to generate a file (like CSV, HTML, Python, TXT), DO NOT use external tools. Instead, output the exact content they requested inside a Markdown code block, and clearly specify the language/extension (for example: \`\`\`csv or \`\`\`html). The chat interface will automatically convert this block into a downloadable file for the user.
Answer in Hebrew.
`;

// לוג פשוט עם prefix קבוע לזיהוי קל ב-console
function log(msg) {
  console.log(`[Chatbot] ${msg}`);
}

// ─── Fuzzy Name Matching ──────────────────────────────────────────────────────
// GPT-4o לפעמים מחזיר שם כלי עם קו תחתון במקום מקף (get_weather vs get-weather).
// הפונקציה מנרמלת שניהם לאותה צורה כדי לאפשר התאמה גם על שגיאות קלות
function normalizeName(name) {
  // מוריד לאותיות קטנות ומסיר _ ו- לחלוטין: "get_weather" → "getweather"
  return name.toLowerCase().replace(/[_\-]/g, "");
}

// ─── MCP Connection Cache ─────────────────────────────────────────────────────
// מבנה: Map<userId, Map<mcpId, { client, tools, transport, status, connectedAt }>>
// כל משתמש שומר Map משלו של חיבורים — מבודד בין משתמשים
// המטרה: לא להתחבר מחדש ל-MCP בכל הודעה — חיבור SSE עולה 1-2 שניות
const mcpCache = new Map();

// שולף (או יוצר) את ה-Map הפנימי של משתמש ספציפי
function getUserCache(userId) {
  if (!mcpCache.has(userId)) mcpCache.set(userId, new Map());
  return mcpCache.get(userId);
}

// ─── MCP Connection ───────────────────────────────────────────────────────────
// יוצר חיבור חדש לשרת MCP ומחזיר אובייקט עם { client, tools, id, transport }
// מחזיר null אם החיבור נכשל (שרת לא עלה, timeout וכד׳)
async function connectToMcp(mcpConfig) {
  // רק HTTP נתמך — STDIO הוסר (ראה חלק י׳ בשיעור, בעיה 6)
  if (mcpConfig.type !== "http") return null;
  log(`Connecting (HTTP) to ${mcpConfig.url}...`);

  // SSEClientTransport יוצר חיבור SSE (Server-Sent Events) לשרת ה-MCP
  const transport = new SSEClientTransport(new URL(mcpConfig.url));

  try {
    // יצירת לקוח MCP — מזהה את עצמו כ-"chatbot"
    const mcpClient = new Client(
      { name: "chatbot", version: "1.0.0" },
      { capabilities: {} },
    );

    // Promise.race — מי שמסיים ראשון "מנצח":
    // אם החיבור הצליח לפני 60 שניות — ממשיכים
    // אם עברו 60 שניות לפני שהחיבור הצליח — זורקים Timeout error
    // 60 שניות כי Render Free יכול לקחת 30 שניות להתעורר (cold start)
    await Promise.race([
      mcpClient.connect(transport),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), MCP_TIMEOUT_MS),
      ),
    ]);

    // שואלים את שרת ה-MCP: "אילו כלים יש לך?"
    // התשובה היא מערך של { name, description, inputSchema }
    const { tools } = await mcpClient.listTools();
    log(`✅ Connected to ${mcpConfig.id} (${tools?.length ?? 0} tools)`);
    return {
      client: mcpClient, // דרכו קוראים לכלים
      tools: tools || [], // רשימת הכלים הזמינים
      id: mcpConfig.id,
      transport, // נשמר כדי לסגור את החיבור כשצריך
    };
  } catch (err) {
    log(`❌ Failed ${mcpConfig.id}: ${err.message}`);
    // סוגרים את ה-transport גם אם נכשלנו — מניעת memory leaks
    transport?.close?.().catch(() => {});
    return null;
  }
}

// ─── Cache Logic ──────────────────────────────────────────────────────────────
// מחזיר חיבור מה-cache אם הוא תקף (פחות מ-10 דקות), אחרת מתחבר מחדש.
// זו האופטימיזציה המרכזית: רוב הפעמים לא צריך reconnect
async function getOrConnectMcp(userId, mcpConfig) {
  const cache = getUserCache(userId);
  const cached = cache.get(mcpConfig.id);
  const now = Date.now();

  // בדיקת cache תקף: קיים + סטטוס "ready" + לא פג תוקף
  if (
    cached &&
    cached.status === "ready" &&
    now - cached.connectedAt < MCP_CACHE_TTL_MS
  ) {
    // ← ← ← רוב הפעמים קורה כאן — return מיידי, ללא network call
    return cached;
  }

  // cache פג תוקף — סוגרים את החיבור הישן לפני פתיחת חדש
  if (cached?.transport) cached.transport.close().catch(() => {});

  // מתחברים מחדש ושומרים ב-cache
  const conn = await connectToMcp(mcpConfig);
  if (conn) {
    const entry = { ...conn, status: "ready", connectedAt: now };
    cache.set(mcpConfig.id, entry);
    return entry;
  }

  // החיבור נכשל — שומרים סטטוס error כדי לא לנסות שוב מיד
  cache.set(mcpConfig.id, {
    status: "error",
    connectedAt: now,
    id: mcpConfig.id,
    tools: [],
  });
  return null;
}

// ─── Chat History ─────────────────────────────────────────────────────────────
// שולף (או יוצר) את היסטוריית השיחה של chatId.
// ההיסטוריה תמיד מתחילה ב-system message עם ה-SYSTEM_PROMPT
function getOrCreateChat(chatId) {
  if (!chats.has(chatId)) {
    // { role: "system" } הוא הודעת ה"הוראות" שה-AI מקבל — חייבת להיות ראשונה
    chats.set(chatId, [{ role: "system", content: SYSTEM_PROMPT }]);
  }
  return chats.get(chatId);
}

// חותך את ההיסטוריה ל-MAX_HISTORY הודעות אחרונות (+ system תמיד נשמרת)
// מונע שהיסטוריה ארוכה מדי תכביד על קריאות ל-OpenAI (ועלות)
function trimHistory(history) {
  const system = history[0]; // הודעת ה-system — לא נוגעים בה לעולם
  const rest = history.slice(1);
  if (rest.length <= MAX_HISTORY) return history; // עוד לא צריך לחתוך
  // שומרים רק את ה-MAX_HISTORY האחרונות
  return [system, ...rest.slice(rest.length - MAX_HISTORY)];
}

// ─── SSE Helper ───────────────────────────────────────────────────────────────
// פותח SSE stream ומחזיר פונקציית send() שכל קריאה אליה שולחת event ללקוח.
// SSE = Server-Sent Events: connection פתוח שהשרת כותב אליו chunks
// הדפדפן קורא כל שורה שמתחילה ב-"data: " ומפרש אותה כ-event
function setupSSE(res) {
  res.setHeader("Content-Type", "text/event-stream"); // מסמן לדפדפן: זה SSE
  res.setHeader("Cache-Control", "no-cache"); // לא לשמור ב-cache
  res.setHeader("Connection", "keep-alive"); // שומר את החיבור פתוח
  res.flushHeaders(); // שולח את ה-headers מיד (לפני כל נתון)

  // מחזיר פונקציה שכל קריאה אליה כותבת שורה בפורמט SSE
  // "data: {...}\n\n" — הפורמט הסטנדרטי של SSE
  return (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ─── Chat API: Streaming + Multi-step Tool Calling ────────────────────────────
// זהו ה-endpoint המרכזי של המערכת — כאן קורה הכל:
// 1. קבלת הודעה מהמשתמש
// 2. חיבור לכלי MCP
// 3. שליחה ל-GPT-4o עם רשימת הכלים
// 4. לולאת tool calling (GPT מבקש כלי → מריצים → חוזרים ל-GPT)
// 5. streaming של התשובה לדפדפן token by token
app.post("/api/chat", async (req, res) => {
  // X-User-ID נשלח מהדפדפן (נוצר ב-localStorage) — מזהה את המשתמש
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  // בדיקת rate limit לפני כל עיבוד
  if (!checkRateLimit(userId))
    return res.status(429).json({ error: "יותר מדי בקשות, המתן דקה" });

  const { chatId, message } = req.body;
  if (!chatId || !message)
    return res.status(400).json({ error: "Missing data" });

  // AbortController — מנגנון ביטול.
  // כשהמשתמש סוגר את הדפדפן/tab, ה-connection נסגר ו-"close" event נזרק.
  // אנחנו מאזינים לזה ומבטלים את הבקשה ל-OpenAI — חוסך tokens ומשאבים
  const abortController = new AbortController();
  req.on("close", () => abortController.abort());

  // פותח SSE stream — מעכשיו כל send() שולח נתון לדפדפן
  const send = setupSSE(res);

  try {
    // שולף/יוצר היסטוריה ומוסיף את ההודעה החדשה
    let history = getOrCreateChat(chatId);
    history.push({ role: "user", content: message });
    // חותך היסטוריה ישנה אם צריך
    chats.set(chatId, trimHistory(history));
    history = chats.get(chatId);

    // ─── חיבור לכלי MCP ────────────────────────────────────────────────────
    const mcpConfigs = listMcps(userId); // רשימת שרתי MCP שהמשתמש הוסיף
    const allTools = []; // כלים בפורמט שOpenAI מבין
    const clientMap = new Map(); // שם כלי → mcpClient (לדעת לאן לשלוח קריאה)

    // מתחברים לכל השרתים במקביל — Promise.all מהיר יותר מ-await בלולאה
    const connections = await Promise.all(
      mcpConfigs.map((c) => getOrConnectMcp(userId, c)),
    );

    // בונים רשימת כלים מאוחדת מכל החיבורים
    for (const conn of connections) {
      if (conn?.tools) {
        for (const tool of conn.tools) {
          // OpenAI מצפה לפורמט ספציפי: { type: "function", function: { name, description, parameters } }
          allTools.push({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description || `Get info about ${tool.name}`,
              parameters: tool.inputSchema || {
                type: "object",
                properties: {},
              },
            },
          });
          // שומרים מיפוי: שם כלי → client שיודע להפעיל אותו
          clientMap.set(tool.name, conn.client);
        }
      }
    }

    const usedToolsLog = []; // יישלח ללקוח בסיום — לתצוגת "כלים שהופעלו"
    let iteration = 0;

    // ─── לולאת Tool Calling ────────────────────────────────────────────────
    // GPT-4o מסוגל לבקש כמה כלים ברצף לפני שהוא נותן תשובה סופית.
    // לכל סיבוב: שולחים ל-GPT → הוא מחזיר תשובה או בקשת כלי
    // אם בקשת כלי: מריצים → מוסיפים תוצאה להיסטוריה → סיבוב הבא
    // אם תשובה רגילה: יוצאים מהלולאה
    while (iteration < MAX_TOOL_LOOPS) {
      iteration++;

      // שליחה ל-OpenAI עם stream: true — מקבלים tokens אחד אחד
      const stream = await openai.chat.completions.create({
        model: MODEL_NAME,
        messages: history,
        tools: allTools.length > 0 ? allTools : undefined, // כלים זמינים
        tool_choice: allTools.length > 0 ? "auto" : undefined, // GPT מחליט מתי להשתמש
        stream: true,
      });

      let chunkText = ""; // טקסט שמצטבר מה-stream
      const pendingToolCalls = []; // tool calls שמגיעים בחלקים ומורכבים כאן

      // קריאת ה-stream: כל chunk הוא חלק קטן מהתשובה
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;

        // תוכן טקסטואלי — שולחים מיד לדפדפן (streaming effect)
        if (delta?.content) {
          chunkText += delta.content;
          send({ type: "chunk", text: delta.content }); // → הדפדפן מציג מיד
        }

        // Tool calls מגיעים מחולקים לחלקים קטנים (כמו הטקסט).
        // למשל: chunk 1: { index:0, id:"call_abc", function: { name: "get_" } }
        //        chunk 2: { index:0, function: { name: "weather", arguments: '{"' } }
        //        chunk 3: { index:0, function: { arguments: 'city": "Tel Aviv"}' } }
        // צריך לצבור את כולם לפני שאפשר להפעיל את הכלי
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            // יצירת placeholder אם זהו ה-chunk הראשון של tool call זה
            if (!pendingToolCalls[tc.index]) {
              pendingToolCalls[tc.index] = {
                id: tc.id || "",
                type: "function",
                function: { name: "", arguments: "" },
              };
            }
            const p = pendingToolCalls[tc.index];
            // צוברים: כל chunk מוסיף עוד קצת לשם ולארגומנטים
            if (tc.id) p.id = tc.id;
            if (tc.function?.name) p.function.name += tc.function.name;
            if (tc.function?.arguments)
              p.function.arguments += tc.function.arguments;
          }
        }
      }

      // מסנן undefined (מיקומים ריקים במערך)
      const activeTools = pendingToolCalls.filter(Boolean);

      // אין tool calls → GPT סיים לענות → יוצאים מהלולאה
      if (activeTools.length === 0) {
        history.push({ role: "assistant", content: chunkText });
        break;
      }

      // GPT ביקש להפעיל כלים — מוסיפים את ה"בקשה" להיסטוריה
      // (OpenAI דורש שהבקשה תופיע בהיסטוריה לפני התוצאה)
      history.push({
        role: "assistant",
        content: chunkText || null,
        tool_calls: activeTools,
      });

      // מפעילים כל כלי שנבקש
      for (const toolCall of activeTools) {
        // ה-arguments מגיעים כ-JSON string — מפרסים
        let args = {};
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {} // אם הפרסינג נכשל, args נשאר {}

        const requestedName = toolCall.function.name;
        usedToolsLog.push({ name: requestedName, args }); // לתצוגה בסוף

        // מחפשים את ה-client שמטפל בכלי הזה
        let mcpClient = clientMap.get(requestedName);
        let realToolName = requestedName;

        // Fuzzy match: אם GPT שלח "get_weather" אבל הכלי נקרא "get-weather"
        // הפונקציה normalizeName מסירה _ ו- ומשווה
        if (!mcpClient) {
          const normalizedReq = normalizeName(requestedName);
          for (const [key, c] of clientMap.entries()) {
            if (normalizeName(key) === normalizedReq) {
              mcpClient = c;
              realToolName = key; // השם האמיתי שהשרת מכיר
              break;
            }
          }
        }

        // שולחים ללקוח event "tool" — ה-UI יציג badge מונפש
        send({ type: "tool", name: requestedName, args });

        // ─── הפעלת הכלי ב-MCP ──────────────────────────────────────────
        let content = "";
        if (!mcpClient) {
          // כלי לא נמצא — מדווחים ל-GPT כדי שיוכל לטפל בזה
          content = `Error: Tool '${requestedName}' not found.`;
        } else {
          try {
            // callTool — שולח בקשה לשרת MCP ומחכה לתוצאה
            const result = await mcpClient.callTool({
              name: realToolName,
              arguments: args,
            });
            // התוצאה יכולה להיות מערך content עם text, או JSON
            content = result.content
              ? result.content.map((c) => c.text).join("\n")
              : JSON.stringify(result);
          } catch (e) {
            content = `Tool Error: ${e.message}`;
          }
        }

        // מוסיפים את תוצאת הכלי להיסטוריה — GPT יראה אותה בסיבוב הבא
        // tool_call_id חייב להתאים ל-id שGPT שלח (OpenAI מאמת זאת)
        history.push({ role: "tool", tool_call_id: toolCall.id, content });
      }
      // ← חוזרים לתחילת הלולאה עם ההיסטוריה המעודכנת
    }

    // שומרים את ההיסטוריה המלאה
    chats.set(chatId, history);
    // שולחים "done" עם רשימת הכלים שהופעלו — ה-UI ינקה badges ויציג סיכום
    send({ type: "done", usedTools: usedToolsLog });
    res.end();
  } catch (err) {
    // AbortError קורה כשהמשתמש סגר את הדפדפן — לא שגיאה, סיום נקי
    if (err.name === "AbortError") {
      console.log(`[Chatbot] Request aborted by user (${userId})`);
      return res.end();
    }
    console.error("Server Error:", err);
    send({ type: "error", message: err.message });
    res.end();
  }
});

// ─── MCP CRUD Endpoints ───────────────────────────────────────────────────────

// GET /api/mcps — מחזיר את רשימת שרתי ה-MCP של המשתמש
app.get("/api/mcps", (req, res) => {
  const userId = req.headers["x-user-id"];
  res.json({ servers: listMcps(userId) });
});

// POST /api/mcps/http — מוסיף שרת MCP חדש (סוג HTTP/SSE)
app.post("/api/mcps/http", (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json({ ok: true, added: addHttpMcp(userId, req.body) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/mcps/:id — מסיר שרת MCP וסוגר את החיבור הפתוח אם יש
app.delete("/api/mcps/:id", (req, res) => {
  const userId = req.headers["x-user-id"];
  // סגירת transport פתוח לפני המחיקה — מניעת connection leaks
  const entry = getUserCache(userId).get(req.params.id);
  if (entry?.transport) entry.transport.close().catch(() => {});
  getUserCache(userId).delete(req.params.id);
  removeMcp(userId, req.params.id);
  res.json({ ok: true });
});

// ─── MCP Ping ─────────────────────────────────────────────────────────────────
// GET /api/mcps/:id/ping — מאלץ reconnect לשרת MCP ומדווח על הצלחה/כישלון.
// חשוב ל-Render Free: שרתים ישנים אחרי חוסר פעילות ולוקח להם זמן להתעורר.
// הכפתור "🔄" ב-UI קורא לendpoint זה — "מחמם" את השרת לפני שיחה
app.get("/api/mcps/:id/ping", async (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const mcpId = req.params.id;
  const configs = listMcps(userId);
  const config = configs.find((m) => m.id === mcpId);
  if (!config) return res.status(404).json({ error: "MCP not found" });

  // מוחקים cache ישן כדי לאלץ חיבור חדש (גם אם הcache לא פג עדיין)
  const oldEntry = getUserCache(userId).get(mcpId);
  if (oldEntry?.transport) oldEntry.transport.close().catch(() => {});
  getUserCache(userId).delete(mcpId);

  // מנסה להתחבר (עד 60 שניות)
  const conn = await getOrConnectMcp(userId, config);

  if (conn) {
    // הצלחה — מחזיר מספר כלים שנטענו
    res.json({ status: "ready", toolCount: conn.tools.length });
  } else {
    res.json({ status: "error" });
  }
});

// ─── Other Endpoints ──────────────────────────────────────────────────────────

// מחיקת היסטוריית שיחה מהשרת (ה-UI מחזיק גיבוי ב-localStorage)
app.delete("/api/chat/:chatId", (req, res) => {
  chats.delete(req.params.chatId);
  res.json({ ok: true });
});

// Health check — Render קורא לזה לבדיקה שהשרת חי
app.get("/healthz", (_req, res) => res.send("OK"));

// ─── הפעלת השרת ──────────────────────────────────────────────────────────────
// PORT מגיע מ-Render (environment variable). מקומית ישתמש ב-3000
const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () =>
  console.log(`Chatbot listening on port ${port}`),
);
