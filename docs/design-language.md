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

All motion is cancelled by the global `prefers-reduced-motion` rule in
`app/globals.css` — every animation below degrades to a calm static state.

- **Embers** (`forge-css-ember` keyframe) — the signature ambient motion.
  A *restrained* field of slow rising sparks in the lattice background
  (a dozen, 9–14s each), reused from the landing's `CssEmbers`. Not a
  fireworks show.
- **Breathe** (`forge-breathe` / `forge-ambient-breathe`) — the molten
  glow swells and settles on a long period. Atmosphere, not attention.
- **The forge moment** — irreversible actions get a brief (~1–1.5s) heat
  surge / spark / crystallization, then settle. (Wired per-action in a
  later track; `ForgeButton` already presses hotter on `:active`.)
- **Stage cooling** — see the pipeline below: the active stage is molten;
  it cools to cyan as newer stages light.
- **Reveal-on-scroll** (`Reveal`) — sections fade + lift in; content is
  always visible without motion under reduced-motion.

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
