// Ring webhook simulator: builds v1.1 payloads exactly as Ring documents them, signs them with
// your HMAC key and POSTs them. The Ring Developer Playground can't send doorbell or motion
// webhooks, so this is how a partner app's real webhook path gets exercised.
//
//   node src/simulate.ts <url> <button_press|motion_detected|device_offline|device_online> <device_id> [sub_type]
//   (key from RING_HMAC_KEY)

import { randomUUID } from "node:crypto";
import { sign, type RingWebhook } from "./ring.ts";

const SHORT: Record<string, string> = { button_press: "button_press", motion_detected: "motion", device_offline: "offline", device_online: "online" };

export function makeWebhook(type: string, deviceId: string, opts: { subType?: string; timestamp?: number; accountId?: string } = {}): RingWebhook {
  const ts = opts.timestamp ?? Date.now();
  const tag = type === "motion_detected" ? (opts.subType ?? "motion") : (SHORT[type] ?? type);
  return {
    meta: { version: "1.1", time: new Date().toISOString(), request_id: randomUUID(), account_id: opts.accountId ?? "ava1.ring.account.SIMULATED" },
    data: {
      id: `${deviceId}_${tag}_${ts}`,
      type,
      attributes: {
        source: deviceId,
        source_type: "devices",
        timestamp: ts,
        ...(type === "motion_detected" ? { sub_type: opts.subType ?? "motion" } : {}),
      },
      relationships: { devices: { links: { self: `/v1/devices/${deviceId}` } } },
    },
  };
}

/** Sends one signed webhook. Returns the HTTP status your endpoint answered with. */
export async function deliver(url: string, key: string, hook: RingWebhook): Promise<number> {
  const body = JSON.stringify(hook);
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Signature": sign(key, body) }, body });
  return r.status;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [url, type, deviceId, subType] = process.argv.slice(2);
  const key = process.env.RING_HMAC_KEY;
  if (!url || !type || !deviceId || !key) {
    console.log("usage: RING_HMAC_KEY=... node src/simulate.ts <url> <type> <device_id> [sub_type]");
    process.exit(1);
  }
  const hook = makeWebhook(type, deviceId, { subType });
  console.log(`${type} → ${url}: HTTP ${await deliver(url, key, hook)}`);
}
