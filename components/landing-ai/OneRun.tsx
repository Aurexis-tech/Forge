'use client';

// OneRun — landing section 5. One real prompt walked end to end, with an
// interactive gate demo: the visitor clicks "Approve" on both gates and the
// "You get" deliverables brighten from amber to live-mint — a hands-on feel for
// "nothing ships without your yes". Styling: OneRun.module.css (lq.* tokens).

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { SectionHeading } from './SectionHeading';
import styles from './OneRun.module.css';

const CHIPS: ReadonlyArray<{ text: string; ok?: boolean }> = [
  { text: 'drafts spec' },
  { text: 'shows it to you' },
  { text: 'plans full-stack' },
  { text: 'generates' },
  { text: 'sandbox boot & test' },
  { text: 'cross-user isolation ✓', ok: true },
];

const GATES: ReadonlyArray<{ n: string; q: string }> = [
  { n: '1', q: 'Create the private repo?' },
  { n: '2', q: 'Deploy?' },
];

function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1" />
      <path d="M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1" />
    </svg>
  );
}
function RepoIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <path d="M6 8.5v7M8.5 6H15a3 3 0 013 3v.5" />
    </svg>
  );
}
function DashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M9 21V9" />
    </svg>
  );
}

const GETS: ReadonlyArray<{ icon: ReactNode; title: string; body: string }> = [
  { icon: <LinkIcon />, title: 'A live URL', body: 'Public the moment you approved it.' },
  { icon: <RepoIcon />, title: 'A private repo', body: 'In your GitHub. Yours to keep.' },
  { icon: <DashIcon />, title: 'A dashboard', body: 'Watch, manage, or stop it anytime.' },
];

export function OneRun() {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [approved, setApproved] = useState<ReadonlyArray<boolean>>([false, false]);
  const unlocked = approved.every(Boolean);

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

  function approve(i: number) {
    setApproved((prev) => {
      if (prev[i]) return prev;
      const next = [...prev];
      next[i] = true;
      return next;
    });
  }

  const runClass = [styles.run, inView ? styles.in : '', unlocked ? styles.unlocked : '']
    .filter(Boolean)
    .join(' ');

  return (
    <section className="mx-auto w-full max-w-5xl px-6 py-20 sm:px-10">
      <SectionHeading
        eyebrow="One run, start to finish"
        title={
          <>
            What a single forge
            <br />
            actually looks like.
          </>
        }
        accent="violet"
      />

      <div ref={ref} className={runClass}>
        <div className={styles.runBlock}>
          <p className={styles.runLabel}>You type</p>
          <p className={styles.prompt}>
            <span className={styles.glyph} aria-hidden>
              ❯
            </span>
            <span>
              &ldquo;A web app where my team submits expenses, a manager approves
              them, and everyone sees their own history.&rdquo;
              <span className={styles.caret} aria-hidden />
            </span>
          </p>
        </div>

        <div className={styles.runBlock}>
          <p className={styles.runLabel}>Forge</p>
          <div className={styles.chips}>
            {CHIPS.map((c, i) => (
              <Fragment key={c.text}>
                {i > 0 ? (
                  <span
                    className={styles.arrow}
                    aria-hidden
                    style={{ transitionDelay: `${i * 0.1}s` }}
                  >
                    →
                  </span>
                ) : null}
                <span
                  className={c.ok ? `${styles.chip} ${styles.chipOk}` : styles.chip}
                  style={{ transitionDelay: `${0.05 + i * 0.1}s` }}
                >
                  {c.text}
                </span>
              </Fragment>
            ))}
          </div>
        </div>

        <div className={styles.runBlock}>
          <p className={styles.runLabel}>It pauses — twice</p>
          {GATES.map((g, i) => {
            const isApproved = approved[i];
            return (
              <button
                key={g.n}
                type="button"
                onClick={() => approve(i)}
                aria-pressed={isApproved}
                className={isApproved ? `${styles.gate} ${styles.approved}` : styles.gate}
              >
                <span className={styles.gateN}>{g.n}</span>
                <span className={styles.gateK}>{isApproved ? 'Approved' : 'Gate'}</span>
                <span className={styles.gateQ}>&ldquo;{g.q}&rdquo;</span>
                <span className={styles.gateAct}>{isApproved ? '✓ done' : 'Approve'}</span>
              </button>
            );
          })}
        </div>

        <div className={styles.runBlock}>
          <p className={styles.runLabel}>You get</p>
          <div className={styles.gets}>
            {GETS.map((g) => (
              <div className={styles.get} key={g.title}>
                <div className={styles.getIc}>{g.icon}</div>
                <h4>{g.title}</h4>
                <p>{g.body}</p>
              </div>
            ))}
          </div>
          <p className={styles.hint}>
            {unlocked
              ? 'Released — your product is live ✓'
              : 'Approve both gates above to release the build →'}
          </p>
        </div>
      </div>
    </section>
  );
}
