// CareBell server: Ring webhooks in, visit records and alerts out, plus the MCP endpoint for Alexa+.
//
//   RING_TOKEN or RING_TOKEN_FILE   access token (Playground token, or one from OAuth account linking)
//   RING_HMAC_KEY                   webhook signing key from the Ring Developer Portal
//   PORT (8841), HOST (127.0.0.1), DATA (./data/state.json)

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, normalize } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Engine, type Alert, type DoorEvent } from "./care.ts";
import { RingClient, parseWebhook, verify } from "./ring.ts";
import { Clock, Store, demoState } from "./store.ts";
import { buildMcp } from "./mcp.ts";
import { makeWebhook, deliver } from "./simulate.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 8841);
const DATA = process.env.DATA ?? join(ROOT, "data/state.json");

function hmacKey(): string {
  if (process.env.RING_HMAC_KEY) return process.env.RING_HMAC_KEY;
  const f = join(ROOT, "data/hmac.key");
  if (!existsSync(f)) {
    mkdirSync(join(ROOT, "data"), { recursive: true });
    writeFileSync(f, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return readFileSync(f, "utf8").trim();
}
const KEY = hmacKey();

function token(): string | undefined {
  if (process.env.RING_TOKEN) return process.env.RING_TOKEN;
  const f = process.env.RING_TOKEN_FILE ?? join(process.env.HOME ?? "", ".config/ring-hack/playground_token");
  return existsSync(f) ? readFileSync(f, "utf8").trim() : undefined;
}

// Every Ring API call, without the token, so the dashboard (and the demo video) can show them.
const ringLog: { at: number; method: string; path: string; status: number; ms: number }[] = [];
const loggedFetch: typeof fetch = async (input, init) => {
  const t0 = Date.now();
  const url = new URL(String(input));
  const r = await fetch(input, init);
  ringLog.push({ at: Date.now(), method: init?.method ?? "GET", path: url.pathname.replace(/ava1\.ring\.device\.\w{12}\w+/, (m) => m.slice(0, 26) + "…"), status: r.status, ms: Date.now() - t0 });
  if (ringLog.length > 50) ringLog.shift();
  return r;
};
const ring = new RingClient(async () => token() ?? "", undefined, loggedFetch);
const ringStatus = { connected: false, device: null as null | { id: string; name: string; online: boolean }, error: "" };

const clock = new Clock();
const store = new Store(DATA, () => demoState(clock.now()));
const engine = new Engine(store.state);

// Server-sent events: the dashboard updates the moment a webhook lands.
const streams = new Set<ServerResponse>();
const push = (kind: string, data: unknown) => {
  for (const s of streams) s.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
};
engine.onAlert = (a: Alert) => push("alert", a);
const changed = () => {
  store.save();
  push("state", snapshot());
};

function today() {
  const d = new Date(clock.now());
  d.setHours(0, 0, 0, 0);
  return engine.day(d.getTime());
}
function snapshot() {
  return { now: clock.now(), clients: engine.s.clients, visits: today(), alerts: engine.s.alerts.slice(-30), ring: { ...ringStatus, log: ringLog.slice(-12) }, offline: engine.s.offline };
}

async function connectRing() {
  if (!token()) {
    ringStatus.error = "no token";
    return;
  }
  try {
    const [d] = await ring.devices();
    if (!d) throw new Error("no devices on this Ring account");
    const online = await ring.online(d.id);
    await ring.capabilities(d.id);
    ringStatus.connected = true;
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
    ringStatus.error = (e as Error).message.slice(0, 120);
  }
}

/** The polling path Ring documents for apps without webhooks: event history, fed through the same engine. */
async function pollHistory() {
  if (!ringStatus.connected || !ringStatus.device) return;
  try {
    for (const h of await ring.history(ringStatus.device.id)) {
      const e: DoorEvent = { id: h.id, deviceId: h.deviceId, type: h.type === "ding" ? "button_press" : h.type === "motion" ? "motion_detected" : h.type, subType: h.subType, timestamp: h.timestamp, source: "history" };
      if (engine.handle(e, clock.now())) changed();
    }
  } catch {
    /* next round */
  }
}

async function onArrival(e: DoorEvent) {
  const v = engine.s.visits.find((x) => x.evidence.some((ev) => ev.eventId === e.id && ev.role === "arrival"));
  if (!v || !ringStatus.connected || e.deviceId !== ringStatus.device?.id) return;
  const jpg = await ring.snapshot(e.deviceId, e.timestamp).catch(() => null);
  if (jpg) {
    v.snapshot = `data:image/jpeg;base64,${jpg.toString("base64")}`;
    changed();
  }
}

const body = (req: IncomingMessage) =>
  new Promise<Buffer>((ok, bad) => {
    const parts: Buffer[] = [];
    req.on("data", (c) => parts.push(c)).on("end", () => ok(Buffer.concat(parts))).on("error", bad);
  });
const json = (res: ServerResponse, code: number, data: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(data));
};
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

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
    const e: DoorEvent = { id: hook.meta.request_id, deviceId: a.source, type: hook.data.type, subType: a.sub_type, timestamp: a.timestamp, source: "webhook" };
    push("ring", { type: e.type, subType: e.subType, deviceId: e.deviceId, at: e.timestamp });
    const v = engine.handle(e, clock.now());
    changed();
    if (v?.checkIn === e.timestamp) onArrival(e);
    return;
  }

  if (p === "/mcp") {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = buildMcp(engine, clock, () => changed());
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    const raw = req.method === "POST" ? JSON.parse((await body(req)).toString() || "null") : undefined;
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

  // Demo controls: a signed webhook through the real endpoint, and a clock that can jump ahead.
  if (req.method === "POST" && p === "/api/demo/door") {
    const { clientId, type, subType } = JSON.parse((await body(req)).toString());
    const c = engine.s.clients.find((x) => x.id === clientId);
    if (!c) return json(res, 404, { error: "no such client" });
    const hook = makeWebhook(type, c.deviceId, { subType, timestamp: clock.now() });
    const status = await deliver(`http://127.0.0.1:${PORT}/webhooks/ring`, KEY, hook);
    return json(res, 200, { status });
  }
  if (req.method === "POST" && p === "/api/demo/advance") {
    const { minutes } = JSON.parse((await body(req)).toString());
    clock.advance(Number(minutes) * 60_000);
    engine.tick(clock.now());
    changed();
    return json(res, 200, { now: clock.now() });
  }
  if (req.method === "POST" && p === "/api/demo/reset") {
    clock.offset = 0;
    Object.assign(engine.s, demoState(clock.now(), ringStatus.device?.id));
    changed();
    return json(res, 200, { ok: true });
  }

  // Static files.
  const file = normalize(join(ROOT, "web", p === "/" ? "index.html" : p));
  if (file.startsWith(join(ROOT, "web")) && existsSync(file)) {
    res.writeHead(200, { "Content-Type": TYPES[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream" });
    return res.end(readFileSync(file));
  }
  json(res, 404, { error: "not found" });
}

createServer((req, res) =>
  route(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: "server error" });
  }),
).listen(PORT, process.env.HOST ?? "127.0.0.1", async () => {
  console.log(`CareBell on http://localhost:${PORT}  (MCP: /mcp, Ring webhooks: /webhooks/ring)`);
  await connectRing();
  console.log(ringStatus.connected ? `Ring: connected to "${ringStatus.device?.name}"` : `Ring: not connected (${ringStatus.error})`);
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
