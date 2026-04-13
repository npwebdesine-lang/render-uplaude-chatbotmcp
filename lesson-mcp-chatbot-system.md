# שיעור מלא: ארכיטקטורה, עקרונות, ובניית MCP Chatbot

> **מה תלמד בשיעור הזה:**
> ארכיטקטורת המערכת, איך כל רכיב עובד ולמה, מטאפורות שיעזרו לך להבין, קוד אמיתי מהפרויקט, מדריך לבניית המערכת מאפס, ומדריך לכתיבת שרתי MCP שמתחברים למערכת.

---

## חלק א׳ — מה המערכת הזו עושה בשורה אחת

> **צ׳אטבוט שרץ בענן, שמסוגל להתחבר בזמן אמת לכלים חיצוניים כלשהם, לקרוא להם אוטומטית, ולהחזיר תוצאות — הכל ב-streaming, כלומר המשתמש רואה את הטקסט מתגבש בזמן אמת.**

כלים חיצוניים = **MCP Servers**: כל תוכנה שאתה כותב, שמחשפת פונקציות (tools) דרך פרוטוקול סטנדרטי.

---

## חלק ב׳ — ארכיטקטורה: מפת המערכת

```
┌─────────────────────────────────────────────────────────────────┐
│                        BROWSER (לקוח)                          │
│                                                                 │
│   app.js: שולח הודעות, קורא SSE stream, מציג Markdown          │
│   index.html: UI — sidebar + chat + modal להוספת MCP           │
│   localStorage: שומר chat history + User ID                    │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTP POST /api/chat + X-User-ID header
                         │ ← SSE stream בחזרה (chunk / tool / done)
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│              EXPRESS SERVER — server.js (על Render)             │
│                                                                 │
│  ┌──────────────┐   ┌───────────────┐   ┌──────────────────┐    │
│  │ Rate Limiter │   │ Chat History  │   │   MCP Cache      │    │
│  │ 20 req/min   │   │ in-memory Map │   │ 10 min TTL/user  │    │
│  └──────────────┘   └───────────────┘   └──────────────────┘    │
│                                                                 │
│             לולאת Tool Calling (עד 5 סיבובים)                  │
└──────────┬──────────────────────────────────┬───────────────────┘
           │ HTTPS API                        │ SSE Client (HTTP)
           ▼                                  ▼
┌──────────────────┐             ┌─────────────────────────────┐
│   OpenAI GPT-4o  │             │      MCP Servers (HTTP/SSE)  │
│                  │             │                             │
│  streaming +     │             │  כל כלי שתבנה — database,  │
│  tool calling    │             │  APIs, קבצים, חישובים...   │
└──────────────────┘             └──────┬──────────────────────┘
                                        │ (אופציונלי: כלים מקומיים)
                                        ▼
                         ┌──────────────────────────────┐
                         │  bridge.js (מחשב מקומי)      │
                         │                              │
                         │  STDIO MCP → HTTP/SSE        │
                         │  נגיש דרך: npx ngrok http    │
                         └──────────────────────────────┘
```

### שלושת השכבות

| שכבה         | קובץ                                       | תפקיד                               |
| ------------ | ------------------------------------------ | ----------------------------------- |
| **Frontend** | `public/app.js`, `index.html`, `style.css` | UI, state, SSE consumer             |
| **Backend**  | `server.js`, `mcp/manager.js`              | orchestration, tool loop, MCP cache |
| **Bridge**   | `bridge.js`                                | חיבור כלים מקומיים לענן             |

---

## חלק ג׳ — מטאפורות להבנת המערכת

### מטאפורה 1: "המוח עם הידיים"

דמיין שאתה שוכר עובד מבריק — הוא יודע הכל, אבל מעולם לא יצא מהמשרד. הוא לא יכול להדפיס מסמך, לא יכול לגשת לאתר אינטרנט, לא יכול לשלוח מייל. הוא רק יכול **לחשוב**.

זה GPT-4o.

שרתי MCP הם ה**ידיים** — הם מאפשרים לו לפעול בעולם האמיתי:

- "תשלוף נתון ממסד נתונים" → MCP שמחבר ל-DB
- "תחשב משהו מורכב" → MCP שמריץ קוד Python
- "תכתוב לקובץ" → MCP שמנהל Filesystem

הצ׳אטבוט שלנו הוא **ה-glue** שמחבר את המוח לידיים.

---

### מטאפורה 2: "המלצר, השף, והמחסן"

**שאלת משתמש** = לקוח שמזמין מנה.

**GPT-4o** = המלצר: הוא מבין מה הלקוח רוצה, ומחליט אם הוא יכול לענות לבד — או שהוא צריך לשלוח הזמנה למטבח.

**MCP Server** = המטבח: יודע לבצע פעולות אמיתיות — בישול, הכנה, הוצאה מהמקרר.

**ה-Tool Loop** = סבב הגשה: המלצר הולך למטבח → חוזר עם צלחת → שם על השולחן. לפעמים צריך לחזור כמה פעמים (עד 5).

**ה-Cache** = המלצר כבר מכיר את המטבח — לא צריך לשאול היכן הם כל פעם מחדש. מספיק לחדש את ההיכרות כל 10 דקות.

---

### מטאפורה 3: "SSE כמו רדיו חי"

כאשר GPT-4o מייצר תשובה, הוא לא מחכה עד שהכל מוכן ואז שולח הכל.

זה כמו **שידור רדיו חי** — הדובר מדבר, ואתה שומע בזמן אמת. הוא לא מקליט כל השיעור ואז שולח.

בטכנולוגיה זה נקרא **Server-Sent Events (SSE)** — connection פתוח שהשרת כותב אליו chunks.

```javascript
// server.js:145-151 — פונקציית SSE
function setupSSE(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  // כל קריאה ל-send() שולחת שורה נוספת ללקוח
  return (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
}
```

---

### מטאפורה 4: "הלולאה כמו שיחת טלפון מרובת שלבים"

דמיין שאתה מתקשר לשירות לקוחות.

1. אתה שואל → הנציג בודק במחשב (tool call 1) → חוזר אליך
2. הנציג מגלה שצריך עוד מידע → בודק שוב (tool call 2) → חוזר
3. עכשיו יש לו הכל → נותן תשובה מלאה

זו **לולאת Tool Calling** — GPT-4o מסוגל לבצע עד 5 סיבובים של שאלה-בדיקה-תשובה לפני שהוא מסכם ומשיב למשתמש.

```javascript
// server.js:207-311 — הלולאה עצמה
while (iteration < MAX_TOOL_LOOPS) {
  iteration++;

  // סיבוב 1: שואלים את GPT-4o עם הכלים הזמינים
  const stream = await openai.chat.completions.create({
    model: MODEL_NAME,
    messages: history,
    tools: allTools,
    tool_choice: "auto",
    stream: true,
  });

  // ...קוראים את ה-stream...

  if (activeTools.length === 0) {
    // GPT-4o לא ביקש כלים — סיימנו!
    history.push({ role: "assistant", content: chunkText });
    break;
  }

  // GPT-4o ביקש כלים — מבצעים ומוסיפים לhistory → סיבוב הבא
  for (const toolCall of activeTools) {
    const result = await mcpClient.callTool({
      name: realToolName,
      arguments: args,
    });
    history.push({ role: "tool", tool_call_id: toolCall.id, content: result });
  }
}
```

---

## חלק ד׳ — Data Flow: מה קורה כשמשתמש שולח הודעה

### שלב 1: הלקוח שולח

```javascript
// public/app.js — שליחת הודעה
const response = await fetch("/api/chat", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-User-ID": getUserId(), // נשמר ב-localStorage
  },
  body: JSON.stringify({ chatId, message: msg }),
});
```

### שלב 2: השרת מקבל — בדיקות ראשוניות

```javascript
// server.js:154-166
app.post("/api/chat", async (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  if (!checkRateLimit(userId))
    return res.status(429).json({ error: "יותר מדי בקשות, המתן דקה" });

  const abortController = new AbortController();
  req.on("close", () => abortController.abort()); // אם המשתמש סוגר tab — מבטלים

  const send = setupSSE(res); // פותחים SSE stream
```

### שלב 3: חיבור לכלים (MCP)

```javascript
// server.js:177-202
const mcpConfigs = listMcps(userId); // שרתים שהמשתמש הוסיף
const allTools = [];
const clientMap = new Map(); // tool name → mcpClient

// מחברים לכל השרתים במקביל (Promise.all)
const connections = await Promise.all(
  mcpConfigs.map((c) => getOrConnectMcp(userId, c)),
);

// בונים את רשימת הכלים בפורמט שOpenAI מבין
for (const conn of connections) {
  if (conn?.tools) {
    for (const tool of conn.tools) {
      allTools.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      });
      clientMap.set(tool.name, conn.client); // זוכרים איזה MCP מטפל בכל tool
    }
  }
}
```

### שלב 4: streaming + tool calling בלולאה

```javascript
// בתוך הלולאה — קריאה ל-OpenAI עם stream
const stream = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: history,
  tools: allTools,
  tool_choice: "auto",
  stream: true,
});

for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta;

  if (delta?.content) {
    send({ type: "chunk", text: delta.content }); // → client רואה טקסט
  }

  // tool calls מגיעים ב-chunks ומורכבים
  if (delta?.tool_calls) {
    // ...צבירת חלקים לאובייקט שלם...
  }
}
```

### שלב 5: הקלייאנט מקבל ומציג

```javascript
// public/app.js — קריאת SSE stream
const reader = response.body.getReader();
let buffer = "";

while (true) {
  const { value, done } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop();

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = JSON.parse(line.slice(6));

    if (data.type === "chunk") {
      fullText += data.text;
      contentDiv.innerHTML = marked.parse(fullText); // Markdown rendering
    } else if (data.type === "tool") {
      // הצג badge מונפש: "⚙️ מפעיל: tool_name"
    } else if (data.type === "done") {
      // סיים — הסר badges, שמור ב-localStorage
    }
  }
}
```

---

## חלק ה׳ — למה המערכת עובדת ככה? החלטות ארכיטקטורליות

### למה SSE ולא WebSockets?

**WebSockets** הם bidirectional — שני הכיוונים פתוחים תמיד.
**SSE** הם unidirectional — השרת כותב, הלקוח קורא.

לצ׳אטבוט שלנו SSE מספיק: המשתמש שולח POST רגיל, ומקבל בחזרה stream. זה:

- פשוט יותר לממש
- עובד דרך HTTP רגיל (Render תומך בו)
- לא דורש תשתית WebSocket מיוחדת

### למה cache של 10 דקות לחיבורי MCP?

כל חיבור SSE ל-MCP Server הוא connection אמיתי ברשת — פתיחתו לוקחת זמן (handshake, TLS, negotiation).

אם היינו מתחברים מחדש עם כל הודעה:

- כל chat turn היה מתעכב 2-5 שניות
- MCP Server ספשר שיושב על Render Free מוגבל בחיבורים

הפתרון: **cache של 10 דקות** — מתחברים פעם אחת, וכל ה-requests של המשתמש תוך 10 דקות משתמשים באותו connection.

```javascript
// server.js:98-127 — Cache logic
async function getOrConnectMcp(userId, mcpConfig) {
  const cached = cache.get(mcpConfig.id);
  const now = Date.now();

  // יש cache תקף? תחזיר אותו
  if (
    cached &&
    cached.status === "ready" &&
    now - cached.connectedAt < MCP_CACHE_TTL_MS
  ) {
    return cached; // ← ← ← רוב הפעמים זה מה שקורה
  }

  // אין cache? מתחבר מחדש
  const conn = await connectToMcp(mcpConfig);
  cache.set(mcpConfig.id, { ...conn, status: "ready", connectedAt: now });
  return conn;
}
```

### למה localStorage ולא database?

המערכת נבנתה לצ׳אטבוט-as-a-demo: פשוטה לפרסום, אפס עלות תשתית.

localStorage = כל ה-chat history חי **בדפדפן של המשתמש**. יתרונות:

- לא צריך DB (חוסך כסף ומורכבות)
- private by design — המשתמש הוא הבעלים של הנתונים

חסרונות:

- אם מוחקים cookies/localStorage — היסטוריה נמחקת
- לא ניתן לגשת מדפדפן אחר

```javascript
// public/app.js — state management
const STORAGE_KEY = `mcp_chats_${getUserId()}`;

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) return JSON.parse(raw);
  // ... state ראשוני
}
```

### למה Node.js ESM (`"type": "module"`)?

ה-SDK של MCP (`@modelcontextprotocol/sdk`) משתמש ב-ES Modules. CommonJS לא יעבוד עם ה-imports שלו. לכן:

```json
// package.json
{
  "type": "module"
}
```

ובקוד:

```javascript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
```

### למה Fuzzy Matching לשמות כלים?

GPT-4o לפעמים מחזיר שם כלי עם קו תחתון במקום מקף (למשל `get_weather` במקום `get-weather`). הפתרון הפשוט:

```javascript
// server.js:51-53
function normalizeName(name) {
  return name.toLowerCase().replace(/[_\-]/g, "");
  // "get_weather" → "getweather"
  // "get-weather" → "getweather"
  // → match!
}
```

---

## חלק ו׳ — מדריך בניה מאפס

### שלב 1: package.json

```json
{
  "name": "my-mcp-chatbot",
  "version": "1.0.0",
  "type": "module",
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "engines": { "node": ">=20" },
  "dependencies": {
    "express": "^4.19.2",
    "openai": "^4.57.0",
    "@modelcontextprotocol/sdk": "^1.26.0",
    "eventsource": "^3.0.2",
    "cors": "^2.8.5"
  }
}
```

```bash
npm install
```

### שלב 2: שרת Express בסיסי עם SSE

```javascript
// server.js — גרסה מינימלית
import express from "express";
import OpenAI from "openai";
import { EventSource } from "eventsource";
global.EventSource = EventSource; // נדרש ל-MCP SDK בNode.js

const app = express();
app.use(express.json());
app.use(express.static("public")); // משרת את ה-frontend

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// פונקציית עזר — פותחת SSE stream
function setupSSE(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  return (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
}

app.listen(3000, () => console.log("Running on port 3000"));
```

### שלב 3: הוספת endpoint לצ׳אט עם streaming

```javascript
const chats = new Map(); // in-memory history

app.post("/api/chat", async (req, res) => {
  const { chatId, message } = req.body;
  const send = setupSSE(res);

  // שמור ב-history
  if (!chats.has(chatId)) chats.set(chatId, []);
  const history = chats.get(chatId);
  history.push({ role: "user", content: message });

  // קריאה ל-OpenAI עם streaming
  const stream = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: history,
    stream: true,
  });

  let fullText = "";
  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content;
    if (text) {
      fullText += text;
      send({ type: "chunk", text }); // שולח token בtoken לדפדפן
    }
  }

  history.push({ role: "assistant", content: fullText });
  send({ type: "done" });
  res.end();
});
```

### שלב 4: הוספת MCP

```javascript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function connectToMcp(url) {
  const transport = new SSEClientTransport(new URL(url));
  const client = new Client(
    { name: "chatbot", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  const { tools } = await client.listTools();
  return { client, tools };
}
```

### שלב 5: Frontend מינימלי

```html
<!-- public/index.html -->
<!DOCTYPE html>
<html>
  <body>
    <div id="chat"></div>
    <form id="form">
      <input id="input" type="text" />
      <button type="submit">שלח</button>
    </form>
    <script>
      const chatId = "chat_1";

      document.getElementById("form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const message = document.getElementById("input").value;
        document.getElementById("input").value = "";

        // הוסף bubble למשתמש
        const chat = document.getElementById("chat");
        chat.innerHTML += `<div><b>אתה:</b> ${message}</div>`;
        const botDiv = document.createElement("div");
        botDiv.innerHTML = "<b>בוט:</b> ";
        chat.appendChild(botDiv);

        // שלח ל-server וקרא SSE
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId, message }),
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = JSON.parse(line.slice(6));
            if (data.type === "chunk") botDiv.innerHTML += data.text;
          }
        }
      });
    </script>
  </body>
</html>
```

---

## חלק ז׳ — איך ליצור MCP שמתאים למערכת הזו

### מה זה MCP בעצם?

MCP = **Model Context Protocol** — פרוטוקול סטנדרטי שמאפשר ל-AI לדעת "אילו פונקציות קיימות" ולקרוא להן.

שרת MCP מגדיר:

1. **רשימת כלים** (tools) — כל כלי עם שם, תיאור, ו-schema של הפרמטרים
2. **לוגיקת ביצוע** — מה קורה כשקוראים לכלי

הצ׳אטבוט שלנו מתחבר ל-MCP **דרך HTTP/SSE** — כך שהשרת שלך חייב לחשוף שני endpoints:

- `GET /sse` — connection ראשוני, SSE stream
- `POST /messages` — קריאות לכלים בזמן session

### דרישות טכניות לMCP שיתאים למערכת

```
✅ שפה: כל שפה (Node.js, Python, Go...)
✅ Transport: HTTP + SSE (לא STDIO)
✅ Endpoint: GET /sse ו-POST /messages
✅ Package: @modelcontextprotocol/sdk (Node) או mcp (Python)
✅ כתובת: חייבת להיות נגישה מהאינטרנט (Render, Railway, ngrok...)
```

---

### דוגמה 1: MCP מינימלי — "שעון" (Node.js)

```javascript
// my-clock-mcp/server.js
import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const app = express();
app.use(cors());
app.use(express.json());

// 1. יצירת שרת MCP
const mcpServer = new Server(
  { name: "clock-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// 2. הגדרת הכלים
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_current_time",
      description: "מחזיר את השעה הנוכחית",
      inputSchema: {
        type: "object",
        properties: {
          timezone: {
            type: "string",
            description: "אזור זמן למשל Asia/Jerusalem",
          },
        },
        required: [],
      },
    },
  ],
}));

// 3. לוגיקת ביצוע הכלים
mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "get_current_time") {
    const timezone = req.params.arguments?.timezone || "Asia/Jerusalem";
    const now = new Date().toLocaleString("he-IL", { timeZone: timezone });
    return {
      content: [{ type: "text", text: `השעה הנוכחית ב-${timezone}: ${now}` }],
    };
  }
  throw new Error(`Tool '${req.params.name}' not found`);
});

// 4. SSE endpoints — הצ׳אטבוט יתחבר לכאן
const sessions = new Map();

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  sessions.set(transport.sessionId, transport);
  res.on("close", () => sessions.delete(transport.sessionId));
  await mcpServer.connect(transport);
});

app.post("/messages", async (req, res) => {
  const transport = sessions.get(req.query.sessionId);
  if (!transport) return res.status(404).json({ error: "Session not found" });
  await transport.handlePostMessage(req, res);
});

app.get("/healthz", (_req, res) => res.send("OK"));

app.listen(3001, () => console.log("Clock MCP running on port 3001"));
```

**package.json לדוגמה זו:**

```json
{
  "name": "clock-mcp",
  "type": "module",
  "dependencies": {
    "express": "^4.19.2",
    "cors": "^2.8.5",
    "@modelcontextprotocol/sdk": "^1.26.0"
  }
}
```

**לפרסום ב-Render:**

1. Push לGitHub
2. New Web Service → תבחר את הrepo
3. Start command: `node server.js`
4. קבל URL כמו: `https://clock-mcp.onrender.com`
5. הוסף בצ׳אטבוט: URL = `https://clock-mcp.onrender.com`

---

### דוגמה 2: MCP מתקדם — "חיפוש בWikipedia" (Node.js)

```javascript
// בתוך ListToolsRequestSchema handler
tools: [
  {
    name: "search_wikipedia",
    description: "מחפש מידע בWikipedia ומחזיר תקציר",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "מה לחפש" },
        language: { type: "string", description: "קוד שפה: he, en, fr..." },
      },
      required: ["query"],
    },
  },
];

// בתוך CallToolRequestSchema handler
if (req.params.name === "search_wikipedia") {
  const { query, language = "he" } = req.params.arguments;
  const url = `https://wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { "Accept-Language": language },
  });
  const data = await response.json();

  if (data.extract) {
    return { content: [{ type: "text", text: data.extract }] };
  } else {
    return { content: [{ type: "text", text: "לא נמצא מידע" }] };
  }
}
```

---

### דוגמה 3: MCP מקומי עם bridge.js

אם יש לך כלי שרץ מקומית (Python script, כלי CLI, וכו׳), אתה יכול להשתמש ב-`bridge.js` שכבר קיים בפרויקט:

```bash
# צעד 1: הרץ את bridge.js עם הכלי שלך
node bridge.js python my_tool.py

# צעד 2: חשוף דרך ngrok
npx ngrok http 3100

# צעד 3: קבל URL כמו: https://abc123.ngrok-free.app
# הוסף בצ׳אטבוט כ-HTTP MCP
```

**הכלי המקומי (my_tool.py) חייב להיות MCP תקני:**

```python
# my_tool.py — MCP STDIO server ב-Python
from mcp.server.stdio import stdio_server
from mcp.server import Server
from mcp.types import Tool, TextContent

server = Server("my-tool")

@server.list_tools()
async def list_tools():
    return [
        Tool(
            name="do_something",
            description="מבצע פעולה מקומית",
            inputSchema={"type": "object", "properties": {"input": {"type": "string"}}}
        )
    ]

@server.call_tool()
async def call_tool(name: str, arguments: dict):
    if name == "do_something":
        result = f"עיבדתי: {arguments.get('input', '')}"
        return [TextContent(type="text", text=result)]

async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())

import asyncio
asyncio.run(main())
```

```bash
pip install mcp
python my_tool.py  # ← bridge.js יקרא לזה
```

---

### איך הצ׳אטבוט מזהה את הכלים שלך

כשמוסיפים MCP לצ׳אטבוט, קורה הדבר הבא:

```javascript
// server.js:64-93 — connectToMcp
const transport = new SSEClientTransport(new URL(mcpConfig.url));
const mcpClient = new Client(
  { name: "chatbot", version: "1.0.0" },
  { capabilities: {} },
);
await mcpClient.connect(transport);

// שואל את שרת הMCP שלך: "אילו כלים יש לך?"
const { tools } = await mcpClient.listTools();
// tools = [{ name: "get_current_time", description: "...", inputSchema: {...} }]
```

לאחר מכן, כל הכלים עוברים ל-GPT-4o בתור `tools` ב-API call:

```javascript
// server.js:188-198 — בניית tool definitions
allTools.push({
  type: "function",
  function: {
    name: tool.name, // "get_current_time"
    description: tool.description, // "מחזיר את השעה הנוכחית"
    parameters: tool.inputSchema, // { type: "object", properties: {...} }
  },
});
```

GPT-4o מחליט בעצמו מתי לקרוא לאיזה כלי, על בסיס ה-**description** שסיפקת.

> **טיפ חשוב:** ה-description של הכלי שלך הוא המפתח. כתוב תיאור ברור ומדויק — GPT-4o מחליט על בסיסו אם ומתי לקרוא לכלי.

---

## חלק ח׳ — אבטחה ומגבלות שחשוב להכיר

### Rate Limiting

```javascript
// server.js:28-37 — 20 requests לדקה למשתמש
const rateLimitMap = new Map();
function checkRateLimit(userId) {
  const now = Date.now();
  const prev = (rateLimitMap.get(userId) || []).filter((t) => now - t < 60_000);
  if (prev.length >= 20) return false;
  prev.push(now);
  rateLimitMap.set(userId, prev);
  return true;
}
```

**מגבלה:** ה-rate limit נמחק כשהשרת מתאפס (Render Free מאפס שרתים כל כמה זמן).

### User ID — אבטחה חלקית בלבד

```javascript
// public/app.js
function getUserId() {
  let uid = localStorage.getItem("chatbot_multi_tenant_uid");
  if (!uid) {
    uid = "usr_" + Math.random().toString(36).substring(2, 15);
    localStorage.setItem("chatbot_multi_tenant_uid", uid);
  }
  return uid;
}
```

ה-User ID נוצר בדפדפן ונשלח כ-header. **כל אחד יכול לזייף אותו.** זה מספיק ל-demo, לא לproduction.

### MCP Config אינו Persistent

```javascript
// mcp/manager.js
const userMcps = new Map(); // ← in-memory בלבד!
```

אם השרת מתאפס, כל ה-MCP configs נמחקים. המשתמשים צריכים להוסיף שוב את שרתיהם.

---

## חלק ט׳ — הרחבות עתידיות

| תכונה                   | מה לשנות                                            |
| ----------------------- | --------------------------------------------------- |
| **DB לפרסיסטנציה**      | החלף `const chats = new Map()` ב-PostgreSQL/MongoDB |
| **Auth אמיתי**          | הוסף JWT/session cookies במקום localStorage User ID |
| **Rate limit מבוזר**    | השתמש ב-Redis במקום in-memory Map                   |
| **Claude במקום GPT-4o** | החלף את openai client ב-Anthropic SDK               |
| **MCP Configs ב-DB**    | שנה את `mcp/manager.js` לשמור ב-DB                  |
| **Multi-modal**         | הוסף תמיכה בתמונות ב-messages                       |

---

## סיכום — מה למדנו

```
מערכת MCP Chatbot = 4 חלקים שמשתפים פעולה:

1. FRONTEND (app.js)
   └── שולח הודעות, קורא SSE, מציג Markdown, שומר ב-localStorage

2. BACKEND (server.js)
   └── מנהל history, מתחבר ל-MCP, מריץ tool loop, streams ל-client

3. MCP MANAGER (mcp/manager.js)
   └── registry של שרתים לפי משתמש, normalizes URLs

4. MCP BRIDGE (bridge.js) — אופציונלי
   └── הופך כלים מקומיים (STDIO) לזמינים בענן

פרוטוקול התקשורת:
  Browser → POST /api/chat → SSE stream ← chunks + tools + done

מפתח ההבנה:
  GPT-4o יכול לחשוב אבל לא לפעול.
  MCP נותן לו ידיים.
  הצ׳אטבוט שלנו הוא ה-glue שמחבר ביניהם.
```

---

## חלק י׳ — לקחים מהדרך: בעיות אמיתיות שנתקלנו בהן

> **זה החלק הכי חשוב בשיעור.**
> ספרי לימוד מראים לך את הגרסה הסופית, הנקייה, המושלמת.
> הפרויקט האמיתי נראה אחרת — ניסיונות, כשלונות, החלטות שבוטלו.
> הקוד הבא לקוח ישירות מה-`git diff` — זה מה שבאמת השתנה.

---

### בעיה 1 — קוד ראשוני בעייתי ולא יעיל

**מה קרה:** הגרסה הראשונה הכילה logging כבד, ניהול cache שבור, וקוד UI מסובך מדי. הכל עבד — אבל בקושי.

**מה השתנה בקוד** — פישוט פונקציית הלוגינג:

```diff
- function log(msg, data) {
-   console.log(
-     `[Chatbot] ${msg}`,
-     data ? JSON.stringify(data).slice(0, 150) : "",
-   );
- }

+ function log(msg) {
+   console.log(`[Chatbot] ${msg}`);
+ }
```

פישוט חיבור ל-MCP (מ-`connectToMcpWithRetry` ל-`connectToMcp` ישיר):

```diff
- async function connectToMcpWithRetry(mcpConfig) {
-   for (let i = 0; i < 2; i++) { // 2 ניסיונות
-     try {
-       // ... הרבה קוד

+ async function connectToMcp(mcpConfig) {
+   if (mcpConfig.type !== "http") return null;
+   // ... קוד נקי
```

**הלקח:**
> אל תנסה לבנות הכל בבת אחת. בנה גרסה עובדת מינימלית, ואז נקה.
> קוד שעובד רע עדיין אפשר לתקן. קוד שלא עובד בכלל — לא.

---

### בעיה 2 — System Prompt חלש: ה-AI לא השתמש בכלים

**מה קרה:** ה-AI קיבל רשימת כלים מ-MCP אבל התעלם מהם וענה מהזיכרון שלו.

**מה השתנה בקוד** — ב-`server.js`, ה-System Prompt עבר כמה גרסאות:

**גרסה ראשונה** — אגרסיבי מדי, לא עבד:
```diff
- const SYSTEM_PROMPT = `
- You are a specialized assistant with access to external tools (MCP).
- CRITICAL RULE:
- If the user's request is even REMOTELY related to a tool you have, YOU MUST USE THE TOOL.
- - Do not answer from your own knowledge.
- - Do not say "I can't check".
- - Do not ask for clarification if you can try the tool first.
- - Always prioritize tool usage over your own knowledge.
- If you have tools available, you MUST use them for relevant questions.
- Answer the user in Hebrew.
- `;
```

**גרסה עם הנחיה ספציפית לכלי** — עבד רק לכלי ספציפי:
```diff
+ const SYSTEM_PROMPT = `
+ You are a helpful assistant.
+ You have access to a tool named 'get_weather'.
+ If the user asks about weather anywhere, YOU MUST CALL 'get_weather'.
+ Do not answer from your own knowledge.
+ Answer in Hebrew.
+ `;
```

**גרסה סופית** — פשוטה, עובדת עם כל כלי:
```diff
+ const SYSTEM_PROMPT = `
+ You are a helpful assistant.
+ Do not answer from your own knowledge.
+ If the tool works, tell the user the result.
+ Answer in Hebrew.
+ `;
```

גם שם המודל עבר תיקון — שגיאת כתיב ש"שברה" את כל השרת:
```diff
- const MODEL_NAME = "gpt 4o";   // ← רווח במקום מקף! OpenAI החזיר שגיאה
+ const MODEL_NAME = "gpt-4o";   // ← תוקן
```

**הלקח:**
> ה-System Prompt הוא ה-API האמיתי שלך עם ה-AI.
> "CRITICAL RULE" לא עוזר — הנחיה פשוטה וישירה עובדת יותר טוב.
> שגיאות כתיב בשם המודל גורמות לקריסה שקשה לאתר.

---

### בעיה 3 — חיבור ל-MCP נכשל: Timeout קצר מדי

**מה קרה:** שרתי Render Free ישנים כשלא פעילים ולוקח להם 15–30 שניות להתעורר. ה-timeout שלנו היה 10 שניות — כל חיבור ראשון נכשל.

**מה השתנה בקוד** — שלב א׳, ב-`server.js`:

```diff
  const connectPromise = mcpClient.connect(transport);
  const timeoutPromise = new Promise((_, reject) =>
-   setTimeout(() => reject(new Error("Timeout")), 10000),
+   // אנחנו נותנים לו 60 שניות להתחבר! (Render לוקח זמן להתעורר)
+   setTimeout(() => reject(new Error("Connection Timeout (60s)")), 60000),
  );
```

**שלב ב׳** — הוספת endpoint חדש לחימום ידני (`/api/mcps/:id/ping`):

```diff
+ // ─── MCP Ping — בדיקת מוכנות שרת (חשוב ל-Render Free) ─────────────
+ app.get("/api/mcps/:id/ping", async (req, res) => {
+   const userId = req.headers["x-user-id"];
+   const config = listMcps(userId).find((m) => m.id === req.params.id);
+
+   // מנקים cache ישן ומתחברים מחדש — "מעיר" את השרת
+   getUserCache(userId).delete(req.params.id);
+   const conn = await getOrConnectMcp(userId, config);
+
+   res.json(conn ? { status: "ready", toolCount: conn.tools.length }
+                 : { status: "error" });
+ });
```

**הלקח:**
> Render Free (ושירותי serverless חינמיים בכלל) ישנים אחרי חוסר פעילות.
> תן ל-UI כפתור "חמם שרת" — עדיף שהמשתמש יחכה בכוונה, מאשר יחשוב שהמערכת שבורה.

---

### בעיה 4 — עברית "ג'יבריש" בקבצים שנוצרו

**מה קרה:** קבצי CSV שנוצרו על ידי ה-AI הציגו ג'יבריש כשנפתחו ב-Excel.

**למה זה קרה:** Excel מצפה ל-BOM (Byte Order Mark) בתחילת קובץ UTF-8 כדי לזהות את ה-encoding.

**מה השתנה בקוד** — ב-`public/app.js`:

```diff
  // אריזת הטקסט לקובץ וירטואלי בזיכרון ה-RAM
- const blob = new Blob([fileContent], {
-   type: "text/plain;charset=utf-8",
- });

+ // הוספנו את התו הנסתר \uFEFF כדי שאקסל יקרא עברית בלי ג'יבריש
+ const blob = new Blob(["\ufeff", fileContent], {
+   type: "text/csv;charset=utf-8",
+ });
```

`"\ufeff"` הוא ה-BOM — תו בלתי נראה בתחילת הקובץ שאומר ל-Excel: "הקובץ הזה הוא UTF-8".

**הלקח:**
> Excel לא קורא UTF-8 בלי BOM. זו בעיה ישנה ומוכרת — הפתרון הוא תו אחד בודד בתחילת הקובץ.
> תמיד בדוק את הפלט האמיתי, לא רק שהקובץ "נוצר".

---

### בעיה 5 — כלים שמחזירים קבצים: אין מה לעשות איתם

**מה קרה:** ה-AI החזיר קוד CSV או HTML — אבל הוא הוצג כטקסט ארוך בצ'אט בלי אפשרות הורדה.

**מה השתנה בקוד** — שתי שינויים במקביל:

**שינוי 1** — הנחיה ל-AI ב-`server.js` (System Prompt):
```diff
  const SYSTEM_PROMPT = `
  You are a helpful assistant.
  Do not answer from your own knowledge.
  If the tool works, tell the user the result.
+ If the user asks you to generate a file (like CSV, HTML, Python, TXT),
+ DO NOT use external tools. Instead, output the exact content they requested
+ inside a Markdown code block, and clearly specify the language/extension
+ (for example: \`\`\`csv or \`\`\`html).
+ The chat interface will automatically convert this block into a downloadable file.
  Answer in Hebrew.
  `;
```

**שינוי 2** — זיהוי code blocks ויצירת כפתור הורדה ב-`public/app.js`:
```diff
  contentDiv.innerHTML = marked.parse(text);

+ // מנוע יצירת הקבצים — מחפש code blocks ומוסיף כפתור הורדה
+ const preBlocks = contentDiv.querySelectorAll("pre");
+ preBlocks.forEach((pre) => {
+   const codeBlock = pre.querySelector("code");
+   const langClass = Array.from(codeBlock.classList)
+     .find((c) => c.startsWith("language-"));
+   const extension = langClass?.replace("language-", "") || "txt";
+
+   const downloadBtn = document.createElement("button");
+   downloadBtn.innerHTML = `⬇️ לחץ להורדה כקובץ (.${extension})`;
+
+   downloadBtn.onclick = () => {
+     const blob = new Blob(["\ufeff", codeBlock.innerText],
+       { type: "text/csv;charset=utf-8" });
+     const a = document.createElement("a");
+     a.href = URL.createObjectURL(blob);
+     a.download = `AI_Generated_${Date.now()}.${extension}`;
+     a.click();
+   };
+   pre.after(btnDiv);
+ });
```

**הלקח:**
> ה-AI יכול לייצר תוכן — אבל ה-UI צריך להחליט מה לעשות איתו.
> System Prompt + קוד בצד לקוח = פתרון שלם ללא endpoint חדש.

---

### בעיה 6 — STDIO וTunnel: Feature שנבנה ונמחק

**מה קרה:** הוספנו תמיכה בשרתי STDIO מקומיים ו-tunnel דרך ngrok. 500+ שורות קוד. יצר בעיות stability.

**מה השתנה בקוד** — ב-`server.js` בעת המחיקה:

```diff
- import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
- import { listMcps, addHttpMcp, addStdioMcp, addLocalMcp,
-           setLocalMcpTunnel, removeMcp } from "./mcp/manager.js";
+ import { listMcps, addHttpMcp, removeMcp } from "./mcp/manager.js";
```

```diff
  async function connectToMcp(mcpConfig) {
-   let transport;
-   if (mcpConfig.type === "http") {
-     transport = new SSEClientTransport(new URL(mcpConfig.url));
-   } else if (mcpConfig.type === "stdio") {
-     transport = new StdioClientTransport({
-       command: mcpConfig.command,
-       args: mcpConfig.args || [],
-     });
-   } else if (mcpConfig.type === "local") {
-     if (!mcpConfig.tunnelUrl) return null;
-     transport = new SSEClientTransport(new URL(mcpConfig.tunnelUrl));
-   } else {
-     return null;
-   }

+   if (mcpConfig.type !== "http") return null;
+   log(`Connecting (HTTP) to ${mcpConfig.url}...`);
+   const transport = new SSEClientTransport(new URL(mcpConfig.url));
```

4 קבצים, 460 שורות — נמחקו בcommit אחד.

**הלקח:**
> **"Less is more"** הוא עיקרון אמיתי, לא רק סיסמה.
> בניית feature ומחיקתו לאחר מכן היא **לא כישלון** — זו למידה.
> קוד שנמחק הוא קוד שלא צריך לתחזק.

---

### בעיה 7 — המשתמש סוגר Tab: בקשה ל-OpenAI ממשיכה לרוץ

**מה קרה:** כשמשתמש סגר את הדפדפן באמצע תשובה, הבקשה ל-OpenAI המשיכה לרוץ בשרת — בזבוז tokens ומשאבים.

**מה השתנה בקוד** — ב-`server.js`, הוספת `AbortController`:

```diff
  app.post("/api/chat", async (req, res) => {
    // ...
+   // יצירת בקר ביטול — אם המשתמש סוגר את החלון, נעצור את הבקשה ל-OpenAI
+   const abortController = new AbortController();
+   req.on("close", () => abortController.abort());

    const stream = await openai.chat.completions.create({
      model: MODEL_NAME,
      messages: history,
      stream: true,
+     signal: abortController.signal,  // ← OpenAI יעצור כשהsignal מופעל
    });

    // ...

  } catch (err) {
+   if (err.name === "AbortError") {
+     console.log(`[Chatbot] Request aborted by user (${userId})`);
+     return res.end(); // סיום נקי — לא שגיאה
+   }
    send({ type: "error", message: err.message });
  }
```

**הלקח:**
> כל בקשת network לשירות חיצוני צריכה להיות ניתנת לביטול.
> `AbortController` + `signal` הוא pattern סטנדרטי ב-Node.js לזה.

---

### סיכום הלקחים — טבלת מהירה

| בעיה                       | הגורם                         | הפתרון                        | הלקח בשורה אחת                      |
| -------------------------- | ----------------------------- | ----------------------------- | ----------------------------------- |
| AI לא משתמש בכלים          | System Prompt לא ברור         | הנחיה פשוטה וישירה            | פשוט > אגרסיבי                     |
| שגיאת כתיב בשם מודל        | `"gpt 4o"` במקום `"gpt-4o"`  | תיקון מקף                     | שגיאות כתיב = קריסות מוזרות        |
| Timeout על חיבור MCP       | Cold start ב-Render Free      | 60 שניות + כפתור Ping         | שרתים חינמיים ישנים — תכנן על זה   |
| ג'יבריש בקבצי CSV          | Excel דורש BOM                | `"\ufeff"` לפני התוכן         | אל תסמוך על ברירות מחדל            |
| אין הורדת קבצים            | UI לא טיפל ב-code blocks      | Blob + System Prompt          | ה-AI מייצר, ה-UI מוריד             |
| Feature STDIO שנמחק        | מורכבות גדולה מהערך           | הסרה מוחלטת (460 שורות)       | קוד שנמחק לא צריך תחזוקה           |
| בקשה ממשיכה אחרי סגירת Tab | אין ביטול לבקשות OpenAI       | AbortController + signal      | כל בקשת network צריכה ביטול        |

---

> **המסקנה הכי חשובה מכל הפרויקט:**
>
> בניית מערכת מורכבת היא תהליך של ניסוי וטעייה.
> כל bug שתיקנת, כל feature שמחקת, כל שורת קוד שפישטת —
> זה **לא עבודה שהלכה לפח**. זו ההנדסה האמיתית.

---

_שיעור זה נכתב על בסיס קוד הפרויקט האמיתי. כל דוגמאות הקוד לקוחות ישירות מ-server.js, bridge.js, mcp/manager.js ו-public/app.js._
