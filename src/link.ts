// Ring one-way account linking, as documented:
// 1. Ring POSTs an authorization code to the Token Exchange URL; we swap it for tokens within 60 s
//    and read the Ring account id from /v1/users/me. The token is "unclaimed".
// 2. Ring sends the user's browser to the Account Link URL with ?nonce&time. The agency signs in;
//    only then do we match the nonce (HMAC-SHA256 of "<time>:<account_id>", URL-safe base64)
//    against unclaimed tokens, POST /v1/accounts/me/app-integrations, then PATCH status=completed.
// 3. Access tokens (~4 h) are refreshed with the refresh token before they expire.

import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { RING_API } from "./ring.ts";

export const RING_OAUTH = "https://oauth.ring.com/oauth/token";
const WINDOW_MS = 600_000;

export interface AppCredentials { clientId: string; clientSecret: string; hmacKey: string }
export interface TokenRecord {
  accountId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  claimedBy?: string;
  linkedAt?: number;
  status: "unclaimed" | "awaiting" | "completed";
}

/** The CSV the Developer Console offers once, at app creation: "Client ID,<v>" / "Client Secret,<v>" / "HMAC Signature Key,<v>". */
export function readCredentials(path: string): AppCredentials | undefined {
  if (!existsSync(path)) return;
  const rows = Object.fromEntries(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf(",");
        return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()];
      }),
  );
  const clientId = rows["client id"];
  const clientSecret = rows["client secret"];
  const hmacKey = rows["hmac signature key"] ?? rows["hmac signing key"];
  return clientId && clientSecret && hmacKey ? { clientId, clientSecret, hmacKey } : undefined;
}

export function nonceFor(key: string, time: string, accountId: string): string {
  return createHmac("sha256", key).update(`${time}:${accountId}`).digest("base64url");
}

function same(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Fresh, not from the future. */
export function freshTime(time: string, now = Date.now()): boolean {
  const t = Number(time);
  return Number.isFinite(t) && t <= now + 5_000 && now - t <= WINDOW_MS;
}

export class Linker {
  creds: AppCredentials;
  path: string;
  tokens: TokenRecord[];
  fetchFn: typeof fetch;

  constructor(creds: AppCredentials, path: string, fetchFn: typeof fetch = fetch) {
    this.creds = creds;
    this.path = path;
    this.fetchFn = fetchFn;
    this.tokens = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.tokens, null, 1), { mode: 0o600 });
  }

  private async oauth(params: Record<string, string>) {
    const r = await this.fetchFn(RING_OAUTH, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, client_id: this.creds.clientId, client_secret: this.creds.clientSecret }),
    });
    if (!r.ok) throw new Error(`Ring OAuth ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as { access_token: string; refresh_token: string; expires_in: number };
  }

  /** Step 1: the code Ring POSTs to the Token Exchange URL. */
  async exchange(code: string, now = Date.now()): Promise<TokenRecord> {
    const t = await this.oauth({ grant_type: "authorization_code", code });
    const me = await this.fetchFn(`${RING_API}/v1/users/me`, { headers: { Authorization: `Bearer ${t.access_token}` } });
    if (!me.ok) throw new Error(`users/me ${me.status}`);
    const accountId = (await me.json()).data.id as string;
    const rec: TokenRecord = { accountId, accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: now + t.expires_in * 1000, status: "unclaimed" };
    this.tokens = this.tokens.filter((x) => x.accountId !== accountId).concat(rec);
    this.save();
    return rec;
  }

  /** Step 2, after the agency has signed in. Returns the linked record, or why it failed. */
  async claim(nonce: string, time: string, signedInAs: string, now = Date.now()): Promise<TokenRecord | string> {
    if (!freshTime(time, now)) return "This link has expired. Start again from the Ring app.";
    const rec = this.tokens.find((t) => t.status !== "completed" && same(nonceFor(this.creds.hmacKey, time, t.accountId), nonce));
    if (!rec) return "We couldn't match this link to a Ring account. Start again from the Ring app.";
    const masked = signedInAs.replace(/^(.)(.*)(.@.*)$/, (_, a, mid, b) => a + "*".repeat(Math.max(1, mid.length)) + b);
    const call = (method: string, body: unknown) =>
      this.fetchFn(`${RING_API}/v1/accounts/me/app-integrations`, { method, headers: { Authorization: `Bearer ${rec.accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const post = await call("POST", { account_identifier: masked, nonce });
    if (!post.ok) return `Ring didn't accept the link (${post.status}).`;
    rec.status = "awaiting";
    const patch = await call("PATCH", { status: "completed" });
    if (!patch.ok) return `Ring didn't complete the link (${patch.status}).`;
    rec.status = "completed";
    rec.claimedBy = signedInAs;
    rec.linkedAt = now;
    this.save();
    return rec;
  }

  /** A current access token for the linked account, refreshed a few minutes before it expires. */
  async token(now = Date.now()): Promise<string | undefined> {
    const rec = this.tokens.find((t) => t.status === "completed");
    if (!rec) return;
    if (rec.expiresAt - now < 5 * 60_000) {
      const t = await this.oauth({ grant_type: "refresh_token", refresh_token: rec.refreshToken });
      rec.accessToken = t.access_token;
      rec.refreshToken = t.refresh_token ?? rec.refreshToken;
      rec.expiresAt = now + t.expires_in * 1000;
      this.save();
    }
    return rec.accessToken;
  }
}
