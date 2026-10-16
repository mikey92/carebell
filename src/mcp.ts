// CareBell for Alexa+: an MCP server (Streamable HTTP, protocol 2025-11-25) a family member's
// assistant can call. "Did Mom's caregiver come today?" is check_visit; the answer carries an
// MCP App card (ui://carebell/visit-card) for screens like Echo Show.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Engine, Visit } from "./care.ts";
import type { Clock } from "./store.ts";
import { visitCardHtml } from "./card.ts";

const CARD = "ui://carebell/visit-card";
const MIN = 60_000;

/** One time zone for every time CareBell shows or says (the agency's). */
export const TZ = process.env.CAREBELL_TZ ?? "America/Los_Angeles";
export function time(ms: number) {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
}

/** The agency's day: visits from 14 hours back to 14 hours ahead, so a demo never falls off a midnight. */
export const WINDOW = 14 * 60 * 60_000;

/** What goes to an assistant: no photos, no private notes. */
export const forAssistant = (v: any) => ({ id: v.id, status: v.status, start: v.start, end: v.end, checkIn: v.checkIn, checkOut: v.checkOut, tasks: v.tasks, flags: v.flags, client: { name: v.client.name }, aide: { name: v.aide.name } });

export function describe(v: Visit & { client: { name: string }; aide: { name: string } }, now: number): string {
  const who = v.aide.name.split(" ")[0];
  switch (v.status) {
    case "scheduled":
      return v.start > now ? `${who} is due at ${v.client.name}'s at ${time(v.start)} for ${v.tasks.join(", ").toLowerCase()}.` : `${who}'s visit is due now.`;
    case "late":
      return `${who} was due at ${time(v.start)} and hasn't come to the door yet.`;
    case "missed":
      return `${who} didn't come to the ${time(v.start)} visit. The agency has been told.`;
    case "on_site":
      return `${who} arrived at ${time(v.checkIn!)} and has been there ${Math.round((now - v.checkIn!) / MIN)} minutes.`;
    case "completed":
      if (v.checkIn === undefined) return `${who}'s visit at ${time(v.start)} is closed.`;
      return v.checkOut === undefined
        ? `${who} came at ${time(v.checkIn)}; the doorbell didn't see them leave.`
        : `${who} came at ${time(v.checkIn)} and left at ${time(v.checkOut)}${v.flags.length ? ` (${v.flags.join("; ")})` : ""}.`;
  }
}

function findClient(e: Engine, name?: string) {
  if (!name) return e.s.clients[0];
  const n = name.toLowerCase().replace(/^(my |the )/, "");
  if (/^(mom|mother|mum|dad|father)$/.test(n)) return e.s.clients[0];
  return e.s.clients.find((c) => c.name.toLowerCase().includes(n) || c.id === n || c.family.some((f) => f.toLowerCase().includes(n))) ?? e.s.clients[0];
}

export function buildMcp(engine: Engine, clock: Clock, save: () => void) {
  const server = new McpServer({ name: "carebell", version: "0.1.0" }, { instructions: "CareBell tells a family whether their parent's home-care aide came, using the Ring doorbell at the parent's door. Answer in one or two spoken sentences; the card shows the detail." });
  const today = () => engine.between(clock.now() - WINDOW, clock.now() + WINDOW);
  const ui = { ui: { resourceUri: CARD } };

  server.registerResource("visit-card", CARD, { mimeType: "text/html;profile=mcp-app", description: "A visit timeline card for screens." }, async () => ({
    contents: [{ uri: CARD, mimeType: "text/html;profile=mcp-app", text: visitCardHtml() }],
  }));

  server.registerTool(
    "check_visit",
    {
      title: "Did the caregiver come?",
      description: "Whether today's home-care visit for a client happened: arrived, left, late or missed, with the doorbell events as evidence.",
      inputSchema: { client: z.string().optional().describe("Client name, e.g. 'Mrs. Park' or 'Mom'") },
      _meta: ui,
    },
    async ({ client }) => {
      const now = clock.now();
      const c = findClient(engine, client);
      const visits = today().filter((v) => v.clientId === c.id);
      const current =
        visits.find((v) => v.status === "on_site") ??
        visits.find((v) => v.status === "late" || v.status === "missed") ??
        [...visits].reverse().find((v) => v.start <= now) ??
        visits[0];
      const text = current ? describe(current, now) : `No visits on ${c.name}'s schedule today.`;
      return { content: [{ type: "text", text }], structuredContent: { client: c.name, now, tz: TZ, visits: visits.map(forAssistant), current: current?.id ?? null } };
    },
  );

  server.registerTool(
    "todays_schedule",
    {
      title: "Today's visits",
      description: "Every visit on today's schedule for one client or all clients, with status.",
      inputSchema: { client: z.string().optional() },
      _meta: ui,
    },
    async ({ client }) => {
      const now = clock.now();
      const c = client ? findClient(engine, client) : undefined;
      const visits = today().filter((v) => !c || v.clientId === c.id);
      return {
        content: [{ type: "text", text: visits.map((v) => `${time(v.start)} ${v.client.name}: ${describe(v, now)}`).join("\n") || "Nothing scheduled today." }],
        structuredContent: { client: c?.name ?? null, now, tz: TZ, visits: visits.map(forAssistant), current: null },
      };
    },
  );

  server.registerTool(
    "recent_alerts",
    { title: "Recent alerts", description: "Alerts CareBell sent today (arrivals, departures, late and missed visits, offline doorbells).", inputSchema: { limit: z.number().int().min(1).max(20).optional() } },
    async ({ limit }) => {
      const a = engine.s.alerts.filter((x) => x.at >= clock.now() - WINDOW).slice(-(limit ?? 5)).reverse();
      return { content: [{ type: "text", text: a.map((x) => `${time(x.at)} ${x.text}`).join("\n") || "No alerts today." }], structuredContent: { alerts: a } };
    },
  );

  server.registerTool(
    "tell_agency",
    {
      title: "Message the agency",
      description: "Send the care agency a note about a client's visit, e.g. a concern or a request to send someone else. Use when the family asks to contact the agency.",
      inputSchema: { client: z.string().optional(), message: z.string().min(3).max(500), urgent: z.boolean().optional() },
    },
    async ({ client, message, urgent }) => {
      const c = findClient(engine, client);
      const now = clock.now();
      const alert = { id: `fam-${now}`, at: now, level: urgent ? ("urgent" as const) : ("warn" as const), to: "agency" as const, clientId: c.id, text: `From ${c.family[0] ?? "family"} about ${c.name}: ${message}` };
      engine.s.alerts.push(alert);
      engine.onAlert(alert);
      save();
      return { content: [{ type: "text", text: `Sent to the agency${urgent ? " as urgent" : ""}.` }], structuredContent: { alert } };
    },
  );

  return server;
}
