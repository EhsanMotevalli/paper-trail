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

// Receipt photos are stored in IndexedDB, not localStorage — photos are much bigger
// than the JSON data (localStorage typically caps out around 5-10MB total), and
// IndexedDB has a far larger quota that's appropriate for images.
const IMG_DB_NAME = "paperTrailImages";
const IMG_STORE = "images";
let imgDbPromise = null;
function openImageDB() {
  if (!imgDbPromise) {
    imgDbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) { reject(new Error("IndexedDB unavailable")); return; }
      const req = indexedDB.open(IMG_DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IMG_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return imgDbPromise;
}
async function saveImage(id, dataUrl) {
  try {
    const db = await openImageDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IMG_STORE, "readwrite");
      tx.objectStore(IMG_STORE).put(dataUrl, id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error("saveImage failed", e);
    return false;
  }
}
async function getImage(id) {
  try {
    const db = await openImageDB();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(IMG_STORE, "readonly").objectStore(IMG_STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.error("getImage failed", e);
    return null;
  }
}
async function deleteImage(id) {
  try {
    const db = await openImageDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IMG_STORE, "readwrite");
      tx.objectStore(IMG_STORE).delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error("deleteImage failed", e);
    return false;
  }
}
async function getAllImages() {
  try {
    const db = await openImageDB();
    return await new Promise((resolve, reject) => {
      const store = db.transaction(IMG_STORE, "readonly").objectStore(IMG_STORE);
      const result = {};
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          result[cursor.key] = cursor.value;
          cursor.continue();
        } else {
          resolve(result);
        }
      };
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.error("getAllImages failed", e);
    return {};
  }
}
async function getAllImageKeys() {
  try {
    const db = await openImageDB();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(IMG_STORE, "readonly").objectStore(IMG_STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.error("getAllImageKeys failed", e);
    return [];
  }
}

/* ---------------------------------- state ----------------------------------- */
let receipts = loadReceipts();
let groups = loadGroups();
let currentFilter = { type: "all", value: null, label: "All" }; // type: all | category | group
let granularity = "day";
let expandedId = null;
let editingId = null;
let searchQuery = "";
let viewMode = "list"; // "list" | "photos"
let receiptsWithPhotos = new Set(); // receipt ids that have a saved photo (for the 📷 badge)
let photoImagesCache = {}; // receiptId -> dataURL, populated when the Photos tab loads

function persist(next) {
  receipts = next;
  saveReceipts(receipts);
  renderAll();
}

const GROUPS_KEY = "paperTrailGroups";
function loadGroups() {
  try {
    return JSON.parse(localStorage.getItem(GROUPS_KEY) || "[]");
  } catch {
    return [];
  }
}
function saveGroups(next) {
  groups = next;
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(groups));
  } catch (e) {
    console.error("save groups failed", e);
  }
}

// Categories the current filter covers — null means "no filter, everything".
function activeCategories() {
  if (currentFilter.type === "category") return [currentFilter.value];
  if (currentFilter.type === "group") {
    const g = groups.find((g) => g.id === currentFilter.value);
    return g ? g.categories : [];
  }
  return null;
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
- Danish receipts often show a discount as a separate "RABAT" line directly under the item it discounts, with a trailing "-" (e.g. "RABAT 7,00-"). Report the item's "price" as the NET amount actually paid AFTER the discount (e.g. 19,95 with a 7,00 rabat -> price 12.95), and separately report the discount amount in a "discount" field (7.00 in that example; use 0 if there was no discount on that line). Do not list "RABAT" as its own item.
- Multi-buy lines look like "2 x 40,00" followed by the line's actual total (e.g. "80,00"), sometimes on the same line, sometimes wrapped onto the next line. Use the TOTAL as the item's price, never the unit price. If a product name and its price are split across lines, still pair them into one item.
- The store name is the top line. The address (street + postal code/city) is usually the 1-2 lines right under it — put that in "location".
- Find the receipt/transaction reference — usually printed near the bottom, often a till number, a long numeric string, a timestamp, or a line like "Bon nr" / "Kvittering nr" / "Transaction #". This is what a customer would need to quote for a return or complaint. Put the most complete version of it (with any till/store number alongside it) in "receiptNumber" as plain text, exactly as printed. Use "" if nothing like this is visible.
- Ignore lines for TOTAL, subtotal, VAT/MOMS, payment method (BETALINGSKORT/kort/kontant/MobilePay), and staff names — these are not purchased items and are not the receipt number.
- The printed TOTAL is ground truth for the receipt's total.
- Prices are plain numbers using a dot for decimals (convert Danish comma-decimals, e.g. "19,95" -> 19.95).
- For every item, pick the closest category from exactly this list: ${catList}.

Return ONLY strict JSON, no markdown fences, no commentary, in exactly this shape:
{"store":"string","location":"string (address, empty if not visible)","date":"YYYY-MM-DD","currency":"kr. or other currency symbol/code","receiptNumber":"string, exactly as printed, empty if none","items":[{"product":"string","price":number,"discount":number,"category":"one of the list above"}],"total":number}`;
}

async function callClaudeVision(base64) {
  const apiKey = getApiKey();
  const model = getModel();
  // Structured extraction doesn't benefit from deliberation, and on Sonnet 5, adaptive
  // thinking is ON by default and shares the SAME token budget as the actual JSON
  // answer — with a modest max_tokens that reliably starved the answer and truncated
  // the JSON mid-way. Disabling thinking (Sonnet-5-only field) fixes that and is
  // faster/cheaper too. Also give plenty of headroom for long, many-item receipts.
  const body = {
    model,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
          { type: "text", text: buildExtractionPrompt() },
        ],
      },
    ],
  };
  if (model === "claude-sonnet-5") {
    body.thinking = { type: "disabled" };
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
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
  if (data.stop_reason === "max_tokens") {
    throw new Error("The receipt was too long for the reply to finish — try again (this should be fixed now, but a very long receipt can still hit the limit).");
  }
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
      discount: Number(it.discount) || 0, // gross line price = price + discount; used only for the built-receipt reconstruction
      category: CATEGORIES.some((c) => c.name === it.category) ? it.category : guessCategory(it.product, store),
    }));
    const total = Number(ai.total) || Math.round(items.reduce((s, i) => s + i.price, 0) * 100) / 100;
    const receipt = {
      id: uid(),
      store,
      location: (ai.location || "").toString().slice(0, 80),
      date: /^\d{4}-\d{2}-\d{2}$/.test(ai.date) ? ai.date : todayISO(),
      currency: ai.currency || DEFAULT_CURRENCY,
      receiptNumber: (ai.receiptNumber || "").toString().slice(0, 60),
      items,
      total,
    };
    showProgress(true, "Saving photo…", 0.92);
    const saved = await saveImage(receipt.id, `data:image/jpeg;base64,${base64}`);
    if (saved) receiptsWithPhotos.add(receipt.id);
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
  receiptsWithPhotos.delete(id);
  delete photoImagesCache[id];
  deleteImage(id);
  builtReceiptCache.delete(id);
}
function updateReceipt(id, patch) {
  persist(receipts.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  builtReceiptCache.delete(id);
}
function updateItem(rid, iid, patch) {
  persist(receipts.map((r) => (r.id !== rid ? r : { ...r, items: r.items.map((it) => (it.id === iid ? { ...it, ...patch } : it)) })));
  builtReceiptCache.delete(rid);
}
function removeItem(rid, iid) {
  persist(receipts.map((r) => (r.id !== rid ? r : { ...r, items: r.items.filter((it) => it.id !== iid) })));
  builtReceiptCache.delete(rid);
}
function addItem(rid) {
  persist(receipts.map((r) => (r.id !== rid ? r : { ...r, items: [...r.items, { id: uid(), product: "Item", price: 0, discount: 0, category: "Other" }] })));
  builtReceiptCache.delete(rid);
}
function recalcTotal(rid) {
  persist(receipts.map((r) => (r.id !== rid ? r : { ...r, total: r.items.reduce((s, i) => s + (Number(i.price) || 0), 0) })));
  builtReceiptCache.delete(rid);
}

/* ---------------------------------- analytics ---------------------------------- */
function flatItems() {
  return receipts.flatMap((r) => r.items.map((it) => ({ ...it, date: r.date, store: r.store, receiptId: r.id })));
}
function quickStats() {
  const items = flatItems();
  const now = new Date();
  const tKey = todayISO();
  const yKey = shiftPeriod(tKey, "day", -1);
  const wKey = periodKey(tKey, "week");
  const pwKey = shiftPeriod(wKey, "week", -1);
  const mKey = tKey.slice(0, 7);
  const pmKey = shiftPeriod(mKey, "month", -1);
  let day = 0, week = 0, month = 0, prevDay = 0, prevWeek = 0, prevMonth = 0;
  for (const it of items) {
    const p = Number(it.price) || 0;
    if (it.date === tKey) day += p;
    if (it.date === yKey) prevDay += p;
    if (periodKey(it.date, "week") === wKey) week += p;
    if (periodKey(it.date, "week") === pwKey) prevWeek += p;
    if (it.date.slice(0, 7) === mKey) month += p;
    if (it.date.slice(0, 7) === pmKey) prevMonth += p;
  }
  return { day, week, month, prevDay, prevWeek, prevMonth };
}
function chartData() {
  const cats = activeCategories();
  const items = flatItems().filter((it) => !cats || cats.includes(it.category));
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
// Sum for the equivalent window immediately BEFORE the given chart data — used for trend badges.
function previousWindowSum(data) {
  if (!data.length) return 0;
  const cats = activeCategories();
  const items = flatItems().filter((it) => !cats || cats.includes(it.category));
  let cursor = shiftPeriod(data[0].key, granularity, -1);
  const prevKeys = new Set();
  for (let i = 0; i < data.length; i++) {
    prevKeys.add(cursor);
    cursor = shiftPeriod(cursor, granularity, -1);
  }
  return items.reduce((s, it) => (prevKeys.has(periodKey(it.date, granularity)) ? s + (Number(it.price) || 0) : s), 0);
}
function trendBadge(current, previous) {
  if (!previous || previous <= 0) return "";
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return `<span class="trend-flat">— flat</span>`;
  const up = pct > 0;
  return `<span class="${up ? "trend-up" : "trend-down"}">${up ? "▲" : "▼"} ${Math.abs(pct)}%</span>`;
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
  const s = quickStats();
  const cards = [
    ["Today", s.day, s.prevDay],
    ["This week", s.week, s.prevWeek],
    ["This month", s.month, s.prevMonth],
  ];
  document.getElementById("stats").innerHTML = cards
    .map(
      ([label, val, prev]) => `<div class="stat-card">
        <div class="stat-label">${label}</div>
        <div class="stat-value">${val.toFixed(2)} <span style="font-size:11px;color:var(--ink-light);font-weight:500;">kr.</span></div>
        <div style="font-size:10px;margin-top:3px;">${trendBadge(val, prev)}</div>
      </div>`
    )
    .join("");
}

function renderChips() {
  const allActive = currentFilter.type === "all";
  const catChips = CATEGORIES.map((c) => {
    const active = currentFilter.type === "category" && currentFilter.value === c.name;
    const style = active ? `background:${c.color};border-color:${c.color};` : "";
    return `<button class="chip ${active ? "active" : ""}" style="${style}" data-filter-cat="${esc(c.name)}">${esc(c.name)}</button>`;
  }).join("");
  const groupChips = groups
    .map((g) => {
      const active = currentFilter.type === "group" && currentFilter.value === g.id;
      const style = active ? `background:#2B2620;border-color:#2B2620;` : "";
      return `<span class="chip ${active ? "active" : ""}" style="${style}display:inline-flex;align-items:center;padding-right:2px;">
        <span data-filter-group="${g.id}" style="padding-right:4px;">${esc(g.name)}</span>
        <button class="chip-remove" data-remove-group="${g.id}" title="Delete group" style="${active ? "color:white;" : ""}">&times;</button>
      </span>`;
    })
    .join("");
  document.getElementById("chips").innerHTML =
    `<button class="chip ${allActive ? "active" : ""}" style="${allActive ? "background:#2B2620;border-color:#2B2620;" : ""}" data-filter-all>All</button>` +
    catChips +
    groupChips +
    `<button class="chip chip-add" data-add-group>+ Group</button>`;
}

function renderChart() {
  const data = chartData();
  const total = data.reduce((s, d) => s + d.value, 0);
  const prevTotal = previousWindowSum(data);
  document.getElementById("panel-total-label").textContent =
    `${currentFilter.label} · last ${data.length} ${granularity === "day" ? "days" : granularity === "week" ? "weeks" : "months"}`;
  document.getElementById("panel-total-value").innerHTML =
    `${total.toFixed(2)} kr. <span style="font-size:12px;margin-left:4px;">${trendBadge(total, prevTotal)}</span>`;

  document.querySelectorAll("#gtoggle button").forEach((b) => b.classList.toggle("active", b.dataset.g === granularity));

  const max = Math.max(1, ...data.map((d) => d.value));
  const w = document.getElementById("chart").clientWidth || 320;
  const h = 150;
  const n = data.length;
  const gap = 4;
  const barW = (w - gap * (n - 1)) / n;
  const color = currentFilter.type === "category" ? catColor(currentFilter.value) : "#3D5C43";

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
            ${receiptsWithPhotos.has(r.id) ? `<button class="btn-icon" data-act="view-photo" data-id="${r.id}" title="View original photo">&#128247;</button>` : ""}
            <button class="btn-icon" data-act="view-built" data-id="${r.id}" title="View built receipt">&#129534;</button>
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
  renderMonthLookup();
  renderSearchOrList();
  if (viewMode === "photos") renderPhotosGrid();
  if (viewMode === "built") renderBuiltGrid();
}

/* ------------------------------------ month lookup ------------------------------------- */
function renderMonthLookup() {
  const picker = document.getElementById("month-picker");
  const val = picker.value || todayISO().slice(0, 7);
  if (!picker.value) picker.value = val;

  const items = flatItems().filter((it) => it.date.slice(0, 7) === val);
  const total = items.reduce((s, i) => s + (Number(i.price) || 0), 0);
  const byCat = {};
  for (const it of items) byCat[it.category] = (byCat[it.category] || 0) + (Number(it.price) || 0);
  const rows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const maxCat = Math.max(1, ...rows.map((r) => r[1]));

  const [y, m] = val.split("-");
  const monthLabel = new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });

  document.getElementById("month-results").innerHTML = `
    <div style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:24px;margin-top:8px;">${total.toFixed(2)} kr.</div>
    <div style="font-size:11px;color:var(--ink-light);margin-bottom:14px;">${esc(monthLabel)}${items.length ? ` · ${items.length} item${items.length !== 1 ? "s" : ""}` : ""}</div>
    ${
      rows.length === 0
        ? `<div class="empty-state" style="padding:6px 0 4px;">No spending recorded that month.</div>`
        : rows
            .map(
              ([cat, amt]) => `
        <div class="month-cat-row">
          <span class="dot" style="background:${catColor(cat)}"></span>
          <span style="flex:1;">${esc(cat)}</span>
          <span style="color:var(--ink-light);">${amt.toFixed(2)} kr.</span>
        </div>
        <div class="month-cat-bar-track"><div class="month-cat-bar-fill" style="width:${Math.round((amt / maxCat) * 100)}%;background:${catColor(cat)};"></div></div>`
            )
            .join("")
    }
  `;
}

/* ------------------------------------ search ------------------------------------- */
function renderSearchOrList() {
  const resultsEl = document.getElementById("search-results");
  if (!searchQuery) {
    resultsEl.innerHTML = "";
    renderReceipts();
    applyViewVisibility();
    return;
  }

  const q = searchQuery.toLowerCase();
  const matches = flatItems().filter((it) => it.product.toLowerCase().includes(q));
  matches.sort((a, b) => (a.date < b.date ? 1 : -1));
  const totalSpent = matches.reduce((s, m) => s + (Number(m.price) || 0), 0);

  document.getElementById("count-label").textContent = `${matches.length} match${matches.length !== 1 ? "es" : ""} for "${searchQuery}"`;

  resultsEl.innerHTML =
    matches.length === 0
      ? `<div class="empty-state">No items match "${esc(searchQuery)}".</div>`
      : `<div class="search-summary">Total on matches: <strong style="color:var(--ink);">${totalSpent.toFixed(2)} kr.</strong></div>` +
        matches
          .map(
            (m) => `
      <div class="search-result" data-open-receipt="${m.receiptId}">
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="dot" style="background:${catColor(m.category)}"></span>
          <span style="flex:1;font-size:13px;">${esc(m.product)}</span>
          <span style="font-weight:600;font-size:13px;">${Number(m.price).toFixed(2)} kr.</span>
        </div>
        <div style="font-size:11px;color:var(--ink-light);margin-left:15px;margin-top:2px;">${esc(m.store)} · ${esc(m.date)}</div>
      </div>`
          )
          .join("");
  applyViewVisibility();
}

/* ------------------------------------ built-receipt image ------------------------------------- */
// Renders a clean "reprint" of a receipt as a canvas, mirroring the original's
// structure: item lines with a RABAT/discount line under any item that had one
// (older receipts saved before the discount field existed just won't show that row).
function wrapCanvasText(ctx, text, maxWidth) {
  const words = String(text || "").split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function renderReceiptCanvas(r) {
  const W = 420;
  const padX = 26;
  const contentW = W - padX * 2;
  const lineH = 22;
  const FONT_BODY = "14px 'Courier New', monospace";
  const FONT_STORE = "bold 19px 'Courier New', monospace";
  const FONT_SMALL = "12px 'Courier New', monospace";
  const FONT_TOTAL = "bold 16px 'Courier New', monospace";
  const FONT_FOOT = "italic 10px 'Courier New', monospace";
  const INK = "#2B2620", INK_LIGHT = "#736B5A", STAMP = "#A8321F", LINE = "#D4CBB8", PAPER = "#F5F1E8", MUTED = "#8A8378";

  // Measuring canvas for layout math before we know final height.
  const measure = document.createElement("canvas").getContext("2d");
  measure.font = FONT_BODY;
  const itemBlocks = (r.items || []).map((it) => {
    const priceStr = `${Number(it.price).toFixed(2)}`;
    const priceW = measure.measureText(priceStr).width;
    const nameLines = wrapCanvasText(measure, it.product, contentW - priceW - 14);
    const discount = Number(it.discount) || 0;
    return { nameLines, priceStr, discountStr: discount > 0 ? `-${discount.toFixed(2)}` : null };
  });
  let bodyLines = 0;
  itemBlocks.forEach((b) => { bodyLines += b.nameLines.length + (b.discountStr ? 1 : 0); });

  measure.font = FONT_SMALL;
  const receiptNoLines = r.receiptNumber ? wrapCanvasText(measure, `Ref: ${r.receiptNumber}`, contentW) : [];

  const height = 46 + 24 + (r.location ? 18 : 0) + 26 + bodyLines * lineH + 24 + 26 + 22 + receiptNoLines.length * 16 + 34 + 20;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = Math.max(height, 260);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let y = 40;
  ctx.textAlign = "center";
  ctx.fillStyle = INK;
  ctx.font = FONT_STORE;
  ctx.fillText(r.store || "Receipt", W / 2, y);
  y += 24;

  if (r.location) {
    ctx.font = FONT_SMALL;
    ctx.fillStyle = INK_LIGHT;
    ctx.fillText(r.location, W / 2, y);
    y += 18;
  }
  y += 12;

  const dashLine = () => {
    ctx.strokeStyle = LINE;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padX, y);
    ctx.lineTo(W - padX, y);
    ctx.stroke();
    ctx.setLineDash([]);
  };
  dashLine();
  y += 22;

  ctx.textAlign = "left";
  ctx.font = FONT_BODY;
  itemBlocks.forEach((b) => {
    b.nameLines.forEach((nl, i) => {
      ctx.fillStyle = INK;
      ctx.textAlign = "left";
      ctx.fillText(nl, padX, y);
      if (i === 0) {
        ctx.textAlign = "right";
        ctx.fillText(b.priceStr, W - padX, y);
      }
      y += lineH;
    });
    if (b.discountStr) {
      ctx.fillStyle = STAMP;
      ctx.textAlign = "left";
      ctx.fillText("RABAT", padX + 10, y);
      ctx.textAlign = "right";
      ctx.fillText(b.discountStr, W - padX, y);
      y += lineH;
    }
  });

  y += 4;
  dashLine();
  y += 26;

  ctx.font = FONT_TOTAL;
  ctx.fillStyle = INK;
  ctx.textAlign = "left";
  ctx.fillText("TOTAL", padX, y);
  ctx.textAlign = "right";
  ctx.fillText(`${Number(r.total).toFixed(2)} ${r.currency || ""}`.trim(), W - padX, y);
  y += 24;

  ctx.font = FONT_SMALL;
  ctx.fillStyle = INK_LIGHT;
  ctx.textAlign = "left";
  ctx.fillText(r.date || "", padX, y);
  y += 20;

  if (receiptNoLines.length) {
    ctx.font = FONT_SMALL;
    ctx.fillStyle = INK_LIGHT;
    ctx.textAlign = "left";
    receiptNoLines.forEach((line) => {
      ctx.fillText(line, padX, y);
      y += 16;
    });
    y += 12;
  } else {
    y += 12;
  }

  ctx.font = FONT_FOOT;
  ctx.fillStyle = MUTED;
  ctx.textAlign = "center";
  ctx.fillText("Reconstructed from scanned receipt data", W / 2, y);

  return canvas;
}

const builtReceiptCache = new Map(); // receiptId -> dataURL, invalidated whenever that receipt changes
function getBuiltReceiptDataUrl(r) {
  if (builtReceiptCache.has(r.id)) return builtReceiptCache.get(r.id);
  const dataUrl = renderReceiptCanvas(r).toDataURL("image/png");
  builtReceiptCache.set(r.id, dataUrl);
  return dataUrl;
}

function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
async function shareDataUrl(dataUrl, filename, title) {
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title });
      return;
    }
  } catch (e) {
    console.warn("share unavailable, falling back to download:", e);
  }
  downloadDataUrl(dataUrl, filename);
}
function safeFilename(s) {
  return String(s || "receipt").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "receipt";
}

/* ------------------------------------ photos & built-receipts tabs ------------------------------------- */
async function renderPhotosGrid() {
  const grid = document.getElementById("photos-grid");
  grid.innerHTML = `<div class="empty-state">Loading photos…</div>`;
  photoImagesCache = await getAllImages();
  const withPhotos = receipts.filter((r) => photoImagesCache[r.id]);
  document.getElementById("count-label").textContent = `${withPhotos.length} photo${withPhotos.length !== 1 ? "s" : ""}`;

  if (withPhotos.length === 0) {
    grid.innerHTML = `<div class="empty-state">No saved photos yet — receipts you scan from now on will appear here.</div>`;
    return;
  }
  const sorted = [...withPhotos].sort((a, b) => (a.date < b.date ? 1 : -1));
  grid.innerHTML = sorted
    .map(
      (r) => `
    <button class="photo-thumb" data-open-photo="${r.id}">
      <img src="${photoImagesCache[r.id]}" alt="${esc(r.store)} receipt" loading="lazy" />
      <div class="photo-thumb-label">${esc(r.store)}<br><span>${esc(r.date)}</span></div>
    </button>`
    )
    .join("");
}

function renderBuiltGrid() {
  const grid = document.getElementById("built-grid");
  document.getElementById("count-label").textContent = `${receipts.length} built receipt${receipts.length !== 1 ? "s" : ""}`;
  if (receipts.length === 0) {
    grid.innerHTML = `<div class="empty-state">No receipts yet — scan one to see it here.</div>`;
    return;
  }
  const sorted = [...receipts].sort((a, b) => (a.date < b.date ? 1 : -1));
  grid.innerHTML = sorted
    .map(
      (r) => `
    <button class="photo-thumb" data-open-built="${r.id}">
      <img src="${getBuiltReceiptDataUrl(r)}" alt="${esc(r.store)} built receipt" loading="lazy" />
      <div class="photo-thumb-label">${esc(r.store)}<br><span>${esc(r.date)}</span></div>
    </button>`
    )
    .join("");
}

function openLightbox(id, dataUrl, store, date, mode) {
  document.getElementById("lightbox-img").src = dataUrl;
  document.getElementById("lightbox-caption").textContent = [mode === "built" ? "Built receipt" : "Original photo", store, date].filter(Boolean).join(" · ");
  document.getElementById("btn-lightbox-view").dataset.receiptId = id;
  document.getElementById("btn-lightbox-download").dataset.filename = `${safeFilename(store)}-${date}-${mode}.png`;
  document.getElementById("btn-lightbox-download").dataset.url = dataUrl;
  document.getElementById("btn-lightbox-share").dataset.filename = `${safeFilename(store)}-${date}-${mode}.png`;
  document.getElementById("btn-lightbox-share").dataset.url = dataUrl;
  document.getElementById("btn-lightbox-share").dataset.title = `${store} receipt`;
  document.getElementById("image-lightbox").style.display = "flex";
}
function closeLightbox() {
  document.getElementById("image-lightbox").style.display = "none";
  document.getElementById("lightbox-img").src = "";
}

document.getElementById("photos-grid").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-open-photo]");
  if (!btn) return;
  const id = btn.dataset.openPhoto;
  const r = receipts.find((x) => x.id === id);
  const dataUrl = photoImagesCache[id];
  if (!dataUrl) return;
  openLightbox(id, dataUrl, r ? r.store : "", r ? r.date : "", "photo");
});
document.getElementById("built-grid").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-open-built]");
  if (!btn) return;
  const id = btn.dataset.openBuilt;
  const r = receipts.find((x) => x.id === id);
  if (!r) return;
  openLightbox(id, getBuiltReceiptDataUrl(r), r.store, r.date, "built");
});
document.getElementById("lightbox-backdrop").addEventListener("click", closeLightbox);
document.getElementById("btn-lightbox-close").addEventListener("click", closeLightbox);
document.getElementById("btn-lightbox-download").addEventListener("click", (e) => {
  const { url, filename } = e.currentTarget.dataset;
  if (url) downloadDataUrl(url, filename);
});
document.getElementById("btn-lightbox-share").addEventListener("click", (e) => {
  const { url, filename, title } = e.currentTarget.dataset;
  if (url) shareDataUrl(url, filename, title);
});
document.getElementById("btn-lightbox-view").addEventListener("click", (e) => {
  const id = e.currentTarget.dataset.receiptId;
  closeLightbox();
  viewMode = "list";
  document.querySelectorAll("#view-toggle button").forEach((b) => b.classList.toggle("active", b.dataset.view === "list"));
  searchQuery = "";
  document.getElementById("search-input").value = "";
  expandedId = id;
  editingId = null;
  applyViewVisibility();
  renderSearchOrList();
  document.getElementById("receipts-list").scrollIntoView({ behavior: "smooth", block: "start" });
});

document.getElementById("view-toggle").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-view]");
  if (!btn) return;
  viewMode = btn.dataset.view;
  document.querySelectorAll("#view-toggle button").forEach((b) => b.classList.toggle("active", b.dataset.view === viewMode));
  applyViewVisibility();
  if (viewMode === "photos") renderPhotosGrid();
  if (viewMode === "built") renderBuiltGrid();
});

function applyViewVisibility() {
  const hasQuery = !!searchQuery;
  const isList = viewMode === "list";
  document.getElementById("search-input").style.display = isList ? "" : "none";
  document.getElementById("search-results").style.display = isList && hasQuery ? "block" : "none";
  document.getElementById("receipts-list").style.display = isList && !hasQuery ? "" : "none";
  document.getElementById("photos-grid").style.display = viewMode === "photos" ? "grid" : "none";
  document.getElementById("built-grid").style.display = viewMode === "built" ? "grid" : "none";
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
  if (e.target.closest("[data-filter-all]")) {
    currentFilter = { type: "all", value: null, label: "All" };
    renderChips();
    renderChart();
    return;
  }
  const catBtn = e.target.closest("[data-filter-cat]");
  if (catBtn) {
    currentFilter = { type: "category", value: catBtn.dataset.filterCat, label: catBtn.dataset.filterCat };
    renderChips();
    renderChart();
    return;
  }
  const removeBtn = e.target.closest("[data-remove-group]");
  if (removeBtn) {
    const id = removeBtn.dataset.removeGroup;
    const g = groups.find((g) => g.id === id);
    if (g && confirm(`Delete the "${g.name}" group? (This won't delete any receipts.)`)) {
      saveGroups(groups.filter((g) => g.id !== id));
      if (currentFilter.type === "group" && currentFilter.value === id) {
        currentFilter = { type: "all", value: null, label: "All" };
      }
      renderChips();
      renderChart();
    }
    return;
  }
  const groupBtn = e.target.closest("[data-filter-group]");
  if (groupBtn) {
    const id = groupBtn.dataset.filterGroup;
    const g = groups.find((g) => g.id === id);
    if (g) {
      currentFilter = { type: "group", value: g.id, label: g.name };
      renderChips();
      renderChart();
    }
    return;
  }
  if (e.target.closest("[data-add-group]")) {
    openGroupForm();
  }
});

function openGroupForm() {
  document.getElementById("group-cat-checks").innerHTML = CATEGORIES.map(
    (c) => `<label class="group-cat-check"><input type="checkbox" value="${esc(c.name)}"> ${esc(c.name)}</label>`
  ).join("");
  document.getElementById("group-name").value = "";
  document.getElementById("group-form").style.display = "block";
}
function closeGroupForm() {
  document.getElementById("group-form").style.display = "none";
}
document.getElementById("btn-group-cancel").addEventListener("click", closeGroupForm);
document.getElementById("btn-group-save").addEventListener("click", () => {
  const name = document.getElementById("group-name").value.trim();
  const checked = Array.from(document.querySelectorAll("#group-cat-checks input:checked")).map((el) => el.value);
  if (!name || checked.length === 0) {
    alert("Give the group a name and pick at least one category.");
    return;
  }
  const g = { id: uid(), name: name.slice(0, 24), categories: checked };
  saveGroups([...groups, g]);
  currentFilter = { type: "group", value: g.id, label: g.name };
  closeGroupForm();
  renderChips();
  renderChart();
});

document.getElementById("gtoggle").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-g]");
  if (!btn) return;
  granularity = btn.dataset.g;
  renderChart();
});

document.getElementById("month-picker").addEventListener("change", renderMonthLookup);

document.getElementById("search-input").addEventListener("input", (e) => {
  searchQuery = e.target.value.trim();
  renderSearchOrList();
});
document.getElementById("search-results").addEventListener("click", (e) => {
  const el = e.target.closest("[data-open-receipt]");
  if (!el) return;
  document.getElementById("search-input").value = "";
  searchQuery = "";
  expandedId = el.dataset.openReceipt;
  editingId = null;
  renderSearchOrList();
  document.getElementById("receipts-list").scrollIntoView({ behavior: "smooth", block: "start" });
});

document.getElementById("receipts-list").addEventListener("click", async (e) => {
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
  } else if (act === "view-photo") {
    const dataUrl = photoImagesCache[id] || (await getImage(id));
    if (dataUrl) {
      photoImagesCache[id] = dataUrl;
      const r = receipts.find((x) => x.id === id);
      openLightbox(id, dataUrl, r ? r.store : "", r ? r.date : "", "photo");
    }
  } else if (act === "view-built") {
    const r = receipts.find((x) => x.id === id);
    if (r) openLightbox(id, getBuiltReceiptDataUrl(r), r.store, r.date, "built");
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

// Preload which receipts have a saved photo (just the keys, not the images) so the
// 📷 badge on each card is accurate without having to open the Photos tab first.
getAllImageKeys().then((keys) => {
  receiptsWithPhotos = new Set(keys);
  if (viewMode === "list" && !searchQuery) renderReceipts();
});
