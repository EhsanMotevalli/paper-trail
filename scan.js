// Server-side proxy for receipt scanning. Holds the real Anthropic API key (never sent
// to the browser), enforces a per-person scan cap, and logs usage per name so the owner
// can see who's using it and roughly what it's costing.
//
// Uses the standard node-redis client (works with Redis Cloud's connection string, not
// Upstash's REST API — the two are different protocols). Vercel's Redis Cloud integration
// has used a couple of different env var names for the connection string over time, so
// this checks the common ones. If none match, check Project Settings > Environment
// Variables after installing and update REDIS_ENV_CANDIDATES below to match.
import { createClient } from "redis";

const REDIS_ENV_CANDIDATES = ["REDISCLOUD_REDIS_URL", "REDIS_URL", "REDISCLOUD_URL", "KV_URL", "REDIS_CONNECTION_STRING"];
function redisUrl() {
  for (const name of REDIS_ENV_CANDIDATES) {
    if (process.env[name]) return process.env[name];
  }
  return null;
}

let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    const url = redisUrl();
    if (!url) throw new Error("No Redis connection string found in environment variables.");
    const client = createClient({ url });
    client.on("error", (err) => console.error("Redis client error:", err));
    clientPromise = client.connect().then(() => client);
  }
  return clientPromise;
}

const SCAN_CAP = 50;
// $ per million tokens. Update if pricing changes.
// gemini-2.5-flash was retired by Google before this app even shipped (confirmed live,
// "no longer available to new users") — swapped to gemini-3.6-flash, Google's own
// suggested replacement. Rate below ($1.50/$7.50) is the standard tier reported by
// multiple independent trackers as of when this was written; spot-check against your
// actual Google AI Studio billing. Google marks 3.6-flash pricing as effective through
// Dec 31, 2026, doubling to $1.50/$1M -> a different rate on Jan 1, 2027 — revisit then.
const MODEL_PRICES = {
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "gemini-3.6-flash": { input: 1.5, output: 7.5 },
};
const ALLOWED_MODELS = Object.keys(MODEL_PRICES);
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
function isGeminiModel(m) {
  return m.startsWith("gemini");
}

// If the model's own items don't add up to its own reported total by more than this,
// it's worth spending a second call to try again — a receipt that far off is probably
// a genuine misread, not just rounding.
const MISMATCH_RETRY_THRESHOLD = 0.01; // 1%

function parseModelJson(data) {
  try {
    const text = (data.content || []).map((b) => b.text || "").join("").trim();
    const clean = text.replace(/```json|```/g, "").trim();
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    const parsed = JSON.parse(clean.slice(start, end + 1));
    return Array.isArray(parsed.items) ? parsed : null;
  } catch {
    return null;
  }
}
// Returns a 0-1 fraction: how far the model's own items are from its own reported
// total. Unparseable/missing data counts as maximally bad (always worth a retry).
// item.price is the GROSS printed line amount (the model never does the subtraction
// itself — see the prompt), so this must subtract each item's discount to get the net
// amount actually paid before comparing to the total, exactly like the client does.
function mismatchFraction(parsed) {
  if (!parsed) return 1;
  const total = Number(parsed.total) || 0;
  const itemsSum = parsed.items.reduce((s, it) => {
    const gross = Number(it.price) || 0;
    const discount = Math.max(0, Number(it.discount) || 0);
    return s + Math.max(0, gross - discount);
  }, 0);
  if (total <= 0) return itemsSum > 0 ? 1 : 0;
  return Math.abs(total - itemsSum) / total;
}
function tokenCost(data, useModel) {
  const inTok = data?.usage?.input_tokens || 0;
  const outTok = data?.usage?.output_tokens || 0;
  const prices = MODEL_PRICES[useModel] || MODEL_PRICES[DEFAULT_MODEL];
  return (inTok / 1e6) * prices.input + (outTok / 1e6) * prices.output;
}
// Items the model itself flagged as uncertain. This catches a real blind spot the
// mismatch check can't: two wrong prices that happen to cancel out (one too high, one
// too low) look perfectly fine on the total but are still wrong — confidence flags are
// an independent signal from the arithmetic check.
function lowConfidenceItems(parsed) {
  if (!parsed) return [];
  return (parsed.items || []).filter((it) => it.lowConfidence === true);
}

async function callAnthropic(useModel, image, prompt, temperature = 0) {
  const body = {
    model: useModel,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
          { type: "text", text: prompt },
        ],
      },
    ],
  };
  if (useModel === "claude-sonnet-5") {
    // Confirmed live: Sonnet 5 rejects `temperature` outright when a `thinking` config
    // is present at all (even explicitly disabled) — "`temperature` is deprecated for
    // this model." So for this model we skip temperature entirely rather than error.
    body.thinking = { type: "disabled" };
  } else {
    // temperature 0 by default on models that do support it: for a "read this receipt
    // exactly" task, we want the most reproducible answer on the first try. The retry
    // path can pass a higher temperature — see callModel below for why.
    body.temperature = temperature;
  }

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) {
    const err = new Error(data?.error?.message || "Request to Anthropic failed");
    err.status = r.status;
    throw err;
  }
  return data;
}

// Google's request/response shape is entirely different from Anthropic's — this
// normalizes the result into the SAME { content, usage, stop_reason } shape Anthropic
// returns, so every downstream piece (parseModelJson, tokenCost, retry logic, and the
// client-side parsing code) works unchanged regardless of which provider answered.
//
// Note: temperature is intentionally NOT sent here — newer Gemini models (confirmed
// live: "`temperature` is deprecated for this model") reject it outright. Unlike
// Anthropic, where a nonzero temperature is how the retry gets a genuinely different
// second look, Gemini's retry differentiation comes entirely from the diagnostic retry
// prompt itself (different input text), which is sufficient on its own.
async function callGemini(useModel, image, prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error("GEMINI_API_KEY is not configured on the server.");
    err.status = 500;
    throw err;
  }
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${useModel}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ inline_data: { mime_type: "image/jpeg", data: image } }, { text: prompt }],
          },
        ],
        generationConfig: {
          maxOutputTokens: 4096,
          responseMimeType: "application/json",
        },
      }),
    }
  );
  const raw = await r.json();
  if (!r.ok) {
    const err = new Error(raw?.error?.message || "Request to Gemini failed");
    err.status = r.status;
    throw err;
  }
  const text = (raw?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  return {
    content: [{ type: "text", text }],
    usage: {
      input_tokens: raw?.usageMetadata?.promptTokenCount || 0,
      output_tokens: raw?.usageMetadata?.candidatesTokenCount || 0,
    },
    stop_reason: raw?.candidates?.[0]?.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn",
  };
}

async function callModel(useModel, image, prompt, temperature = 0) {
  // Gemini doesn't accept temperature on this model (see callGemini) — silently
  // dropped for that provider rather than every call site needing to know that.
  return isGeminiModel(useModel) ? callGemini(useModel, image, prompt) : callAnthropic(useModel, image, prompt, temperature);
}

// Builds a retry prompt that tells the model exactly what didn't add up on the first
// pass, and asks it to specifically re-check digits that are easy to misread on thermal
// receipt print (1/7, 2 vs the "1" that started this exact bug report, 3/8, 5/6, 0/6).
// A blind retry at temperature 0 would almost certainly repeat the identical misread —
// this makes the second attempt an actually-informed re-check, not a coin flip.
function buildRetryPrompt(basePrompt, firstParsed) {
  const itemLines = (firstParsed?.items || [])
    .map((it) => `- ${it.product}: ${it.price}${it.discount ? ` (discount ${it.discount})` : ""}`)
    .join("\n");
  return `${basePrompt}

IMPORTANT — this is a RE-CHECK. A first read of this exact receipt found:
${itemLines || "(no items parsed)"}
Reported total: ${firstParsed?.total ?? "unknown"}

Those numbers do not add up correctly, which usually means one or more digits were misread — commonly confused pairs on thermal receipt print include 1/7, 1/2, 3/8, 5/6, and 0/6. Look at the image again from scratch and re-read every price digit by digit, especially for items that repeat (like two of the same product at slightly different prices — double check each one independently rather than assuming they match). Do not just copy the numbers above if they're wrong; provide your own genuinely re-examined reading.`;
}

// A more targeted version for when the model flagged specific line(s) as uncertain,
// rather than the whole receipt being unclear. Points the re-check directly at those
// lines instead of asking for a full re-read.
function buildTargetedRetryPrompt(basePrompt, firstParsed, flaggedItems) {
  const flaggedLines = flaggedItems.map((it) => `- ${it.product}: ${it.price}${it.discount ? ` (discount ${it.discount})` : ""}`).join("\n");
  return `${basePrompt}

IMPORTANT — this is a RE-CHECK. A first read of this exact receipt was mostly confident, but flagged these specific line(s) as uncertain:
${flaggedLines}

Look at the image again and find exactly those line(s) — re-read the product name and price digit by digit, since a low-confidence flag usually means faint print, an ambiguous digit, or a partially obscured number. Confirm the reading if it was actually correct, or provide a corrected one if it wasn't. Report the FULL item list again as usual (not just the flagged ones), keeping the rest of the receipt exactly as it read the first time.`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { name, image, prompt, model } = req.body || {};
    const cleanName = String(name || "anonymous").trim().slice(0, 40) || "anonymous";
    const key = cleanName.toLowerCase().replace(/\s+/g, "-");
    const useModel = ALLOWED_MODELS.includes(model) ? model : DEFAULT_MODEL;

    if (!image || !prompt) {
      return res.status(400).json({ error: "Missing image or prompt" });
    }

    const redis = await getClient();
    const usageKey = `usage:${key}`;
    const current = await redis.hGet(usageKey, "scans");
    const scansSoFar = Number(current) || 0;
    if (scansSoFar >= SCAN_CAP) {
      return res.status(429).json({
        error: `You've hit the ${SCAN_CAP}-scan test limit for this app. Ask the owner to raise it if you need more.`,
      });
    }

    // Attempt 1.
    let data = await callModel(useModel, image, prompt);
    let attempts = 1;
    let totalCostUsd = tokenCost(data, useModel);
    let parsed = parseModelJson(data);
    let mismatch = mismatchFraction(parsed);
    let flagged = lowConfidenceItems(parsed);

    // A single "badness" score combining both signals: the arithmetic mismatch AND
    // the model's own flagged uncertainty (each remaining flagged line counts for
    // roughly a 1% mismatch's worth of doubt). This catches errors the mismatch check
    // alone can't — like two wrong prices that happen to cancel out on the total.
    const badness = (mismatchVal, items) => mismatchVal + items.length * 0.01;

    // Automatic retry: only when there's a real reason to doubt the first read — either
    // the numbers don't add up, or the model itself flagged uncertainty — so a clean
    // read never costs more than it does today. Uses a diagnostic prompt (targeted at
    // the specific flagged line(s) when there are few, or a general re-check otherwise)
    // plus a nonzero temperature, since a blind identical retry at temperature 0 would
    // very likely repeat the exact same misread rather than genuinely re-examine the image.
    if (mismatch > MISMATCH_RETRY_THRESHOLD || flagged.length > 0) {
      try {
        const retryPrompt =
          flagged.length > 0 && flagged.length <= 4
            ? buildTargetedRetryPrompt(prompt, parsed, flagged)
            : buildRetryPrompt(prompt, parsed);
        const data2 = await callModel(useModel, image, retryPrompt, 0.4);
        attempts = 2;
        totalCostUsd += tokenCost(data2, useModel);
        const parsed2 = parseModelJson(data2);
        const mismatch2 = mismatchFraction(parsed2);
        const flagged2 = lowConfidenceItems(parsed2);
        if (badness(mismatch2, flagged2) < badness(mismatch, flagged)) {
          data = data2;
          parsed = parsed2;
          mismatch = mismatch2;
          flagged = flagged2;
        }
      } catch (retryErr) {
        // Retry failing shouldn't sink an otherwise-usable first result.
        console.error("retry attempt failed (non-fatal):", retryErr);
      }
    }

    const needsRetake = mismatch > MISMATCH_RETRY_THRESHOLD || flagged.length > 0;
    data._meta = { attempts, needsRetake };

    // Usage accounting — never blocks the response if it fails.
    try {
      await redis.hIncrBy(usageKey, "scans", attempts);
      await redis.hIncrByFloat(usageKey, "costUsd", totalCostUsd);
      await redis.hSet(usageKey, { displayName: cleanName, lastUsed: new Date().toISOString() });
      await redis.sAdd("usage:names", key);
    } catch (logErr) {
      console.error("usage logging failed (non-fatal):", logErr);
    }

    return res.status(200).json(data);
  } catch (e) {
    console.error(e);
    return res.status(e.status || 500).json({ error: e.message || "Server error — try again in a moment." });
  }
}

