import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Linker, nonceFor, freshTime, readCredentials } from "../src/link.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const creds = { clientId: "id", clientSecret: "secret", hmacKey: "k" };

test("nonce: HMAC-SHA256 of '<time>:<account_id>', URL-safe base64 without padding", () => {
  const n = nonceFor("k", "1771130906289", "ava1.ring.account.X");
  const want = createHmac("sha256", "k").update("1771130906289:ava1.ring.account.X").digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(n, want);
  assert.doesNotMatch(n, /[+/=]/);
});

test("link time must be within 10 minutes and not in the future", () => {
  const now = 1_800_000_000_000;
  assert.ok(freshTime(String(now - 60_000), now));
  assert.ok(!freshTime(String(now - 601_000), now));
  assert.ok(!freshTime(String(now + 60_000), now));
  assert.ok(!freshTime("abc", now));
});

test("exchange → unclaimed token; claim after sign-in → POST then PATCH completed", async () => {
  const calls: string[] = [];
  const fake: typeof fetch = async (input, init) => {
    const u = String(input);
    calls.push(`${init?.method ?? "GET"} ${new URL(u).pathname}`);
    if (u.includes("oauth")) return Response.json({ access_token: "A", refresh_token: "R", expires_in: 14400 });
    if (u.endsWith("/v1/users/me")) return Response.json({ data: { id: "ava1.ring.account.X" } });
    return new Response(null, { status: 200 });
  };
  const dir = mkdtempSync(join(tmpdir(), "cb-"));
  const l = new Linker(creds, join(dir, "t.json"), fake);
  const now = Date.now();
  await l.exchange("code", now);
  assert.equal(l.tokens[0].status, "unclaimed");
  assert.equal(await l.token(now), undefined, "unclaimed tokens are never used");
  const time = String(now - 1000);
  assert.equal(typeof (await l.claim("wrong", time, "a@b.co", now)), "string");
  const r = await l.claim(nonceFor("k", time, "ava1.ring.account.X"), time, "admin@agency.com", now);
  assert.equal(typeof r, "object");
  assert.equal(l.tokens[0].status, "completed");
  assert.deepEqual(calls.slice(-2), ["POST /v1/accounts/me/app-integrations", "PATCH /v1/accounts/me/app-integrations"]);
  assert.equal(await l.token(now), "A");
});

test("credentials CSV from the Developer Console", () => {
  const dir = mkdtempSync(join(tmpdir(), "cb-"));
  const f = join(dir, "c.csv");
  writeFileSync(f, "Client ID,CareBell_x\nClient Secret,s3\nHMAC Signature Key,hk\n");
  assert.deepEqual(readCredentials(f), { clientId: "CareBell_x", clientSecret: "s3", hmacKey: "hk" });
});
