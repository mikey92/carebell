// State on disk (one JSON file), a clock the demo can move forward, and the demo household.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { emptyState, type CareState } from "./care.ts";

const MIN = 60_000;

/** Real time plus an offset, so a two-hour visit can be shown in a three-minute video. */
export class Clock {
  offset = 0;
  now() {
    return Date.now() + this.offset;
  }
  advance(ms: number) {
    this.offset += ms;
  }
}

export class Store {
  path: string;
  state: CareState;
  constructor(path: string, seed: () => CareState) {
    this.path = path;
    this.state = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as CareState) : seed();
  }
  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path + ".tmp", JSON.stringify(this.state, null, 1));
    renameSync(this.path + ".tmp", this.path);
  }
}

/**
 * Two clients on one agency's schedule. Mrs. Park's door is the Ring device (the Playground
 * doorbell when connected); Mr. Lee's door is simulated. Times are relative to `now`.
 */
export function demoState(now: number, ringDeviceId = "sim.ring.device.park-front-door"): CareState {
  const s = emptyState();
  s.clients.push(
    { id: "park", name: "Mrs. Park", deviceId: ringDeviceId, family: ["Ellie (daughter)"], note: "84, lives alone. Needs help with lunch and evening medication." },
    { id: "lee", name: "Mr. Lee", deviceId: "sim.ring.device.lee-front-door", family: ["James (son)"], note: "79, recovering from a hip replacement." },
  );
  s.aides.push({ id: "maria", name: "Maria Santos" }, { id: "daniel", name: "Daniel Kim" });
  const at = (m: number) => now + m * MIN;
  s.visits.push(
    { id: "v-park-am", clientId: "park", aideId: "maria", start: at(-210), end: at(-150), tasks: ["Breakfast", "Morning medication"], status: "completed", checkIn: at(-212), checkOut: at(-149), evidence: [], flags: [] },
    { id: "v-park-noon", clientId: "park", aideId: "maria", start: at(2), end: at(122), tasks: ["Lunch", "Bathing", "Light housekeeping"], status: "scheduled", evidence: [], flags: [] },
    { id: "v-lee-noon", clientId: "lee", aideId: "daniel", start: at(5), end: at(65), tasks: ["Physical therapy exercises", "Lunch"], status: "scheduled", evidence: [], flags: [] },
    { id: "v-park-pm", clientId: "park", aideId: "maria", start: at(420), end: at(480), tasks: ["Dinner", "Evening medication"], status: "scheduled", evidence: [], flags: [] },
  );
  return s;
}
