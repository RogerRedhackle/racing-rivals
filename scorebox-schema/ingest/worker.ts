// =============================================================================
// Ingest worker  🟦 ENGINE (provider-agnostic)
// -----------------------------------------------------------------------------
// Pulls racecards + results from ANY RacingProvider and writes them through the
// service_role-only RPCs in 06_ingest.sql. The worker issues NO raw SQL — all
// integrity (idempotency, one favourite, the status machine, NR handling) lives
// in the DB, so this file stays thin and provider-swappable.
//
// Two operations (run on a schedule — see scheduler/README):
//   ingestCards(date)   — declarations + odds, run through the morning/afternoon
//                         so odds drift and non-runners are picked up.
//   ingestResults(date) — finishing order + closing SP; flips races to
//                         'resulted', which is exactly the signal the ENGINE's
//                         orchestrate_tick gates on to score the day.
//
// Both are idempotent end-to-end: re-running converges to the same DB state and
// never double-writes (the RPCs upsert / delete-then-insert).
//
// Connection: PostgREST RPC with the service-role key (same as the orchestrator
// fallback). Runs under Deno or Node 18+.
// =============================================================================

import { RacingProvider, NormalisedMeeting, NormalisedResult } from "./types.ts";

interface WorkerOpts {
  supabaseUrl?: string;
  serviceRoleKey?: string;
}

export class IngestWorker {
  private url: string;
  private key: string;
  private provider: RacingProvider;

  constructor(provider: RacingProvider, opts: WorkerOpts = {}) {
    this.provider = provider;
    this.url = (opts.supabaseUrl ?? env("SUPABASE_URL") ?? "").replace(/\/$/, "");
    this.key = opts.serviceRoleKey ?? env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!this.url || !this.key) {
      throw new Error("IngestWorker: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    }
  }

  /** Call a Postgres RPC over PostgREST with the service-role key. */
  private async rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: this.key,
        authorization: `Bearer ${this.key}`,
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`rpc ${fn} failed (${res.status}): ${body.slice(0, 400)}`);
    }
    return res.json() as Promise<T>;
  }

  // -- 1. cards: meetings -> races -> runners ----------------------------------
  async ingestCards(date: string): Promise<{ meetings: number; races: number; runners: number }> {
    const meetings: NormalisedMeeting[] = await this.provider.fetchCards(date);
    let nMeet = 0, nRace = 0, nRun = 0;

    for (const m of meetings) {
      const meetingId = await this.rpc<string>("ingest_meeting", {
        p_course: m.course,
        p_meeting_date: m.date,
        p_going: m.going ?? null,
        p_festival_slug: m.festivalSlug ?? null,
        p_provider: this.provider.name,
      });
      nMeet++;

      for (const r of m.races) {
        const raceId = await this.rpc<string>("ingest_race", {
          p_meeting_id: meetingId,
          p_race_no: r.raceNo,
          p_name: r.name,
          p_off_time: r.offTime,
          p_distance: r.distance ?? null,
          p_race_class: r.raceClass ?? null,
          p_places_paid: r.placesPaid ?? null,
          p_provider: this.provider.name,
        });
        nRace++;

        const runners = r.runners.map((x) => ({
          cloth_no: x.clothNo,
          horse_name: x.horseName,
          jockey: x.jockey ?? null,
          trainer: x.trainer ?? null,
          odds_num: x.oddsNum ?? null,
          odds_den: x.oddsDen ?? null,
          is_favourite: x.isFavourite ?? false,
          status: x.status ?? "runner",
        }));
        const count = await this.rpc<number>("ingest_runners", {
          p_race_id: raceId,
          p_runners: runners,
          p_provider: this.provider.name,
        });
        nRun += count ?? 0;
      }
    }
    return { meetings: nMeet, races: nRace, runners: nRun };
  }

  // -- 2. results: finishing order + closing SP, then 'resulted' ---------------
  async ingestResults(date: string): Promise<{ races_resulted: number; voided: number }> {
    const results: NormalisedResult[] = await this.provider.fetchResults(date);
    let resulted = 0, voided = 0;

    for (const res of results) {
      // resolve the race we ingested earlier by (course, date, race_no)
      const raceId = await this.resolveRaceId(res.course, res.date, res.raceNo);
      if (!raceId) {
        console.warn(`ingestResults: no ingested race for ${res.course} ${res.date} R${res.raceNo}`);
        continue;
      }

      if (res.voidRace) {
        await this.rpc("apply_result", {
          p_race_id: raceId,
          p_placings: [],
          p_void_race: true,
          p_final_odds: null,
          p_provider: this.provider.name,
        });
        voided++;
        continue;
      }

      await this.rpc("apply_result", {
        p_race_id: raceId,
        p_placings: res.placings.map((p) => ({
          cloth_no: p.clothNo,
          finish_pos: p.finishPos,
          is_void: p.isVoid ?? false,
        })),
        p_void_race: false,
        p_final_odds: res.finalOdds
          ? res.finalOdds.map((o) => ({ cloth_no: o.clothNo, odds_num: o.oddsNum, odds_den: o.oddsDen }))
          : null,
        p_provider: this.provider.name,
      });
      resulted++;
    }
    return { races_resulted: resulted, voided };
  }

  /** Resolve a race id from (course, date, race_no) via a PostgREST select. */
  private async resolveRaceId(course: string, date: string, raceNo: number): Promise<string | null> {
    // meetings filtered by course+date, then the race by race_no
    const mUrl =
      `${this.url}/rest/v1/meetings?select=id&course=eq.${encodeURIComponent(course)}` +
      `&meeting_date=eq.${date}`;
    const mRes = await fetch(mUrl, {
      headers: { apikey: this.key, authorization: `Bearer ${this.key}` },
    });
    const meetings = (await mRes.json()) as { id: string }[];
    if (!meetings?.length) return null;

    const rUrl =
      `${this.url}/rest/v1/races?select=id&meeting_id=eq.${meetings[0].id}&race_no=eq.${raceNo}`;
    const rRes = await fetch(rUrl, {
      headers: { apikey: this.key, authorization: `Bearer ${this.key}` },
    });
    const races = (await rRes.json()) as { id: string }[];
    return races?.[0]?.id ?? null;
  }
}

function env(k: string): string | undefined {
  // @ts-ignore Deno
  if (typeof Deno !== "undefined") return Deno.env.get(k);
  // @ts-ignore Node
  return typeof process !== "undefined" ? process.env?.[k] : undefined;
}
