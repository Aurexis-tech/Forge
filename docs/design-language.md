# The Forge Design Language

> The one thing someone remembers about Aurexis Forge is **the moment of forging** —
> describing an idea and watching it become real. Everything in the
> interface serves that moment: heat where it's earned, calm everywhere
> else.

This is the reference for how the app looks, moves, and feels. It is
deliberately short. When in doubt, choose restraint and reserve heat for
meaning.

---

## 1. Philosophy

**Heat with conviction, restraint everywhere else.**

- The forge is hot iron and glowing embers. Amber is not a decorative
  accent — it is **heat**, and heat means something: an irreversible
  action (forging, an authorization gate, going live), or the trace of
  one (the just-acted stage, still molten before it cools).
- Outside those moments the interface is **calm**: obsidian, hairline
  borders, generous space made deliberate by rhythm, serif display +
  serif body + mono labels. Premium = quiet confidence, punctuated by
  heat at the right moments.
- **Never amber-everywhere.** If everything glows, nothing does. A page at
  rest should be cool; heat appears when the user is about to act, acts,
  or is looking at the result of acting.
- **Forging is a moment.** Irreversible actions earn a brief, bounded
  visual answer (a heat surge / embers / the thing crystallizing),
  ~1–1.5s, then it settles. Memorable, not gratuitous.

---

## 2. The heat spectrum + cool palette

Heat is a **temperature scale**, coolest ember → brightest molten spark.
Defined as CSS variables in `app/globals.css`, surfaced in Tailwind as
`heat.*` / `cool.*`.

| Token | Value | Meaning |
|---|---|---|
| `--heat-coal` | `#7a3b12` | cooled / spent — a completed-and-settled warm |
| `--heat-ember` | `#c2611f` | glowing ember — recent warmth, dimming |
| `--heat-glow` | `#ff9a4d` | **the anchor** (= legacy `forge-amber`) — working heat |
| `--heat-molten` | `#ffba73` | molten — the just-acted, hottest live point |
| `--heat-spark` | `#ffe6c7` | white-hot spark — the brief flash of forging |
| `--cool-cyan` | `#4fd4f0` | accent / active state / settled "live" |
| `--cool-deep` | `#2a6f8a` | the coldest settle — fully cooled pipeline tail |

Neutrals: `--ink #e7ecf3` (text), `--dim #8a93a6` (secondary),
`--faint #5b6475` (tertiary / pending), `--line rgba(255,255,255,.08)`
(hairline borders), `--bg #05060a` (obsidian void).

**Usage:** `heat-glow` for the working action; `heat-molten`/`heat-spark`
for the peak of the forge moment + the active pipeline stage;
`cool-cyan` for accents, active/eyebrow state, and where heat has
**cooled** (completed stages, "live"). Reserve `heat-*` for meaning.

---

## 3. Typography

Brand fonts only — loaded via `next/font` in `app/layout.tsx`, surfaced as
`--font-display` / `--font-body` / `--font-mono` and Tailwind
`font-display` / `font-body` / `font-mono`. **No Inter/Roboto/Arial.**

- **Display — Fraunces** (serif). Headings (`h1/h2/h3` inherit it via a
  global rule). The moment-of-arrival face. Use `text-3xl…text-5xl`,
  `font-medium`, `text-balance`.
- **Body — Spectral** (serif). Prose, descriptions, the describe box.
  Calm reading.
- **Mono — IBM Plex Mono**. Eyebrows, labels, the pipeline, stage pills,
  code/URLs. Always `uppercase` + wide `tracking` for labels
  (`tracking-[0.3em]`–`[0.5em]`, `text-[10px]`).

Rhythm: eyebrow (mono, cyan) → display heading → body subcopy. See
`SectionHeader`.

---

## 4. Motion vocabulary

**Motion with intention.** Four rules, no exceptions:

1. **Bounded.** Every motion *settles*. The only continuous motion in the
   app is the ambient ember + breathe in `ForgeBackdrop`. Nothing else
   loops — except the loading heat-bar, which lives only as long as the
   bounded operation it reports.
2. **Purposeful.** Each motion means something: hover = "this is
   interactive"; a stage warming = "this is what changed"; the forge
   moment = "this is the irreversible act." No meaning → no motion.
3. **Never blocking.** Motion happens *next to* or *after* the
   interaction, never before it. Submit fires the forge moment; the
   request and navigation do not wait for it.
4. **Reduced-motion honored — and verified.** The global
   `prefers-reduced-motion` rule in `app/globals.css` collapses every
   animation/transition to ~instant; `motionMs()` collapses every
   JS-timed duration to `0`. The **same end state** always happens — just
   not animated.

### Motion tokens — one place

Durations + easings live in **`lib/forge-motion.ts`** (the canonical
source) and are mirrored as `--motion-*` / `--ease-*` CSS custom
properties in `app/globals.css` for the keyframe-driven motions. Reference
them by name; never hard-code a duration in a component.

| Token | Value | Meaning |
|---|---|---|
| `forgeMoment` | `1500ms` | the heat surge on FORGE IT |
| `stageCool` | `600ms` | a pipeline stage warming/cooling as the cursor moves |
| `hoverWarm` | `180ms` | hover/focus heat warming in/out |
| `revealBase` | `500ms` | a revealed element's fade+lift |
| `revealStep` | `120ms` | the stagger step between revealed elements |
| `heatBar` | `1400ms` | one cycle of the loading heat-bar |

Easings: `cool` (decelerate-to-settle), `warm` (confident ease-in-out),
`forge` (= cool, the strike). `motionMs(token, reduced?)` returns `0`
under reduced motion, else the token — the single shortcut every timed
motion consults.

### The vocabulary

- **Embers** (`forge-css-ember`) + **Breathe** (`forge-ambient-breathe`)
  — the *only* sanctioned continuous motion. Restrained ambient field in
  the `ForgeBackdrop`. Atmosphere, not attention.
- **The forge moment** (`forge-moment-overlay` / `forge-moment-card`) —
  FORGE IT strikes a bounded ~1.5s white-hot surge over the acted-on
  `EmberCard`, then radiates and settles. Fires **in parallel** with the
  submit/navigation — never gates it. Instant under reduced-motion.
- **Stage warm / cool** (`forge-stage-warm` + `.forge-stage-dot`) — the
  just-reached pipeline stage warms dim → molten *once* on arrival
  (single play, no infinite pulse); the dots ease their colour swap at the
  `stageCool` tempo so an advancing cursor reads as molten cooling to
  cyan. Instant swap under reduced-motion.
- **Hover lift** (`.forge-lift`) — interactive surfaces (`EmberCard`,
  cards) rise ~2px + warm their border/glow on hover at the `hoverWarm`
  tempo; `ForgeButton` intensifies on hover then strikes hotter on
  `:active`. Text inputs warm with a focus-only inner heat-glow (one rule
  in `globals.css` covers every input). Static under reduced-motion.
- **Orchestrated reveal** (`Reveal` + `revealStep`) — a page reveals in a
  small stagger: header (0) → primary card(s) (`revealStep`) → secondary
  (`revealStep × 2`); under ~400ms total. Content is fully visible
  immediately under reduced-motion.
- **Loading heat-bar** (`.forge-heat-bar`) — where the app waits, a thin
  bar sweeps cool → ember → glow. The lone repeating motion outside the
  ambient field, and only for the duration of the wait. Frozen to a
  static heat gradient under reduced-motion.

---

## 5. Component vocabulary

The shared primitives live in `components/forge/*`. Compose from these;
do not re-implement their look per page.

- **`ForgeBackdrop`** — the shared atmosphere (lattice + breathing glow +
  rising embers + vignette), mounted **once** in `app/(app)/layout.tsx`.
  Every app page inherits it.
- **`SectionHeader`** — eyebrow (mono, cyan) + display heading + optional
  body subcopy + optional action. `level={1}` for page titles, `2` for
  sections.
- **`HeatBadge`** — the pill primitive (hairline, mono, uppercase). `tone`
  is a heat/cool tint (`HEAT_TONES`) or a brand tone string. Mold badges
  + stage pills + status chips all compose it.
- **`ForgeButton`** — the heat-glow action button. **The** button for
  irreversible forge moments (FORGE IT, authorize, go live); glows on
  hover, presses hotter on `:active`. Do **not** use it for incidental
  actions.
- **`EmberCard`** — the surface. Hairline border + obsidian glass, with an
  optional faint inner ember: `tone="warm"` (recent/live), `tone="cool"`
  (settled), `tone="none"` (the quiet default — most cards).
- **`StagePipeline`** — `INTENT → … → LIVE` read as **cooling**: active =
  molten (just-acted, glowing), completed = cooled cyan, pending = dim;
  the final `LIVE` settles cool.

Example — a page header + the action:

```tsx
<SectionHeader level={1} eyebrow="welcome · stage 01"
  title="Describe what you want to build" subcopy={…} />
<ForgeButton type="submit" busy={submitting}>Forge it</ForgeButton>
<StagePipeline activeIndex={0} /> {/* INTENT molten, rest dim */}
```

---

## 6. What NOT to do

- ❌ **Amber everywhere.** Heat is for meaning. A resting page is cool.
- ❌ Purple gradients, neon, or more than the obsidian + heat + cyan
  palette. No fourth loud colour.
- ❌ Generic dark-theme components (cookie-cutter cards, default shadows,
  Inter/Roboto/Arial). Use the primitives + brand fonts.
- ❌ AI-slop motion — bouncing, spinning, constant pulsing, parallax on
  everything. Motion is rare, slow, and meaningful; the forge moment is
  bounded (~1.5s) and the ambient embers are sparse.
- ❌ Heat on incidental controls. The "+ new forge" link is a quiet
  bordered chip; only the true forge action wears `ForgeButton`.
- ❌ Motion that's required to see content. Everything must read fully
  under `prefers-reduced-motion`.
