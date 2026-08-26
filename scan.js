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
// NOTE on gemini-2.5-flash: third-party pricing trackers disagreed at the time this was
// written ($0.15/$1.25 vs $0.30/$2.50) — using the more consistently-reported figure
// below, but treat it as approximate until confirmed against your actual Google AI
// Studio billing. Also: Google has scheduled gemini-2.5-flash for retirement around
// October 2026 in favor of newer Gemini 3.x models — this will need swapping out then.
const MODEL_PRICES = {
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
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
function mismatchFraction(parsed) {
  if (!parsed) return 1;
  const total = Number(parsed.total) || 0;
  const itemsSum = parsed.items.reduce((s, it) => s + (Number(it.price) || 0), 0);
  if (total <= 0) return itemsSum > 0 ? 1 : 0;
  return Math.abs(total - itemsSum) / total;
}
function tokenCost(data, useModel) {
  const inTok = data?.usage?.input_tokens || 0;
  const outTok = data?.usage?.output_tokens || 0;
  const prices = MODEL_PRICES[useModel] || MODEL_PRICES[DEFAULT_MODEL];
  return (inTok / 1e6) * prices.input + (outTok / 1e6) * prices.output;
}

async function callAnthropic(useModel, image, prompt) {
  const body = {
    model: useModel,
    max_tokens: 4096,
    // temperature 0: for a "read this receipt exactly" task, we want the most
    // reproducible answer every time, not creative variation — scanning the same
    // receipt twice should give the same result, not two different totals.
    temperature: 0,
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
  if (useModel === "claude-sonnet-5") body.thinking = { type: "disabled" };

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
          temperature: 0,
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

async function callModel(useModel, image, prompt) {
  return isGeminiModel(useModel) ? callGemini(useModel, image, prompt) : callAnthropic(useModel, image, prompt);
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

    // Automatic retry: only when the model's own numbers don't add up, so a clean
    // read never costs more than it does today — only the genuinely hard ones do.
    if (mismatch > MISMATCH_RETRY_THRESHOLD) {
      try {
        const data2 = await callModel(useModel, image, prompt);
        attempts = 2;
        totalCostUsd += tokenCost(data2, useModel);
        const parsed2 = parseModelJson(data2);
        const mismatch2 = mismatchFraction(parsed2);
        if (mismatch2 < mismatch) {
          data = data2;
          parsed = parsed2;
          mismatch = mismatch2;
        }
      } catch (retryErr) {
        // Retry failing shouldn't sink an otherwise-usable first result.
        console.error("retry attempt failed (non-fatal):", retryErr);
      }
    }

    const needsRetake = mismatch > MISMATCH_RETRY_THRESHOLD;
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

