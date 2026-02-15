/**
 * server.js
 * ----------
 * שרת Express שמריץ:
 * 1) Frontend סטטי מתוך /public
 * 2) API לצ'אט מול OpenAI עם זיכרון לפי chatId
 * 3) API לניהול MCPs דרך registry (mcp/manager.js)
 *
 * חשוב:
 * - כדי שה-LLM "יזכור" שיחה — אנחנו שולחים לו בכל בקשה את history של אותו chatId.
 * - את OPENAI_API_KEY חייבים להגדיר ב-Render (Environment Variables) ובמחשב המקומי (.env או setx).
 */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

import { listMcps, addHttpMcp, addLocalMcp, removeMcp } from "./mcp/manager.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// מגיש את האתר (index.html, app.js, style.css)
app.use(express.static(path.join(__dirname, "public")));

// Render health check
app.get("/healthz", (req, res) => res.status(200).send("ok"));

// OpenAI client
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===============================
// זיכרון שיחות בשרת (RAM)
// ===============================
/**
 * chats Map:
 * chatId => messages[]
 * messages בפורמט של OpenAI Chat Completions:
 *  { role: "system"|"user"|"assistant", content: "..." }
 *
 * הערה: ב-Render free יכול להיות restart ואז הזיכרון בשרת יימחק.
 * עדיין יש זיכרון בלקוח (LocalStorage), אבל השרת יתחיל מחדש אם יופעל מחדש.
 * אם רוצים persistent אמיתי: DB / Redis.
 */
const chats = new Map();

const SYSTEM_PROMPT =
  "אתה עוזר שימושי, חד וברור. ענה בעברית. התבסס על ההיסטוריה של הצ'אט הנוכחי.";

// כמה "פניות" לשמור כדי לא להתנפח (20 = בערך 40 הודעות user+assistant)
const MAX_TURNS = 20;

function getOrCreateChat(chatId) {
  if (!chats.has(chatId)) {
    chats.set(chatId, [{ role: "system", content: SYSTEM_PROMPT }]);
  }
  return chats.get(chatId);
}

function trimHistory(messages) {
  // משאירים system ראשון, ומקצצים את היתר
  const system = messages[0]?.role === "system" ? [messages[0]] : [];
  const rest = messages.filter((m) => m.role !== "system");
  const maxMsgs = MAX_TURNS * 2;
  return [...system, ...rest.slice(-maxMsgs)];
}

// מוחק צ'אט מהזיכרון של השרת
app.delete("/api/chat/:chatId", (req, res) => {
  const { chatId } = req.params;
  chats.delete(chatId);
  res.json({ ok: true });
});

// ===============================
// API: Chat
// ===============================
/**
 * POST /api/chat
 * body: { chatId, message }
 * response: { reply }
 */
app.post("/api/chat", async (req, res) => {
  try {
    const { chatId, message } = req.body || {};

    if (!chatId || typeof chatId !== "string") {
      return res.status(400).json({ error: "chatId is required" });
    }
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message is required" });
    }

    // 1) מביאים history לצ'אט הזה
    const history = getOrCreateChat(chatId);

    // 2) מוסיפים הודעת משתמש
    history.push({ role: "user", content: message });
    chats.set(chatId, trimHistory(history));

    // 3) שולחים ל-OpenAI את כל ההיסטוריה של אותו chatId
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: chats.get(chatId),
      temperature: 0.6,
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() || "";

    // 4) שומרים תשובת מודל בהיסטוריה
    const updated = chats.get(chatId);
    updated.push({ role: "assistant", content: reply });
    chats.set(chatId, trimHistory(updated));

    res.json({ reply });
  } catch (err) {
    console.error("chat error:", err?.message || err);
    res.status(500).json({ error: "Server error" });
  }
});

// ===============================
// API: MCP Registry
// ===============================
/**
 * GET /api/mcps
 * מחזיר רשימת MCPs שנוספו
 */
app.get("/api/mcps", (req, res) => {
  res.json({ servers: listMcps() });
});

/**
 * POST /api/mcps/http
 * body: { id, label, url }
 * מוסיף MCP Render URL
 */
app.post("/api/mcps/http", (req, res) => {
  try {
    const { id, label, url } = req.body || {};
    const added = addHttpMcp({ id, label, url });
    res.json({ ok: true, added });
  } catch (e) {
    res.status(400).json({ error: e.message || "Failed to add MCP" });
  }
});

/**
 * POST /api/mcps/local
 * body: { id, label, command, args }
 * מוסיף MCP מקומי (stdio) כרשומה
 * הערה: ב-Render זה לא יכול לרוץ באמת, אבל נשמר כדי שתראה אותו ברשימה.
 */
app.post("/api/mcps/local", (req, res) => {
  try {
    const { id, label, command, args } = req.body || {};
    const added = addLocalMcp({ id, label, command, args });
    res.json({ ok: true, added });
  } catch (e) {
    res.status(400).json({ error: e.message || "Failed to add local MCP" });
  }
});

/**
 * DELETE /api/mcps/:id
 * מוחק MCP מהרשימה
 */
app.delete("/api/mcps/:id", (req, res) => {
  try {
    removeMcp(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message || "Failed to remove MCP" });
  }
});

// ===============================
// Start
// ===============================
const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => console.log("Chatbot listening on", port));
