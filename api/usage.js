// Password-protected usage dashboard: /api/usage?password=yourpassword
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

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export default async function handler(req, res) {
  const password = req.query.password;
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center;">
      <h3>Paper Trail — Usage</h3>
      <p>Add <code>?password=yourpassword</code> to the URL.</p>
    </body></html>`);
  }

  const redis = await getClient();
  const names = (await redis.sMembers("usage:names")) || [];
  const rows = [];
  let totalScans = 0;
  let totalCost = 0;

  for (const n of names) {
    const data = await redis.hGetAll(`usage:${n}`);
    const scans = Number(data?.scans || 0);
    const cost = Number(data?.costUsd || 0);
    totalScans += scans;
    totalCost += cost;
    rows.push({ name: data?.displayName || n, scans, cost, lastUsed: data?.lastUsed || "" });
  }
  rows.sort((a, b) => b.scans - a.scans);

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Paper Trail — Usage</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: 'Courier New', monospace; background: #EAE2CE; color: #2B2620; padding: 24px 16px; max-width: 640px; margin: 0 auto; }
  h2 { margin-bottom: 4px; }
  .summary { color: #736B5A; font-size: 13px; margin-bottom: 20px; }
  table { border-collapse: collapse; width: 100%; background: #F5F1E8; border-radius: 8px; overflow: hidden; }
  th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid #D4CBB8; font-size: 13px; }
  th { text-transform: uppercase; font-size: 10px; letter-spacing: .06em; color: #736B5A; background: #EAE2CE; }
  tr:last-child td { border-bottom: none; }
  .cap-near { color: #A8321F; font-weight: bold; }
  .empty { color: #736B5A; padding: 30px 0; text-align: center; }
</style></head>
<body>
  <h2>Paper Trail — Tester Usage</h2>
  <div class="summary">${totalScans} total scans across ${rows.length} tester${rows.length !== 1 ? "s" : ""} · ~$${totalCost.toFixed(4)} estimated total cost</div>
  ${
    rows.length === 0
      ? `<div class="empty">No scans logged yet.</div>`
      : `<table>
    <tr><th>Name</th><th>Scans</th><th>Est. cost</th><th>Last used</th></tr>
    ${rows
      .map(
        (r) => `<tr>
      <td>${esc(r.name)}</td>
      <td class="${r.scans >= SCAN_CAP ? "cap-near" : ""}">${r.scans}/${SCAN_CAP}</td>
      <td>$${r.cost.toFixed(4)}</td>
      <td>${esc(r.lastUsed ? new Date(r.lastUsed).toLocaleString() : "")}</td>
    </tr>`
      )
      .join("")}
  </table>`
  }
</body></html>`;

  return res.status(200).send(html);
}
