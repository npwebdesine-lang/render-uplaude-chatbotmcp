/**
 * public/app.js
 * לוגיקת צד לקוח - כולל תמיכה בהפרדת משתמשים (Multi-Tenancy)
 */

// --- מנגנון תעודת זהות וירטואלית ---
function getUserId() {
  let uid = localStorage.getItem("chatbot_multi_tenant_uid");
  if (!uid) {
    uid = "usr_" + Math.random().toString(36).substring(2, 15);
    localStorage.setItem("chatbot_multi_tenant_uid", uid);
  }
  return uid;
}

// כותרות קבועות לכל פנייה לשרת
const apiHeaders = {
  "Content-Type": "application/json",
  "X-User-ID": getUserId(), // תעודת הזהות שלנו!
};

// --- אלמנטים מה-DOM ---
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

// --- ניהול סטייט (State) מקומי ---
const STORAGE_KEY = `mcp_chats_${getUserId()}`;
let state = loadState();

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

// --- ניהול ה-UI של הצ'אט ---
function addBubble(text, who = "me", toolsUsed = []) {
  const div = document.createElement("div");
  div.className = `bubble ${who}`;

  const contentDiv = document.createElement("div");
  contentDiv.textContent = text;
  div.appendChild(contentDiv);

  if (toolsUsed && toolsUsed.length > 0) {
    const toolsDiv = document.createElement("div");
    toolsDiv.className = "tools-used";
    toolsDiv.innerHTML = toolsUsed
      .map((t) => `<div class="tool-badge">⚙️ פעל: ${escapeHtml(t.name)}</div>`)
      .join("");
    div.appendChild(toolsDiv);
  }

  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function renderActiveChat() {
  chatEl.innerHTML = "";
  const active = getActiveChat();
  currentChatTitle.textContent = active ? active.title : "צ'אט";
  if (active && active.messages) {
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
        if (window.innerWidth <= 768) sidebar.classList.remove("open"); // סגירת תפריט במובייל
      };
      chatListEl.appendChild(btn);
    });
}

function renameChatIfFirstMessage(chatId, firstUserMessage) {
  const c = state.chats[chatId];
  if (c && c.messages.length === 1 && c.title.startsWith("צ'אט")) {
    c.title =
      firstUserMessage.slice(0, 20) + (firstUserMessage.length > 20 ? "…" : "");
  }
}

newChatBtn.addEventListener("click", () => {
  const newId = makeId();
  state.chats[newId] = { title: `צ'אט חדש`, messages: [] };
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

// שליחת הודעה
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
  sendBtn.disabled = true;

  const loadingId = "loader";
  const loadingBubble = document.createElement("div");
  loadingBubble.className = "bubble bot blink";
  loadingBubble.id = loadingId;
  loadingBubble.textContent = "מקליד...";
  chatEl.appendChild(loadingBubble);
  chatEl.scrollTop = chatEl.scrollHeight;

  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({ chatId, message: msg }),
    });
    const data = await r.json().catch(() => ({}));
    document.getElementById(loadingId)?.remove();

    if (!r.ok) throw new Error(data?.error || "Request failed");

    activeChat.messages.push({
      who: "bot",
      text: data.reply,
      tools: data.usedTools,
    });
    saveState();
    addBubble(data.reply, "bot", data.usedTools);
  } catch (err) {
    document.getElementById(loadingId)?.remove();
    activeChat.messages.push({ who: "bot", text: "שגיאה: " + err.message });
    saveState();
    addBubble("שגיאה: " + err.message, "bot");
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
});

// --- MCP UI ---
function openModal() {
  modalOverlay.classList.remove("hidden");
  httpStatus.textContent = "";
}
function closeModal() {
  modalOverlay.classList.add("hidden");
}
openMcpModalBtn.addEventListener("click", openModal);
closeModalBtn.addEventListener("click", closeModal);
cancelBtn1.addEventListener("click", closeModal);

async function refreshMcps() {
  try {
    const r = await fetch("/api/mcps", { headers: apiHeaders });
    const data = await r.json();
    renderMcpList(data.servers || []);
  } catch (e) {
    console.error("Failed to fetch MCPs", e);
  }
}

function renderMcpList(servers) {
  mcpList.innerHTML = "";
  if (!servers.length) {
    mcpList.innerHTML = `<div style="font-size:12px; color:gray;">אין כלים מחוברים.</div>`;
    return;
  }
  for (const s of servers) {
    const div = document.createElement("div");
    div.className = "list-item mcp-card";
    div.innerHTML = `
      <div>
        <div style="font-weight:bold;">${escapeHtml(s.label)}</div>
        <div style="font-size:11px; color:#a0c4ff;">${escapeHtml(s.id)}</div>
      </div>
      <button class="icon-btn danger-text" data-del="${escapeHtml(s.id)}">🗑️</button>
    `;
    mcpList.appendChild(div);
  }
  mcpList.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("לנתק את הכלי הזה?")) return;
      await fetch(
        `/api/mcps/${encodeURIComponent(btn.getAttribute("data-del"))}`,
        {
          method: "DELETE",
          headers: apiHeaders,
        },
      );
      await refreshMcps();
    });
  });
}

addHttpBtn.addEventListener("click", async () => {
  try {
    httpStatus.textContent = "מתחבר...";
    const body = {
      id: httpId.value.trim(),
      label: httpLabel.value.trim(),
      url: httpUrl.value.trim(),
    };
    const r = await fetch("/api/mcps/http", {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error("Connection failed");
    httpStatus.textContent = "✅ חובר בהצלחה";
    setTimeout(() => {
      closeModal();
      refreshMcps();
    }, 1000);
  } catch (e) {
    httpStatus.textContent = "❌ שגיאה: " + e.message;
  }
});

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// מובייל Menu Toggle
mobileMenuBtn.addEventListener("click", () => sidebar.classList.add("open"));
closeSidebarBtn.addEventListener("click", () =>
  sidebar.classList.remove("open"),
);

// אתחול
renderChatSidebarList();
renderActiveChat();
refreshMcps();
