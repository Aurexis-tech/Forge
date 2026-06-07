'use client';

// HowItWorks — landing section 2. The canonical 8-station loop rendered as an
// elevated pipeline: a connecting spine, grouped headers ("builds silently" →
// "your approval" → "live"), and gate lock-nodes on stations 6 & 7 (the only
// points that wait on the visitor's yes). Steps reveal on scroll. Styling lives
// in HowItWorks.module.css, mapped to the site's lq.* tokens.

import { Fragment, useEffect, useRef, useState } from 'react';
import { SectionHeading } from './SectionHeading';
import styles from './HowItWorks.module.css';

interface Station {
  n: string;
  title: string;
  tag: string;
  desc: string;
  kind?: 'gate' | 'live';
}

interface Group {
  label: string;
  tone?: 'gate' | 'live';
  steps: ReadonlyArray<Station>;
}

const GROUPS: ReadonlyArray<Group> = [
  {
    label: 'Builds silently · no input from you',
    steps: [
      {
        n: '1',
        title: 'Intent',
        tag: 'auto',
        desc: 'You describe the outcome in plain words. Forge asks a few sharp questions until the idea is fully understood.',
      },
      {
        n: '2',
        title: 'Spec',
        tag: 'auto',
        desc: 'Your words become a structured spec — shown to you before anything is built.',
      },
      {
        n: '3',
        title: 'Plan',
        tag: 'auto',
        desc: 'Forge works out how to build it and what kind of thing it is, then routes to the right mold.',
      },
      {
        n: '4',
        title: 'Code',
        tag: 'auto',
        desc: 'The builder generates it on top of vetted scaffolds, then lints and tests it.',
      },
      {
        n: '5',
        title: 'Sandbox',
        tag: 'auto',
        desc: 'It runs in a sealed, single-use environment first. If it breaks, it breaks safely in there — never on you.',
      },
    ],
  },
  {
    label: 'Your approval · nothing happens without your yes',
    tone: 'gate',
    steps: [
      {
        n: '6',
        title: 'Repo',
        tag: 'Your yes',
        desc: 'Your yes → a private repo in your GitHub, code pushed. You own it from the first commit.',
        kind: 'gate',
      },
      {
        n: '7',
        title: 'Deploy',
        tag: 'Your yes',
        desc: 'Your yes → a live URL. Nothing public happens unprompted.',
        kind: 'gate',
      },
    ],
  },
  {
    label: 'Live',
    tone: 'live',
    steps: [
      {
        n: '8',
        title: 'Live',
        tag: 'Running',
        desc: "It's yours, running — and kept alive around the clock if it needs to be.",
        kind: 'live',
      },
    ],
  },
];

function LockKey() {
  return (
    <span className={styles.key}>
      <svg viewBox="0 0 24 24" fill="none" stroke="#1a1205" strokeWidth="2.4">
        <path d="M12 2a5 5 0 00-5 5v3H6v10h12V10h-1V7a5 5 0 00-5-5zm-3 8V7a3 3 0 116 0v3H9z" />
      </svg>
    </span>
  );
}

export function HowItWorks() {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            setInView(true);
            io.disconnect();
          }
        }),
      { threshold: 0.18 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <section className="mx-auto w-full max-w-5xl px-6 py-20 sm:px-10">
      <SectionHeading
        eyebrow="How it works"
        title={
          <>
            A sentence goes in.
            <br />A running product comes out.
          </>
        }
        intro="Eight stations, one continuous loop. You only ever touch the two that stop and ask."
      />

      <div ref={ref} className={inView ? `${styles.pipe} ${styles.in}` : styles.pipe}>
        {GROUPS.map((g) => (
          <Fragment key={g.label}>
            <p
              className={[
                styles.pipeGroup,
                g.tone === 'gate'
                  ? styles.gGate
                  : g.tone === 'live'
                    ? styles.gLive
                    : undefined,
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {g.label}
            </p>
            {g.steps.map((s) => (
              <div
                key={s.n}
                className={[
                  styles.step,
                  s.kind === 'gate'
                    ? styles.sGate
                    : s.kind === 'live'
                      ? styles.sLive
                      : undefined,
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <div className={styles.node}>
                  {s.n}
                  {s.kind === 'gate' ? <LockKey /> : null}
                </div>
                <div className={styles.stepBody}>
                  <div className={styles.stepHead}>
                    <span className={styles.stepTitle}>{s.title}</span>
                    <span className={styles.stepTag}>{s.tag}</span>
                  </div>
                  <p className={styles.stepDesc}>{s.desc}</p>
                </div>
              </div>
            ))}
          </Fragment>
        ))}
      </div>
    </section>
  );
}
