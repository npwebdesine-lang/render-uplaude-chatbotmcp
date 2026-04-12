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

// ─── State ───────────────────────────────────────────────────────────────────
const STORAGE_KEY = `mcp_chats_${getUserId()}`;
let state = loadState();

// סטטוס מוכנות של כל MCP: id -> 'loading' | 'ready' | 'error' | 'unknown'
const mcpStatusMap = new Map();
let lastMcpServers = [];

// ─── Chat State ──────────────────────────────────────────────────────────────
function makeId() {
  return `chat_${Date.now()}`;
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {}
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

// ─── HTML Escape ─────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// ─── Download Buttons (Blob Magic) ───────────────────────────────────────────
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

function addDownloadButtons(contentDiv) {
  contentDiv.querySelectorAll("pre").forEach((pre) => {
    const codeBlock = pre.querySelector("code");
    if (!codeBlock) return;

    // מניעת כפל כפתורים
    if (pre.querySelector(".download-btn-wrap")) return;

    let extension = "txt";
    const langClass = Array.from(codeBlock.classList).find((c) =>
      c.startsWith("language-")
    );
    if (langClass) extension = langClass.replace("language-", "");

    const mime = MIME_TYPES[extension] || "text/plain";
    const needsBom = extension === "csv"; // BOM רק ל-CSV (אקסל)

    const btnDiv = document.createElement("div");
    btnDiv.className = "download-btn-wrap";

    const downloadBtn = document.createElement("button");
    downloadBtn.className = "primary-btn download-btn";
    downloadBtn.textContent = `⬇ הורד קובץ (.${extension})`;

    downloadBtn.onclick = () => {
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
    div.appendChild(buildToolsDiv(toolsUsed));
  }

  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
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
 * יוצר בועת bot ריקה שתתמלא בזמן ה-streaming
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
  return { div, contentDiv, cursor };
}

/**
 * מעדכן את תוכן הבועה תוך כדי streaming (עם requestAnimationFrame לביצועים)
 */
let renderScheduled = false;
let pendingText = "";
let pendingContentDiv = null;
let pendingCursor = null;

function scheduleRender(contentDiv, text, cursor) {
  pendingText = text;
  pendingContentDiv = contentDiv;
  pendingCursor = cursor;
  if (!renderScheduled) {
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      if (!pendingContentDiv) return;
      pendingContentDiv.innerHTML = marked.parse(pendingText);
      if (pendingCursor) {
        const cur = document.createElement("span");
        cur.className = "typing-cursor";
        pendingContentDiv.appendChild(cur);
      }
      chatEl.scrollTop = chatEl.scrollHeight;
    });
  }
}

/**
 * סוגר את הבועה אחרי שה-stream נגמר — מוסיף כפתורי הורדה ותגיות כלים
 */
function finalizeStreamBubble(div, contentDiv, fullText, toolsUsed) {
  contentDiv.innerHTML = marked.parse(fullText);
  addDownloadButtons(contentDiv);

  if (toolsUsed?.length > 0) {
    div.appendChild(buildToolsDiv(toolsUsed));
  }

  chatEl.scrollTop = chatEl.scrollHeight;
}

// ─── Chat Rendering ───────────────────────────────────────────────────────────
function renderActiveChat() {
  chatEl.innerHTML = "";
  const active = getActiveChat();
  currentChatTitle.textContent = active ? active.title : "צ'אט";
  if (active?.messages) {
    for (const m of active.messages) {
      addBubble(m.text, m.who, m.tools);
    }
  }
}

function renderChatSidebarList() {
  chatListEl.innerHTML = "";
  Object.entries(state.chats)
    .reverse()
    .forEach(([id, chatObj]) => {
      const btn = document.createElement("button");
      btn.className = `list-item ${id === state.activeChatId ? "active" : ""}`;
      btn.textContent = chatObj.title;
      btn.onclick = () => {
        state.activeChatId = id;
        saveState();
        renderChatSidebarList();
        renderActiveChat();
        if (window.innerWidth <= 768) sidebar.classList.remove("open");
      };
      chatListEl.appendChild(btn);
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
    await fetch(`/api/chat/${activeId}`, {
      method: "DELETE",
      headers: apiHeaders,
    });
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

  // יצירת בועת bot ריקה שתתמלא ב-streaming
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
      buffer = lines.pop(); // השורה האחרונה אולי חלקית

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        let data;
        try {
          data = JSON.parse(line.slice(6));
        } catch {
          continue;
        }

        if (data.type === "chunk") {
          fullText += data.text;
          scheduleRender(contentDiv, fullText, cursor);
        } else if (data.type === "tool") {
          // הצג תג כלי בזמן אמת
          const badge = document.createElement("div");
          badge.className = "tool-badge tool-badge-live";
          badge.textContent = `⚙️ מפעיל: ${escapeHtml(data.name)}`;
          bubbleDiv.appendChild(badge);
          chatEl.scrollTop = chatEl.scrollHeight;
        } else if (data.type === "done") {
          usedTools = data.usedTools || [];
          // הסרת תגי כלים חיים ועיבוד סופי
          bubbleDiv
            .querySelectorAll(".tool-badge-live")
            .forEach((el) => el.remove());
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
  return `<span class="mcp-dot mcp-unknown" title="לא נבדק">○</span>`;
}

/**
 * שולח ping לשרת MCP ומעדכן את הסטטוס
 */
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
      // שמור tool count להצגה
      mcpStatusMap.set(`${mcpId}_tools`, data.toolCount);
    } else {
      mcpStatusMap.set(mcpId, "error");
    }
  } catch {
    mcpStatusMap.set(mcpId, "error");
  }

  renderMcpList(lastMcpServers);
}

function renderMcpList(servers) {
  lastMcpServers = servers;
  mcpList.innerHTML = "";

  if (!servers.length) {
    mcpList.innerHTML = `<div style="font-size:12px; color:gray; padding:5px;">אין כלים מחוברים.</div>`;
    return;
  }

  for (const s of servers) {
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
    div.innerHTML = `
      <div class="mcp-info">
        <div class="mcp-label">${escapeHtml(s.label)}</div>
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
  }

  // כפתורי ping
  mcpList.querySelectorAll("[data-ping]").forEach((btn) => {
    btn.addEventListener("click", () => pingMcp(btn.getAttribute("data-ping")));
  });

  // כפתורי מחיקה
  mcpList.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del");
      if (!confirm("לנתק את הכלי הזה?")) return;
      await fetch(`/api/mcps/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: apiHeaders,
      });
      mcpStatusMap.delete(id);
      mcpStatusMap.delete(`${id}_tools`);
      await refreshMcps();
    });
  });
}

async function refreshMcps() {
  try {
    const r = await fetch("/api/mcps", { headers: apiHeaders });
    const data = await r.json();
    const servers = data.servers || [];
    renderMcpList(servers);
    // ping אוטומטי לכל שרת שעדיין לא נבדק
    for (const s of servers) {
      if (!mcpStatusMap.has(s.id) || mcpStatusMap.get(s.id) === "unknown") {
        pingMcp(s.id); // לא await — מבוצע במקביל ברקע
      }
    }
  } catch (e) {
    console.error("Failed to fetch MCPs", e);
  }
}

// ─── MCP Modal ────────────────────────────────────────────────────────────────
function openModal() {
  modalOverlay.classList.remove("hidden");
  httpStatus.textContent = "";
  httpId.value = "";
  httpLabel.value = "";
  httpUrl.value = "";
}
function closeModal() {
  modalOverlay.classList.add("hidden");
}

openMcpModalBtn.addEventListener("click", openModal);
closeModalBtn.addEventListener("click", closeModal);
cancelBtn1.addEventListener("click", closeModal);

addHttpBtn.addEventListener("click", async () => {
  const body = {
    id: httpId.value.trim(),
    label: httpLabel.value.trim(),
    url: httpUrl.value.trim(),
  };

  if (!body.id || !body.label || !body.url) {
    httpStatus.textContent = "❌ יש למלא את כל השדות";
    return;
  }

  try {
    httpStatus.textContent = "מוסיף...";
    addHttpBtn.disabled = true;

    const r = await fetch("/api/mcps/http", {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || "שגיאה");
    }

    const { added } = await r.json();
    httpStatus.textContent = "✅ נוסף! בודק חיבור לשרת...";
    httpStatus.className = "status";

    await refreshMcps();

    // ping מיידי ועדכון הסטטוס בחלון
    mcpStatusMap.set(added.id, "loading");
    renderMcpList(lastMcpServers);

    const pingRes = await fetch(
      `/api/mcps/${encodeURIComponent(added.id)}/ping`,
      { headers: apiHeaders }
    );
    const pingData = await pingRes.json();

    if (pingData.status === "ready") {
      mcpStatusMap.set(added.id, "ready");
      mcpStatusMap.set(`${added.id}_tools`, pingData.toolCount);
      httpStatus.textContent = `✅ מוכן! ${pingData.toolCount} כלים נטענו בהצלחה`;
      httpStatus.className = "status success";
    } else {
      mcpStatusMap.set(added.id, "error");
      httpStatus.textContent =
        "⚠️ השרת נוסף אך לא הגיב — ייתכן שהוא עדיין מתחיל (Render Free)";
      httpStatus.className = "status warning";
    }

    renderMcpList(lastMcpServers);

    setTimeout(() => {
      closeModal();
      addHttpBtn.disabled = false;
    }, 2500);
  } catch (e) {
    httpStatus.textContent = "❌ שגיאה: " + e.message;
    httpStatus.className = "status error";
    addHttpBtn.disabled = false;
  }
});

// ─── Mobile Sidebar ───────────────────────────────────────────────────────────
mobileMenuBtn.addEventListener("click", () => sidebar.classList.add("open"));
closeSidebarBtn.addEventListener("click", () =>
  sidebar.classList.remove("open")
);

// ─── Init ─────────────────────────────────────────────────────────────────────
renderChatSidebarList();
renderActiveChat();
refreshMcps();
