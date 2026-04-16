/**
 * public/app.js
 * ─────────────────────────────────────────────────────────────────────────────
 * כל לוגיקת ה-UI רצה כאן בדפדפן.
 * אחראי על: שליחת הודעות, קריאת SSE stream, הצגת Markdown,
 *           ניהול multi-chat, ניהול שרתי MCP, ואנימציות GSAP
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── User Identity ────────────────────────────────────────────────────────────
// יוצר (או שולף) מזהה ייחודי למשתמש שנשמר ב-localStorage.
// כל פתיחת דפדפן חדש = אותו userId → אותם צ'אטים + אותם שרתי MCP
// שיעור: זה לא אבטחה אמיתית — כל אחד יכול לזייף את ה-ID.
//        מספיק ל-demo, לא ל-production
function getUserId() {
  let uid = localStorage.getItem("chatbot_multi_tenant_uid");
  if (!uid) {
    // יצירת UUID פשוט מ-Math.random — "usr_" + 13 תווים אקראיים
    uid = "usr_" + Math.random().toString(36).substring(2, 15);
    localStorage.setItem("chatbot_multi_tenant_uid", uid);
  }
  return uid;
}

// headers שנשלחים בכל בקשה לשרת
// Content-Type: אומר לשרת שה-body הוא JSON
// X-User-ID: מזהה את המשתמש (הגדרנו ב-server.js שבלעדיו בקשות נדחות)
const apiHeaders = {
  "Content-Type": "application/json",
  "X-User-ID": getUserId(),
};

// ─── DOM Elements ─────────────────────────────────────────────────────────────
// שולפים פעם אחת בטעינה — יותר יעיל מ-getElementById בכל פעם
const chatEl = document.getElementById("chat");
const form = document.getElementById("form");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const newChatBtn = document.getElementById("newChatBtn");
const deleteChatBtn = document.getElementById("deleteChatBtn");
const chatListEl = document.getElementById("chatList");
const currentChatTitle = document.getElementById("currentChatTitle");
const mcpList = document.getElementById("mcpList");
const openMcpModalBtn = document.getElementById("openMcpModalBtn");
const modalOverlay = document.getElementById("modalOverlay");
const closeModalBtn = document.getElementById("closeModalBtn");
const cancelBtn1 = document.getElementById("cancelBtn1");
const httpId = document.getElementById("httpId");
const httpLabel = document.getElementById("httpLabel");
const httpUrl = document.getElementById("httpUrl");
const addHttpBtn = document.getElementById("addHttpBtn");
const httpStatus = document.getElementById("httpStatus");
const mobileMenuBtn = document.getElementById("mobileMenuBtn");
const sidebar = document.getElementById("sidebar");
const closeSidebarBtn = document.getElementById("closeSidebarBtn");

// ─── GSAP Animations ──────────────────────────────────────────────────────────
// GSAP (GreenSock Animation Platform) — ספריית אנימציות מתקדמת.
// gsap.fromTo(el, from, to) — מגדיר נקודת התחלה ונקודת סיום של אנימציה
// gsap.to(el, props) — מאניה מהמצב הנוכחי לערכים המוגדרים
// כל האנימציות מרוכזות כאן כדי שיהיה קל לשנות/לכבות אותן
const anim = {
  // ─── הודעה חדשה בצ'אט — עולה מלמטה ונכנסת ───────────────────────────────
  // opacity: 0→1 (שקיפות), y: 20→0 (מיקום אנכי בפיקסלים)
  bubbleIn(el) {
    gsap.fromTo(
      el,
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.35, ease: "power2.out" },
    );
  },

  // ─── תג כלי פעיל — מתרחב ואז פועם בלופ ──────────────────────────────────
  // שלב 1: scale: 0.7→1 (כניסה מהירה עם "קפיצה")
  // שלב 2: onComplete — אחרי הכניסה, מתחיל לולאת פעימה (repeat: -1 = אינסוף)
  toolBadgeIn(el) {
    gsap.fromTo(
      el,
      { opacity: 0, scale: 0.7 },
      {
        opacity: 1,
        scale: 1,
        duration: 0.25,
        ease: "back.out(2)",
        onComplete() {
          // yoyo: true = הולך ובא — fade out ואז fade in שוב ושוב
          gsap.to(el, {
            opacity: 0.45,
            duration: 0.55,
            repeat: -1,
            yoyo: true,
            ease: "sine.inOut",
          });
        },
      },
    );
  },

  // ─── עצירת אנימציית פעימה ויציב ──────────────────────────────────────────
  // killTweensOf מעצור את כל האנימציות הפעילות על האלמנט
  toolBadgeStop(el) {
    gsap.killTweensOf(el);
    gsap.to(el, { opacity: 1, scale: 1, duration: 0.15 });
  },

  // ─── div "כלים שהופעלו" — מחליק פנימה מלמעלה ───────────────────────────
  toolsUsedIn(el) {
    gsap.fromTo(
      el,
      { opacity: 0, y: -8 },
      { opacity: 1, y: 0, duration: 0.3, ease: "power2.out" },
    );
  },

  // ─── פתיחת מודל — overlay מתעמעם + כרטיס מתרחב ─────────────────────────
  modalOpen(overlayEl, cardEl) {
    gsap.fromTo(
      overlayEl,
      { opacity: 0 },
      { opacity: 1, duration: 0.22, ease: "none" },
    );
    // scale: 0.9→1 + y: -22→0 = אפקט "נפילה מלמעלה"
    gsap.fromTo(
      cardEl,
      { opacity: 0, scale: 0.9, y: -22 },
      { opacity: 1, scale: 1, y: 0, duration: 0.32, ease: "back.out(1.5)" },
    );
  },

  // ─── סגירת מודל — הפוך מפתיחה, עם callback בסיום ────────────────────────
  // onComplete: רץ אחרי שהאנימציה מסתיימת — שם מסתירים את ה-overlay
  modalClose(overlayEl, cardEl, onDone) {
    gsap.to(cardEl, {
      opacity: 0,
      scale: 0.9,
      y: -10,
      duration: 0.18,
      ease: "power2.in",
    });
    gsap.to(overlayEl, {
      opacity: 0,
      duration: 0.22,
      ease: "none",
      onComplete: onDone, // קריאה לפונקציה שתסתיר את האלמנט
    });
  },

  // ─── פריט בסרגל הצ'אטים — נכנס מימין עם עיכוב לפי מיקום ────────────────
  // delay: index * 0.04 = כל פריט נכנס 40ms אחרי הקודם (stagger effect)
  listItemIn(el, index) {
    gsap.fromTo(
      el,
      { opacity: 0, x: 18 },
      {
        opacity: 1,
        x: 0,
        duration: 0.22,
        delay: index * 0.04,
        ease: "power2.out",
      },
    );
  },

  // ─── כרטיס MCP — נכנס עם stagger וקצת scale ────────────────────────────
  mcpCardIn(el, index) {
    gsap.fromTo(
      el,
      { opacity: 0, x: 16, scale: 0.97 },
      {
        opacity: 1,
        x: 0,
        scale: 1,
        duration: 0.26,
        delay: index * 0.06,
        ease: "power2.out",
      },
    );
  },

  // ─── נקודת סטטוס MCP — קפיצה אלסטית כשהסטטוס משתנה ─────────────────────
  // elastic.out = אנימציה קפיצית (מגיע לגודל, חורג קצת, חוזר)
  mcpDotFlash(dotEl) {
    gsap.fromTo(
      dotEl,
      { scale: 1.9, opacity: 0.6 },
      { scale: 1, opacity: 1, duration: 0.45, ease: "elastic.out(1, 0.4)" },
    );
  },

  // ─── כפתור שליחה — דחיסה קלה ושחרור ────────────────────────────────────
  sendPop(el) {
    gsap.fromTo(
      el,
      { scale: 0.88 },
      { scale: 1, duration: 0.35, ease: "elastic.out(1, 0.5)" },
    );
  },

  // ─── Sidebar מובייל — נכנס מימין ────────────────────────────────────────
  // xPercent: 100 = מחוץ למסך לגמרי מימין
  sidebarOpen(el) {
    el.classList.add("open");
    sidebarBackdrop.classList.add("visible");
    gsap.fromTo(
      el,
      { xPercent: 100 },
      { xPercent: 0, duration: 0.32, ease: "power3.out" },
    );
  },

  // ─── Sidebar מובייל — יוצא ימינה ────────────────────────────────────────
  sidebarClose(el) {
    sidebarBackdrop.classList.remove("visible");
    gsap.to(el, {
      xPercent: 100,
      duration: 0.26,
      ease: "power3.in",
      onComplete() {
        el.classList.remove("open");
        gsap.set(el, { clearProps: "transform" }); // ניקוי inline style
      },
    });
  },

  // ─── אנימציית טעינה ראשונית של הדף ──────────────────────────────────────
  // במובייל: רק ה-main נכנס (sidebar מוסתר)
  // בדסקטופ: שניהם נכנסים עם עיכוב קל בין ה-main לsidebar
  pageLoad() {
    const main = document.querySelector(".main-chat");
    if (window.innerWidth <= 768) {
      gsap.set(sidebar, { xPercent: 100 }); // מסתיר sidebar מחוץ למסך
      gsap.fromTo(
        main,
        { opacity: 0 },
        { opacity: 1, duration: 0.45, ease: "power1.out" },
      );
    } else {
      gsap.fromTo(
        sidebar,
        { opacity: 0, x: 24 },
        { opacity: 1, x: 0, duration: 0.45, ease: "power2.out" },
      );
      gsap.fromTo(
        main,
        { opacity: 0 },
        { opacity: 1, duration: 0.5, delay: 0.12, ease: "power1.out" },
      );
    }
  },
};

// ─── State Management ─────────────────────────────────────────────────────────
// כל ה-state (צ'אטים, הודעות) חי ב-localStorage של הדפדפן.
// יתרון: אין צורך ב-DB. חיסרון: נמחק אם המשתמש מנקה את הדפדפן
const STORAGE_KEY = `mcp_chats_${getUserId()}`; // מפתח ייחודי לכל משתמש
let state = loadState();

// מפה לסטטוס חיבור של כל שרת MCP: id → 'loading' | 'ready' | 'error' | 'unknown'
const mcpStatusMap = new Map();
let lastMcpServers = []; // שמירת הרשימה האחרונה לרינדור מחדש

// ─── Chat State ───────────────────────────────────────────────────────────────
// יוצר ID ייחודי לצ'אט חדש מבוסס timestamp
function makeId() {
  return `chat_${Date.now()}`;
}

// טוען את ה-state מ-localStorage, או יוצר state ראשוני אם אין
function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {}
  }
  // state ראשוני: צ'אט אחד ריק
  const first = makeId();
  const init = {
    activeChatId: first,
    chats: { [first]: { title: "צ'אט 1", messages: [] } },
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(init));
  return init;
}

// שומר את כל ה-state לdisk (localStorage) — נקרא אחרי כל שינוי
function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// מחזיר את אובייקט הצ'אט הפעיל כרגע
function getActiveChat() {
  return state.chats[state.activeChatId];
}

// ─── Utilities ────────────────────────────────────────────────────────────────
// מונע XSS: ממיר תווים מיוחדים ל-HTML entities כדי שלא יבוצעו כ-HTML
// חשוב לכל טקסט שמגיע מהמשתמש או מהשרת ומוצג ב-innerHTML
function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// ─── Download Buttons (Blob Magic) ───────────────────────────────────────────
// מיפוי מסיומת קובץ לסוג MIME — משמש ליצירת Blob עם הסוג הנכון
const MIME_TYPES = {
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  py: "text/x-python",
  js: "text/javascript",
  ts: "text/typescript",
  json: "application/json",
  xml: "application/xml",
  txt: "text/plain",
  md: "text/markdown",
  sql: "text/plain",
  sh: "text/x-sh",
  css: "text/css",
};

// מחפשת code blocks ב-Markdown שהAI יצר ומוסיפה כפתור הורדה לכל אחד.
// הקסם: Blob API + URL.createObjectURL = יצירת קובץ להורדה ב-RAM של הדפדפן
// ללא כל שרת או שמירה לדיסק
function addDownloadButtons(contentDiv) {
  contentDiv.querySelectorAll("pre").forEach((pre) => {
    const codeBlock = pre.querySelector("code");
    // אם אין קוד, או כבר יש כפתור הורדה — מדלגים
    if (!codeBlock || pre.querySelector(".download-btn-wrap")) return;

    // שולפים את סוג השפה מ-class כמו "language-csv" → "csv"
    let extension = "txt"; // ברירת מחדל אם אין שפה מוגדרת
    const langClass = Array.from(codeBlock.classList).find((c) =>
      c.startsWith("language-"),
    );
    if (langClass) extension = langClass.replace("language-", "");

    const mime = MIME_TYPES[extension] || "text/plain";
    // CSV בעברית צריך BOM (Byte Order Mark) כדי ש-Excel יקרא נכון
    // "\ufeff" הוא התו הנסתר הזה — שיעור: Excel לא קורא UTF-8 בלי BOM
    const needsBom = extension === "csv";

    const btnDiv = document.createElement("div");
    btnDiv.className = "download-btn-wrap";

    const downloadBtn = document.createElement("button");
    downloadBtn.className = "primary-btn download-btn";
    downloadBtn.textContent = `⬇ הורד קובץ (.${extension})`;

    downloadBtn.onclick = () => {
      anim.sendPop(downloadBtn); // ✨ אנימציית לחיצה
      const fileContent = codeBlock.innerText;

      // Blob = "קובץ וירטואלי" בזיכרון הדפדפן
      // needsBom: מוסיף "\ufeff" לפני התוכן לקבצי CSV בעברית
      const parts = needsBom ? ["\ufeff", fileContent] : [fileContent];
      const blob = new Blob(parts, { type: `${mime};charset=utf-8` });

      // createObjectURL יוצר URL זמני שמצביע ל-Blob בזיכרון (כמו "blob://...")
      const url = URL.createObjectURL(blob);

      // יצירת link אחד, לחיצה עליו, ומחיקתו — הדרך הסטנדרטית להורדה
      const a = document.createElement("a");
      a.href = url;
      a.download = `AI_Generated_${Date.now()}.${extension}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      // שחרור הזיכרון — ה-URL לא נחוץ יותר
      URL.revokeObjectURL(url);
    };

    btnDiv.appendChild(downloadBtn);
    pre.appendChild(btnDiv);
  });
}

// ─── Chat Bubbles ─────────────────────────────────────────────────────────────
// יוצרת bubble (בועת הודעה) ומוסיפה לצ'אט.
// who: "me" = הודעת משתמש (ימין), "bot" = תשובת AI (שמאל)
// הודעות bot מוצגות כ-Markdown (marked.parse) — טבלאות, קוד, כותרות ועוד
function addBubble(text, who = "me", toolsUsed = []) {
  const div = document.createElement("div");
  div.className = `bubble ${who}`;

  const contentDiv = document.createElement("div");
  if (who === "bot") {
    contentDiv.className = "markdown-content";
    // marked.parse ממיר Markdown ל-HTML: **bold** → <strong>, ```code``` → <pre> וכד׳
    contentDiv.innerHTML = marked.parse(text);
    // בודק אם יש code blocks ומוסיף כפתורי הורדה
    addDownloadButtons(contentDiv);
  } else {
    // הודעת משתמש — טקסט פשוט (לא Markdown) כדי למנוע XSS
    contentDiv.textContent = text;
    contentDiv.style.whiteSpace = "pre-wrap"; // שומר על ירידות שורה
  }
  div.appendChild(contentDiv);

  // תגיות "כלים שהופעלו" — מוצגות בתחתית ה-bubble אחרי שהתשובה מוכנה
  if (toolsUsed?.length > 0) {
    const toolsDiv = buildToolsDiv(toolsUsed);
    div.appendChild(toolsDiv);
  }

  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight; // גלילה אוטומטית לתחתית

  anim.bubbleIn(div); // ✨ אנימציית כניסה
  return div;
}

// בונה div עם תגיות של שמות הכלים שהופעלו
function buildToolsDiv(tools) {
  const toolsDiv = document.createElement("div");
  toolsDiv.className = "tools-used";
  toolsDiv.innerHTML = tools
    .map((t) => `<div class="tool-badge">⚙️ פעל: ${escapeHtml(t.name)}</div>`)
    .join("");
  return toolsDiv;
}

// ─── Streaming Bubble ─────────────────────────────────────────────────────────
// יוצרת bubble ריקה שתתמלא token by token מה-SSE stream.
// cursor = | מהבהב שמסמן שה-AI עוד כותב
function createStreamBubble() {
  const div = document.createElement("div");
  div.className = "bubble bot";

  const contentDiv = document.createElement("div");
  contentDiv.className = "markdown-content";

  const cursor = document.createElement("span");
  cursor.className = "typing-cursor"; // CSS מגדיר אנימציית הבהוב
  contentDiv.appendChild(cursor);

  div.appendChild(contentDiv);
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;

  anim.bubbleIn(div); // ✨ אנימציית כניסה
  return { div, contentDiv, cursor };
}

// ─── Render Throttling ────────────────────────────────────────────────────────
// בעיה: ה-stream שולח עשרות tokens בשנייה. אם נעדכן את ה-DOM בכל token —
// הדפדפן יתקשה לעמוד בקצב ויהיה ביצועים גרועים.
// פתרון: requestAnimationFrame (rAF) — הדפדפן מאחד עדכונים לפריים אחד (60fps)
// גם אם הגיעו 10 tokens מאז הפריים האחרון — רק עדכון DOM אחד יבוצע
let renderScheduled = false;
let _pendingText = "";
let _pendingDiv = null;
let _pendingCursor = null;

function scheduleRender(contentDiv, text, cursor) {
  // שומרים את הערכים העדכניים ביותר
  _pendingText = text;
  _pendingDiv = contentDiv;
  _pendingCursor = cursor;

  // אם כבר יש render מתוזמן — לא מוסיפים עוד (הוא יקח את _pendingText האחרון)
  if (!renderScheduled) {
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      if (!_pendingDiv) return;
      // עדכון DOM אחד בלבד — עם כל הטקסט שהצטבר
      _pendingDiv.innerHTML = marked.parse(_pendingText);
      if (_pendingCursor) {
        // הוסף cursor בחזרה (marked.parse מחק את כל ה-innerHTML)
        const cur = document.createElement("span");
        cur.className = "typing-cursor";
        _pendingDiv.appendChild(cur);
      }
      chatEl.scrollTop = chatEl.scrollHeight;
    });
  }
}

// ─── Finalize Streaming ───────────────────────────────────────────────────────
// נקרא כשה-stream מסיים (event "done" מהשרת).
// מסיר cursor, מוסיף כפתורי הורדה, מציג תגיות כלים
function finalizeStreamBubble(div, contentDiv, fullText, toolsUsed) {
  contentDiv.innerHTML = marked.parse(fullText); // render סופי ללא cursor
  addDownloadButtons(contentDiv);

  if (toolsUsed?.length > 0) {
    const toolsDiv = buildToolsDiv(toolsUsed);
    div.appendChild(toolsDiv);
    anim.toolsUsedIn(toolsDiv); // ✨ תגיות כלים נכנסות
  }

  chatEl.scrollTop = chatEl.scrollHeight;
}

// ─── Chat Rendering ───────────────────────────────────────────────────────────
// מרנדר מחדש את כל ההודעות של הצ'אט הפעיל (לאחר טעינה או החלפת צ'אט).
// הודעות היסטוריות נטענות ללא אנימציה — רק הודעות חדשות מונפשות
function renderActiveChat() {
  chatEl.innerHTML = ""; // מנקה את הצ'אט
  const active = getActiveChat();
  currentChatTitle.textContent = active ? active.title : "צ'אט";
  if (active?.messages) {
    active.messages.forEach((m) => {
      const div = document.createElement("div");
      div.className = `bubble ${m.who}`;
      const contentDiv = document.createElement("div");
      if (m.who === "bot") {
        contentDiv.className = "markdown-content";
        contentDiv.innerHTML = marked.parse(m.text || "");
        addDownloadButtons(contentDiv);
      } else {
        contentDiv.textContent = m.text || "";
        contentDiv.style.whiteSpace = "pre-wrap";
      }
      div.appendChild(contentDiv);
      if (m.tools?.length > 0) div.appendChild(buildToolsDiv(m.tools));
      chatEl.appendChild(div);
    });
    chatEl.scrollTop = chatEl.scrollHeight;
  }
}

// מרנדר את הסרגל הצדדי של הצ'אטים
function renderChatSidebarList() {
  chatListEl.innerHTML = "";
  Object.entries(state.chats)
    .reverse() // הצ'אט החדש ביותר ראשון
    .forEach(([id, chatObj], index) => {
      const btn = document.createElement("button");
      btn.className = `list-item ${id === state.activeChatId ? "active" : ""}`;
      btn.textContent = chatObj.title;
      btn.onclick = () => {
        state.activeChatId = id;
        saveState();
        renderChatSidebarList();
        renderActiveChat();
        if (window.innerWidth <= 768) anim.sidebarClose(sidebar); // סגירה אוטו' במובייל
      };
      chatListEl.appendChild(btn);
      anim.listItemIn(btn, index); // ✨ כניסת פריטי רשימה
    });
}

// שינוי שם אוטומטי של צ'אט חדש לפי ההודעה הראשונה (20 תווים ראשונים)
function renameChatIfFirstMessage(chatId, firstUserMessage) {
  const c = state.chats[chatId];
  if (c && c.messages.length === 1 && c.title.startsWith("צ'אט")) {
    c.title =
      firstUserMessage.slice(0, 20) + (firstUserMessage.length > 20 ? "…" : "");
  }
}

// ─── Chat Buttons ─────────────────────────────────────────────────────────────
newChatBtn.addEventListener("click", () => {
  anim.sendPop(newChatBtn); // ✨
  const newId = makeId();
  state.chats[newId] = { title: "צ'אט חדש", messages: [] };
  state.activeChatId = newId;
  saveState();
  renderChatSidebarList();
  renderActiveChat();
  input.focus();
});

deleteChatBtn.addEventListener("click", async () => {
  const activeId = state.activeChatId;
  if (!activeId || !confirm("למחוק את הצ'אט הזה?")) return;
  try {
    // מוחק גם מהשרת (היסטוריה ב-server.js) וגם מה-localStorage
    await fetch(`/api/chat/${activeId}`, {
      method: "DELETE",
      headers: apiHeaders,
    });
  } catch {}

  delete state.chats[activeId];
  const ids = Object.keys(state.chats);
  if (ids.length === 0) {
    // אם מחקנו את הצ'אט האחרון — יוצרים חדש אוטומטית
    const newId = makeId();
    state.chats[newId] = { title: "צ'אט 1", messages: [] };
    state.activeChatId = newId;
  } else {
    state.activeChatId = ids[ids.length - 1]; // עובר לצ'אט האחרון
  }
  saveState();
  renderChatSidebarList();
  renderActiveChat();
});

// ─── Textarea Auto-resize ─────────────────────────────────────────────────────
// גובה ה-textarea גדל אוטומטית עם הקלדה (עד 150px)
input.addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height =
    (this.scrollHeight < 150 ? this.scrollHeight : 150) + "px";
});

// Enter שולח הודעה, Shift+Enter = ירידת שורה
input.addEventListener("keydown", function (event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendBtn.click();
  }
});

// ─── Form Submit: SSE Streaming ──────────────────────────────────────────────
// זרימת העבודה:
// 1. המשתמש לוחץ שלח → שולחים POST /api/chat
// 2. השרת מחזיר SSE stream (לא JSON רגיל)
// 3. קוראים שורה אחרי שורה: "data: {...}\n\n"
// 4. כל event יכול להיות: chunk (token) | tool (כלי מופעל) | done | error
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = input.value.trim();
  if (!msg) return;

  anim.sendPop(sendBtn); // ✨ אנימציית לחיצה על כפתור שליחה

  const chatId = state.activeChatId;
  const activeChat = getActiveChat();

  // שמירה מיידית ב-localStorage לפני שהשרת מגיב
  activeChat.messages.push({ who: "me", text: msg });
  renameChatIfFirstMessage(chatId, msg);
  saveState();
  renderChatSidebarList();
  addBubble(msg, "me"); // הצגת הודעת המשתמש מיד

  input.value = "";
  input.style.height = "auto";
  sendBtn.disabled = true; // מניעת שליחה כפולה

  // יצירת bubble ריקה שתתמלא מה-stream
  const { div: bubbleDiv, contentDiv, cursor } = createStreamBubble();
  let fullText = "";
  let usedTools = [];

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({ chatId, message: msg }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || "Request failed");
    }

    // ─── קריאת SSE Stream ─────────────────────────────────────────────────
    // response.body.getReader() = Streams API — קריאה בזרימה ללא המתנה לסיום
    const reader = response.body.getReader();
    const decoder = new TextDecoder(); // ממיר Uint8Array → string
    let buffer = ""; // מאגר לטקסט חלקי בין קריאות

    while (true) {
      const { value, done } = await reader.read();
      if (done) break; // השרת סגר את ה-stream

      // decode עם stream: true = לא מסיים encoding באמצע תו מרובה-bytes
      buffer += decoder.decode(value, { stream: true });

      // SSE פורמט: כל event מסתיים ב-"\n\n".
      // פיצול לשורות — שורה אחרונה יכולה להיות חצי event, שומרים ל-buffer
      const lines = buffer.split("\n");
      buffer = lines.pop(); // ← חצי-שורה אחרונה, ממשיכים בקריאה הבאה

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue; // שורות ריקות ו-comments
        let data;
        try {
          data = JSON.parse(line.slice(6));
        } catch {
          continue;
        } // slice(6) = מסיר "data: "

        if (data.type === "chunk") {
          // token חדש מ-GPT — מוסיפים לטקסט ומנזמנים render
          fullText += data.text;
          scheduleRender(contentDiv, fullText, cursor); // throttled render
        } else if (data.type === "tool") {
          // GPT מפעיל כלי — מציגים badge מונפש
          const badge = document.createElement("div");
          badge.className = "tool-badge tool-badge-live";
          badge.textContent = `⚙️ מפעיל: ${escapeHtml(data.name)}`;
          bubbleDiv.appendChild(badge);
          anim.toolBadgeIn(badge); // ✨ badge נכנס ומתחיל לפעום
          chatEl.scrollTop = chatEl.scrollHeight;
        } else if (data.type === "done") {
          // השרת סיים — מנקים badges חיים, מציגים תגיות סופיות
          usedTools = data.usedTools || [];
          bubbleDiv.querySelectorAll(".tool-badge-live").forEach((el) => {
            anim.toolBadgeStop(el); // ✨ עצירת פעימה
            el.remove();
          });
          finalizeStreamBubble(bubbleDiv, contentDiv, fullText, usedTools);
        } else if (data.type === "error") {
          throw new Error(data.message);
        }
      }
    }
  } catch (err) {
    finalizeStreamBubble(bubbleDiv, contentDiv, `שגיאה: ${err.message}`, []);
    fullText = `שגיאה: ${err.message}`;
  }

  // שמירה סופית של תשובת הבוט ב-localStorage
  activeChat.messages.push({ who: "bot", text: fullText, tools: usedTools });
  saveState();
  sendBtn.disabled = false;
  input.focus();
});

// ─── MCP Status ───────────────────────────────────────────────────────────────
// מחזיר HTML של נקודת סטטוס צבעונית לפי מצב החיבור
function getMcpStatusHtml(id) {
  const s = mcpStatusMap.get(id) || "unknown";
  if (s === "loading")
    return `<span class="mcp-dot mcp-loading" title="מתחבר לשרת...">◉</span>`;
  if (s === "ready")
    return `<span class="mcp-dot mcp-ready" title="מוכן לשימוש">●</span>`;
  if (s === "error")
    return `<span class="mcp-dot mcp-error" title="שגיאת חיבור">●</span>`;
  return `<span class="mcp-dot mcp-unknown" title="לא נבדק">○</span>`;
}

// שולח ping לשרת MCP ספציפי ומעדכן את הסטטוס ב-UI.
// קורא ל-/api/mcps/:id/ping שמאלץ reconnect בשרת (מועיל ל-Render Free cold start)
async function pingMcp(mcpId) {
  mcpStatusMap.set(mcpId, "loading"); // מיידי — מציג אינדיקטור טעינה
  renderMcpList(lastMcpServers);

  try {
    const r = await fetch(`/api/mcps/${encodeURIComponent(mcpId)}/ping`, {
      headers: apiHeaders,
    });
    const data = await r.json();
    if (data.status === "ready") {
      mcpStatusMap.set(mcpId, "ready");
      mcpStatusMap.set(`${mcpId}_tools`, data.toolCount); // שומרים מספר כלים
    } else {
      mcpStatusMap.set(mcpId, "error");
    }
  } catch {
    mcpStatusMap.set(mcpId, "error");
  }

  renderMcpList(lastMcpServers); // מעדכן UI

  // אנימציה על הנקודה — requestAnimationFrame מבטיח שהDOM כבר עודכן
  requestAnimationFrame(() => {
    const dotEl = mcpList
      .querySelector(`[data-ping="${CSS.escape(mcpId)}"]`)
      ?.closest(".mcp-card")
      ?.querySelector(".mcp-dot");
    if (dotEl) anim.mcpDotFlash(dotEl); // ✨ נקודה קופצת
  });
}

// מרנדר את רשימת שרתי ה-MCP בסרגל הצדדי
function renderMcpList(servers) {
  lastMcpServers = servers; // שמירה לרינדור עתידי (כשסטטוס משתנה)
  mcpList.innerHTML = "";

  if (!servers.length) {
    mcpList.innerHTML = `<div style="font-size:12px; color:gray; padding:5px;">אין כלים מחוברים.</div>`;
    return;
  }

  servers.forEach((s, index) => {
    const status = mcpStatusMap.get(s.id) || "unknown";
    const toolCount = mcpStatusMap.get(`${s.id}_tools`);

    let statusLabel = "";
    if (status === "loading") statusLabel = "מתחבר...";
    else if (status === "ready")
      statusLabel =
        toolCount !== undefined ? `${toolCount} כלים נטענו` : "מוכן";
    else if (status === "error") statusLabel = "שגיאת חיבור";

    const div = document.createElement("div");
    div.className = "list-item mcp-card";
    const typeBadge = `<span class="mcp-type-badge http">HTTP</span>`;

    // innerHTML עם escapeHtml על כל ערך שמגיע מ-user/server (הגנה מ-XSS)
    div.innerHTML = `
      <div class="mcp-info">
        <div class="mcp-label">${typeBadge}${escapeHtml(s.label)}</div>
        <div class="mcp-meta">
          ${getMcpStatusHtml(s.id)}
          <span class="mcp-status-text ${status}">${escapeHtml(statusLabel)}</span>
        </div>
      </div>
      <div class="mcp-actions">
        <button class="icon-btn" data-ping="${escapeHtml(s.id)}" title="בדוק חיבור">🔄</button>
        <button class="icon-btn danger-text" data-del="${escapeHtml(s.id)}" title="הסר">🗑️</button>
      </div>
    `;
    mcpList.appendChild(div);
    anim.mcpCardIn(div, index); // ✨ כרטיס נכנס
  });

  // Event delegation — מוסיפים listeners פעם אחת על הכפתורים שנוצרו
  mcpList.querySelectorAll("[data-ping]").forEach((btn) => {
    btn.addEventListener("click", () => {
      anim.sendPop(btn); // ✨
      pingMcp(btn.getAttribute("data-ping"));
    });
  });

  mcpList.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del");
      if (!confirm("לנתק את הכלי הזה?")) return;
      // ✨ כרטיס יוצא ימינה לפני מחיקה — אנימציית יציאה
      const card = btn.closest(".mcp-card");
      gsap.to(card, {
        opacity: 0,
        x: 30,
        duration: 0.22,
        ease: "power2.in",
        onComplete: async () => {
          await fetch(`/api/mcps/${encodeURIComponent(id)}`, {
            method: "DELETE",
            headers: apiHeaders,
          });
          mcpStatusMap.delete(id);
          mcpStatusMap.delete(`${id}_tools`);
          await refreshMcps(); // רינדור מחדש אחרי המחיקה
        },
      });
    });
  });
}

// טוען את רשימת שרתי ה-MCP מהשרת ומתחיל ping לכל שרת לא בדוק
async function refreshMcps() {
  try {
    const r = await fetch("/api/mcps", { headers: apiHeaders });
    const data = await r.json();
    const servers = data.servers || [];
    renderMcpList(servers);
    // ping רק לשרתים שעוד לא בדקנו (כדי לא לבדוק שוב אחרי רינדור)
    for (const s of servers) {
      if (!mcpStatusMap.has(s.id) || mcpStatusMap.get(s.id) === "unknown") {
        pingMcp(s.id);
      }
    }
  } catch (e) {
    console.error("Failed to fetch MCPs", e);
  }
}

// ─── MCP Modal ────────────────────────────────────────────────────────────────
const modalCard = modalOverlay.querySelector(".modal");

// פותח את ה-modal להוספת שרת MCP חדש
function openModal() {
  // ניקוי שדות מהפעם הקודמת
  httpId.value = "";
  httpLabel.value = "";
  httpUrl.value = "";
  httpStatus.textContent = "";
  httpStatus.className = "status";
  modalOverlay.classList.remove("hidden");
  anim.modalOpen(modalOverlay, modalCard); // ✨ אנימציית פתיחה
}

// סוגר את ה-modal עם אנימציה, ואחריה מסתיר (hidden class)
function closeModal() {
  anim.modalClose(modalOverlay, modalCard, () => {
    // ✨ אנימציית סגירה
    modalOverlay.classList.add("hidden");
    gsap.set([modalOverlay, modalCard], { clearProps: "all" }); // ניקוי inline styles
  });
}

openMcpModalBtn.addEventListener("click", openModal);
closeModalBtn.addEventListener("click", closeModal);
cancelBtn1.addEventListener("click", closeModal);

// ping + עדכון UI אחרי הוספת שרת — פונקציה משותפת
async function pingAndFinalize(addedId) {
  await refreshMcps();
  mcpStatusMap.set(addedId, "loading");
  renderMcpList(lastMcpServers);

  const pingRes = await fetch(`/api/mcps/${encodeURIComponent(addedId)}/ping`, {
    headers: apiHeaders,
  });
  const pingData = await pingRes.json();

  if (pingData.status === "ready") {
    mcpStatusMap.set(addedId, "ready");
    mcpStatusMap.set(`${addedId}_tools`, pingData.toolCount);
    httpStatus.textContent = `✅ מוכן! ${pingData.toolCount} כלים נטענו בהצלחה`;
    httpStatus.className = "status success";
  } else {
    mcpStatusMap.set(addedId, "error");
    // הסבר ידידותי: Render Free יכול לקחת זמן להתעורר
    httpStatus.textContent =
      "⚠️ השרת נוסף אך לא הגיב — ייתכן שהוא עדיין מתחיל (Render Free)";
    httpStatus.className = "status warning";
  }

  renderMcpList(lastMcpServers);
  setTimeout(() => {
    closeModal();
    addHttpBtn.disabled = false;
  }, 2500); // מחכה 2.5 שניות כדי שהמשתמש יוכל לקרוא את הסטטוס
}

// הוספת שרת HTTP חדש — שולח POST ואז מבצע ping לבדיקת חיבור
addHttpBtn.addEventListener("click", async () => {
  const id = httpId.value.trim();
  const label = httpLabel.value.trim();
  const url = httpUrl.value.trim();
  if (!id || !label || !url) {
    httpStatus.textContent = "❌ יש למלא את כל השדות";
    httpStatus.className = "status error";
    // ✨ "shake" effect על ה-modal כשיש שגיאה — אנימציית רעידה
    gsap.fromTo(
      modalCard,
      { x: -6 },
      { x: 0, duration: 0.4, ease: "elastic.out(3, 0.3)" },
    );
    return;
  }
  try {
    httpStatus.textContent = "מוסיף...";
    httpStatus.className = "status";
    addHttpBtn.disabled = true; // מניעת לחיצה כפולה
    const r = await fetch("/api/mcps/http", {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({ id, label, url }),
    });
    if (!r.ok)
      throw new Error((await r.json().catch(() => ({}))).error || "שגיאה");
    const { added } = await r.json();
    httpStatus.textContent = "✅ נוסף! בודק חיבור לשרת...";
    await pingAndFinalize(added.id); // ping ל"חימום" השרת ובדיקת כלים
  } catch (e) {
    httpStatus.textContent = "❌ שגיאה: " + e.message;
    httpStatus.className = "status error";
    gsap.fromTo(
      modalCard,
      { x: -6 },
      { x: 0, duration: 0.4, ease: "elastic.out(3, 0.3)" },
    );
    addHttpBtn.disabled = false;
  }
});

// ─── Mobile Sidebar ───────────────────────────────────────────────────────────
mobileMenuBtn.addEventListener("click", () => anim.sidebarOpen(sidebar)); // ✨
closeSidebarBtn.addEventListener("click", () => anim.sidebarClose(sidebar)); // ✨

// ─── Sidebar Backdrop ───────────────────────────────────────────────────────
const sidebarBackdrop = document.getElementById("sidebarBackdrop");
sidebarBackdrop.addEventListener("click", () => {
  anim.sidebarClose(sidebar);
});

// Close sidebar when clicking outside in mobile view
window.addEventListener("resize", () => {
  if (window.innerWidth > 768 && sidebar.classList.contains("open")) {
    anim.sidebarClose(sidebar);
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────
// סדר הפעולות בטעינה:
// 1. מרנדר את הסרגל הצדדי
// 2. מרנדר את הצ'אט הפעיל
// 3. טוען ומבדוק שרתי MCP
// 4. אנימציית כניסה לדף
renderChatSidebarList();
renderActiveChat();
refreshMcps();
anim.pageLoad(); // ✨ אנימציית טעינה ראשונית
