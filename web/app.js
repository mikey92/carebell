// CareBell dashboard: family phone, agency board, and a simulated Alexa+ that talks to the
// CareBell MCP server over Streamable HTTP, exactly as an Alexa+ add-on would.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
let TZ;
const tm = (ms) => (ms == null ? "—" : new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ }));
/** Demo controls need the key the server prints into data/demo.key, passed as #demo=<key>. */
const DEMO_KEY = new URLSearchParams(location.hash.slice(1)).get("demo") ?? "";
const LABEL = { scheduled: "Scheduled", on_site: "With client", completed: "Done", late: "Late", missed: "Missed" };
let state = null;
const seenAlerts = new Set();

function line(v, now) {
  const a = v.aide.name.split(" ")[0];
  if (v.status === "completed") return v.checkOut == null ? `${a} came ${tm(v.checkIn)} · departure not seen` : `${a} came ${tm(v.checkIn)}, left ${tm(v.checkOut)}`;
  if (v.status === "on_site") {
    const m = Math.round((now - v.checkIn) / 60000);
    return `${a} arrived ${tm(v.checkIn)} · ${m < 1 ? "just now" : `${m} min so far`}`;
  }
  if (v.status === "late") return `${a} due ${tm(v.start)} · not at the door yet`;
  if (v.status === "missed") return `${a} due ${tm(v.start)} · nobody came`;
  return `${a} · ${tm(v.start)} – ${tm(v.end)}`;
}

function evidence(v) {
  return v.evidence
    .filter((e) => e.role !== "seen")
    .map((e) => `${e.role === "arrival" ? "in" : "out"}: ${e.type === "button_press" ? "doorbell" : `motion (${esc(e.subType)})`} ${tm(e.at)}`)
    .join("<br>");
}

function alertItem(a) {
  const fresh = !seenAlerts.has(a.id);
  seenAlerts.add(a.id);
  return `<li class="${a.level}${fresh && state ? " new" : ""}"><time>${tm(a.at)}</time>${esc(a.text)}</li>`;
}

function render(s) {
  const first = !state;
  state = s;
  TZ = s.tz;
  $("#clock").textContent = tm(s.now);
  const r = s.ring;
  $("#ring").classList.toggle("on", r.connected);
  $("#ring-text").textContent = r.connected ? `Ring connected (${r.via}) · ${r.device.name} ${r.device.online ? "online" : "offline"}` : `Ring: ${r.error || "not connected"}`;

  const mom = s.visits.filter((v) => v.clientId === "park");
  $("#family-visits").innerHTML = mom
    .map((v) => `<li class="st-${v.status}"><span class="dot"></span><div><b>${esc(v.tasks.join(", "))}</b><span class="when">${esc(line(v, s.now))}</span>${v.flags.map((f) => `<div class="flag">⚠ ${esc(f)}</div>`).join("")}${v.snapshot ? `<img class="snap" alt="Door at arrival" src="${v.snapshot}">` : ""}</div></li>`)
    .join("");
  const fam = s.alerts.filter((a) => a.to !== "agency" && a.clientId === "park").slice(-6).reverse();
  if (first) fam.forEach((a) => seenAlerts.add(a.id));
  $("#family-alerts").innerHTML = fam.map(alertItem).join("") || `<li>No notifications yet.</li>`;

  $("#board").innerHTML = s.visits
    .map((v) => `<tr><td>${tm(v.start)}</td><td>${esc(v.client.name)}</td><td>${esc(v.aide.name)}</td><td><span class="pill ${v.status}">${LABEL[v.status]}</span>${v.flags.map((f) => `<div class="flag">${esc(f)}</div>`).join("")}</td><td class="ev">${evidence(v) || "—"}</td></tr>`)
    .join("");
  const ag = s.alerts.filter((a) => a.to !== "family" && a.level !== "info").slice(-5).reverse();
  if (first) ag.forEach((a) => seenAlerts.add(a.id));
  $("#agency-alerts").innerHTML = ag.map(alertItem).join("") || `<li>All visits on track.</li>`;
  $("#ring-log").innerHTML = r.log.slice().reverse().map((l) => `<li>${tm(l.at)} <b>${l.method}</b> ${esc(l.path)} → ${l.status} (${l.ms} ms)</li>`).join("") || "<li>—</li>";
}

const es = new EventSource("/api/stream");
es.addEventListener("state", (e) => render(JSON.parse(e.data)));

// ---- Alexa+ (simulated): an MCP client over Streamable HTTP ----
let rpcId = 1;
const mcpLog = (dir, m) => {
  const el = $("#mcp-log");
  el.textContent = `${dir} ${JSON.stringify(m).slice(0, 400)}\n` + el.textContent.slice(0, 4000);
};
async function mcp(method, params) {
  const msg = { jsonrpc: "2.0", id: rpcId++, method, params };
  mcpLog("→", msg);
  const r = await fetch("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" }, body: JSON.stringify(msg) });
  const j = await r.json();
  mcpLog("←", j);
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

const frame = $("#card");
const cardReady = new Promise((ok) => (frame.onload = ok));
(async () => {
  try {
    await mcp("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "carebell-alexa-sim", version: "0.1.0" } });
    const res = await mcp("resources/read", { uri: "ui://carebell/visit-card" });
    frame.srcdoc = res.contents[0].text;
  } catch (e) {
    $("#reply").textContent = `CareBell's card didn't load (${e.message}).`;
  }
})();

/** What Alexa+ does with its own model; here a few phrasings are enough to route to the right tool. */
function route(q) {
  const s = q.toLowerCase();
  if (/tell|message|let .*agency|complain|send someone/.test(s)) {
    const m = q.replace(/^.*?(tell|message) (the )?agency( that)?/i, "").trim() || q;
    return ["tell_agency", { client: "Mom", message: m, urgent: /urgent|now|asap|skipped|didn't/.test(s) }];
  }
  if (/alert|notification|anything happen/.test(s)) return ["recent_alerts", { limit: 4 }];
  if (/schedule|today's visits|who.*coming|when/.test(s)) return ["todays_schedule", { client: "Mom" }];
  return ["check_visit", { client: "Mom" }];
}

async function ask(q) {
  $("#said").textContent = `“Alexa, ${q.replace(/^alexa,?\s*/i, "")}”`;
  $("#reply").textContent = "…";
  const [name, args] = route(q);
  try {
    const res = await mcp("tools/call", { name, arguments: args });
    const text = res.content.map((c) => c.text).join(" ");
    $("#reply").textContent = text;
    if (res.structuredContent?.visits) {
      await cardReady;
      $("#card").contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: res }, "*");
    }
    if ("speechSynthesis" in window) {
      speechSynthesis.cancel();
      speechSynthesis.speak(new SpeechSynthesisUtterance(text.split("\n")[0]));
    }
  } catch (e) {
    $("#reply").textContent = `Sorry, CareBell isn't answering (${e.message}).`;
  }
}
$("#ask").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#q").value.trim() || $("#q").placeholder;
  $("#q").value = "";
  ask(q);
});
document.querySelectorAll(".chips button").forEach((b) => b.addEventListener("click", () => ask(b.dataset.q)));

// ---- Demo controls ----
const post = (url, body) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Demo-Key": DEMO_KEY }, body: JSON.stringify(body) }).then((r) => {
    if (r.status === 403) alert("Demo controls need the demo key in the address (#demo=…).");
    return r.json();
  });
if (!DEMO_KEY) document.querySelector(".demo").hidden = true;
document.querySelectorAll("[data-door]").forEach((b) =>
  b.addEventListener("click", () => post("/api/demo/door", { clientId: b.dataset.door, type: b.dataset.type, subType: b.dataset.sub })),
);
document.querySelectorAll("[data-advance]").forEach((b) => b.addEventListener("click", () => post("/api/demo/advance", { minutes: Number(b.dataset.advance) })));
$("#reset").addEventListener("click", () => post("/api/demo/reset", {}));
