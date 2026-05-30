# Aurexis Forge — Design Language

The product is currently mid-migration. Two design systems coexist on
purpose; both are documented so anyone working on the UI can tell which
one a surface belongs to and which one to reach for in new work.

- **AI-futuristic** is the primary, forward-going language. New work
  uses it. The 9 migrated routes + the shared authorization gate wear it
  today.
- **Forge** stays alive only for the surfaces it hasn't been removed
  from yet — the un-migrated `/projects/[id]` *interior* panels, the
  `/settings/connections` page, and the un-migrated route fallback in
  the backdrop/nav switches. See the **Transitional state** section
  below for the exact list.

When the interior of the workshop is migrated, the forge primitives,
backdrop, nav, and the switch can be retired. The **Deferred full
cleanup** checklist at the end captures that work.

---

## Honesty principles

Backbone of every migrated surface. Encoded as test assertions; reviewers
should reject any PR that violates them.

1. **Bind to real data.** Every value on screen comes from the engine or
   the user's record (spec, plan, build, journey, ledger, audit_log,
   budgets, runtime). No fabricated counts, no synthetic activity, no
   placeholder dollar amounts.
2. **Omit what isn't plumbed.** If a field isn't tracked, render `—` or
   leave the row out. Don't invent a value to fill the layout.
3. **UI claims match the real mechanism.** The Keys page banner says
   `BYOK · encrypted at rest` — AES-256-GCM at rest in the
   `connections` table, scoped per user × provider, validated by a tiny
   live call before save, never echoed back beyond `last4`. **NOT**
   "zero-knowledge" / "browser-session" / "never server-side" / "end-to-
   end" — the server holds `APP_ENC_KEY` and can decrypt. A test
   (`tests/unit/keys-ai.test.ts`) rejects every false phrase explicitly.
4. **Don't loop a fake.** The Governance spend meter and the Workshop
   journey pipeline reflect real state; the design study's
   looping-fake-spend demo is forbidden. Fills are one-shot CSS
   transitions, not infinite animations of synthetic values.
5. **Preserve every real action.** Migration restyles only; gate
   wiring, POST endpoints, `router.refresh()` callbacks, native
   `confirm()` prompts, and `requireText` validation are preserved
   byte-for-byte.

---

## Palette (CSS custom properties)

All defined in `app/globals.css` under `:root`. The Tailwind namespace
`lq.*` is the surface name (`bg-lq-void`, `text-lq-aurora`,
`border-lq-line`, etc.) — defined in `tailwind.config.ts`.

### Surface

| Token | Value | Use |
|---|---|---|
| `--void` | `#08090d` | Backdrop. The deepest surface; everything floats above it. |
| `--elev-1` | `#0e1018` | First lift — list rows, inline event chips, the meter track. |
| `--elev-2` | `#14171f` | Second lift — used inside LiquidGlass for nested wells. |
| `--line` | `rgba(255, 255, 255, 0.08)` | Hairline borders between surfaces. |
| `--grid` | `rgba(255, 255, 255, 0.012)` | The faint 12-column lattice in `AurexisAmbient`. |

### Ink (text)

| Token | Value | Use |
|---|---|---|
| `--ink-base` | `#f0f2f8` | Primary text. Inherited via `body { color: var(--ink-base) }`. |
| `--ink-dim` | `#9aa0b0` | Secondary copy, descriptions, sub-meta. |
| `--ink-faint` | `#5a5f6e` | Tertiary — eyebrows, timestamps, "—" placeholders. |
| `--ink-ghost` | `#353841` | Quaternary — disabled-but-visible chrome. |

> Note: the forge `--ink: #e7ecf3` token still exists alongside `--ink-base`
> for the un-migrated forge surfaces. Reconciliation
> (`--ink-base → --ink`) is in the deferred cleanup.

### Accents

| Token | Value | Meaning |
|---|---|---|
| `--aurora` | `#5fe6ff` | Primary action / live, settled / verified / done. |
| `--violet` | `#a78bfa` | Secondary accent; sparingly used as a backdrop highlight. |
| `--amber` | `#fbbf24` | Active stage / WARMING / gate-awaiting (caution, not alarm). |
| `--mint` | `#6ee7b7` | Live runtime / UNDER CAP / healthy. |
| `--rose` | `#fb7185` | Failed / AT CAP / the kill switch / authorize-irreversible. |

---

## Typography

Loaded via `next/font/google` in `app/layout.tsx`. Each family exposes
a CSS variable.

| Family | Variable | Tailwind utility | Use |
|---|---|---|---|
| Inter | `--font-ui` | `font-ui` | All AI-system text. Set on every migrated heading + body. |
| JetBrains Mono | `--font-code` | `font-code` | Eyebrows, labels, tabular numbers, code-ish chrome. |

The migrated surfaces apply `font-ui` directly on each `<h1>/<h2>/<h3>`.
The legacy `globals.css` rule that points all `h1/h2/h3` at the forge
Fraunces face is still in force during the transition — `font-ui` wins
when explicitly applied; un-migrated forge headings inherit the global.

---

## Material — LiquidGlass

`components/lq/LiquidGlass.tsx` + `LiquidGlass.module.css` (scoped). The
single surface primitive. Polymorphic via `as="..."` (`div` / `button` /
`a`). Composable.

```tsx
<LiquidGlass as="div" variant="aurora" className="p-6">…</LiquidGlass>
<LiquidGlass as="button" variant="rose" disabled={busy}>Authorize</LiquidGlass>
```

### What the material is made of (CSS module)

- **Background**: `rgba(255, 255, 255, 0.05)` over the void.
- **`backdrop-filter: blur(24px) saturate(180%)`** — the actual frosted
  effect. Saturate punches the accent colors through the blur.
- **Border**: `1px solid rgba(255, 255, 255, 0.16)` — a hairline that
  catches light at the edge.
- **Inset shadows**: `inset 0 1px 0 rgba(255,255,255,0.18)` on the top
  edge + `inset 0 -1px 0 rgba(0,0,0,0.22)` on the bottom — what gives
  the surface its depth.
- **`::before`** — wet top-edge highlight; a `linear-gradient` strip
  that fades in/out across the top 10–90% of the surface.
- **`::after`** — cursor-tracking specular; a `radial-gradient`
  centered on `--mx / --my`, which `useSpecular` writes on the element
  during `pointermove` (and resets to `50%/50%` on `pointerleave`).
  Custom props inherit into pseudo-elements, so the gradient just reads
  the variables directly.

### Variants

- `default` — neutral; for cards, list containers, header chrome.
- `aurora` — primary action surface; aurora border/glow. Save, Activate,
  Approve (when neutral).
- `rose` — irreversible / weighty; rose border/glow. Authorize on the
  gate, Pull lever on the kill switch, Remove on the keys card.
- `disabled` — flattened material, no specular tracking; takes the
  element out of the tab order unless it's a `<button>` (in which case
  the native `disabled` attribute applies).

### Helpers

- `useSpecular<T extends HTMLElement>(enabled = true): RefObject<T>` —
  attaches the `pointermove` / `pointerleave` listeners. SSR-safe; the
  effect only runs in the browser.
- `specularOffset(rect, clientX, clientY)` — the pure math, exported
  separately so it's unit-testable without a DOM.
- `SPECULAR_RESET` — `{ mx: '50%', my: '50%' }`, the neutral position.

### Reduced motion

The hover *lift* transform is dropped under `prefers-reduced-motion:
reduce` (rule lives in `LiquidGlass.module.css`). The specular highlight
stays because it's pointer-driven (not an autoplay loop); reduced motion
only asks us to drop autoplay.

---

## Backdrop — AurexisAmbient

`components/lq/AurexisAmbient.tsx` + `AurexisAmbient.module.css`
(scoped). Fixed `inset: 0; z-index: -10; pointer-events: none`. Layers,
from back to front:

1. **`--void` field** — the base.
2. **12-column lattice** — `repeating-linear-gradient` (×2 — vertical +
   horizontal), masked through a `radial-gradient` ellipse so it
   strengthens toward the top center and fades out toward the edges.
3. **Aurora breathe** — slow infinite radial pulse in `--aurora`.
4. **Violet breathe** — slow infinite radial pulse in `--violet`, out
   of phase with the aurora.
5. **Vignette** — dark `radial-gradient` corners, guarantees AA contrast
   over text.

The two breathing pulses are this module's only infinite animations,
declared inside `AurexisAmbient.module.css` (NOT in `globals.css`).

---

## Chrome — AiNav + routing switch

### AiNav

`components/lq/AiNav.tsx` + `AiNav.module.css`. The migrated-route nav.
A LiquidGlass strip across the top with the brand mark, the section
links, the user pill, and a sign-out form.

### Routing switch (the transition machinery)

Two client components decide whether a route gets the AI-futuristic
chrome or falls back to forge. Both consult `lib/migrated-routes.ts`.

- `components/lq/AppBackdrop.tsx` — mounted once in
  `app/(app)/layout.tsx`. Renders `AurexisAmbient` for migrated routes,
  `ForgeBackdrop + ForgeScene` (the 3D layer) for un-migrated routes.
- `components/lq/AppShellHeader.tsx` — renders `AiNav` for migrated
  routes, the forge `AppNav` for un-migrated routes.

### `lib/migrated-routes.ts`

```ts
export const MIGRATED_ROUTES: readonly string[] = [
  '/forge',
  '/projects',
  '/agents',
  '/systems',
  '/software',
  '/infrastructure',
  '/settings/keys',
  '/governance',
];

export const MIGRATED_PATTERNS: readonly RegExp[] = [
  /^\/projects\/[^/]+$/,  // /projects/[id] — the workshop page
];

export function isMigratedRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  if (MIGRATED_ROUTES.includes(pathname)) return true;
  for (const pattern of MIGRATED_PATTERNS) {
    if (pattern.test(pathname)) return true;
  }
  return false;
}
```

Exact-match list first, anchored regex patterns second. Each route opts
in deliberately; un-migrated dynamic children (e.g. a hypothetical
`/projects/[id]/runs`) stay on forge until they opt in too.

---

## Motion discipline

- **Bounded transitions are the default.** Almost every motion on a
  migrated surface is a CSS transition (`transition: ... var(--ease)`),
  played by a class change or a one-shot `animation: ... both` rule.
- **Infinite animations live in CSS modules**, never in `globals.css`.
- **Per-module loop count is documented and minimal:**

| Module | Loops | What loops |
|---|---|---|
| `AurexisAmbient.module.css` | 2 | aurora breathe, violet breathe |
| `keys.module.css` (keys-ai) | 1 | `keysVerifiedRim` — aurora breathing rim on verified provider cards |
| `governance.module.css` | 0 | the spend meter is a CSS transition; no loops |
| `workshop.module.css` | 1 | `workshopActiveRim` — amber breathing rim on the single active journey stage |
| `gate.module.css` | 0 | a gate shouldn't throb; weight comes from the static rose variant + a one-shot mount fade |

- **`globals.css` ≤ 4 infinite animations** — enforced by
  `forge-motion.test.ts`. The four loops in there today are the forge
  backdrop's ambient set (`forge-breathe`, `forge-ambient-breathe`,
  `forge-css-ember` via `animation-iteration-count: infinite`,
  `forge-heat-bar`). The enforcer stays in force during the transition;
  the AI module loops above count against the global ≤4 budget **only
  when those modules' surfaces are mounted**.
- **Reduced motion**: the global `@media (prefers-reduced-motion: reduce)`
  rule in `globals.css` collapses every `animation-duration` and
  `transition-duration` to `0.001ms !important`. AI modules inherit this
  for free.

---

## Heat-as-meaning — retained ONLY on Governance

The forge "heat spectrum" (cool → ember → glow → molten) is preserved as
the SOURCE OF TRUTH for spend-zone classification — `spendHeatTone()` in
`lib/forge-heat.ts`. The Governance migration layers an AI-palette
remap on top:

```ts
// lib/governance-zones.ts
export function spendZone(spentUsd: number, capUsd: number | null | undefined): SpendZoneVm {
  if (capUsd == null || capUsd <= 0) return { zone: 'no-cap', label: 'NO CAP SET', color: 'mint', ... };
  const tone = spendHeatTone(spentUsd, capUsd);
  switch (tone) {
    case 'cool':   return { zone: 'safe',    label: 'UNDER CAP', color: 'mint',   ... };
    case 'ember':  return { zone: 'steady',  label: 'STEADY',    color: 'aurora', ... };
    case 'glow':   return { zone: 'warming', label: 'WARMING',   color: 'amber',  ... };
    case 'molten': return { zone: 'over',    label: 'AT CAP',    color: 'rose',   ... };
  }
}
```

The thresholds (`< 50%` cool, `50–79%` ember, `80–99%` glow, `≥ 100%`
molten) are not forked; the test iterates every 5% from 0–150 asserting
the mapping. The meter binds to **real spend** (`getSpendUsd(userId,
period)`) vs the **real per-user cap** (the user's `budgets` row, set
via `PUT /api/governance/budget`). Bar fills 0 → real pct on mount as a
bounded CSS transition; never loops fake spend.

Outside Governance, the AI surfaces do not use heat-as-meaning. Status
on the Keys / Workshop / Gate surfaces is direct: aurora = healthy,
amber = active/warming, rose = failed/irreversible, mint = live, dim =
inactive.

---

## Migrated surfaces

The full set of surfaces that wear the AI-futuristic language today.

### Routes (9 + 1 pattern)

| Route | Source | Real data it binds to |
|---|---|---|
| `/` (public landing) | `app/page.tsx` + `components/landing-ai/` | static marketing |
| `/forge` (intake) | `app/(app)/forge/page.tsx` + `components/intake-ai/IntakeFormAi` | `POST /api/projects` |
| `/projects` (home) | `app/(app)/projects/page.tsx` + `components/projects-ai/ProjectsAi` | `loadProjectCards(userId)` — real projects + journey + mold |
| `/agents` | `components/projects-ai/MoldSpaceAi` (agent) | same loader, filtered |
| `/systems` | `components/projects-ai/MoldSpaceAi` (system) | same |
| `/software` | `components/projects-ai/MoldSpaceAi` (software) | same |
| `/infrastructure` | `components/projects-ai/MoldSpaceAi` (infrastructure) | same |
| `/settings/keys` | `app/(app)/settings/keys/page.tsx` + `components/keys-ai/KeysAi` | `GET / POST / DELETE /api/connections/keys` |
| `/governance` | `app/(app)/governance/page.tsx` + `components/governance-ai/GovernanceAi` | `getSpendUsd`, `listBudgets`, `activeKillSwitch`, `getRecentCostEvents`, `audit_log`, `agent_runtimes` |
| `/projects/[id]` (workshop shell, via pattern) | `app/(app)/projects/[id]/page.tsx` + `components/workshop-ai/WorkshopShell` | `deriveJourney`, `getProjectSpend`, the project record, the mold |

### Shared component

| Component | Source | Where it shows up |
|---|---|---|
| `AuthorizationGate` | `components/gate/AuthorizationGate.tsx` (restyled to LiquidGlass `rose`) | every gate moment across 12 caller flows — GitHub push (agent/system/software), Vercel deploy (×3), runtime activate (×3), software DB provision, infra apply, infra confirm-plan |

---

## Transitional state — what still wears forge (intentionally)

This is the honest picture of the repo today. None of it is on the
chopping block for THIS migration phase.

### Un-migrated routes

- `/settings/connections` — forge (`GlassPanel`, forge primitives).
- `/sign-in` + `/auth/callback` — minimal auth pages; not really
  design-language territory.

### Forge surfaces still in use

- **The interior `*Area` panels rendered inside the `/projects/[id]`
  workshop shell** — `SpecArea`, `PlanArea`, `SystemPlanArea`,
  `SoftwarePlanArea`, `InfraPlanArea`, `BuildArea`, `SystemBuildArea`,
  `SoftwareBuildArea`, `InfraBuildArea`, `TestArea`, `PushArea`,
  `DeployArea`, `RuntimeArea`, `AgentDashboard`, the forge
  `ForgeTimelinePanel`, etc. The workshop CHROME is AI; the panels
  inside are forge.

### Forge primitives + chrome still imported by live code

| File | Why it stays |
|---|---|
| `components/forge/EmberCard.tsx` | used by the interior `*Area` panels |
| `components/forge/SectionHeader.tsx` | same |
| `components/forge/HeatBadge.tsx` | same + `components/governance/SpendMeter.tsx` (the forge form, still wired for the un-migrated heat-as-meaning path) |
| `components/forge/StagePipeline.tsx` | same |
| `components/forge/ForgeButton.tsx` | same |
| `components/ForgeBackdrop.tsx` | served by `AppBackdrop` for every un-migrated route |
| `components/ForgeScene.tsx` + `components/ForgeWorld.tsx` | the 3D layer mounted with ForgeBackdrop |
| `components/FallbackShell.tsx` + `components/landing/{Aurora,LivingBackdrop,Embers,CssEmbers,HeroCanvas,LandingHero,LiveAgentCard,MagneticButton,Sections,Typewriter,useReducedMotion}.tsx` | FallbackShell is the WebGL-off backdrop ForgeScene mounts when WebGL is unavailable / reduced-motion is on; it imports `Aurora` + `LivingBackdrop`, which transitively use the rest of `components/landing/` |
| `components/AppNav.tsx` (forge variant) | served by `AppShellHeader` for un-migrated routes |
| `components/GlassPanel.tsx` | used by many interior panels + `/settings/connections` |
| `components/lq/AppBackdrop.tsx` + `AppShellHeader.tsx` | the switches themselves — retired only when EVERY route is migrated |
| `lib/migrated-routes.ts` | the switch's source of truth |
| `lib/forge-heat.ts` | `spendHeatTone` is reused by `governance-zones.ts`; `keyStatusTone` + `projectCardTone` are used by the live forge `SpendMeter` / `KeysForm` |
| `--font-display` / `--font-body` / `--font-mono` + the `h1/h2/h3 → font-display` global rule | the un-migrated forge headings inherit it |
| `--ink` (forge) AND `--ink-base` (AI) | both tokens stay during the transition |
| The `≤4 infinite loops` enforcer | stays at exactly 4 (the forge backdrop's set); reshuffle is in the deferred checklist |

---

## Deferred FULL-CLEANUP checklist

Run this once the workshop interior `*Area` panels are migrated. **Do
not run any of these steps before that point** — they will break live
surfaces.

1. **Migrate the workshop interior** — restyle every `*Area` panel
   (`SpecArea`, `PlanArea` × 4 molds, `BuildArea`, `TestArea`,
   `PushArea`, `DeployArea`, `RuntimeArea`, `AgentDashboard`, the
   timeline panel, the live tail) to LiquidGlass.
2. **Migrate `/settings/connections`** to LiquidGlass.
3. **Delete the forge primitives**: `components/forge/EmberCard.tsx`,
   `SectionHeader.tsx`, `HeatBadge.tsx`, `StagePipeline.tsx`,
   `ForgeButton.tsx`.
4. **Delete the forge backdrop + nav**: `components/ForgeBackdrop.tsx`,
   `components/ForgeScene.tsx`, `components/ForgeWorld.tsx`,
   `components/FallbackShell.tsx`, `components/landing/` (the entire
   dir, since only FallbackShell uses it), `components/AppNav.tsx`.
5. **Retire the switch**: delete `components/lq/AppBackdrop.tsx` (mount
   `AurexisAmbient` directly in `app/(app)/layout.tsx`),
   `components/lq/AppShellHeader.tsx` (mount `AiNav` directly), and
   `lib/migrated-routes.ts`.
6. **Drop the `h1/h2/h3 → font-display` global rule** in
   `app/globals.css`; rely on per-component `font-ui` everywhere.
7. **Reconcile ink tokens**: rename `--ink-base` → `--ink` in
   `app/globals.css` and `tailwind.config.ts` (`lq.ink`'s var
   reference). Delete the old forge `--ink`.
8. **Reshuffle the ≤4 infinite enforcer**: the forge backdrop's 4 loops
   go away; the enforcer should now sum the loops across mounted AI
   modules (`AurexisAmbient` = 2, `keys` = 1, `workshop` = 1) and
   document the new ceiling.
9. **Delete every test that reads the deleted forge sources** (the
   stragglers in `forge-design-language.test.ts`, `forge-motion.test.ts`,
   `forge-propagation.test.ts`, `app-shell-design.test.ts`) and confirm
   the AI suites still cover the live behaviour they were checking.

---

## What lives where

```
app/
  globals.css                  ← tokens, the h1/h2/h3 font rule, ≤4-infinite enforcer
  layout.tsx                   ← fonts via next/font (--font-ui, --font-code, --font-display)
  page.tsx                     ← public landing (AI)
  (app)/
    layout.tsx                 ← mounts <AppBackdrop /> + <AppShellHeader />
    forge/page.tsx             ← IntakeFormAi (AI)
    projects/page.tsx          ← ProjectsAi (AI)
    projects/[id]/page.tsx     ← WorkshopShell (AI) wrapping forge *Area panels
    agents|systems|software|infrastructure/page.tsx  ← MoldSpaceAi (AI)
    settings/keys/page.tsx     ← KeysAi (AI)
    settings/connections/page.tsx  ← forge (un-migrated)
    governance/page.tsx        ← GovernanceAi (AI)
components/
  lq/                          ← AI primitives + switches + AurexisAmbient + AiNav
  landing-ai/                  ← public landing parts
  intake-ai/                   ← IntakeFormAi
  projects-ai/                 ← ProjectsAi, MoldSpaceAi, MoldGrid, ProjectCardAi
  keys-ai/                     ← KeysAi
  governance-ai/               ← GovernanceAi, KillSwitchAi, BudgetFormAi
  workshop-ai/                 ← WorkshopShell, JourneyPipelineAi
  gate/                        ← AuthorizationGate (restyled, shared)
  forge/                       ← LIVE forge primitives — used by interior *Area panels
  ForgeBackdrop / ForgeScene / ForgeWorld / FallbackShell / landing/
                               ← LIVE forge backdrop chain (un-migrated routes)
  AppNav.tsx                   ← LIVE forge nav (un-migrated routes)
  GlassPanel.tsx               ← LIVE — used by interior *Area panels
lib/
  migrated-routes.ts           ← exact list + regex patterns + isMigratedRoute()
  forge-heat.ts                ← spendHeatTone (Governance reuses), keyStatusTone, projectCardTone
  workshop-vm.ts               ← pure VM for /projects/[id] workshop
  governance-zones.ts          ← spendZone (reuses spendHeatTone), kill-switch copy
  keys-config.ts               ← KEYS_SECURITY copy (the honesty source), provider set, masking
docs/
  design-language.md           ← this file
```
