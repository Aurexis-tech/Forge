// MoldShowcase — the public landing's front-door gallery. The inner grid
// + per-card markup lives in MoldGallery (so the same grid is reused
// inside the signed-in /projects empty/first-run state without duplicating
// the card markup). This component is the LANDING-specific wrapper:
//   - the `<section id="molds">` so the landing CTA "See examples" can
//     anchor-scroll into it
//   - the landing column rhythm (max-w-7xl, py-20)
// Behavior is preserved exactly — the cards and their hover treatment
// come from the shared MoldGallery.

import { MoldGallery } from './MoldGallery';

export function MoldShowcase() {
  return (
    <section id="molds" className="mx-auto w-full max-w-7xl px-6 py-20 sm:px-10">
      <MoldGallery />
    </section>
  );
}
