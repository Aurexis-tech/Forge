// PURE, client-side, FREE provisional mold guess for the intake's live
// hint. This is UX-only — a soft "looks like · Agent" cue while the
// user types. The AUTHORITATIVE classification still happens
// server-side in the engine's `classify` stage when the forge actually
// runs; we never call the engine or a model on keystrokes (cost +
// latency). Pure so it's unit-tested node-side.
//
// Behaviour (rewritten from the keyword-priority first pass):
//   1. SCORE each mold by counting how many of its signal patterns
//      match the input (at least once each, not per occurrence).
//   2. If TWO OR MORE molds score ≥ 2, return null (ABSTAIN) — the
//      input has strong signals in multiple molds (the classic
//      "track 5 competitors → weekly digest" case fires agent AND
//      system); the forge will classify for real.
//   3. Otherwise, if the top mold is clearly ahead (top ≥ 1 AND
//      either second == 0 OR top − second ≥ 2), return it as a
//      provisional guess.
//   4. Otherwise return null (weak / ambiguous).
//
// The signals deliberately reflect what the four molds ACTUALLY mean:
//   agents         — one ongoing automation (scrape/notify/cadence).
//   systems        — multiple things coordinated or aggregated.
//   software       — people use a UI (app / dashboard / approve).
//   infrastructure — platform / data plane / IaC primitives.
//
// Never returns a confident mold when agent AND system both fire
// strongly — that's the whole point of the rewrite.

export type MoldHint = 'agents' | 'systems' | 'software' | 'infrastructure';

/** Signal sets — one regex per signal so each contributes at most +1
 *  to its mold's score. Patterns are run against the lowercased text. */
const SIGNALS: Readonly<Record<MoldHint, ReadonlyArray<RegExp>>> = {
  agents: [
    /\bscan\b/,
    /\bscrape\b/,
    /\bwatch(?:es|ed|ing)?\b/,
    /\bmonitor(?:s|ed|ing)?\b/,
    /\bbrief\b/,
    /\bsummari[sz]e\b/,
    /\bdaily\b/,
    /\bweekly\b/,
    /\bhourly\b/,
    /every\s+(?:morning|day|hour|week)\b/,
    /\bnotify\b/,
    /email\s+me\b/,
    /\balert\b/,
    /\bfetch\b/,
    /\btrack(?:s|ed|ing)?\b/,
  ],
  systems: [
    /\bcompetitors?\b/,
    /\bseveral\b/,
    /\bmultiple\b/,
    // "across X ... and Y" — coordination across multiple targets.
    /\bacross\s+\S[^.\n]*\band\b/,
    /\bteam\s+of\b/,
    /\bcoordinate\b/,
    /\borchestrat/,
    /\bpipeline\b/,
    /\bdigest\b/,
    /\bround[-\s]?up\b/,
    // "5 competitors" / "12 sources" / "8 sites" / "20 feeds" / "3 accounts"
    /\b\d+\s+(?:competitors|sources|sites|feeds|accounts)\b/,
  ],
  software: [
    /\bapp\b/,
    /\bapplication\b/,
    /\busers?\b/,
    /\bsign\s?up\b/,
    /\blogin\b/,
    /\bdashboard\b/,
    /\binterface\b/,
    /\bcrud\b/,
    /\bsubmit\b/,
    /\bapprove\b/,
    /\breview\b/,
    /\bportal\b/,
    /\bweb\s+app\b/,
    /\bproduct\b/,
  ],
  infrastructure: [
    /\bpostgres\b/,
    /\bdatabase\b/,
    /\brow[-\s]?level\s+security\b/,
    /\brls\b/,
    /\bvpc\b/,
    /\blambda\b/,
    /\biam\b/,
    /\bapi\s+gateway\b/,
    /\bs3\b/,
    /\bbucket\b/,
    /\bbackup/,
    /\bobserv/,
    /\bprovision/,
    /\bcluster\b/,
    /\binfrastructure\b/,
  ],
};

/** A confidence threshold: a mold is "strong" when it scores at least
 *  this many distinct signals. Two strong molds → abstain. */
const STRONG = 2;

/** The required lead a confident top mold must have over the runner-up
 *  (when the runner-up has any score at all). */
const REQUIRED_GAP = 2;

const MOLDS: ReadonlyArray<MoldHint> = [
  'agents',
  'systems',
  'software',
  'infrastructure',
];

interface MoldScore {
  readonly mold: MoldHint;
  readonly score: number;
}

/** Internal: compute the per-mold scores (exposed for tests). Pure. */
export function scoreMoldSignals(
  text: string,
): Readonly<Record<MoldHint, number>> {
  const t = (text ?? '').toLowerCase();
  const out: Record<MoldHint, number> = {
    agents: 0,
    systems: 0,
    software: 0,
    infrastructure: 0,
  };
  if (!t.trim()) return out;

  for (const m of MOLDS) {
    let n = 0;
    for (const re of SIGNALS[m]) {
      if (re.test(t)) n += 1;
    }
    out[m] = n;
  }

  // Bonus systems signal: 2+ commas typically means a 3+ item list,
  // which reads as a multi-target / aggregation intent. Caps at +1 so
  // long sentences don't dominate.
  const commaCount = (t.match(/,/g) ?? []).length;
  if (commaCount >= 2) out.systems += 1;

  return out;
}

/**
 * Provisional mold guess from free text. Returns the mold key, or null
 * when signals are weak, conflict, or the text is empty. The forge's
 * server-side classify is always the authority — this is UX only.
 */
export function detectMoldHint(text: string): MoldHint | null {
  const scores = scoreMoldSignals(text);

  // Sort molds by score descending. Stable order via MOLDS list above.
  const ranked: MoldScore[] = MOLDS.map((m) => ({ mold: m, score: scores[m] }));
  ranked.sort((a, b) => b.score - a.score);

  // ABSTAIN when two or more molds fire strongly (the borderline
  // "competitor watch → weekly digest" case: agent AND system both
  // hit ≥2). The forge classifier resolves it for real.
  const strongCount = ranked.filter((r) => r.score >= STRONG).length;
  if (strongCount >= 2) return null;

  const top = ranked[0]!;
  const second = ranked[1]!;
  if (top.score < 1) return null;
  if (second.score === 0) return top.mold;
  if (top.score - second.score >= REQUIRED_GAP) return top.mold;
  return null;
}
