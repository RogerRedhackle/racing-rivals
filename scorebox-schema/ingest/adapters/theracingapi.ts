// =============================================================================
// The Racing API adapter  (https://www.theracingapi.com)  🟥 PACK (racing)
// -----------------------------------------------------------------------------
// First concrete RacingProvider. Converts The Racing API's racecards + results
// JSON into the normalised shape. The worker never imports this directly by
// type — it takes a `RacingProvider`, so a second provider is just another file
// in this folder.
//
// Auth: HTTP Basic with your username + password (their standard scheme).
//   env: RACING_API_USER, RACING_API_PASS  (or pass into the constructor)
//
// Endpoints used (Standard plan; adjust paths to your plan/version):
//   GET /v1/racecards/standard?day=YYYY-MM-DD&region_codes=gb,ire
//   GET /v1/results?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
//
// NOTE ON FIELD NAMES: providers rename fields between plans/versions. The
// mapping below is centralised in `mapCard()` / `mapResult()` so when a field
// name differs on your plan you change it in exactly one place. Anything we
// can't get on the "form + odds only" tier (jockey/trainer richness, etc.) is
// simply left null — the schema and prototypes already handle that (SRC? state).
// =============================================================================

import {
  NormalisedMeeting,
  NormalisedResult,
  RacingProvider,
  parseFractional,
} from "../types.ts";

interface TheRacingApiOpts {
  user?: string;
  pass?: string;
  baseUrl?: string;
  regions?: string[]; // e.g. ['gb','ire']
}

export class TheRacingApiProvider implements RacingProvider {
  readonly name = "theracingapi";
  private auth: string;
  private baseUrl: string;
  private regions: string[];

  constructor(opts: TheRacingApiOpts = {}) {
    const user = opts.user ?? getEnv("RACING_API_USER");
    const pass = opts.pass ?? getEnv("RACING_API_PASS");
    if (!user || !pass) {
      throw new Error("TheRacingApiProvider: set RACING_API_USER and RACING_API_PASS");
    }
    this.auth = "Basic " + btoa(`${user}:${pass}`);
    this.baseUrl = (opts.baseUrl ?? "https://api.theracingapi.com").replace(/\/$/, "");
    this.regions = opts.regions ?? ["gb", "ire"];
  }

  private async get(path: string, params: Record<string, string>): Promise<any> {
    const qs = new URLSearchParams(params).toString();
    const url = `${this.baseUrl}${path}${qs ? "?" + qs : ""}`;
    const res = await fetch(url, { headers: { authorization: this.auth } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`theracingapi ${res.status} on ${path}: ${body.slice(0, 300)}`);
    }
    return res.json();
  }

  // -- racecards ---------------------------------------------------------------
  async fetchCards(date: string): Promise<NormalisedMeeting[]> {
    const data = await this.get("/v1/racecards/standard", {
      day: date,
      region_codes: this.regions.join(","),
    });
    return this.mapCards(date, data);
  }

  // -- results -----------------------------------------------------------------
  async fetchResults(date: string): Promise<NormalisedResult[]> {
    const data = await this.get("/v1/results", {
      start_date: date,
      end_date: date,
      region_codes: this.regions.join(","),
    });
    return this.mapResults(date, data);
  }

  // ---- mapping (the ONE place field names live) ------------------------------
  private mapCards(date: string, data: any): NormalisedMeeting[] {
    const races: any[] = data?.racecards ?? data?.results ?? [];
    // group races by course into meetings
    const byCourse = new Map<string, NormalisedMeeting>();
    for (const rc of races) {
      const course = rc.course ?? rc.course_name ?? "Unknown";
      if (!byCourse.has(course)) {
        byCourse.set(course, {
          course,
          date,
          going: rc.going ?? null,
          festivalSlug: null,
          races: [],
        });
      }
      const meeting = byCourse.get(course)!;
      const runners = (rc.runners ?? []).map((r: any) => {
        const frac = parseFractional(r.odds?.[0]?.fractional ?? r.sp ?? r.odds ?? null);
        return {
          clothNo: Number(r.number ?? r.cloth_number ?? r.saddle ?? 0),
          horseName: r.horse ?? r.name ?? "Unknown",
          jockey: r.jockey ?? null,
          trainer: r.trainer ?? null,
          oddsNum: frac.oddsNum,
          oddsDen: frac.oddsDen,
          // the feed may flag the favourite; else the DB derives it from price
          isFavourite: Boolean(r.favourite ?? r.is_favourite ?? false),
          status: (r.non_runner ?? r.is_non_runner) ? "non_runner" : "runner",
        };
      });
      meeting.races.push({
        raceNo: Number(rc.race_number ?? rc.race_no ?? meeting.races.length + 1),
        name: rc.race_name ?? rc.name ?? `Race ${meeting.races.length + 1}`,
        offTime: rc.off_dt ?? rc.off_time ?? `${date}T00:00:00+00:00`,
        distance: rc.distance ?? rc.distance_f ?? null,
        raceClass: rc.race_class ?? rc.class ?? null,
        placesPaid: rc.places_paid ?? null,
        providerRaceId: String(rc.race_id ?? rc.id ?? ""),
        runners,
      });
    }
    return [...byCourse.values()];
  }

  private mapResults(date: string, data: any): NormalisedResult[] {
    const races: any[] = data?.results ?? data?.racecards ?? [];
    return races.map((rc: any) => {
      const runners: any[] = rc.runners ?? [];
      const voidRace = Boolean(rc.void ?? rc.abandoned ?? false);
      const placings = runners.map((r: any) => ({
        clothNo: Number(r.number ?? r.cloth_number ?? 0),
        // providers give position as "1".."N" or "PU"/"F"/"UR" for non-finishers
        finishPos: parsePos(r.position ?? r.finish_pos),
        isVoid: Boolean(r.void ?? false),
      }));
      const finalOdds = runners
        .map((r: any) => {
          const f = parseFractional(r.sp ?? r.sp_fractional ?? null);
          return { clothNo: Number(r.number ?? 0), oddsNum: f.oddsNum, oddsDen: f.oddsDen };
        })
        .filter((o) => o.oddsNum !== null);
      return {
        providerRaceId: String(rc.race_id ?? rc.id ?? ""),
        course: rc.course ?? rc.course_name ?? "Unknown",
        date,
        raceNo: Number(rc.race_number ?? rc.race_no ?? 0),
        voidRace,
        placings,
        finalOdds: finalOdds.length ? finalOdds : undefined,
      };
    });
  }
}

function parsePos(p: unknown): number | null {
  if (p === null || p === undefined) return null;
  const n = Number(String(p).trim());
  return Number.isFinite(n) && n >= 1 ? n : null; // PU/F/UR/etc -> unplaced
}

function getEnv(k: string): string | undefined {
  // works under Deno and Node
  // @ts-ignore - Deno global
  if (typeof Deno !== "undefined") return Deno.env.get(k);
  // @ts-ignore - Node global
  return typeof process !== "undefined" ? process.env?.[k] : undefined;
}
