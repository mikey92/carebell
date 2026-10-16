import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, emptyState, type DoorEvent } from "../src/care.ts";
import { sign, verify, parseWebhook } from "../src/ring.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 17, 16, 0); // 9:00 PT

function setup() {
  const s = emptyState();
  s.clients.push({ id: "c1", name: "Mrs. Park", deviceId: "dev1", family: ["Ellie"] });
  s.aides.push({ id: "a1", name: "Maria" });
  s.visits.push({ id: "v1", clientId: "c1", aideId: "a1", start: T0, end: T0 + 120 * MIN, tasks: ["Lunch", "Medication"], status: "scheduled", evidence: [], flags: [] });
  return new Engine(s);
}
let n = 0;
const ev = (type: string, at: number, subType?: string, deviceId = "dev1"): DoorEvent => ({ id: `e${++n}`, deviceId, type, subType, timestamp: at, source: "simulator" });

test("doorbell press in the window checks the aide in and tells the family", () => {
  const e = setup();
  const v = e.handle(ev("button_press", T0 + 3 * MIN));
  assert.equal(v?.status, "on_site");
  assert.equal(v?.checkIn, T0 + 3 * MIN);
  assert.match(e.s.alerts.at(-1)!.text, /Maria rang the doorbell at Mrs. Park's home\. Visit started/);
  assert.equal(e.s.alerts.at(-1)!.to, "family");
});

test("human motion after the minimum stay checks out; a short visit is flagged", () => {
  const e = setup();
  e.handle(ev("button_press", T0));
  const v = e.handle(ev("motion_detected", T0 + 50 * MIN, "human"));
  assert.equal(v?.status, "completed");
  assert.ok(v?.flags.some((f) => f.startsWith("short")));
  assert.equal(e.s.alerts.at(-1)!.level, "warn");
});

test("motion soon after arrival is not a departure", () => {
  const e = setup();
  e.handle(ev("button_press", T0));
  const v = e.handle(ev("motion_detected", T0 + 5 * MIN, "human"));
  assert.equal(v?.status, "on_site");
});

test("no one at the door: late, then missed with an urgent alert to both", () => {
  const e = setup();
  e.tick(T0 + 11 * MIN);
  assert.equal(e.s.visits[0].status, "late");
  e.tick(T0 + 31 * MIN);
  assert.equal(e.s.visits[0].status, "missed");
  const last = e.s.alerts.at(-1)!;
  assert.equal(last.level, "urgent");
  assert.equal(last.to, "both");
  // The aide shows up after all: the agency hears too.
  const v = e.handle(ev("button_press", T0 + 40 * MIN));
  assert.equal(v?.status, "on_site");
  assert.ok(v?.flags.some((f) => f.startsWith("late")));
  assert.equal(e.s.alerts.at(-1)!.to, "both");
});

test("events outside any visit window, vehicles and other doors are ignored", () => {
  const e = setup();
  assert.equal(e.handle(ev("button_press", T0 - 3 * 60 * MIN)), undefined);
  assert.equal(e.handle(ev("motion_detected", T0, "vehicle")), undefined);
  assert.equal(e.handle(ev("button_press", T0, undefined, "other")), undefined);
  assert.equal(e.s.visits[0].status, "scheduled");
});

test("the same event delivered twice is handled once", () => {
  const e = setup();
  const x = ev("button_press", T0);
  e.handle(x);
  const before = e.s.alerts.length;
  assert.equal(e.handle(x), undefined);
  assert.equal(e.s.alerts.length, before);
});

test("an offline doorbell is reported, and the late alert says why", () => {
  const e = setup();
  e.handle(ev("device_offline", T0 - MIN));
  e.tick(T0 + 11 * MIN);
  assert.match(e.s.alerts.at(-1)!.text, /offline/);
});

test("webhook signatures: raw-body HMAC-SHA256, hex, sha256= prefix", () => {
  const body = Buffer.from(JSON.stringify({ meta: { request_id: "r1" }, data: { type: "button_press", attributes: { source: "d", timestamp: 1 } } }));
  const sig = sign("k", body);
  assert.match(sig, /^sha256=[0-9a-f]{64}$/);
  assert.ok(verify("k", body, sig));
  assert.ok(!verify("other", body, sig));
  assert.ok(!verify("k", Buffer.from(body.toString() + " "), sig));
  assert.ok(!verify("k", body, undefined));
  assert.equal(parseWebhook(body).data.type, "button_press");
  assert.throws(() => parseWebhook(Buffer.from("{}")));
});

test("a visit nobody is seen leaving closes without inventing a departure time", () => {
  const e = setup();
  e.handle(ev("button_press", T0));
  e.tick(T0 + 181 * MIN);
  const v = e.s.visits[0];
  assert.equal(v.status, "completed");
  assert.equal(v.checkOut, undefined);
  assert.ok(v.flags.includes("departure not seen"));
});

test("a late-delivered event can't move a departure backwards", () => {
  const e = setup();
  e.handle(ev("button_press", T0));
  e.handle(ev("motion_detected", T0 + 110 * MIN, "human"));
  e.handle(ev("motion_detected", T0 + 25 * MIN, "human")); // retried, arrives after the departure
  assert.equal(e.s.visits[0].checkOut, T0 + 110 * MIN);
});

test("a package delivery doesn't end the visit; the real departure later does", () => {
  const e = setup();
  e.handle(ev("button_press", T0));
  assert.equal(e.handle(ev("motion_detected", T0 + 30 * MIN, "package_delivery")), undefined);
  assert.equal(e.handle(ev("motion_detected", T0 + 31 * MIN, "motion"))?.status, "on_site");
  e.handle(ev("motion_detected", T0 + 40 * MIN, "human")); // someone at the door mid-visit: read as leaving...
  const v = e.handle(ev("motion_detected", T0 + 115 * MIN, "human")); // ...until the aide really leaves
  assert.equal(v?.checkOut, T0 + 115 * MIN);
  assert.ok(!v?.flags.some((f) => f.startsWith("short")));
});
