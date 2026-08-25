
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
const MODEL_PRICES = {
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { name, image, prompt, model } = req.body || {};
    const cleanName = String(name || "anonymous").trim().slice(0, 40) || "anonymous";
    const key = cleanName.toLowerCase().replace(/\s+/g, "-");
    const useModel = model === "claude-haiku-4-5-20251001" ? model : "claude-sonnet-5";

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
      return res.status(r.status).json({ error: data?.error?.message || "Request to Anthropic failed" });
    }

    // Usage accounting — never blocks the response if it fails.
    try {
      const inTok = data.usage?.input_tokens || 0;
      const outTok = data.usage?.output_tokens || 0;
      const prices = MODEL_PRICES[useModel] || MODEL_PRICES["claude-sonnet-5"];
      const costUsd = (inTok / 1e6) * prices.input + (outTok / 1e6) * prices.output;

      await redis.hIncrBy(usageKey, "scans", 1);
      await redis.hIncrByFloat(usageKey, "costUsd", costUsd);
      await redis.hSet(usageKey, { displayName: cleanName, lastUsed: new Date().toISOString() });
      await redis.sAdd("usage:names", key);
    } catch (logErr) {
      console.error("usage logging failed (non-fatal):", logErr);
    }

    return res.status(200).json(data);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error — try again in a moment." });
  }
}
