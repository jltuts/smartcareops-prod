import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';

gsap.registerPlugin(ScrollTrigger);

export function mountDoctorMotion(root) {
  if (!root || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};
  const desktop = window.matchMedia('(min-width: 901px) and (pointer: fine)').matches;
  const lenis = desktop ? new Lenis({ autoRaf: true, duration: 0.85, smoothWheel: true, syncTouch: false }) : null;
  lenis?.on('scroll', ScrollTrigger.update);
  const context = gsap.context(() => {
    // Keep the route heading focusable while its entrance fade is running.
    gsap.fromTo('.doctor-hero > *, .doctor-inbox', { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.48, stagger: 0.08, ease: 'power2.out', clearProps: 'transform,opacity' });
  }, root);
  const animated = new WeakSet();
  let frame;
  const reveal = () => {
    frame = undefined;
    const selectors = ['.doctor-card', '.doctor-case-header', '.doctor-evidence-zone', '.clinical-plan', '.clinical-analysis', '.clinical-explanation', '.clinical-decision'];
    for (const selector of selectors) {
      const fresh = [...root.querySelectorAll(selector)].filter(item => !animated.has(item));
      fresh.forEach(item => animated.add(item));
      if (fresh.length) gsap.fromTo(fresh, { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: 0.42, stagger: 0.06, ease: 'power2.out', clearProps: 'transform,opacity,visibility' });
    }
    ScrollTrigger.refresh();
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(reveal); };
  const observer = new MutationObserver(schedule); observer.observe(root, { childList: true, subtree: true }); schedule();
  return () => { if (frame) cancelAnimationFrame(frame); observer.disconnect(); context.revert(); lenis?.destroy(); };
}
