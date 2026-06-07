// FinalCta — landing section 8. Closes the page on the three-beat promise and
// the single primary action, echoing the hero's CTA + price line.

import { LiquidGlass } from '@/components/lq/LiquidGlass';

export function FinalCta() {
  return (
    <section className="mx-auto w-full max-w-7xl px-6 py-24 sm:px-10">
      <LiquidGlass
        as="div"
        className="flex flex-col items-center gap-8 px-6 py-16 text-center font-ui sm:py-20"
      >
        <h2 className="max-w-3xl font-ui text-4xl font-extrabold leading-[1.05] tracking-[-0.02em] text-lq-ink sm:text-6xl">
          Describe it. Approve it.{' '}
          <span className="text-lq-aurora">Watch it go live.</span>
        </h2>

        <div className="flex flex-col items-center gap-4">
          <LiquidGlass
            as="a"
            href="/forge"
            variant="aurora"
            className="inline-flex items-center rounded-[14px] px-7 py-4 text-[16px] font-semibold"
          >
            Start a forge →
          </LiquidGlass>
          <span className="font-code text-[12px] uppercase tracking-[0.2em] text-lq-ink-faint">
            $5 first run · BYOK · cancel anytime
          </span>
        </div>
      </LiquidGlass>
    </section>
  );
}
