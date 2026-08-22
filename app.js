/* ---------------------------- config & helpers ---------------------------- */
const CATEGORIES = [
  { name: "Groceries", color: "#3D5C43" },
  { name: "Dining", color: "#A8321F" },
  { name: "Transport", color: "#4A6C8C" },
  { name: "Shopping", color: "#8C5A9C" },
  { name: "Health", color: "#B0763C" },
  { name: "Entertainment", color: "#C48A2E" },
  { name: "Utilities", color: "#5A6B78" },
  { name: "Home", color: "#7A6A4F" },
  { name: "Other", color: "#8A8378" },
];
const catColor = (name) => (CATEGORIES.find((c) => c.name === name) || CATEGORIES.at(-1)).color;
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const pad = (n) => String(n).padStart(2, "0");
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* --------------------------------- storage --------------------------------- */
const STORE_KEY = "paperTrailReceipts";
function loadReceipts() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
  } catch {
    return [];
  }
}
function saveReceipts(list) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch (e) {
    console.error("save failed", e);
  }
}

/* ---------------------------------- state ----------------------------------- */
let receipts = loadReceipts();
let filterCat = "All";
let granularity = "day";
let expandedId = null;
let editingId = null;

function persist(next) {
  receipts = next;
  saveReceipts(receipts);
  renderAll();
}

/* ---------------------------------- dates ------------------------------------ */
function startOfWeek(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = (day + 6) % 7;
  date.setDate(date.getDate() - diff);
  date.setHours(0, 0, 0, 0);
  return date;
}
function periodKey(dateStr, g) {
  const d = new Date(dateStr + "T00:00:00");
  if (g === "day") return dateStr;
  if (g === "week") {
    const s = startOfWeek(d);
    return `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`;
  }
  return dateStr.slice(0, 7);
}
function periodLabel(key, g) {
  if (g === "month") {
    const [y, m] = key.split("-");
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  }
  const d = new Date(key + "T00:00:00");
  if (g === "week") return "Wk " + d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function shiftPeriod(key, g, delta) {
  if (g === "day") {
    const d = new Date(key + "T00:00:00");
    d.setDate(d.getDate() + delta);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  if (g === "week") {
    const d = new Date(key + "T00:00:00");
    d.setDate(d.getDate() + delta * 7);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/* --------------------------------- settings (API key) --------------------------------- */
const SETTINGS_KEY = "paperTrailSettings";
const DEFAULT_MODEL = "claude-sonnet-5";
function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    return {};
  }
}
function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch (e) {
    console.error("save settings failed", e);
  }
}
function getApiKey() {
  return (loadSettings().apiKey || "").trim();
}
function getModel() {
  return loadSettings().model || DEFAULT_MODEL;
}

/* --------------------------------- category guessing (fallback only) --------------------------------- */
// The AI extraction below picks its own category per item. These are only a safety net —
// used if the model returns something outside our category list.
const GROCERY_STORE_RE = /\b(netto|rema\s?1000|fakta|bilka|f[øo]tex|irma|lidl|aldi|meny|spar|super\s?brugsen|kvickly|coop)\b/i;
const CATEGORY_KEYWORDS = {
  Health: ["håndsprit","handsprit","sprit","medicin","vitamin","paracetamol","apotek","libresse","bind","tampon","plaster"],
  Home: ["pose","rengøring","opvask","toiletpapir","vaskepulver","køkkenrulle","affaldspose","lys ","stearinlys"],
  Dining: ["kaffe to go","bakery","bageri","café","restaurant","frokost"],
  Groceries: [
    "mælk","ost","hytteost","kylling","okse","laks","fisk","banan","æg","æggebægre","gulerødder","agurk","peber",
    "squash","iceberg","salat","avocado","blomme","blomkål","kakao","rugbrød","levain","solgryn","brød","frugt",
    "grønt","kød","mel","ris","pasta","yoghurt","smør","chokolade","kaffe","the","kartofl","tomat","løg","citron",
  ],
};
function guessCategory(product, store) {
  const p = (product || "").toLowerCase();
  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) {
    if (words.some((w) => p.includes(w))) return cat;
  }
  if (GROCERY_STORE_RE.test(store || "")) return "Groceries";
  return "Other";
}

const DEFAULT_CURRENCY = "kr.";

/* --------------------------------- AI vision extraction --------------------------------- */
function buildExtractionPrompt() {
  const catList = CATEGORIES.map((c) => c.name).join(", ");
  return `You are reading a photo of a shop receipt, most likely Danish, sometimes English. Extract structured purchase data, reasoning carefully about which price belongs to which line.

Rules:
- Danish receipts often show a discount as a separate "RABAT" line directly under the item it discounts, with a trailing "-" (e.g. "RABAT 7,00-"). Net this against the item above it — report that item's price AFTER the discount, and do not list "RABAT" as its own item.
- Multi-buy lines look like "2 x 40,00" followed by the line's actual total (e.g. "80,00"), sometimes on the same line, sometimes wrapped onto the next line. Use the TOTAL as the item's price, never the unit price. If a product name and its price are split across lines, still pair them into one item.
- The store name is the top line. The address (street + postal code/city) is usually the 1-2 lines right under it — put that in "location".
- Ignore lines for TOTAL, subtotal, VAT/MOMS, payment method (BETALINGSKORT/kort/kontant/MobilePay), till/receipt numbers, staff names, and barcodes — these are not purchased items.
- The printed TOTAL is ground truth for the receipt's total.
- Prices are plain numbers using a dot for decimals (convert Danish comma-decimals, e.g. "19,95" -> 19.95).
- For every item, pick the closest category from exactly this list: ${catList}.

Return ONLY strict JSON, no markdown fences, no commentary, in exactly this shape:
{"store":"string","location":"string (address, empty if not visible)","date":"YYYY-MM-DD","currency":"kr. or other currency symbol/code","items":[{"product":"string","price":number,"category":"one of the list above"}],"total":number}`;
}

async function callClaudeVision(base64) {
  const apiKey = getApiKey();
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: getModel(),
      max_tokens: 1500,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
            { type: "text", text: buildExtractionPrompt() },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    let msg = `Request failed (${response.status})`;
    try {
      const err = await response.json();
      msg = err?.error?.message || msg;
    } catch {}
    if (response.status === 401) throw new Error("That API key was rejected. Check it in Settings.");
    if (response.status === 429) throw new Error("Rate limited by Anthropic — wait a moment and try again.");
    throw new Error(msg);
  }

  const data = await response.json();
  const text = (data.content || []).map((b) => b.text || "").join("").trim();
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("The model didn't return readable data — try again.");
  const parsed = JSON.parse(clean.slice(start, end + 1));
  if (!Array.isArray(parsed.items)) throw new Error("Malformed response from the model.");
  return parsed;
}

// Resizes/compresses for upload. Kept in color — vision models read a real photo far
// better than a binarized black/white version, unlike on-device OCR.
function fileToBase64(file, maxDim = 2000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => (img.src = e.target.result);
    reader.onerror = reject;
    img.onload = () => {
      let { width, height } = img;
      if (width > height && width > maxDim) {
        height = Math.round((height * maxDim) / width);
        width = maxDim;
      } else if (height > maxDim) {
        width = Math.round((width * maxDim) / height);
        height = maxDim;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", 0.88).split(",")[1]);
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handleFile(file) {
  if (!file) return;
  showError(null);
  if (!getApiKey()) {
    showError("Add your Anthropic API key in Settings (gear icon, top right) before scanning.");
    openSettings();
    return;
  }
  showProgress(true, "Uploading photo…", 0.15);
  try {
    const base64 = await fileToBase64(file);
    showProgress(true, "Reading receipt with AI…", 0.55);
    const ai = await callClaudeVision(base64);
    const store = (ai.store || "Unknown store").toString().slice(0, 60);
    const items = (ai.items || []).map((it) => ({
      id: uid(),
      product: (it.product || "Item").toString().slice(0, 80),
      price: Number(it.price) || 0,
      category: CATEGORIES.some((c) => c.name === it.category) ? it.category : guessCategory(it.product, store),
    }));
    const total = Number(ai.total) || Math.round(items.reduce((s, i) => s + i.price, 0) * 100) / 100;
    const receipt = {
      id: uid(),
      store,
      location: (ai.location || "").toString().slice(0, 80),
      date: /^\d{4}-\d{2}-\d{2}$/.test(ai.date) ? ai.date : todayISO(),
      currency: ai.currency || DEFAULT_CURRENCY,
      items,
      total,
    };
    persist([receipt, ...receipts]);
    expandedId = receipt.id;
    editingId = receipt.id;
    renderAll();
  } catch (e) {
    console.error(e);
    showError(e.message || "Couldn't read that receipt. Try again, or add it manually below.");
  } finally {
    showProgress(false);
  }
}

function addManual() {
  const receipt = {
    id: uid(),
    store: "New receipt",
    location: "",
    date: todayISO(),
    currency: DEFAULT_CURRENCY,
    items: [{ id: uid(), product: "Item", price: 0, category: "Other" }],
    total: 0,
  };
  persist([receipt, ...receipts]);
  expandedId = receipt.id;
  editingId = receipt.id;
  renderAll();
}

/* ------------------------------- receipt mutators ------------------------------- */
function deleteReceipt(id) {
  persist(receipts.filter((r) => r.id !== id));
}
function updateReceipt(id, patch) {
  persist(receipts.map((r) => (r.id === id ? { ...r, ...patch } : r)));
}
function updateItem(rid, iid, patch) {
  persist(receipts.map((r) => (r.id !== rid ? r : { ...r, items: r.items.map((it) => (it.id === iid ? { ...it, ...patch } : it)) })));
}
function removeItem(rid, iid) {
  persist(receipts.map((r) => (r.id !== rid ? r : { ...r, items: r.items.filter((it) => it.id !== iid) })));
}
function addItem(rid) {
  persist(receipts.map((r) => (r.id !== rid ? r : { ...r, items: [...r.items, { id: uid(), product: "Item", price: 0, category: "Other" }] })));
}
function recalcTotal(rid) {
  persist(receipts.map((r) => (r.id !== rid ? r : { ...r, total: r.items.reduce((s, i) => s + (Number(i.price) || 0), 0) })));
}

/* ---------------------------------- analytics ---------------------------------- */
function flatItems() {
  return receipts.flatMap((r) => r.items.map((it) => ({ ...it, date: r.date })));
}
function quickStats() {
  const items = flatItems();
  const now = new Date();
  const tKey = todayISO();
  const wKey = (() => {
    const s = startOfWeek(now);
    return `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`;
  })();
  const mKey = tKey.slice(0, 7);
  let day = 0, week = 0, month = 0;
  for (const it of items) {
    const p = Number(it.price) || 0;
    if (it.date === tKey) day += p;
    if (periodKey(it.date, "week") === wKey) week += p;
    if (it.date.slice(0, 7) === mKey) month += p;
  }
  return { day, week, month };
}
function chartData() {
  const items = flatItems().filter((it) => filterCat === "All" || it.category === filterCat);
  const map = {};
  for (const it of items) {
    const k = periodKey(it.date, granularity);
    map[k] = (map[k] || 0) + (Number(it.price) || 0);
  }
  const count = granularity === "day" ? 14 : granularity === "week" ? 8 : 6;
  let cursor = periodKey(todayISO(), granularity);
  const keys = [];
  for (let i = 0; i < count; i++) {
    keys.unshift(cursor);
    cursor = shiftPeriod(cursor, granularity, -1);
  }
  return keys.map((k) => ({ key: k, label: periodLabel(k, granularity), value: Math.round((map[k] || 0) * 100) / 100 }));
}

/* ----------------------------------- render ------------------------------------ */
function showError(msg) {
  const box = document.getElementById("error-box");
  if (!msg) {
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }
  box.className = "error-box";
  box.style.display = "flex";
  box.innerHTML = `<span>&#9888;</span><span>${esc(msg)}</span>`;
}
function showProgress(on, label, progress) {
  document.getElementById("dz-idle").style.display = on ? "none" : "block";
  document.getElementById("dz-progress").style.display = on ? "flex" : "none";
  if (on) {
    document.getElementById("progress-text").textContent = label || "Working…";
    document.getElementById("progress-fill").style.width = `${Math.round((progress || 0) * 100)}%`;
  }
}

function renderStats() {
  const { day, week, month } = quickStats();
  document.getElementById("stats").innerHTML = ["Today", "This week", "This month"]
    .map((label, i) => {
      const val = [day, week, month][i];
      return `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value">${val.toFixed(2)} <span style="font-size:11px;color:var(--ink-light);font-weight:500;">kr.</span></div></div>`;
    })
    .join("");
}

function renderChips() {
  const all = [{ name: "All", color: "#2B2620" }, ...CATEGORIES];
  document.getElementById("chips").innerHTML = all
    .map((c) => {
      const active = filterCat === c.name;
      const style = active ? `background:${c.color};border-color:${c.color};` : "";
      return `<button class="chip ${active ? "active" : ""}" style="${style}" data-cat="${esc(c.name)}">${esc(c.name)}</button>`;
    })
    .join("");
}

function renderChart() {
  const data = chartData();
  const total = data.reduce((s, d) => s + d.value, 0);
  document.getElementById("panel-total-label").textContent =
    `${filterCat === "All" ? "Total" : filterCat} · last ${data.length} ${granularity === "day" ? "days" : granularity === "week" ? "weeks" : "months"}`;
  document.getElementById("panel-total-value").textContent = `${total.toFixed(2)} kr.`;

  document.querySelectorAll("#gtoggle button").forEach((b) => b.classList.toggle("active", b.dataset.g === granularity));

  const max = Math.max(1, ...data.map((d) => d.value));
  const w = document.getElementById("chart").clientWidth || 320;
  const h = 150;
  const n = data.length;
  const gap = 4;
  const barW = (w - gap * (n - 1)) / n;
  const color = filterCat === "All" ? "#3D5C43" : catColor(filterCat);

  let bars = "";
  let labels = "";
  data.forEach((d, i) => {
    const barH = Math.max(2, (d.value / max) * (h - 28));
    const x = i * (barW + gap);
    const y = h - 22 - barH;
    bars += `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" rx="2" fill="${color}"><title>${esc(d.label)}: ${d.value.toFixed(2)}</title></rect>`;
    if (n <= 14) {
      labels += `<text x="${x + barW / 2}" y="${h - 6}" font-size="9" fill="#736B5A" text-anchor="middle" font-family="IBM Plex Mono, monospace">${esc(d.label)}</text>`;
    }
  });
  document.getElementById("chart").innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}">${bars}${labels}</svg>`;
}

function tornPolygon(teeth = 22, depth = 6) {
  const pts = ["0% 0%", "100% 0%", "100% 100%"];
  for (let i = 0; i <= teeth; i++) {
    const x = 100 - (i / teeth) * 100;
    const y = i % 2 === 0 ? 100 : 100 - depth;
    pts.push(`${x.toFixed(2)}% ${y}%`);
  }
  pts.push("0% 100%");
  return `polygon(${pts.join(",")})`;
}
const TORN = tornPolygon();

function renderReceipts() {
  const sorted = [...receipts].sort((a, b) => (a.date < b.date ? 1 : -1));
  document.getElementById("count-label").textContent = `${sorted.length} receipt${sorted.length !== 1 ? "s" : ""}`;
  const list = document.getElementById("receipts-list");

  if (sorted.length === 0) {
    list.innerHTML = `<div class="empty-state">Nothing filed yet. Scan your first receipt above.</div>`;
    return;
  }

  list.innerHTML = sorted
    .map((r, idx) => {
      const isOpen = expandedId === r.id;
      const isEditing = editingId === r.id;
      const rot = ((idx % 3) - 1) * 0.35;

      const metaHtml = isEditing
        ? `<input class="f" type="date" data-act="set-date" data-id="${r.id}" value="${esc(r.date)}" style="width:130px;">
           <input class="f" placeholder="location" data-act="set-location" data-id="${r.id}" value="${esc(r.location)}" style="width:140px;">`
        : `<span>${esc(r.date)}</span>${r.location ? `<span>&#128205; ${esc(r.location)}</span>` : ""}`;

      const storeHtml = isEditing
        ? `<input class="f" data-act="set-store" data-id="${r.id}" value="${esc(r.store)}" style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:15px;margin-bottom:4px;">`
        : `<div class="r-store">&#128722; ${esc(r.store)}</div>`;

      const itemsHtml = !isOpen
        ? ""
        : `<div class="r-items">${r.items
            .map((it) => {
              if (isEditing) {
                const opts = CATEGORIES.map((c) => `<option value="${c.name}" ${it.category === c.name ? "selected" : ""}>${c.name}</option>`).join("");
                return `<div class="item-row">
                  <input class="f" data-act="set-item-name" data-rid="${r.id}" data-iid="${it.id}" value="${esc(it.product)}" style="flex:1;">
                  <input class="f" data-act="set-item-price" data-rid="${r.id}" data-iid="${it.id}" type="number" step="0.01" value="${it.price}" style="width:68px;">
                  <select class="f" data-act="set-item-cat" data-rid="${r.id}" data-iid="${it.id}" style="width:112px;">${opts}</select>
                  <button class="btn-icon" data-act="remove-item" data-rid="${r.id}" data-iid="${it.id}">&times;</button>
                </div>`;
              }
              return `<div class="item-row">
                <span class="dot" style="background:${catColor(it.category)}"></span>
                <span class="item-name">${esc(it.product)}</span>
                <span class="item-cat">${esc(it.category)}</span>
                <span class="item-price">${Number(it.price).toFixed(2)}</span>
              </div>`;
            })
            .join("")}
            ${isEditing ? `<button class="btn-icon" data-act="add-item" data-rid="${r.id}" style="color:#3D5C43;align-self:flex-start;">+ add item</button>` : ""}
          </div>`;

      return `<div class="receipt-card fade-in" style="clip-path:${TORN};transform:rotate(${rot}deg);">
        <div class="receipt-inner">
          <div class="r-top">
            <div style="flex:1;min-width:0;">
              ${storeHtml}
              <div class="r-meta">${metaHtml}</div>
            </div>
            <div style="text-align:right;">
              <div class="r-total">${Number(r.total).toFixed(2)} <span class="r-currency">${esc(r.currency)}</span></div>
            </div>
          </div>
          <div class="r-actions">
            <button class="btn-icon" data-act="toggle-open" data-id="${r.id}">${isOpen ? "&#9650;" : "&#9660;"} ${r.items.length} item${r.items.length !== 1 ? "s" : ""}</button>
            <button class="btn-icon" data-act="toggle-edit" data-id="${r.id}">${isEditing ? "&#10003; Done" : "&#9998; Edit"}</button>
            <button class="btn-icon" data-act="delete" data-id="${r.id}" style="color:#A8321F;margin-left:auto;">&#128465;</button>
          </div>
          ${itemsHtml}
        </div>
      </div>`;
    })
    .join("");
}

function renderAll() {
  renderStats();
  renderChips();
  renderChart();
  renderReceipts();
}

/* ------------------------------------ settings modal ------------------------------------- */
function openSettings() {
  const s = loadSettings();
  document.getElementById("settings-key").value = s.apiKey || "";
  document.getElementById("settings-model").value = s.model || DEFAULT_MODEL;
  document.getElementById("settings-modal").style.display = "flex";
}
function closeSettings() {
  document.getElementById("settings-modal").style.display = "none";
}
document.getElementById("btn-settings").addEventListener("click", openSettings);
document.getElementById("settings-backdrop").addEventListener("click", closeSettings);
document.getElementById("btn-settings-close").addEventListener("click", closeSettings);
document.getElementById("btn-settings-save").addEventListener("click", () => {
  const apiKey = document.getElementById("settings-key").value.trim();
  const model = document.getElementById("settings-model").value;
  saveSettings({ apiKey, model });
  closeSettings();
  showError(null);
});

/* ------------------------------------ events ------------------------------------- */
document.getElementById("btn-camera").addEventListener("click", () => document.getElementById("input-camera").click());
document.getElementById("btn-upload").addEventListener("click", () => document.getElementById("input-upload").click());
document.getElementById("btn-manual").addEventListener("click", addManual);
document.getElementById("input-camera").addEventListener("change", (e) => handleFile(e.target.files?.[0]));
document.getElementById("input-upload").addEventListener("change", (e) => handleFile(e.target.files?.[0]));

const dz = document.getElementById("dropzone");
dz.addEventListener("dragover", (e) => e.preventDefault());
dz.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files?.[0];
  if (f) handleFile(f);
});

document.getElementById("chips").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-cat]");
  if (!btn) return;
  filterCat = btn.dataset.cat;
  renderChips();
  renderChart();
});
document.getElementById("gtoggle").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-g]");
  if (!btn) return;
  granularity = btn.dataset.g;
  renderChart();
});

document.getElementById("receipts-list").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  if (act === "toggle-open") {
    expandedId = expandedId === id ? null : id;
    renderReceipts();
  } else if (act === "toggle-edit") {
    if (editingId === id) {
      recalcTotal(id);
      editingId = null;
    } else {
      editingId = id;
      expandedId = id;
    }
    renderReceipts();
  } else if (act === "delete") {
    deleteReceipt(id);
  } else if (act === "remove-item") {
    removeItem(btn.dataset.rid, btn.dataset.iid);
  } else if (act === "add-item") {
    addItem(btn.dataset.rid);
  }
});

document.getElementById("receipts-list").addEventListener("change", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  if (act === "set-store") updateReceipt(el.dataset.id, { store: el.value });
  else if (act === "set-date") updateReceipt(el.dataset.id, { date: el.value });
  else if (act === "set-location") updateReceipt(el.dataset.id, { location: el.value });
  else if (act === "set-item-name") updateItem(el.dataset.rid, el.dataset.iid, { product: el.value });
  else if (act === "set-item-price") updateItem(el.dataset.rid, el.dataset.iid, { price: Number(el.value) });
  else if (act === "set-item-cat") updateItem(el.dataset.rid, el.dataset.iid, { category: el.value });
});

window.addEventListener("resize", () => renderChart());

renderAll();
