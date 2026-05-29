// PURE, client-side, FREE provisional mold guess for the intake's live
// hint. This is UX-only — a soft "looks like · Agent" cue while the user
// types. The AUTHORITATIVE classification happens server-side in the
// engine's classify stage when the forge actually runs; we never call the
// engine on keystrokes (cost + latency). Pure so it's unit-tested node-side.

export type MoldHint = 'agents' | 'systems' | 'software' | 'infrastructure';

const RE = {
  systems: /coordinate|multiple agents|team of (bots|agents)|orchestrat|swarm/,
  infrastructure:
    /postgres|database|row[- ]?level security|\brls\b|vpc|lambda|iam|api gateway|s3 bucket|backup|observ|infrastructure/,
  software:
    /\bapp\b|application|users?|sign ?up|login|interface|dashboard|crud|submit|approve|notification|web app|product/,
  agents:
    /scan|scrape|watch|monitor|brief|summari[sz]e|every (morning|day|hour|week)|daily|weekly|notify|email me|fetch|track/,
} as const;

// Broad nouns whose co-occurrence (3+) suggests a multi-part SYSTEM.
const BROAD = ['agent', 'system', 'app', 'infrastructure', 'database'];

/**
 * Provisional mold guess from free text. Returns the mold key, or null
 * ("detecting") when nothing matches or the text is empty.
 *
 *   - 3+ of {agent, system, app, infrastructure, database} → 'systems'
 *   - else the first match, in priority order:
 *       systems → infrastructure → software → agents
 *   - else null
 */
export function detectMoldHint(text: string): MoldHint | null {
  const t = (text ?? '').toLowerCase();
  if (!t.trim()) return null;

  const broadHits = BROAD.filter((w) => t.includes(w)).length;
  if (broadHits >= 3) return 'systems';

  if (RE.systems.test(t)) return 'systems';
  if (RE.infrastructure.test(t)) return 'infrastructure';
  if (RE.software.test(t)) return 'software';
  if (RE.agents.test(t)) return 'agents';
  return null;
}
