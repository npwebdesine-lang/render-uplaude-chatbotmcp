/**
 * UI Logic
 * ========
 * - טוען סטטוס servers/tools מהשרת
 * - פותח מודאל "צרף MCP"
 * - תומך בצירוף HTTP (Render URL) ו-stdio (מקומי)
 * - מציג כרטיסים של MCPs מחוברים + אפשרות הסרה
 * - שולח צ'אט ל-/api/chat
 */

const chat = document.getElementById("chat");
const form = document.getElementById("form");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");

const statusChip = document.getElementById("statusChip");
const refreshBtn = document.getElementById("refreshTools");

const serversList = document.getElementById("serversList");

// Modal
const modal = document.getElementById("modal");
const openAttach = document.getElementById("openAttach");
const closeModal = document.getElementById("closeModal");
const xBtn = document.getElementById("xBtn");
const modalStatus = document.getElementById("modalStatus");

// Tabs
const tabButtons = Array.from(document.querySelectorAll(".tab"));
const tabPanes = Array.from(document.querySelectorAll(".tabPane"));

// HTTP fields
const httpId = document.getElementById("httpId");
const httpLabel = document.getElementById("httpLabel");
const httpUrl = document.getElementById("httpUrl");
const attachHttp = document.getElementById("attachHttp");

// STDIO fields
const stdioId = document.getElementById("stdioId");
const stdioLabel = document.getElementById("stdioLabel");
const stdioCommand = document.getElementById("stdioCommand");
const stdioArgs = document.getElementById("stdioArgs");
const attachStdio = document.getElementById("attachStdio");

function setChip(text) {
  statusChip.textContent = text;
}

function setModalStatus(text) {
  modalStatus.textContent = text || "";
}

function openModal() {
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  setModalStatus("");
}

function hideModal() {
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  setModalStatus("");
}

// close hooks
openAttach.addEventListener("click", openModal);
closeModal.addEventListener("click", hideModal);
xBtn.addEventListener("click", hideModal);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideModal();
});
document
  .querySelectorAll("[data-close]")
  .forEach((b) => b.addEventListener("click", hideModal));

// tabs
tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    tabButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const target = btn.getAttribute("data-tab");
    tabPanes.forEach((p) => p.classList.remove("active"));
    document.getElementById(target).classList.add("active");
    setModalStatus("");
  });
});

function addBubble(text, who) {
  const div = document.createElement("div");
  div.className = `bubble ${who}`;
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function serverCardHtml(s) {
  const meta =
    s.type === "http"
      ? `URL: ${s.url}`
      : `CMD: ${s.command} ${Array.isArray(s.args) ? s.args.join(" ") : ""}`;

  return `
    <div class="card">
      <div class="cardLeft">
        <div class="cardTitle">
          ${escapeHtml(s.label || s.id)}
          <span class="badge">${escapeHtml(s.type.toUpperCase())}</span>
          <span class="badge">tools: ${s.toolCount ?? 0}</span>
        </div>
        <div class="cardMeta">${escapeHtml(meta)}</div>
      </div>
      <div class="cardActions">
        <button class="btn btn-danger" data-remove="${escapeHtml(s.id)}">הסר</button>
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function fetchMcps() {
  const r = await fetch("/api/mcps");
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Failed to fetch MCPs");
  return data;
}

async function refreshTools() {
  setChip("מרענן כלים...");
  const r = await fetch("/api/mcps/refresh", { method: "POST" });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Refresh failed");
  await renderState(data);
  setChip(`Servers: ${data.servers.length} | Tools: ${data.tools.length}`);
}

async function renderState(data) {
  // servers list
  if (!data.servers?.length) {
    serversList.innerHTML = `
      <div class="card">
        <div class="cardLeft">
          <div class="cardTitle">אין MCP מחוברים</div>
          <div class="cardMeta">לחץ על "צרף MCP" כדי להוסיף Render URL או MCP מקומי (stdio)</div>
        </div>
      </div>
    `;
  } else {
    serversList.innerHTML = data.servers.map(serverCardHtml).join("");
  }

  // attach remove handlers
  serversList.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-remove");
      if (!confirm(`להסיר MCP "${id}"?`)) return;
      try {
        setChip("מסיר...");
        const rr = await fetch(`/api/mcps/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        const dd = await rr.json();
        if (!rr.ok) throw new Error(dd.error || "Remove failed");
        await renderState(dd);
        setChip(`Servers: ${dd.servers.length} | Tools: ${dd.tools.length}`);
      } catch (e) {
        alert("שגיאה בהסרה: " + e.message);
        setChip("שגיאה");
      }
    });
  });
}

// Attach HTTP
attachHttp.addEventListener("click", async () => {
  const id = httpId.value.trim();
  const url = httpUrl.value.trim();
  const label = httpLabel.value.trim();

  if (!id) return setModalStatus("חסר ID (למשל: weather)");
  if (!url) return setModalStatus("חסר URL");

  setModalStatus("מחבר MCP (HTTP)...");
  try {
    const r = await fetch("/api/mcps/add-http", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, url, label }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Attach failed");
    await renderState(data);
    setChip(`Servers: ${data.servers.length} | Tools: ${data.tools.length}`);
    setModalStatus("הוסף בהצלחה ✅");
  } catch (e) {
    setModalStatus("שגיאה: " + e.message);
  }
});

// Attach stdio
attachStdio.addEventListener("click", async () => {
  const id = stdioId.value.trim();
  const command = stdioCommand.value.trim();
  const label = stdioLabel.value.trim();
  const argsRaw = stdioArgs.value.trim();

  if (!id) return setModalStatus("חסר ID (למשל: localWeather)");
  if (!command) return setModalStatus("חסר Command (למשל: node)");

  let args = [];
  if (argsRaw) {
    try {
      args = JSON.parse(argsRaw);
      if (!Array.isArray(args)) throw new Error("Args must be JSON array");
    } catch (e) {
      return setModalStatus(
        'Args לא תקין. צריך JSON array. לדוגמה: ["src/index.js"]',
      );
    }
  }

  setModalStatus("מחבר MCP (stdio)...");
  try {
    const r = await fetch("/api/mcps/add-stdio", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, command, args, label }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Attach failed");
    await renderState(data);
    setChip(`Servers: ${data.servers.length} | Tools: ${data.tools.length}`);
    setModalStatus("הוסף בהצלחה ✅");
  } catch (e) {
    setModalStatus("שגיאה: " + e.message);
  }
});

// Refresh button
refreshBtn.addEventListener("click", async () => {
  try {
    await refreshTools();
  } catch (e) {
    alert("שגיאה ברענון: " + e.message);
    setChip("שגיאה");
  }
});

// Chat submit
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = input.value.trim();
  if (!msg) return;

  addBubble(msg, "me");
  input.value = "";
  input.focus();
  sendBtn.disabled = true;

  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: msg }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Chat failed");
    addBubble(data.reply || "(empty)", "bot");
  } catch (e) {
    addBubble("שגיאה: " + e.message, "bot");
  } finally {
    sendBtn.disabled = false;
  }
});

// init
(async () => {
  try {
    const data = await fetchMcps();
    await renderState(data);
    setChip(`Servers: ${data.servers.length} | Tools: ${data.tools.length}`);
  } catch (e) {
    setChip("שגיאה בטעינת מצב");
  }
})();
