// The visit engine: turns doorbell events into home-care visit records and alerts.
// Pure and clock-free: every call takes `now`, so tests and the demo can run time forward.

export interface Client { id: string; name: string; deviceId: string; family: string[]; note?: string }
export interface Aide { id: string; name: string; phone?: string }
export type VisitStatus = "scheduled" | "late" | "on_site" | "completed" | "missed";

export interface DoorEvent {
  id: string;
  deviceId: string;
  /** button_press | motion_detected | device_offline | device_online */
  type: string;
  subType?: string;
  timestamp: number;
  source: "webhook" | "history" | "simulator";
}

export interface Visit {
  id: string;
  clientId: string;
  aideId: string;
  start: number;
  end: number;
  tasks: string[];
  status: VisitStatus;
  checkIn?: number;
  checkOut?: number;
  /** Door events that decided this visit, newest last. */
  evidence: { eventId: string; type: string; subType?: string; at: number; role: "arrival" | "departure" | "seen" }[];
  flags: string[];
  snapshot?: string;
}

export interface Alert {
  id: string;
  at: number;
  level: "info" | "warn" | "urgent";
  to: "family" | "agency" | "both";
  visitId?: string;
  clientId?: string;
  text: string;
}

export interface CareState {
  clients: Client[];
  aides: Aide[];
  visits: Visit[];
  alerts: Alert[];
  /** Event ids already handled (Ring retries; request_id/event id make handling idempotent). */
  seen: string[];
  offline: string[];
}

export const RULES = {
  /** An aide ringing up to this early still counts as arriving for the visit. */
  earlyMs: 20 * 60_000,
  /** No one at the door this long after the start: family hears the aide is late. */
  lateMs: 10 * 60_000,
  /** ...and this long: the agency is asked to send someone else. */
  missedMs: 30 * 60_000,
  /** Door activity this long after check-in is read as the aide leaving. */
  minStayMs: 20 * 60_000,
  /** A visit shorter than this share of the plan is flagged. */
  shortShare: 0.8,
};

const MIN = 60_000;
const fmt = (ms: number) => `${Math.round(ms / MIN)} min`;

/** Arrival: a doorbell press, or a person (or unclassified motion, when Smart Alerts is off). */
const isPerson = (e: DoorEvent) => e.type === "button_press" || (e.type === "motion_detected" && (e.subType === "human" || e.subType === "motion"));
/** Departure needs stronger evidence: a press or a classified person, not any motion. */
const isLeaving = (e: DoorEvent) => e.type === "button_press" || (e.type === "motion_detected" && e.subType === "human");

export class Engine {
  s: CareState;
  onAlert: (a: Alert) => void = () => {};

  constructor(state: CareState) {
    this.s = state;
  }

  client(id: string) {
    return this.s.clients.find((c) => c.id === id)!;
  }
  aide(id: string) {
    return this.s.aides.find((a) => a.id === id)!;
  }

  private alert(now: number, a: Omit<Alert, "id" | "at">) {
    const full: Alert = { id: `a${this.s.alerts.length + 1}-${now}`, at: now, ...a };
    this.s.alerts.push(full);
    this.onAlert(full);
  }

  /** One door event. Returns the visit it changed, if any. Events outside every visit window are ignored on purpose. */
  handle(e: DoorEvent, now = e.timestamp): Visit | undefined {
    if (this.s.seen.includes(e.id)) return;
    this.s.seen.push(e.id);
    if (this.s.seen.length > 5000) this.s.seen.splice(0, 1000);
    if (this.s.alerts.length > 500) this.s.alerts.splice(0, 100);

    const clients = this.s.clients.filter((c) => c.deviceId === e.deviceId);
    if (e.type === "device_offline" || e.type === "device_online") {
      const off = e.type === "device_offline";
      this.s.offline = this.s.offline.filter((d) => d !== e.deviceId).concat(off ? [e.deviceId] : []);
      for (const c of clients)
        this.alert(now, {
          level: off ? "warn" : "info",
          to: "agency",
          clientId: c.id,
          text: off ? `${c.name}'s doorbell went offline. Visits there can't be confirmed until it's back.` : `${c.name}'s doorbell is back online.`,
        });
      return;
    }
    if (!isPerson(e)) return;

    const ids = new Set(clients.map((c) => c.id));
    const visits = this.s.visits.filter((v) => ids.has(v.clientId));

    // Someone already inside: this is them leaving (or stepping out). A completed visit takes a later
    // departure while its planned window is still open, so a delivery at the door doesn't end it early.
    const here = visits.find(
      (v) =>
        (v.status === "on_site" && e.timestamp >= v.checkIn!) ||
        (v.status === "completed" && v.checkOut !== undefined && e.timestamp >= v.checkOut && (e.timestamp - v.checkOut < 10 * MIN || e.timestamp <= v.end)),
    );
    if (here && isLeaving(e) && e.timestamp - here.checkIn! >= RULES.minStayMs) {
      const first = here.status === "on_site";
      here.status = "completed";
      here.checkOut = e.timestamp;
      here.evidence.push({ eventId: e.id, type: e.type, subType: e.subType, at: e.timestamp, role: "departure" });
      const stayed = here.checkOut - here.checkIn!;
      const planned = here.end - here.start;
      here.flags = here.flags.filter((f) => !f.startsWith("short"));
      if (stayed < planned * RULES.shortShare) here.flags.push(`short: ${fmt(stayed)} of ${fmt(planned)} planned`);
      if (first) {
        const c = this.client(here.clientId);
        const a = this.aide(here.aideId);
        this.alert(now, {
          level: here.flags.some((f) => f.startsWith("short")) ? "warn" : "info",
          to: "family",
          visitId: here.id,
          clientId: c.id,
          text: `${a.name} left ${c.name}'s home after ${fmt(stayed)}${stayed < planned * RULES.shortShare ? ` (planned ${fmt(planned)})` : ""}.`,
        });
      }
      return here;
    }
    if (here) {
      here.evidence.push({ eventId: e.id, type: e.type, subType: e.subType, at: e.timestamp, role: "seen" });
      return here;
    }

    // Otherwise: the aide arriving for a visit whose window is open.
    const due = visits
      .filter((v) => (v.status === "scheduled" || v.status === "late" || v.status === "missed") && e.timestamp >= v.start - RULES.earlyMs && e.timestamp <= v.end)
      .sort((a, b) => Math.abs(a.start - e.timestamp) - Math.abs(b.start - e.timestamp))[0];
    if (!due) return;
    const wasMissed = due.status === "missed";
    const lateBy = e.timestamp - due.start;
    due.status = "on_site";
    due.checkIn = e.timestamp;
    due.evidence.push({ eventId: e.id, type: e.type, subType: e.subType, at: e.timestamp, role: "arrival" });
    if (lateBy >= RULES.lateMs) due.flags.push(`late: ${fmt(lateBy)}`);
    const c = this.client(due.clientId);
    const a = this.aide(due.aideId);
    const how = e.type === "button_press" ? "rang the doorbell" : "was seen at the door";
    this.alert(now, {
      level: "info",
      to: wasMissed ? "both" : "family",
      visitId: due.id,
      clientId: c.id,
      text: `${a.name} ${how} at ${c.name}'s home${lateBy >= RULES.lateMs ? `, ${fmt(lateBy)} late` : ""}. Visit started.`,
    });
    return due;
  }

  /** Runs the clock: late and missed visits. */
  tick(now: number) {
    for (const v of this.s.visits) {
      const c = this.client(v.clientId);
      const a = this.aide(v.aideId);
      const offline = this.s.offline.includes(c.deviceId);
      if (v.status === "scheduled" && now >= v.start + RULES.lateMs) {
        v.status = "late";
        this.alert(now, {
          level: "warn",
          to: "family",
          visitId: v.id,
          clientId: c.id,
          text: offline
            ? `${c.name}'s doorbell is offline, so CareBell can't see whether ${a.name} has arrived.`
            : `${a.name} hasn't arrived at ${c.name}'s home yet (due ${fmt(now - v.start)} ago).`,
        });
      }
      if (v.status === "late" && now >= v.start + RULES.missedMs) {
        v.status = "missed";
        this.alert(now, {
          level: "urgent",
          to: "both",
          visitId: v.id,
          clientId: c.id,
          text: `Missed visit: no one has come to ${c.name}'s door ${fmt(now - v.start)} after ${a.name}'s visit was due. The agency should call ${a.name} or send someone else.`,
        });
      }
      if (v.status === "on_site" && now >= v.end + 60 * MIN) {
        // Nobody was seen leaving; the record says so instead of inventing a time.
        v.flags.push("departure not seen");
        v.status = "completed";
      }
    }
  }

  /** Visits starting in [from, to), with their client and aide: what a family or a scheduler looks at. */
  between(from: number, to: number) {
    return this.s.visits
      .filter((v) => v.start >= from && v.start < to)
      .sort((a, b) => a.start - b.start)
      .map((v) => ({ ...v, client: this.client(v.clientId), aide: this.aide(v.aideId) }));
  }
}

export function emptyState(): CareState {
  return { clients: [], aides: [], visits: [], alerts: [], seen: [], offline: [] };
}
