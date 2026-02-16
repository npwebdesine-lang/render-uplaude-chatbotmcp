/**
 * public/app.js
 * -------------
 * כולל תצוגה של "Used Tool"
 */

const chatEl = document.getElementById("chat");
const form = document.getElementById("form");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const newChatBtn = document.getElementById("newChatBtn");
const deleteChatBtn = document.getElementById("deleteChatBtn");
const chatSelect = document.getElementById("chatSelect");
const mcpList = document.getElementById("mcpList");
const mcpStats = document.getElementById("mcpStats");
const openMcpModalBtn = document.getElementById("openMcpModalBtn");
const modalOverlay = document.getElementById("modalOverlay");
const closeModalBtn = document.getElementById("closeModalBtn");
const cancelBtn1 = document.getElementById("cancelBtn1");
const cancelBtn2 = document.getElementById("cancelBtn2");
const tabs = Array.from(document.querySelectorAll(".tab"));
const panes = Array.from(document.querySelectorAll(".pane"));
const httpId = document.getElementById("httpId");
const httpLabel = document.getElementById("httpLabel");
const httpUrl = document.getElementById("httpUrl");
const addHttpBtn = document.getElementById("addHttpBtn");
const httpStatus = document.getElementById("httpStatus");
const localId = document.getElementById("localId");
const localLabel = document.getElementById("localLabel");
const localCmd = document.getElementById("localCmd");
const localArgs = document.getElementById("localArgs");
const addLocalBtn = document.getElementById("addLocalBtn");
const localStatus = document.getElementById("localStatus");

const STORAGE_KEY = "mcp_chatbot_multi_v4"; // גרסה חדשה

let state = loadState();

function makeId() {
  return `chat_${Date.now()}_${Math.random().toString(16).slice(2)}`;
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
function clearChatUI() {
  chatEl.innerHTML = "";
}

// --- פונקציה מעודכנת להוספת בועה עם כלים ---
function addBubble(text, who = "me", toolsUsed = []) {
  const div = document.createElement("div");
  div.className = `bubble ${who}`;

  // תוכן ההודעה
  const contentDiv = document.createElement("div");
  contentDiv.textContent = text;
  div.appendChild(contentDiv);

  // אם יש כלים שהופעלו, נוסיף אותם למטה
  if (toolsUsed && toolsUsed.length > 0) {
    const toolsDiv = document.createElement("div");
    toolsDiv.className = "tools-used";
    toolsDiv.innerHTML = toolsUsed
      .map(
        (t) => `<div class="tool-badge">⚙️ Used: ${escapeHtml(t.name)}</div>`,
      )
      .join("");
    div.appendChild(toolsDiv);
  }

  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function renderActiveChat() {
  clearChatUI();
  const active = getActiveChat();
  if (active && active.messages) {
    for (const m of active.messages) {
      addBubble(m.text, m.who, m.tools);
    }
  }
}

function renderChatSelect() {
  chatSelect.innerHTML = "";
  Object.entries(state.chats).forEach(([id, chatObj], idx) => {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = chatObj.title || `צ'אט ${idx + 1}`;
    if (id === state.activeChatId) opt.selected = true;
    chatSelect.appendChild(opt);
  });
}

function renameChatIfFirstMessage(chatId, firstUserMessage) {
  const c = state.chats[chatId];
  if (c && c.messages.length === 1 && c.title.startsWith("צ'אט")) {
    c.title =
      firstUserMessage.slice(0, 18) + (firstUserMessage.length > 18 ? "…" : "");
  }
}

renderChatSelect();
renderActiveChat();

newChatBtn.addEventListener("click", () => {
  const newId = makeId();
  state.chats[newId] = {
    title: `צ'אט ${Object.keys(state.chats).length + 1}`,
    messages: [],
  };
  state.activeChatId = newId;
  saveState();
  renderChatSelect();
  renderActiveChat();
  input.focus();
});

chatSelect.addEventListener("change", () => {
  state.activeChatId = chatSelect.value;
  saveState();
  renderActiveChat();
  input.focus();
});

deleteChatBtn.addEventListener("click", async () => {
  const activeId = state.activeChatId;
  if (!activeId || !confirm("למחוק?")) return;
  try {
    await fetch(`/api/chat/${activeId}`, { method: "DELETE" });
  } catch {}
  delete state.chats[activeId];
  const ids = Object.keys(state.chats);
  if (ids.length === 0) {
    const newId = makeId();
    state.chats[newId] = { title: "צ'אט 1", messages: [] };
    state.activeChatId = newId;
  } else {
    state.activeChatId = ids[0];
  }
  saveState();
  renderChatSelect();
  renderActiveChat();
  input.focus();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = input.value.trim();
  if (!msg) return;

  const chatId = state.activeChatId;
  const activeChat = getActiveChat();

  activeChat.messages.push({ who: "me", text: msg });
  renameChatIfFirstMessage(chatId, msg);
  saveState();
  renderChatSelect();
  addBubble(msg, "me");

  input.value = "";
  input.focus();
  sendBtn.disabled = true;

  const loadingId = "loader-" + Date.now();
  const loadingBubble = document.createElement("div");
  loadingBubble.className = "bubble bot blink";
  loadingBubble.id = loadingId;
  loadingBubble.textContent = "● ● ●";
  chatEl.appendChild(loadingBubble);
  chatEl.scrollTop = chatEl.scrollHeight;

  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, message: msg }),
    });
    const data = await r.json().catch(() => ({}));

    document.getElementById(loadingId)?.remove();

    if (!r.ok) throw new Error(data?.error || "Request failed");

    // שמירה בהיסטוריה כולל הכלים
    activeChat.messages.push({
      who: "bot",
      text: data.reply,
      tools: data.usedTools, // שומרים את הכלים בזיכרון המקומי
    });
    saveState();

    // שליחה לבועה כולל הכלים
    addBubble(data.reply, "bot", data.usedTools);
  } catch (err) {
    document.getElementById(loadingId)?.remove();
    const text = "שגיאה: " + err.message;
    activeChat.messages.push({ who: "bot", text });
    saveState();
    addBubble(text, "bot");
  } finally {
    sendBtn.disabled = false;
  }
});

// MCP Logic
function openModal() {
  modalOverlay.classList.remove("hidden");
  httpStatus.textContent = "";
  localStatus.textContent = "";
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
cancelBtn2.addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeModal();
});

tabs.forEach((t) => {
  t.addEventListener("click", () => {
    tabs.forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    panes.forEach((p) => p.classList.add("hidden"));
    document
      .querySelector(`.pane[data-pane="${t.dataset.tab}"]`)
      .classList.remove("hidden");
  });
});

async function refreshMcps() {
  try {
    const r = await fetch("/api/mcps");
    const data = await r.json();
    const servers = data.servers || [];
    mcpStats.textContent = `Servers: ${servers.length}`;
    renderMcpList(servers);
  } catch (e) {
    console.error("Failed to fetch MCPs", e);
  }
}

function renderMcpList(servers) {
  mcpList.innerHTML = "";
  if (!servers.length) {
    mcpList.innerHTML = `<div class="empty">לא נוספו MCPs.</div>`;
    return;
  }
  for (const s of servers) {
    const div = document.createElement("div");
    div.className = "mcp-item";
    div.innerHTML = `
      <div class="mcp-main">
        <div class="mcp-title">${escapeHtml(s.label)} <span class="pill">${escapeHtml(s.type)}</span></div>
        <div class="mcp-sub">${escapeHtml(s.id)}</div>
      </div>
      <button class="danger sm" data-del="${escapeHtml(s.id)}">מחק</button>
    `;
    mcpList.appendChild(div);
  }
  mcpList.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("למחוק?")) return;
      await fetch(
        `/api/mcps/${encodeURIComponent(btn.getAttribute("data-del"))}`,
        { method: "DELETE" },
      );
      await refreshMcps();
    });
  });
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error("Failed");
    httpStatus.textContent = "✅ נוסף";
    setTimeout(() => {
      closeModal();
      refreshMcps();
    }, 1000);
  } catch (e) {
    httpStatus.textContent = "❌ " + e.message;
  }
});

addLocalBtn.addEventListener("click", async () => {
  try {
    localStatus.textContent = "מוסיף...";
    const body = {
      id: localId.value.trim(),
      label: localLabel.value.trim(),
      command: localCmd.value.trim(),
      args: localArgs.value.split(","),
    };
    const r = await fetch("/api/mcps/local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error("Failed");
    localStatus.textContent = "✅ נוסף";
    setTimeout(() => {
      closeModal();
      refreshMcps();
    }, 1000);
  } catch (e) {
    localStatus.textContent = "❌ " + e.message;
  }
});

refreshMcps();
