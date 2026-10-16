# Friction log

What got in the way while building CareBell on the Ring Partner API, in the order it happened.
Severity: **high** blocks the build, **medium** costs real time or forces a workaround, **low** is a papercut.

## 1. The Playground can't send doorbell or motion webhooks
- **Task:** test CareBell's webhook handler with a real `button_press`.
- **Steps:** Developer Console → Playground → Generate token; looked for a way to trigger events.
- **Expected:** a "send test webhook" button (button press, human motion) to a URL I enter, signed with a test HMAC key.
- **Actual:** the Playground can simulate live-view *streams* (Package, Vehicle, Motion), but nothing is delivered to a webhook URL, and there is no test signing key.
- **Severity:** high (the webhook is the core of any real-time Ring app).
- **Workaround:** wrote `src/simulate.ts`, which builds v1.1 payloads exactly as documented, signs them with HMAC-SHA256 over the raw body and POSTs them to the real endpoint.
- **Suggestion:** a "Send test event" panel in the Playground: event type, sub_type, target URL, and a per-developer test HMAC key.

## 2. Event history is empty on the Playground device
- **Task:** use the documented polling alternative (`GET /v1/history/devices/{id}/events`).
- **Expected:** a few sample `ding` / `motion` events so parsing can be tested.
- **Actual:** `{"data": []}` every time.
- **Severity:** medium. The history code path can only be tested against made-up data.
- **Suggestion:** seed the Playground device with a day of sample events, or let simulated live-view events also appear in history.

## 3. Snapshots on the Playground: `TIME_RANGE_NOT_AUTHORIZED`
- **Task:** attach a door snapshot to the "visit started" notification (`POST /v1/devices/{id}/media/image/download`).
- **Actual:** `403 TIME_RANGE_NOT_AUTHORIZED: Requested time range is not within authorized boundaries` for `latest_in_range` over the last hour.
- **Expected:** either an image or an error that says which time range *is* authorized.
- **Severity:** medium.
- **Workaround:** the snapshot is optional; the notification goes out without it.
- **Suggestion:** document the authorized range for Playground tokens, and include it in the error `detail`.

## 4. Playground token: 30 minutes, UI only
- **Task:** keep a local server connected while developing.
- **Actual:** the token lasts ~30 minutes, has no refresh token, and can only be copied from the page (it is cleared when the tab closes).
- **Severity:** low.
- **Suggestion:** a longer-lived developer token, or a refresh token for Playground sessions.

## 5. Developer registration form
- **Task:** register as a developer to reach the Playground.
- **Actual:** the Country, State and phone-country fields are custom dropdowns; typing a value shows it but doesn't select it, and the form reports "required field" with the value visibly filled in.
- **Severity:** low.
- **Suggestion:** native `<select>` elements, or commit the typed value on blur.

## What worked well
- `GET /v1/devices`, `/status`, `/capabilities` answered first time with a Playground token; JSON:API responses are consistent.
- The webhook docs are unusually precise: raw-body HMAC, hex encoding, `request_id` for idempotency, the retry schedule. CareBell's handler was written from the docs alone.
- The `ring-api-helloworld` repo is a good map of the endpoints.
