// Read-only view of the Phase 4-4 preview + cost ceiling verdict.
//
// Mirrors the SoftwareTestView / InfraBuildView shape:
//   - A prominent ceiling-verdict banner at the top (green / amber /
//     red depending on within / no-cap / over budget)
//   - The aggregated cost summary line (monthly + hourly)
//   - The to-be-created resources grouped by layer (network → data →
//     compute → observability)
//   - The per-module cost breakdown table
//   - The locked footer note ("provision lands next, behind a typed
//     confirm")
//
// SECURITY: this component receives a sanitised PublicInfraPreview
// only. The preview blob contains catalog-derived strings — no
// secrets, no tokens, no credentials.

import { GlassPanel } from '@/components/GlassPanel';
import type { PublicInfraPreview } from '@/lib/engine/infra/preview/persistence';
import type { InfraPreviewResult } from '@/lib/engine/infra/preview/derive';

interface Props {
  preview: PublicInfraPreview;
}

export function InfraPreviewView({ preview }: Props) {
  const verdict = preview.ceiling_verdict;
  const isOver = verdict === 'over_budget';
  const isNoBudget = verdict === 'no_budget_set';
  const isWithin = verdict === 'within_budget';

  return (
    <GlassPanel
      className={
        isOver
          ? 'border-rose-400/50 shadow-amber'
          : isNoBudget
            ? 'border-forge-amber/40 shadow-amber'
            : 'border-emerald-400/40 shadow-amber'
      }
    >
      <div className="flex flex-col gap-5">
        {/* --- Header + ceiling verdict --------------------------------- */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className={
                'inline-block h-2 w-2 rounded-full ' +
                (isOver
                  ? 'bg-rose-400 shadow-amber'
                  : isNoBudget
                    ? 'bg-forge-amber shadow-amber'
                    : 'bg-emerald-400 shadow-amber')
              }
            />
            <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
              infrastructure · preview
            </h2>
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            phase 4 · cost ceiling = gate
          </p>
        </div>

        <CeilingBanner preview={preview} />

        {/* --- Aggregated cost line --------------------------------------- */}
        <div className="rounded-lg border border-white/10 bg-black/30 p-4 font-mono text-[12px]">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            estimated cost · monthly / hourly
          </p>
          <p className="mt-1 text-forge-text">
            {formatUsd(preview.estimated_usd_per_month)}
            <span className="text-forge-dim"> /mo · </span>
            {formatUsdFine(preview.estimated_usd_per_hour)}
            <span className="text-forge-dim"> /hr</span>
          </p>
          <p className="mt-2 text-[10px] text-forge-dim">
            {summaryLine(preview.preview)}
          </p>
        </div>

        {/* --- Resources by layer --------------------------------------- */}
        <div className="flex flex-col gap-3">
          {preview.preview.layers.map((layer) => (
            <LayerBlock key={layer.layer} layer={layer} />
          ))}
        </div>

        {/* --- Per-module breakdown ------------------------------------- */}
        <div className="rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-[11px]">
          <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            cost breakdown · by module
          </p>
          <ul className="flex flex-col gap-1">
            {preview.preview.by_module.map((m) => (
              <li
                key={m.module}
                className="flex flex-wrap items-baseline justify-between gap-2"
              >
                <span className="text-forge-text/90">
                  {m.module_label}
                  <span className="ml-1 text-forge-dim">× {m.count}</span>
                </span>
                <span className="text-forge-text">
                  {formatUsd(m.usd_per_month)}{' '}
                  <span className="text-forge-dim">/mo</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* --- Public-exposure opt-ins ---------------------------------- */}
        {preview.preview.public_exposure_opt_ins.length > 0 ? (
          <div className="rounded-lg border border-forge-amber/40 bg-forge-amber/10 p-3 font-mono text-[11px] text-forge-amber">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em]">
              public exposure opt-ins
            </p>
            <p className="mt-1">
              the spec explicitly opted into public exposure for:{' '}
              {preview.preview.public_exposure_opt_ins.join(', ')}. the P4-5
              typed-confirm gate will surface these again before any apply.
            </p>
          </div>
        ) : (
          <p className="rounded-lg border border-emerald-400/30 bg-emerald-500/5 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-emerald-300">
            no public exposure · every resource stays private
          </p>
        )}

        {/* --- Locked footer -------------------------------------------- */}
        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          {isWithin
            ? 'locked · provision (the real-cloud step) lands next, behind a typed confirm'
            : isNoBudget
              ? 'locked · set a hard-cap budget before provisioning, then revisit this preview'
              : 'locked · provisioning blocked · raise the ceiling or trim the spec, then re-preview'}
        </p>
        <p className="font-mono text-[10px] text-forge-dim/80">
          inert preview · no terraform plan / apply · no cloud api call
        </p>
      </div>
    </GlassPanel>
  );
}

function CeilingBanner({ preview }: { preview: PublicInfraPreview }) {
  const verdict = preview.ceiling_verdict;
  if (verdict === 'over_budget') {
    return (
      <div className="rounded-lg border border-rose-400/50 bg-rose-500/10 p-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-rose-300">
          over budget · provisioning blocked
        </p>
        <p className="mt-2 text-sm text-rose-100">{preview.ceiling_message}</p>
      </div>
    );
  }
  if (verdict === 'no_budget_set') {
    return (
      <div className="rounded-lg border border-forge-amber/40 bg-forge-amber/10 p-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-amber">
          no hard-cap budget set
        </p>
        <p className="mt-2 text-sm text-forge-text/90">
          {preview.ceiling_message}
        </p>
      </div>
    );
  }
  // within_budget
  return (
    <div className="rounded-lg border border-emerald-400/50 bg-emerald-500/10 p-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-emerald-300">
        within budget · provisioning unlocked
      </p>
      <p className="mt-2 text-sm text-emerald-100">
        {preview.ceiling_message}
      </p>
    </div>
  );
}

function LayerBlock({
  layer,
}: {
  layer: InfraPreviewResult['layers'][number];
}) {
  if (layer.steps.length === 0) return null;
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-cyan">
          {layer.label}
        </p>
        <span className="font-mono text-[10px] text-forge-dim">
          {formatUsd(layer.layer_usd_per_month)} /mo
        </span>
      </div>
      <ul className="mt-2 flex flex-col gap-2">
        {layer.steps.map((s) => (
          <li
            key={s.step_id}
            className="rounded-md border border-white/5 bg-black/30 p-2 font-mono text-[11px]"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-forge-text">
                {s.module_label}
                {s.resource_id ? (
                  <span className="text-forge-dim"> · {s.resource_id}</span>
                ) : null}
                {s.sizing_summary ? (
                  <span className="text-forge-dim"> · {s.sizing_summary}</span>
                ) : null}
              </span>
              <span className="text-forge-text">
                {formatUsd(s.estimated_usd_per_month)} /mo
              </span>
            </div>
            <ul className="mt-1 list-inside list-disc text-[10px] text-forge-dim">
              {s.creates.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            {s.public_exposure_opt_in ? (
              <p className="mt-1 font-mono text-[10px] text-forge-amber">
                public exposure opt-in (spec requested)
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function summaryLine(p: InfraPreviewResult): string {
  return (
    p.summary.resource_count +
    ' resources across ' +
    p.summary.module_count +
    ' module' +
    (p.summary.module_count === 1 ? '' : 's') +
    ' · ' +
    p.summary.layer_count +
    ' layer' +
    (p.summary.layer_count === 1 ? '' : 's') +
    ' active'
  );
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '$0';
  if (n >= 100) return '$' + Math.round(n).toLocaleString('en-US');
  return '$' + (Math.round(n * 100) / 100).toFixed(2);
}

function formatUsdFine(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '$0';
  if (n >= 1) return '$' + (Math.round(n * 100) / 100).toFixed(2);
  return '$' + (Math.round(n * 10_000) / 10_000).toFixed(4);
}
