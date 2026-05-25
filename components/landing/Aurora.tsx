// The slow warm aurora that drifts behind the forge core.
// Pure DOM/CSS — two large blurred radial gradients with very slow
// keyframe motion. Cheap, no canvas overhead, and degrades gracefully
// under prefers-reduced-motion via the global @media rule in globals.css.

export function Aurora() {
  return (
    <div
      aria-hidden
      // pointer-events-none so the hero input still receives focus through it.
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <div
        className="absolute -left-[20%] -top-[10%] h-[70vh] w-[70vh] rounded-full opacity-50 mix-blend-screen blur-3xl"
        style={{
          background:
            'radial-gradient(circle at 35% 35%, rgba(255,154,77,0.55) 0%, rgba(255,154,77,0.18) 40%, transparent 70%)',
          animation: 'forge-aurora-a 28s ease-in-out infinite alternate',
        }}
      />
      <div
        className="absolute -right-[15%] top-[10%] h-[60vh] w-[60vh] rounded-full opacity-40 mix-blend-screen blur-3xl"
        style={{
          background:
            'radial-gradient(circle at 50% 50%, rgba(79,212,240,0.35) 0%, rgba(79,212,240,0.08) 45%, transparent 70%)',
          animation: 'forge-aurora-b 36s ease-in-out infinite alternate',
        }}
      />
    </div>
  );
}
