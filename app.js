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

/* ------------------------------ receipt parsing ------------------------------ */
function parseDate(text) {
  let m = text.match(/(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = text.match(/(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/);
  if (m) {
    let [, a, b, y] = m;
    if (y.length === 2) y = "20" + y;
    let day = a, month = b;
    if (Number(a) > 12) { day = a; month = b; } else if (Number(b) > 12) { day = b; month = a; }
    if (Number(month) > 12) return null;
    return `${y}-${pad(month)}-${pad(day)}`;
  }
  return null;
}

const DEFAULT_CURRENCY = "kr.";

function detectCurrency(text) {
  if (/\bDKK\b/i.test(text) || /\bkr\.?\b/i.test(text)) return "kr.";
  if (/\$/.test(text)) return "$";
  if (/€/.test(text)) return "€";
  if (/£/.test(text)) return "£";
  const m = text.match(/\b(USD|EUR|GBP|SEK|NOK)\b/i);
  if (m) return m[1].toUpperCase();
  return DEFAULT_CURRENCY;
}

const SKIP_WORDS = /\b(subtotal|sub\s*total|delsum|total|i\s*alt|ialt|tax|vat|moms|udgør|afgift|change|byttepenge|cash|kontant|card|kort|dankort|betalingskort|balance|saldo|amount due|beløb|tender|visa|mastercard|payment|betaling|thank you|tak|receipt|kvittering|bon|approved|godkendt|butik|momsnr|betjent)\b/i;
const DISCOUNT_RE = /\b(rabat|discount)\b/i;

// Parses a number that may be Danish-style "1.234,56" (period thousands, comma decimal)
// or standard "1,234.56" (comma thousands, period decimal). A trailing "-" (Danish
// receipts mark discounts this way) makes it negative.
function parsePriceString(str) {
  str = str.trim();
  const negative = /-\s*$/.test(str);
  str = str.replace(/-\s*$/, "").trim();
  const lastComma = str.lastIndexOf(",");
  const lastDot = str.lastIndexOf(".");
  let decimalSep = null;
  if (lastComma > -1 && lastDot > -1) decimalSep = lastComma > lastDot ? "," : ".";
  else if (lastComma > -1) decimalSep = ",";
  else if (lastDot > -1) decimalSep = ".";
  let value;
  if (!decimalSep) value = parseFloat(str);
  else {
    const thousandSep = decimalSep === "," ? "." : ",";
    value = parseFloat(str.split(thousandSep).join("").replace(decimalSep, "."));
  }
  return negative ? -value : value;
}

// Matches a number at the end of a line, Danish or standard style, optionally with a
// trailing "-" (discount) or "kr"/"dkk" suffix.
const TRAILING_PRICE_RE = /(\d[\d.,]{0,10}\d{2})\s*(-)?\s*(?:kr\.?|dkk)?\s*$/i;

// Receipts often wrap a single item across 2-3 lines: the product name (and sometimes
// a size/description line) comes first with no price, then a line like "2 x 40,00   80,00"
// carries the actual line total. This buffers text-only lines and attaches them to the
// next line that does carry a price, so "MAMONE KAKAO" + "2 x 40,00 80,00" becomes one
// row instead of a dangling name and an orphaned "2 x 40,00" fragment.
function mergeMultilineRows(lines) {
  const merged = [];
  let buffer = [];
  for (const line of lines) {
    if (TRAILING_PRICE_RE.test(line)) {
      merged.push(buffer.length ? `${buffer.join(" ")} ${line}` : line);
      buffer = [];
    } else {
      buffer.push(line);
      if (buffer.length > 2) buffer.shift(); // cap: item names rarely span 3+ lines
    }
  }
  return merged;
}

/* --------------------------------- category guessing --------------------------------- */
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

function parseReceiptText(raw) {
  const rawLines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 1);
  const lines = mergeMultilineRows(rawLines);

  const storeLine = lines.find((l) => !/^\d+$/.test(l) && l.replace(/[^a-zA-ZæøåÆØÅ]/g, "").length >= 3) || lines[0] || "Unknown store";

  let items = [];
  let totalCandidates = [];

  for (const line of lines) {
    const m = line.match(TRAILING_PRICE_RE);
    if (!m) continue;
    const price = parsePriceString(m[1] + (m[2] || ""));
    if (Number.isNaN(price) || price === 0) continue;
    const label = line.slice(0, m.index).replace(/[.\-·_\s]+$/, "").trim();
    const isTotalLine = /\b(total|i\s*alt|ialt)\b/i.test(line);
    const isSubLine = /\b(subtotal|sub\s*total|delsum)\b/i.test(line);

    if (isTotalLine && !isSubLine) {
      totalCandidates.push(Math.abs(price));
      continue;
    }
    if (DISCOUNT_RE.test(line) && price < 0) {
      // Net the discount against the item right above it — that's what was actually paid.
      if (items.length > 0) items[items.length - 1].price = Math.max(0, items[items.length - 1].price + price);
      continue;
    }
    if (SKIP_WORDS.test(line)) continue;
    if (!label || label.length < 2 || price < 0) continue;
    items.push({ id: uid(), product: label, price, category: guessCategory(label, storeLine) });
  }

  const total = totalCandidates.length
    ? Math.max(...totalCandidates)
    : Math.round(items.reduce((s, i) => s + i.price, 0) * 100) / 100;

  const date = parseDate(raw) || todayISO();
  const currency = detectCurrency(raw);

  if (items.length === 0 && total > 0) {
    items.push({ id: uid(), product: "Purchase", price: total, category: guessCategory("", storeLine) });
  } else if (totalCandidates.length) {
    // A printed total is ground truth. If OCR dropped a line or misread it, the item
    // list won't add up — reconcile so category totals still match what was paid.
    const itemsSum = Math.round(items.reduce((s, i) => s + i.price, 0) * 100) / 100;
    const diff = Math.round((total - itemsSum) * 100) / 100;
    if (diff >= 0.05) {
      items.push({ id: uid(), product: "Unmatched line(s)", price: diff, category: "Other" });
    }
  }

  return { store: storeLine.slice(0, 60), location: "", date, currency, items, total };
}

/* --------------------------------- OCR flow ----------------------------------- */
// Converts to grayscale and binarizes with Otsu's method — thermal receipt photos
// (uneven lighting, slight glare, faint print) OCR far more reliably as clean black
// text on white than as a color/contrast-filtered photo.
function binarize(canvas) {
  const ctx = canvas.getContext("2d");
  const { width: w, height: h } = canvas;
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  const hist = new Array(256).fill(0);
  for (let i = 0; i < d.length; i += 4) {
    const gray = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    d[i] = d[i + 1] = d[i + 2] = gray;
    hist[gray]++;
  }
  const total = w * h;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, maxVar = 0, threshold = 140;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varBetween > maxVar) { maxVar = varBetween; threshold = t; }
  }
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] > threshold ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(imgData, 0, 0);
}

function fileToDataUrl(file, maxDim = 1800) {
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
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      binarize(canvas);
      resolve(canvas.toDataURL("image/jpeg", 0.9));
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ------------------------------- smart reader (on-device LLM) ------------------------------- */
// Small (~250M param) instruction model, loaded lazily on first scan and cached by the
// browser/service worker afterwards. If it fails to load or times out, the app falls
// back to the rule-based parser above — the LLM only ever refines, never blocks.
const LLM_MODEL = "Xenova/LaMini-Flan-T5-248M";
let llmPipelinePromise = null;

function getLLM() {
  if (!llmPipelinePromise) {
    llmPipelinePromise = (async () => {
      const { pipeline, env } = await import("https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2");
      env.allowLocalModels = false;
      return pipeline("text2text-generation", LLM_MODEL, {
        quantized: true,
        progress_callback: (p) => {
          if (p.status === "progress" && typeof p.progress === "number") {
            showProgress(true, `Downloading smart reader (one-time)… ${Math.round(p.progress)}%`, p.progress / 100);
          }
        },
      });
    })();
  }
  return llmPipelinePromise;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("smart reader timed out")), ms)),
  ]);
}

function buildLLMPrompt(rawText) {
  const catList = CATEGORIES.map((c) => c.name).join(", ");
  return `Read this messy OCR text from a Danish or English shop receipt. Product names and their prices are sometimes on separate lines — pair them up. Output ONLY strict JSON, no explanation, in exactly this shape:
{"store":"string","date":"YYYY-MM-DD or empty","currency":"kr. or empty","items":[{"product":"string","price":number,"category":"one of: ${catList}"}],"total":number}
Prices must be plain numbers with a dot for decimals.

OCR text:
"""
${rawText.slice(0, 1800)}
"""

JSON:`;
}

async function llmExtract(rawText) {
  const generator = await withTimeout(getLLM(), 45000);
  showProgress(true, "Reading with smart reader…", 0.9);
  const out = await withTimeout(
    generator(buildLLMPrompt(rawText), { max_new_tokens: 700, temperature: 0.01, do_sample: false }),
    30000
  );
  const text = Array.isArray(out) ? out[0].generated_text : out.generated_text;
  const clean = String(text || "").replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Smart reader returned no JSON");
  const parsed = JSON.parse(clean.slice(start, end + 1));
  if (!Array.isArray(parsed.items) || parsed.items.length === 0) throw new Error("Smart reader found no items");
  return parsed;
}

async function refineWithLLM(rawText, fallbackParsed) {
  try {
    const llm = await llmExtract(rawText);
    return {
      store: llm.store || fallbackParsed.store,
      location: fallbackParsed.location,
      date: llm.date || fallbackParsed.date,
      currency: llm.currency || fallbackParsed.currency,
      items: llm.items.map((it) => ({
        id: uid(),
        product: (it.product || "Item").toString().slice(0, 80),
        price: Number(it.price) || 0,
        category: CATEGORIES.some((c) => c.name === it.category) && it.category !== "Other"
          ? it.category
          : guessCategory(it.product, llm.store || fallbackParsed.store),
      })),
      total: Number(llm.total) || llm.items.reduce((s, i) => s + (Number(i.price) || 0), 0),
    };
  } catch (e) {
    console.warn("Smart reader unavailable, using standard parsing:", e.message);
    return fallbackParsed;
  }
}

async function handleFile(file) {
  if (!file) return;
  showError(null);
  showProgress(true, "Loading recognizer…", 0);
  try {
    const dataUrl = await fileToDataUrl(file);
    const result = await Tesseract.recognize(dataUrl, "dan+eng", {
      logger: (m) => {
        if (m.status && typeof m.progress === "number") {
          const label = m.status === "recognizing text" ? "Reading text…" : m.status;
          showProgress(true, label.charAt(0).toUpperCase() + label.slice(1), m.progress * 0.7);
        }
      },
    });
    const text = result?.data?.text || "";
    if (!text.trim()) throw new Error("No text found");
    const ruleParsed = parseReceiptText(text);
    const parsed = await refineWithLLM(text, ruleParsed);
    const receipt = {
      id: uid(),
      store: parsed.store,
      location: parsed.location,
      date: parsed.date,
      currency: parsed.currency,
      items: parsed.items,
      total: parsed.total,
      readMethod: parsed === ruleParsed ? "rules" : "ai",
    };
    persist([receipt, ...receipts]);
    expandedId = receipt.id;
    editingId = receipt.id;
    renderAll();
  } catch (e) {
    console.error(e);
    showError("Couldn't make out that receipt. Try a flatter, well-lit, closer photo — or add it manually below.");
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
              ${r.readMethod === "rules" ? `<div style="font-size:9.5px;color:var(--ink-light);margin-top:2px;">quick read · check items</div>` : ""}
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
