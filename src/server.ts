// CareBell server: Ring webhooks in, visit records and alerts out, plus the MCP endpoint for Alexa+.
//
//   RING_CREDENTIALS_FILE   the app-credentials CSV from the Ring Developer Console (Client ID/Secret, HMAC key)
//   RING_TOKEN / RING_TOKEN_FILE   a Playground token, used until a Ring account is linked
//   PORT (8841), HOST (127.0.0.1), DATA (./data/state.json), CAREBELL_TZ (America/Los_Angeles)

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Engine, type Alert, type DoorEvent } from "./care.ts";
import { RingClient, parseWebhook, verify } from "./ring.ts";
import { Clock, Store, demoState } from "./store.ts";
import { buildMcp, TZ, WINDOW } from "./mcp.ts";
import { makeWebhook, deliver } from "./simulate.ts";
import { Linker, readCredentials } from "./link.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB = join(ROOT, "web");
const PORT = Number(process.env.PORT ?? 8841);
const DATA = process.env.DATA ?? join(ROOT, "data/state.json");
const MAX_BODY = 64 * 1024;
const HOME = process.env.HOME ?? "";

/** A secret kept in data/<name> (mode 600), created on first run. */
function localSecret(name: string): string {
  const f = join(ROOT, "data", name);
  if (!existsSync(f)) {
    mkdirSync(join(ROOT, "data"), { recursive: true });
    writeFileSync(f, randomBytes(24).toString("base64url"), { mode: 0o600 });
  }
  return readFileSync(f, "utf8").trim();
}

const creds = readCredentials(process.env.RING_CREDENTIALS_FILE ?? join(HOME, ".config/ring-hack/carebell_app_credentials.csv"));
/** Webhooks are signed with the app's HMAC key; without an app, a local key signs the simulator's. */
const KEY = creds?.hmacKey ?? process.env.RING_HMAC_KEY ?? localSecret("hmac.key");
/** Demo controls and agency sign-in are not open to the internet. */
const DEMO_KEY = process.env.DEMO_KEY ?? localSecret("demo.key");
const AGENCY_PASSCODE = process.env.AGENCY_PASSCODE ?? localSecret("agency.passcode");

// Every Ring API call, without the token, so the dashboard (and the demo video) can show them.
const ringLog: { at: number; method: string; path: string; status: number; ms: number }[] = [];
const loggedFetch: typeof fetch = async (input, init) => {
  const t0 = Date.now();
  const url = new URL(String(input));
  const r = await fetch(input, init);
  ringLog.push({ at: Date.now(), method: init?.method ?? "GET", path: url.host.startsWith("oauth") ? "oauth.ring.com" + url.pathname : url.pathname.replace(/ava1\.ring\.(device|account)\.\w{8}\w+/g, (m) => m.slice(0, 26) + "…"), status: r.status, ms: Date.now() - t0 });
  if (ringLog.length > 50) ringLog.shift();
  return r;
};
const linker = creds ? new Linker(creds, join(ROOT, "data/tokens.json"), loggedFetch) : undefined;

function playgroundToken(): string | undefined {
  if (process.env.RING_TOKEN) return process.env.RING_TOKEN;
  const f = process.env.RING_TOKEN_FILE ?? join(HOME, ".config/ring-hack/playground_token");
  return existsSync(f) ? readFileSync(f, "utf8").trim() : undefined;
}
/** A linked Ring account (OAuth, refreshed) wins; the Playground token is the fallback. */
async function token(): Promise<string> {
  return (await linker?.token().catch(() => undefined)) ?? playgroundToken() ?? "";
}
const ring = new RingClient(token, undefined, loggedFetch);
const ringStatus = { connected: false, via: "" as "" | "linked account" | "playground", device: null as null | { id: string; name: string; online: boolean }, error: "" };

const clock = new Clock();
const seed = () => demoState(clock.now(), ringStatus.device?.id);
const store = new Store(DATA, seed);
const engine = new Engine(store.state);
// A server started on a later day reloads yesterday's schedule; start the demo day fresh instead.
if (!engine.between(clock.now() - WINDOW, clock.now() + WINDOW).length) Object.assign(engine.s, { ...seed(), seen: engine.s.seen });

// Server-sent events: the dashboard updates the moment a webhook lands.
const streams = new Set<ServerResponse>();
const push = (kind: string, data: unknown) => {
  for (const s of streams) s.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
};
setInterval(() => streams.forEach((s) => s.write(": ping\n\n")), 25_000);
engine.onAlert = (a: Alert) => push("alert", a);
const changed = () => {
  store.save();
  push("state", snapshot());
};

function snapshot() {
  const now = clock.now();
  return {
    now,
    tz: TZ,
    clients: engine.s.clients.map((c) => ({ id: c.id, name: c.name, family: c.family })),
    visits: engine.between(now - WINDOW, now + WINDOW),
    alerts: engine.s.alerts.filter((a) => a.at >= now - WINDOW).slice(-30),
    ring: { ...ringStatus, log: ringLog.slice(-12) },
    offline: engine.s.offline,
  };
}

async function connectRing() {
  if (!(await token())) {
    ringStatus.connected = false;
    ringStatus.error = "no token";
    return;
  }
  try {
    const [d] = await ring.devices();
    if (!d) throw new Error("no devices shared with CareBell");
    const online = await ring.online(d.id);
    ringStatus.connected = true;
    ringStatus.via = linker?.tokens.some((t) => t.status === "completed") ? "linked account" : "playground";
    ringStatus.device = { id: d.id, name: d.name, online };
    ringStatus.error = "";
    // Mrs. Park's front door is the real Ring doorbell.
    const park = engine.s.clients.find((c) => c.id === "park");
    if (park && park.deviceId !== d.id) {
      park.deviceId = d.id;
      changed();
    }
  } catch (e) {
    ringStatus.connected = false;
    ringStatus.error = (e as Error).message.replace(/Bearer \S+/g, "").slice(0, 120);
  }
}

/** Real events happen in real time; when the demo clock has jumped ahead, they are moved with it. */
const onDemoClock = (ts: number) => ts + clock.offset;

/** The polling path Ring documents for apps without webhooks: event history, through the same engine. */
async function pollHistory() {
  if (!ringStatus.connected || !ringStatus.device) return;
  try {
    for (const h of await ring.history(ringStatus.device.id)) {
      const type = h.type === "ding" ? "button_press" : h.type === "motion" ? "motion_detected" : h.type;
      const e: DoorEvent = { id: `${h.deviceId}_${type}_${h.timestamp}`, deviceId: h.deviceId, type, subType: h.subType, timestamp: onDemoClock(h.timestamp), source: "history" };
      if (engine.handle(e, clock.now())) changed();
    }
  } catch {
    /* next round */
  }
}

async function attachSnapshot(e: DoorEvent, realTs: number) {
  const v = engine.s.visits.find((x) => x.evidence.some((ev) => ev.eventId === e.id && ev.role === "arrival"));
  if (!v || !ringStatus.connected || e.deviceId !== ringStatus.device?.id) return;
  const jpg = await ring.snapshot(e.deviceId, realTs).catch(() => null);
  if (jpg) {
    v.snapshot = `data:image/jpeg;base64,${jpg.toString("base64")}`;
    changed();
  }
}

class TooLarge extends Error {}
const body = (req: IncomingMessage) =>
  new Promise<Buffer>((ok, bad) => {
    const parts: Buffer[] = [];
    let n = 0;
    req
      .on("data", (c: Buffer) => {
        n += c.length;
        if (n <= MAX_BODY) parts.push(c); // past the cap: read and drop, then answer 413
      })
      .on("end", () => (n > MAX_BODY ? bad(new TooLarge()) : ok(Buffer.concat(parts))))
      .on("error", bad);
  });
const jsonBody = async (req: IncomingMessage) => {
  try {
    return JSON.parse((await body(req)).toString() || "{}");
  } catch (e) {
    if (e instanceof TooLarge) throw e;
    return {};
  }
};
const json = (res: ServerResponse, code: number, data: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(data));
};
const sameSecret = (a: string | undefined, b: string) => !!a && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const DOOR_TYPES = new Set(["button_press", "motion_detected", "device_offline", "device_online"]);
const SUB_TYPES = new Set(["human", "motion", "vehicle", "package_delivery", "other_motion"]);

function linkPage(params: URLSearchParams, message = "") {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Ring to CareBell</title>
<link rel="stylesheet" href="/styles.css"><main class="panel" style="max-width:420px;margin:40px auto">
<h2>Connect your Ring doorbell to CareBell</h2><p class="muted">Sign in with your agency account. CareBell will see doorbell presses and motion at the doors you chose in the Ring app, and only during scheduled visits.</p>
${message ? `<p class="flag">${esc(message)}</p>` : ""}
<form method="post" style="display:grid;gap:10px">
<input type="hidden" name="nonce" value="${esc(params.get("nonce") ?? "")}"><input type="hidden" name="time" value="${esc(params.get("time") ?? "")}">
<label>Work email<br><input name="email" type="email" required style="width:100%;padding:8px"></label>
<label>Agency passcode<br><input name="passcode" type="password" required style="width:100%;padding:8px"></label>
<button>Sign in and connect</button></form></main>`;
}

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;

  // Ring webhooks: verify the raw body first, answer fast, then work.
  if (req.method === "POST" && p === "/webhooks/ring") {
    const raw = await body(req);
    if (!verify(KEY, raw, req.headers["x-signature"] as string)) return json(res, 401, { error: "Invalid signature" });
    let hook;
    try {
      hook = parseWebhook(raw);
    } catch {
      return json(res, 400, { error: "Unknown payload" });
    }
    json(res, 200, { status: "processed" });
    const a = hook.data.attributes;
    // request_id is Ring's idempotency key for retries; data.id names the physical event.
    if (engine.s.seen.includes(hook.meta.request_id)) return;
    engine.s.seen.push(hook.meta.request_id);
    const e: DoorEvent = { id: hook.data.id, deviceId: a.source, type: hook.data.type, subType: a.sub_type, timestamp: onDemoClock(a.timestamp), source: "webhook" };
    push("ring", { type: e.type, subType: e.subType, at: e.timestamp });
    const v = engine.handle(e, clock.now());
    changed();
    if (v?.checkIn === e.timestamp) attachSnapshot(e, a.timestamp);
    return;
  }

  // Ring account linking (one-way): Ring posts the code here, backend to backend.
  if (req.method === "POST" && p === "/ring/token") {
    if (!linker) return json(res, 503, { error: "Ring app credentials not configured" });
    const raw = (await body(req)).toString();
    let code: string | undefined;
    try {
      const j = JSON.parse(raw);
      code = j.code ?? j.authorization_code;
    } catch {
      const f = new URLSearchParams(raw);
      code = f.get("code") ?? f.get("authorization_code") ?? undefined;
    }
    if (!code) return json(res, 400, { error: "missing code" });
    try {
      await linker.exchange(code);
      return json(res, 200, { status: "ok" });
    } catch (e) {
      console.error("token exchange:", (e as Error).message);
      return json(res, 502, { error: "exchange failed" });
    }
  }
  // ...and sends the user's browser here with ?nonce&time. Sign-in comes first; then the nonce is matched.
  if (p === "/ring/link") {
    if (req.method !== "POST") return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(linkPage(url.searchParams));
    const f = new URLSearchParams((await body(req)).toString());
    if (!sameSecret(f.get("passcode") ?? undefined, AGENCY_PASSCODE) || !/^[^@\s]+@[^@\s]+$/.test(f.get("email") ?? ""))
      return res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" }).end(linkPage(f, "That email or passcode isn't right."));
    if (!linker) return res.writeHead(503).end("Ring app credentials not configured");
    const r = await linker.claim(f.get("nonce") ?? "", f.get("time") ?? "", f.get("email")!);
    if (typeof r === "string") return res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(linkPage(f, r));
    await connectRing();
    changed();
    return res.writeHead(303, { Location: "/?linked=1" }).end();
  }

  if (p === "/mcp") {
    let raw: unknown;
    if (req.method === "POST") {
      try {
        raw = JSON.parse((await body(req)).toString());
      } catch (e) {
        if (e instanceof TooLarge) return json(res, 413, { error: "too large" });
        return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = buildMcp(engine, clock, () => changed());
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    return transport.handleRequest(req, res, raw);
  }

  if (p === "/api/state") return json(res, 200, snapshot());
  if (p === "/api/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
    streams.add(res);
    req.on("close", () => streams.delete(res));
    return;
  }

  // Demo controls (need the demo key): a signed webhook through the real endpoint, and a clock that jumps ahead.
  if (req.method === "POST" && p.startsWith("/api/demo/")) {
    if (!sameSecret(req.headers["x-demo-key"] as string | undefined, DEMO_KEY)) return json(res, 403, { error: "demo key required" });
    const b = await jsonBody(req);
    if (p === "/api/demo/door") {
      const c = engine.s.clients.find((x) => x.id === b.clientId);
      if (!c || !DOOR_TYPES.has(b.type) || (b.subType !== undefined && !SUB_TYPES.has(b.subType))) return json(res, 400, { error: "bad event" });
      // Real time on the hook, like Ring would send; the receiver moves it onto the demo clock.
      const hook = makeWebhook(b.type, c.deviceId, { subType: b.subType, timestamp: Date.now() });
      return json(res, 200, { status: await deliver(`http://127.0.0.1:${PORT}/webhooks/ring`, KEY, hook) });
    }
    if (p === "/api/demo/advance") {
      const m = Number(b.minutes);
      if (!Number.isFinite(m) || m < 1 || m > 1440) return json(res, 400, { error: "minutes must be 1-1440" });
      clock.advance(m * 60_000);
      engine.tick(clock.now());
      changed();
      return json(res, 200, { now: clock.now() });
    }
    if (p === "/api/demo/reset") {
      clock.offset = 0;
      Object.assign(engine.s, { ...seed(), seen: engine.s.seen });
      changed();
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "not found" });
  }

  // Static files.
  const file = normalize(join(WEB, p === "/" ? "index.html" : p));
  if (file.startsWith(WEB + sep) && existsSync(file)) {
    res.writeHead(200, { "Content-Type": TYPES[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream" });
    return res.end(readFileSync(file));
  }
  json(res, 404, { error: "not found" });
}

createServer((req, res) =>
  route(req, res).catch((e) => {
    if (e instanceof TooLarge) return json(res, 413, { error: "too large" });
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: "server error" });
  }),
).listen(PORT, process.env.HOST ?? "127.0.0.1", async () => {
  console.log(`CareBell on http://localhost:${PORT}  (MCP: /mcp, Ring: /webhooks/ring, /ring/token, /ring/link)`);
  console.log(creds ? "Ring app credentials loaded" : "No Ring app credentials: webhooks are checked with a local key");
  await connectRing();
  console.log(ringStatus.connected ? `Ring: connected to "${ringStatus.device?.name}" via ${ringStatus.via}` : `Ring: not connected (${ringStatus.error})`);
  setInterval(() => {
    const before = JSON.stringify(engine.s.visits.map((v) => v.status));
    engine.tick(clock.now());
    if (JSON.stringify(engine.s.visits.map((v) => v.status)) !== before) changed();
  }, 5_000);
  setInterval(async () => {
    await connectRing();
    await pollHistory();
    push("state", snapshot());
  }, 60_000);
});
