/**
 * public/app.js
 */

// ─── User Identity ───────────────────────────────────────────────────────────
function getUserId() {
  let uid = localStorage.getItem("chatbot_multi_tenant_uid");
  if (!uid) {
    uid = "usr_" + Math.random().toString(36).substring(2, 15);
    localStorage.setItem("chatbot_multi_tenant_uid", uid);
  }
  return uid;
}

const apiHeaders = {
  "Content-Type": "application/json",
  "X-User-ID": getUserId(),
};

// ─── DOM Elements ────────────────────────────────────────────────────────────
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

// ─── GSAP Animation Library ───────────────────────────────────────────────────
const anim = {

  /** הודעה חדשה עולה ונכנסת */
  bubbleIn(el) {
    gsap.fromTo(el,
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.35, ease: "power2.out" }
    );
  },

  /** תג כלי חי — מתרחב ופועם */
  toolBadgeIn(el) {
    gsap.fromTo(el,
      { opacity: 0, scale: 0.7 },
      {
        opacity: 1, scale: 1, duration: 0.25, ease: "back.out(2)",
        onComplete() {
          gsap.to(el, {
            opacity: 0.45, duration: 0.55,
            repeat: -1, yoyo: true, ease: "sine.inOut"
          });
        }
      }
    );
  },

  /** הורג אנימציית פעימה ומייצב תג */
  toolBadgeStop(el) {
    gsap.killTweensOf(el);
    gsap.to(el, { opacity: 1, scale: 1, duration: 0.15 });
  },

  /** div של כלים שהסתיימו — מחליק פנימה */
  toolsUsedIn(el) {
    gsap.fromTo(el,
      { opacity: 0, y: -8 },
      { opacity: 1, y: 0, duration: 0.3, ease: "power2.out" }
    );
  },

  /** פתיחת מודל */
  modalOpen(overlayEl, cardEl) {
    gsap.fromTo(overlayEl,
      { opacity: 0 },
      { opacity: 1, duration: 0.22, ease: "none" }
    );
    gsap.fromTo(cardEl,
      { opacity: 0, scale: 0.9, y: -22 },
      { opacity: 1, scale: 1, y: 0, duration: 0.32, ease: "back.out(1.5)" }
    );
  },

  /** סגירת מודל עם callback */
  modalClose(overlayEl, cardEl, onDone) {
    gsap.to(cardEl, {
      opacity: 0, scale: 0.9, y: -10,
      duration: 0.18, ease: "power2.in"
    });
    gsap.to(overlayEl, {
      opacity: 0, duration: 0.22, ease: "none",
      onComplete: onDone
    });
  },

  /** פריט ברשימת הצ'אטים נכנס מהצד */
  listItemIn(el, index) {
    gsap.fromTo(el,
      { opacity: 0, x: 18 },
      { opacity: 1, x: 0, duration: 0.22, delay: index * 0.04, ease: "power2.out" }
    );
  },

  /** כרטיס MCP נכנס בסטאגר */
  mcpCardIn(el, index) {
    gsap.fromTo(el,
      { opacity: 0, x: 16, scale: 0.97 },
      { opacity: 1, x: 0, scale: 1, duration: 0.26, delay: index * 0.06, ease: "power2.out" }
    );
  },

  /** נקודת סטטוס MCP קופצת כשמשתנה */
  mcpDotFlash(dotEl) {
    gsap.fromTo(dotEl,
      { scale: 1.9, opacity: 0.6 },
      { scale: 1, opacity: 1, duration: 0.45, ease: "elastic.out(1, 0.4)" }
    );
  },

  /** כפתור שליחה נלחץ */
  sendPop(el) {
    gsap.fromTo(el,
      { scale: 0.88 },
      { scale: 1, duration: 0.35, ease: "elastic.out(1, 0.5)" }
    );
  },

  /** פתיחת sidebar במובייל */
  sidebarOpen(el) {
    el.classList.add("open");
    gsap.fromTo(el,
      { xPercent: 100 },
      { xPercent: 0, duration: 0.32, ease: "power3.out" }
    );
  },

  /** סגירת sidebar במובייל */
  sidebarClose(el) {
    gsap.to(el, {
      xPercent: 100, duration: 0.26, ease: "power3.in",
      onComplete() {
        el.classList.remove("open");
        gsap.set(el, { clearProps: "transform" });
      }
    });
  },

  /** אנימציית כניסה לכל הדף */
  pageLoad() {
    const main = document.querySelector(".main-chat");
    if (window.innerWidth <= 768) {
      // Mobile: sidebar מוסתר דרך transform, רק main נכנס
      gsap.set(sidebar, { xPercent: 100 });
      gsap.fromTo(main,
        { opacity: 0 },
        { opacity: 1, duration: 0.45, ease: "power1.out" }
      );
    } else {
      // Desktop: sidebar ו-main נכנסים ביחד
      gsap.fromTo(sidebar,
        { opacity: 0, x: 24 },
        { opacity: 1, x: 0, duration: 0.45, ease: "power2.out" }
      );
      gsap.fromTo(main,
        { opacity: 0 },
        { opacity: 1, duration: 0.5, delay: 0.12, ease: "power1.out" }
      );
    }
  },
};

// ─── State ───────────────────────────────────────────────────────────────────
const STORAGE_KEY = `mcp_chats_${getUserId()}`;
let state = loadState();

const mcpStatusMap = new Map(); // id -> 'loading' | 'ready' | 'error' | 'unknown'
let lastMcpServers = [];

// ─── Chat State ──────────────────────────────────────────────────────────────
function makeId() {
  return `chat_${Date.now()}`;
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try { return JSON.parse(raw); } catch {}
  }
  const first = makeId();
  const init = {
    activeChatId: first,
    chats: { [first]: { title: "צ'אט 1", messages: [] } },
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(init));
  return init;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function getActiveChat() {
  return state.chats[state.activeChatId];
}

// ─── Utilities ───────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// ─── Download Buttons (Blob Magic) ───────────────────────────────────────────
const MIME_TYPES = {
  csv: "text/csv",
  html: "text/html", htm: "text/html",
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

function addDownloadButtons(contentDiv) {
  contentDiv.querySelectorAll("pre").forEach((pre) => {
    const codeBlock = pre.querySelector("code");
    if (!codeBlock || pre.querySelector(".download-btn-wrap")) return;

    let extension = "txt";
    const langClass = Array.from(codeBlock.classList).find((c) =>
      c.startsWith("language-")
    );
    if (langClass) extension = langClass.replace("language-", "");

    const mime = MIME_TYPES[extension] || "text/plain";
    const needsBom = extension === "csv";

    const btnDiv = document.createElement("div");
    btnDiv.className = "download-btn-wrap";

    const downloadBtn = document.createElement("button");
    downloadBtn.className = "primary-btn download-btn";
    downloadBtn.textContent = `⬇ הורד קובץ (.${extension})`;

    downloadBtn.onclick = () => {
      anim.sendPop(downloadBtn);
      const fileContent = codeBlock.innerText;
      const parts = needsBom ? ["\ufeff", fileContent] : [fileContent];
      const blob = new Blob(parts, { type: `${mime};charset=utf-8` });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `AI_Generated_${Date.now()}.${extension}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };

    btnDiv.appendChild(downloadBtn);
    pre.appendChild(btnDiv);
  });
}

// ─── Chat Bubbles ─────────────────────────────────────────────────────────────
function addBubble(text, who = "me", toolsUsed = []) {
  const div = document.createElement("div");
  div.className = `bubble ${who}`;

  const contentDiv = document.createElement("div");
  if (who === "bot") {
    contentDiv.className = "markdown-content";
    contentDiv.innerHTML = marked.parse(text);
    addDownloadButtons(contentDiv);
  } else {
    contentDiv.textContent = text;
    contentDiv.style.whiteSpace = "pre-wrap";
  }
  div.appendChild(contentDiv);

  if (toolsUsed?.length > 0) {
    const toolsDiv = buildToolsDiv(toolsUsed);
    div.appendChild(toolsDiv);
  }

  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;

  anim.bubbleIn(div); // ✨ כניסה מונפשת
  return div;
}

function buildToolsDiv(tools) {
  const toolsDiv = document.createElement("div");
  toolsDiv.className = "tools-used";
  toolsDiv.innerHTML = tools
    .map((t) => `<div class="tool-badge">⚙️ פעל: ${escapeHtml(t.name)}</div>`)
    .join("");
  return toolsDiv;
}

/**
 * בועת bot ריקה שתתמלא ב-streaming
 */
function createStreamBubble() {
  const div = document.createElement("div");
  div.className = "bubble bot";

  const contentDiv = document.createElement("div");
  contentDiv.className = "markdown-content";

  const cursor = document.createElement("span");
  cursor.className = "typing-cursor";
  contentDiv.appendChild(cursor);

  div.appendChild(contentDiv);
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;

  anim.bubbleIn(div); // ✨ כניסה מונפשת
  return { div, contentDiv, cursor };
}

/**
 * עדכון בועה תוך כדי streaming (מוגבל ל-rAF לביצועים)
 */
let renderScheduled = false;
let _pendingText = "";
let _pendingDiv = null;
let _pendingCursor = null;

function scheduleRender(contentDiv, text, cursor) {
  _pendingText = text;
  _pendingDiv = contentDiv;
  _pendingCursor = cursor;
  if (!renderScheduled) {
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      if (!_pendingDiv) return;
      _pendingDiv.innerHTML = marked.parse(_pendingText);
      if (_pendingCursor) {
        const cur = document.createElement("span");
        cur.className = "typing-cursor";
        _pendingDiv.appendChild(cur);
      }
      chatEl.scrollTop = chatEl.scrollHeight;
    });
  }
}

/**
 * סיום streaming — מוסיף כפתורי הורדה ותגיות כלים
 */
function finalizeStreamBubble(div, contentDiv, fullText, toolsUsed) {
  contentDiv.innerHTML = marked.parse(fullText);
  addDownloadButtons(contentDiv);

  if (toolsUsed?.length > 0) {
    const toolsDiv = buildToolsDiv(toolsUsed);
    div.appendChild(toolsDiv);
    anim.toolsUsedIn(toolsDiv); // ✨ תגיות כלים נכנסות
  }

  chatEl.scrollTop = chatEl.scrollHeight;
}

// ─── Chat Rendering ───────────────────────────────────────────────────────────
function renderActiveChat() {
  chatEl.innerHTML = "";
  const active = getActiveChat();
  currentChatTitle.textContent = active ? active.title : "צ'אט";
  if (active?.messages) {
    // הודעות היסטוריות נטענות ללא אנימציה לביצועים
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

function renderChatSidebarList() {
  chatListEl.innerHTML = "";
  Object.entries(state.chats)
    .reverse()
    .forEach(([id, chatObj], index) => {
      const btn = document.createElement("button");
      btn.className = `list-item ${id === state.activeChatId ? "active" : ""}`;
      btn.textContent = chatObj.title;
      btn.onclick = () => {
        state.activeChatId = id;
        saveState();
        renderChatSidebarList();
        renderActiveChat();
        if (window.innerWidth <= 768) anim.sidebarClose(sidebar);
      };
      chatListEl.appendChild(btn);
      anim.listItemIn(btn, index); // ✨ כניסת פריטי רשימה
    });
}

function renameChatIfFirstMessage(chatId, firstUserMessage) {
  const c = state.chats[chatId];
  if (c && c.messages.length === 1 && c.title.startsWith("צ'אט")) {
    c.title =
      firstUserMessage.slice(0, 20) +
      (firstUserMessage.length > 20 ? "…" : "");
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
    await fetch(`/api/chat/${activeId}`, { method: "DELETE", headers: apiHeaders });
  } catch {}

  delete state.chats[activeId];
  const ids = Object.keys(state.chats);
  if (ids.length === 0) {
    const newId = makeId();
    state.chats[newId] = { title: "צ'אט 1", messages: [] };
    state.activeChatId = newId;
  } else {
    state.activeChatId = ids[ids.length - 1];
  }
  saveState();
  renderChatSidebarList();
  renderActiveChat();
});

// ─── Textarea auto-resize + Shift+Enter ──────────────────────────────────────
input.addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = (this.scrollHeight < 150 ? this.scrollHeight : 150) + "px";
});

input.addEventListener("keydown", function (event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendBtn.click();
  }
});

// ─── Form Submit (Streaming) ──────────────────────────────────────────────────
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = input.value.trim();
  if (!msg) return;

  anim.sendPop(sendBtn); // ✨ כפתור שליחה קופץ

  const chatId = state.activeChatId;
  const activeChat = getActiveChat();

  activeChat.messages.push({ who: "me", text: msg });
  renameChatIfFirstMessage(chatId, msg);
  saveState();
  renderChatSidebarList();
  addBubble(msg, "me");

  input.value = "";
  input.style.height = "auto";
  sendBtn.disabled = true;

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
        let data;
        try { data = JSON.parse(line.slice(6)); } catch { continue; }

        if (data.type === "chunk") {
          fullText += data.text;
          scheduleRender(contentDiv, fullText, cursor);

        } else if (data.type === "tool") {
          // ✨ תג כלי חי עם אנימציה
          const badge = document.createElement("div");
          badge.className = "tool-badge tool-badge-live";
          badge.textContent = `⚙️ מפעיל: ${escapeHtml(data.name)}`;
          bubbleDiv.appendChild(badge);
          anim.toolBadgeIn(badge);
          chatEl.scrollTop = chatEl.scrollHeight;

        } else if (data.type === "done") {
          usedTools = data.usedTools || [];
          // עצור פעימה של תגי כלים חיים לפני הסרה
          bubbleDiv.querySelectorAll(".tool-badge-live").forEach((el) => {
            anim.toolBadgeStop(el);
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

  activeChat.messages.push({ who: "bot", text: fullText, tools: usedTools });
  saveState();
  sendBtn.disabled = false;
  input.focus();
});

// ─── MCP Status ───────────────────────────────────────────────────────────────
function getMcpStatusHtml(id) {
  const s = mcpStatusMap.get(id) || "unknown";
  if (s === "loading")
    return `<span class="mcp-dot mcp-loading" title="מתחבר לשרת...">◉</span>`;
  if (s === "ready")
    return `<span class="mcp-dot mcp-ready" title="מוכן לשימוש">●</span>`;
  if (s === "error")
    return `<span class="mcp-dot mcp-error" title="שגיאת חיבור">●</span>`;
  if (s === "offline")
    return `<span class="mcp-dot mcp-unknown" title="ממתין לחיבור tunnel">○</span>`;
  return `<span class="mcp-dot mcp-unknown" title="לא נבדק">○</span>`;
}

async function pingMcp(mcpId) {
  mcpStatusMap.set(mcpId, "loading");
  renderMcpList(lastMcpServers);

  try {
    const r = await fetch(`/api/mcps/${encodeURIComponent(mcpId)}/ping`, {
      headers: apiHeaders,
    });
    const data = await r.json();
    if (data.status === "ready") {
      mcpStatusMap.set(mcpId, "ready");
      mcpStatusMap.set(`${mcpId}_tools`, data.toolCount);
    } else {
      mcpStatusMap.set(mcpId, "error");
    }
  } catch {
    mcpStatusMap.set(mcpId, "error");
  }

  renderMcpList(lastMcpServers);
  renderLocalMcpList(lastMcpServers);

  // ✨ הבהוב נקודת הסטטוס אחרי שינוי (HTTP/STDIO)
  requestAnimationFrame(() => {
    const dotEl = mcpList
      .querySelector(`[data-ping="${CSS.escape(mcpId)}"]`)
      ?.closest(".mcp-card")
      ?.querySelector(".mcp-dot");
    if (dotEl) anim.mcpDotFlash(dotEl);

    // local panel
    const localDotEl = localMcpList
      .querySelector(`[data-ping="${CSS.escape(mcpId)}"]`)
      ?.closest(".mcp-card")
      ?.querySelector(".mcp-dot");
    if (localDotEl) anim.mcpDotFlash(localDotEl);
  });
}

function renderMcpList(servers) {
  lastMcpServers = servers;
  // מציג רק HTTP ו-STDIO — local מוצג בפאנל הנפרד
  const remoteServers = servers.filter(s => s.type !== "local");
  mcpList.innerHTML = "";

  if (!remoteServers.length) {
    mcpList.innerHTML = `<div style="font-size:12px; color:gray; padding:5px;">אין כלים מחוברים.</div>`;
    return;
  }

  remoteServers.forEach((s, index) => {
    const status = mcpStatusMap.get(s.id) || "unknown";
    const toolCount = mcpStatusMap.get(`${s.id}_tools`);

    let statusLabel = "";
    if (status === "loading") statusLabel = "מתחבר...";
    else if (status === "ready")
      statusLabel = toolCount !== undefined ? `${toolCount} כלים נטענו` : "מוכן";
    else if (status === "error") statusLabel = "שגיאת חיבור";

    const div = document.createElement("div");
    div.className = "list-item mcp-card";
    const typeBadge = s.type === "stdio"
      ? `<span class="mcp-type-badge stdio">STDIO</span>`
      : `<span class="mcp-type-badge http">HTTP</span>`;

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
    anim.mcpCardIn(div, index); // ✨ כרטיס MCP נכנס
  });

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
      // ✨ כרטיס יוצא
      const card = btn.closest(".mcp-card");
      gsap.to(card, {
        opacity: 0, x: 30, duration: 0.22, ease: "power2.in",
        onComplete: async () => {
          await fetch(`/api/mcps/${encodeURIComponent(id)}`, {
            method: "DELETE",
            headers: apiHeaders,
          });
          mcpStatusMap.delete(id);
          mcpStatusMap.delete(`${id}_tools`);
          await refreshMcps();
        }
      });
    });
  });
}

async function refreshMcps() {
  try {
    const r = await fetch("/api/mcps", { headers: apiHeaders });
    const data = await r.json();
    const servers = data.servers || [];
    renderMcpList(servers);
    renderLocalMcpList(servers);
    // auto-ping רק ל-HTTP/STDIO שלא נבדקו
    for (const s of servers.filter(s => s.type !== "local")) {
      if (!mcpStatusMap.has(s.id) || mcpStatusMap.get(s.id) === "unknown") {
        pingMcp(s.id);
      }
    }
    // auto-ping ל-local שיש להם tunnelUrl
    for (const s of servers.filter(s => s.type === "local" && s.tunnelUrl)) {
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
const tabHttp = document.getElementById("tabHttp");
const tabStdio = document.getElementById("tabStdio");
const httpFieldsEl = document.getElementById("httpFields");
const stdioFieldsEl = document.getElementById("stdioFields");
const stdioCommand = document.getElementById("stdioCommand");
const stdioArgs = document.getElementById("stdioArgs");

let mcpMode = "http"; // "http" | "stdio"

function setMcpMode(mode) {
  mcpMode = mode;
  tabHttp.classList.toggle("active", mode === "http");
  tabStdio.classList.toggle("active", mode === "stdio");
  httpFieldsEl.classList.toggle("hidden", mode !== "http");
  stdioFieldsEl.classList.toggle("hidden", mode !== "stdio");
  httpStatus.textContent = "";
  httpStatus.className = "status";
}

tabHttp.addEventListener("click", () => setMcpMode("http"));
tabStdio.addEventListener("click", () => setMcpMode("stdio"));

function openModal() {
  setMcpMode("http");
  httpId.value = "";
  httpLabel.value = "";
  httpUrl.value = "";
  stdioCommand.value = "";
  stdioArgs.value = "";
  modalOverlay.classList.remove("hidden");
  anim.modalOpen(modalOverlay, modalCard); // ✨
}

function closeModal() {
  anim.modalClose(modalOverlay, modalCard, () => { // ✨
    modalOverlay.classList.add("hidden");
    gsap.set([modalOverlay, modalCard], { clearProps: "all" });
  });
}

openMcpModalBtn.addEventListener("click", openModal);
closeModalBtn.addEventListener("click", closeModal);
cancelBtn1.addEventListener("click", closeModal);

/**
 * פונקציית ping + עדכון UI — משותפת ל-HTTP ו-STDIO
 */
async function pingAndFinalize(addedId) {
  await refreshMcps();
  mcpStatusMap.set(addedId, "loading");
  renderMcpList(lastMcpServers);

  const pingRes = await fetch(
    `/api/mcps/${encodeURIComponent(addedId)}/ping`,
    { headers: apiHeaders }
  );
  const pingData = await pingRes.json();

  if (pingData.status === "ready") {
    mcpStatusMap.set(addedId, "ready");
    mcpStatusMap.set(`${addedId}_tools`, pingData.toolCount);
    httpStatus.textContent = `✅ מוכן! ${pingData.toolCount} כלים נטענו בהצלחה`;
    httpStatus.className = "status success";
  } else {
    mcpStatusMap.set(addedId, "error");
    httpStatus.textContent =
      mcpMode === "stdio"
        ? "⚠️ לא ניתן להפעיל את הפקודה — בדוק שהפקודה מותקנת"
        : "⚠️ השרת נוסף אך לא הגיב — ייתכן שהוא עדיין מתחיל (Render Free)";
    httpStatus.className = "status warning";
  }

  renderMcpList(lastMcpServers);
  setTimeout(() => {
    closeModal();
    addHttpBtn.disabled = false;
  }, 2500);
}

addHttpBtn.addEventListener("click", async () => {
  const id = httpId.value.trim();
  const label = httpLabel.value.trim();

  if (mcpMode === "http") {
    // ─── HTTP mode ───────────────────────────────────────────────
    const url = httpUrl.value.trim();
    if (!id || !label || !url) {
      httpStatus.textContent = "❌ יש למלא את כל השדות";
      httpStatus.className = "status error";
      gsap.fromTo(modalCard, { x: -6 }, { x: 0, duration: 0.4, ease: "elastic.out(3, 0.3)" });
      return;
    }
    try {
      httpStatus.textContent = "מוסיף...";
      httpStatus.className = "status";
      addHttpBtn.disabled = true;
      const r = await fetch("/api/mcps/http", {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({ id, label, url }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "שגיאה");
      const { added } = await r.json();
      httpStatus.textContent = "✅ נוסף! בודק חיבור לשרת...";
      await pingAndFinalize(added.id);
    } catch (e) {
      httpStatus.textContent = "❌ שגיאה: " + e.message;
      httpStatus.className = "status error";
      gsap.fromTo(modalCard, { x: -6 }, { x: 0, duration: 0.4, ease: "elastic.out(3, 0.3)" });
      addHttpBtn.disabled = false;
    }

  } else {
    // ─── STDIO mode ──────────────────────────────────────────────
    const command = stdioCommand.value.trim();
    const args = stdioArgs.value.trim();
    if (!id || !label || !command) {
      httpStatus.textContent = "❌ יש למלא מזהה, שם ופקודה";
      httpStatus.className = "status error";
      gsap.fromTo(modalCard, { x: -6 }, { x: 0, duration: 0.4, ease: "elastic.out(3, 0.3)" });
      return;
    }
    try {
      httpStatus.textContent = "מוסיף ומפעיל תהליך...";
      httpStatus.className = "status";
      addHttpBtn.disabled = true;
      const r = await fetch("/api/mcps/stdio", {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({ id, label, command, args }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "שגיאה");
      const { added } = await r.json();
      httpStatus.textContent = "✅ נוסף! מפעיל תהליך מקומי...";
      await pingAndFinalize(added.id);
    } catch (e) {
      httpStatus.textContent = "❌ שגיאה: " + e.message;
      httpStatus.className = "status error";
      gsap.fromTo(modalCard, { x: -6 }, { x: 0, duration: 0.4, ease: "elastic.out(3, 0.3)" });
      addHttpBtn.disabled = false;
    }
  }
});

// ─── Local MCP Panel ─────────────────────────────────────────────────────────
const localMcpList = document.getElementById("localMcpList");
const openLocalMcpModalBtn = document.getElementById("openLocalMcpModalBtn");
const localMcpModal = document.getElementById("localMcpModal");
const localMcpModalCard = localMcpModal.querySelector(".modal");
const closeLocalModalBtn = document.getElementById("closeLocalModalBtn");
const cancelLocalBtn = document.getElementById("cancelLocalBtn");
const addLocalMcpBtn = document.getElementById("addLocalMcpBtn");
const localId = document.getElementById("localId");
const localLabel = document.getElementById("localLabel");
const localCommand = document.getElementById("localCommand");
const localMcpStatus = document.getElementById("localMcpStatus");

function openLocalModal() {
  localId.value = "";
  localLabel.value = "";
  localCommand.value = "";
  localMcpStatus.textContent = "";
  localMcpStatus.className = "status";
  localMcpModal.classList.remove("hidden");
  anim.modalOpen(localMcpModal, localMcpModalCard); // ✨
}

function closeLocalModal() {
  anim.modalClose(localMcpModal, localMcpModalCard, () => {
    localMcpModal.classList.add("hidden");
    gsap.set([localMcpModal, localMcpModalCard], { clearProps: "all" });
  });
}

openLocalMcpModalBtn.addEventListener("click", openLocalModal);
closeLocalModalBtn.addEventListener("click", closeLocalModal);
cancelLocalBtn.addEventListener("click", closeLocalModal);

addLocalMcpBtn.addEventListener("click", async () => {
  const id = localId.value.trim();
  const label = localLabel.value.trim();
  const command = localCommand.value.trim();

  if (!id || !label || !command) {
    localMcpStatus.textContent = "❌ יש למלא את כל השדות";
    localMcpStatus.className = "status error";
    gsap.fromTo(localMcpModalCard, { x: -6 }, { x: 0, duration: 0.4, ease: "elastic.out(3, 0.3)" });
    return;
  }

  try {
    localMcpStatus.textContent = "שומר...";
    addLocalMcpBtn.disabled = true;
    const r = await fetch("/api/mcps/local", {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({ id, label, command }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "שגיאה");
    await refreshMcps();
    closeLocalModal();
    addLocalMcpBtn.disabled = false;
  } catch (e) {
    localMcpStatus.textContent = "❌ שגיאה: " + e.message;
    localMcpStatus.className = "status error";
    gsap.fromTo(localMcpModalCard, { x: -6 }, { x: 0, duration: 0.4, ease: "elastic.out(3, 0.3)" });
    addLocalMcpBtn.disabled = false;
  }
});

/**
 * מעדכן את ה-tunnel URL דרך prompt פשוט
 */
async function setTunnelUrl(mcpId) {
  const url = prompt("הכנס את כתובת ה-tunnel (ngrok / cloudflare):");
  if (!url?.trim()) return;

  try {
    const r = await fetch(`/api/mcps/local/${encodeURIComponent(mcpId)}/tunnel`, {
      method: "PATCH",
      headers: apiHeaders,
      body: JSON.stringify({ tunnelUrl: url.trim() }),
    });
    if (!r.ok) throw new Error("שגיאה בשמירת ה-URL");
    await refreshMcps();
    // ping אוטומטי אחרי עדכון URL
    mcpStatusMap.set(mcpId, "loading");
    renderLocalMcpList(lastMcpServers);
    pingMcp(mcpId);
  } catch (e) {
    alert("שגיאה: " + e.message);
  }
}

/**
 * מרנדר את פאנל ה-MCP המקומי
 */
function renderLocalMcpList(servers) {
  const localServers = (servers || []).filter(s => s.type === "local");
  localMcpList.innerHTML = "";

  if (!localServers.length) {
    localMcpList.innerHTML = `<div style="font-size:12px; color:gray; padding:5px;">לחץ ➕ להוסיף MCP מקומי.</div>`;
    return;
  }

  localServers.forEach((s, index) => {
    const status = mcpStatusMap.get(s.id) || (s.tunnelUrl ? "unknown" : "offline");
    const toolCount = mcpStatusMap.get(`${s.id}_tools`);

    let statusLabel = "";
    if (status === "offline")    statusLabel = "ממתין לחיבור";
    else if (status === "loading") statusLabel = "מתחבר...";
    else if (status === "ready")   statusLabel = toolCount !== undefined ? `${toolCount} כלים` : "מוכן";
    else if (status === "error")   statusLabel = "שגיאת חיבור";

    const tunnelDisplay = s.tunnelUrl
      ? `<div class="local-tunnel-url" title="${escapeHtml(s.tunnelUrl)}">${escapeHtml(s.tunnelUrl.replace(/^https?:\/\//, "").substring(0, 28))}…</div>`
      : "";

    const tunnelBtn = !s.tunnelUrl
      ? `<button class="tunnel-btn" data-tunnel="${escapeHtml(s.id)}">🔗 חבר Tunnel</button>`
      : `<button class="tunnel-btn" data-tunnel="${escapeHtml(s.id)}" title="שנה URL">✏️</button>`;

    const div = document.createElement("div");
    div.className = "list-item mcp-card local-mcp-card";
    div.innerHTML = `
      <div class="mcp-info">
        <div class="mcp-label">
          <span class="mcp-type-badge local">LOCAL</span>${escapeHtml(s.label)}
        </div>
        <div class="local-mcp-command">${escapeHtml(s.command)}</div>
        ${tunnelDisplay}
        <div class="mcp-meta">
          ${getMcpStatusHtml(s.id)}
          <span class="mcp-status-text ${status}">${escapeHtml(statusLabel)}</span>
        </div>
      </div>
      <div class="mcp-actions">
        ${tunnelBtn}
        ${s.tunnelUrl ? `<button class="icon-btn" data-ping="${escapeHtml(s.id)}" title="בדוק חיבור">🔄</button>` : ""}
        <button class="icon-btn danger-text" data-del="${escapeHtml(s.id)}" title="הסר">🗑️</button>
      </div>
    `;
    localMcpList.appendChild(div);
    anim.mcpCardIn(div, index); // ✨
  });

  // tunnel button
  localMcpList.querySelectorAll("[data-tunnel]").forEach(btn => {
    btn.addEventListener("click", () => setTunnelUrl(btn.getAttribute("data-tunnel")));
  });

  // ping button
  localMcpList.querySelectorAll("[data-ping]").forEach(btn => {
    btn.addEventListener("click", () => {
      anim.sendPop(btn);
      pingMcp(btn.getAttribute("data-ping"));
    });
  });

  // delete button
  localMcpList.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del");
      if (!confirm("למחוק את ה-MCP המקומי הזה?")) return;
      const card = btn.closest(".mcp-card");
      gsap.to(card, {
        opacity: 0, x: 30, duration: 0.22, ease: "power2.in",
        onComplete: async () => {
          await fetch(`/api/mcps/${encodeURIComponent(id)}`, {
            method: "DELETE", headers: apiHeaders,
          });
          mcpStatusMap.delete(id);
          mcpStatusMap.delete(`${id}_tools`);
          await refreshMcps();
        }
      });
    });
  });
}

// ─── Mobile Sidebar ───────────────────────────────────────────────────────────
mobileMenuBtn.addEventListener("click", () => anim.sidebarOpen(sidebar));  // ✨
closeSidebarBtn.addEventListener("click", () => anim.sidebarClose(sidebar)); // ✨

// ─── Init ─────────────────────────────────────────────────────────────────────
renderChatSidebarList();
renderActiveChat();
refreshMcps();
anim.pageLoad(); // ✨ אנימציית טעינה ראשונית
