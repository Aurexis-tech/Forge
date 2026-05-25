// Capability checks for the 3D layer. Run on mount, never during SSR.

export function detectWebGL(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl =
      canvas.getContext('webgl2') ||
      canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl');
    if (!gl) return false;
    // Some headless / locked-down environments give us a context that
    // can't actually render — sanity-check one attribute.
    const dbg = (gl as WebGLRenderingContext).getParameter?.(
      (gl as WebGLRenderingContext).VERSION,
    );
    return typeof dbg === 'string' && dbg.length > 0;
  } catch {
    return false;
  }
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function isSmallViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < 768;
}
