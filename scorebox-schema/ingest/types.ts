// =============================================================================
// Normalised racing-ingest shape  🟦 ENGINE-shaped, 🟥 racing-filled
// -----------------------------------------------------------------------------
// Every provider adapter converts the feed's native JSON into THESE types. The
// worker only ever sees this shape, so swapping providers (or adding a second
// one) never touches the worker or the DB contract — you write one new adapter.
//
// This is the racing realisation of the multi-sport "sport pack" idea: the four
// adapter slots (Field / Pick / Price / Result) show up here as Meeting → Race
// → Runner (field + price) and Placing (result).
// =============================================================================

/** A day's fixture at one course. Natural key downstream: (course, date). */
export interface NormalisedMeeting {
  course: string;            // 'Royal Ascot'
  date: string;              // 'YYYY-MM-DD' (the meeting_date)
  going?: string | null;     // 'Good To Firm'
  festivalSlug?: string | null; // link to a pre-created festival, else null
  races: NormalisedRace[];
}

/** One race. Natural key downstream: (meeting, race_no). */
export interface NormalisedRace {
  raceNo: number;            // 1..20 (the printed race number on the card)
  name: string;              // 'Royal Hunt Cup'
  offTime: string;           // ISO 8601 with offset, e.g. '2026-06-17T14:30:00+00:00'
  distance?: string | null;  // '1m'
  raceClass?: string | null; // 'Class 2'
  placesPaid?: number | null;// how many places pay (1..6); null -> DB default (3)
  providerRaceId?: string;   // the feed's own id, for logging/debug
  runners: NormalisedRunner[];
}

/** One declared runner with its market price. */
export interface NormalisedRunner {
  clothNo: number;           // saddle-cloth number, 1..40 (the natural key in a race)
  horseName: string;
  jockey?: string | null;
  trainer?: string | null;
  // Price as an exact fraction (keeps the v2 base deterministic). e.g. 9/1.
  oddsNum?: number | null;
  oddsDen?: number | null;
  // Optional explicit favourite flag. If no runner is flagged, the DB derives
  // the favourite as the shortest decimal price (deterministic tie-break).
  isFavourite?: boolean;
  // 'runner' (default) | 'declared' | 'non_runner' | 'withdrawn'
  status?: RunnerStatus;
}

export type RunnerStatus = "declared" | "runner" | "non_runner" | "withdrawn";

/** One line of a finishing result. */
export interface NormalisedPlacing {
  clothNo: number;
  finishPos: number | null;  // 1.. ; null = unplaced / DNF / pulled up
  isVoid?: boolean;          // this runner voided (e.g. withdrawn at start)
}

/** A full result for a race, as produced by an adapter's result endpoint. */
export interface NormalisedResult {
  providerRaceId?: string;
  // Match a race we already ingested. Adapters should supply enough to resolve
  // it: either the providerRaceId (preferred if we stored it) or the triple.
  course: string;
  date: string;              // 'YYYY-MM-DD'
  raceNo: number;
  voidRace?: boolean;        // whole race abandoned/void
  placings: NormalisedPlacing[];
  // Optional closing SP per cloth_no, to lock real SP onto runners before scoring.
  finalOdds?: { clothNo: number; oddsNum: number | null; oddsDen: number | null }[];
}

// -----------------------------------------------------------------------------
// The adapter interface every provider must implement.
// -----------------------------------------------------------------------------
export interface RacingProvider {
  /** Short id stored in the ingest audit log, e.g. 'theracingapi'. */
  readonly name: string;

  /** Fetch the full racecards (meetings → races → runners) for a given date. */
  fetchCards(date: string): Promise<NormalisedMeeting[]>;

  /** Fetch results for a given date (or a subset that's resulted so far). */
  fetchResults(date: string): Promise<NormalisedResult[]>;
}

// -----------------------------------------------------------------------------
// Small shared helpers used by adapters.
// -----------------------------------------------------------------------------

/** Parse a fractional-odds string like "9/1", "7/2", "Evens", "EVS" -> {num,den}. */
export function parseFractional(
  s: string | null | undefined,
): { oddsNum: number | null; oddsDen: number | null } {
  if (!s) return { oddsNum: null, oddsDen: null };
  const t = s.trim().toLowerCase();
  if (t === "evens" || t === "evs" || t === "even") return { oddsNum: 1, oddsDen: 1 };
  if (t === "sp" || t === "nr" || t === "-") return { oddsNum: null, oddsDen: null };
  const m = t.match(/^(\d+)\s*[/-]\s*(\d+)$/);
  if (m) return { oddsNum: Number(m[1]), oddsDen: Number(m[2]) };
  // decimal fallback (e.g. "10.0") -> convert to a fraction over 1 (lossy but ok)
  const dec = Number(t);
  if (Number.isFinite(dec) && dec > 1) {
    return { oddsNum: Math.round((dec - 1) * 100), oddsDen: 100 };
  }
  return { oddsNum: null, oddsDen: null };
}
