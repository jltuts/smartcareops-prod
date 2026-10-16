import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';

gsap.registerPlugin(ScrollTrigger);

export function mountHomeMotion(outlet) {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const desktop = matchMedia('(min-width: 900px) and (pointer: fine)').matches;
  const nav = document.querySelector('.site-header .landing-nav');
  let lenis;
  let navTrigger;
  if (!reduceMotion && desktop) {
    lenis = new Lenis({ autoRaf: true, duration: 0.9, smoothWheel: true, syncTouch: false });
    lenis.on('scroll', ScrollTrigger.update);
  }
  const context = gsap.context(() => {
    if (reduceMotion) return;
    navTrigger = ScrollTrigger.create({ start: 36, end: 'max', onToggle: self => nav?.classList.toggle('is-scrolled', self.isActive) });

    const heroTimeline = gsap.timeline({ scrollTrigger: { trigger: '.landing-hero', start: 'top top', end: '+=90vh', scrub: .65 } });
    heroTimeline.fromTo('.landing-hero-line', { autoAlpha: 1, y: 26 }, { autoAlpha: 1, y: 0, duration: .34, stagger: .12, ease: 'power3.out' }, 0)
      .fromTo('.landing-hero-statement, .landing-hero-intro', { autoAlpha: 1, y: 18 }, { autoAlpha: 1, y: 0, duration: .24, stagger: .08, ease: 'power2.out' }, .25)
      .fromTo('.landing-hero-actions, .landing-proof', { autoAlpha: 1, y: 14 }, { autoAlpha: 1, y: 0, duration: .2, stagger: .06, ease: 'power2.out' }, .42)
      .fromTo('.node-patient', { scale: .86, autoAlpha: .78 }, { scale: 1, autoAlpha: 1, duration: .15 }, .12)
      .fromTo('.connector-patient-doctor', { strokeDashoffset: 28 }, { strokeDashoffset: 0, duration: .2 }, .28)
      .fromTo('.node-doctor', { scale: .86, autoAlpha: .42 }, { scale: 1, autoAlpha: 1, duration: .15 }, .35)
      .fromTo('.connector-doctor-response', { strokeDashoffset: 28 }, { strokeDashoffset: 0, duration: .2 }, .51)
      .fromTo('.node-response', { scale: .86, autoAlpha: .42 }, { scale: 1, autoAlpha: 1, duration: .15 }, .58)
      .fromTo('.connector-response-network', { strokeDashoffset: 28 }, { strokeDashoffset: 0, duration: .2 }, .72)
      .fromTo('.node-network', { scale: .86, autoAlpha: .42 }, { scale: 1, autoAlpha: 1, duration: .15 }, .79);

    if (desktop) {
      gsap.to('.landing-hero-visual', { yPercent: 7, ease: 'none', scrollTrigger: { trigger: '.landing-hero', start: 'top top', end: 'bottom top', scrub: .8 } });
      gsap.to('.landing-orbit', { yPercent: 16, xPercent: -5, ease: 'none', scrollTrigger: { trigger: '.landing-hero', start: 'top top', end: 'bottom top', scrub: 1 } });
    }
    gsap.utils.toArray('.landing-section-intro').forEach(element => gsap.fromTo(element, { autoAlpha: 0, y: 26 }, { autoAlpha: 1, y: 0, duration: .65, ease: 'power2.out', clearProps: 'transform,opacity,visibility', scrollTrigger: { trigger: element, start: 'top 84%', once: true } }));
    gsap.fromTo('.landing-portal-card', { autoAlpha: 0, y: 28 }, { autoAlpha: 1, y: 0, duration: .58, stagger: .1, ease: 'power3.out', clearProps: 'transform,opacity,visibility', scrollTrigger: { trigger: '.landing-portal-grid', start: 'top 80%', once: true } });
    gsap.fromTo('.landing-journey-step', { autoAlpha: 0, y: 18 }, { autoAlpha: 1, y: 0, duration: .45, stagger: .08, ease: 'power2.out', clearProps: 'transform,opacity,visibility', scrollTrigger: { trigger: '.landing-journey-track', start: 'top 82%', once: true } });
    gsap.fromTo('.landing-journey-line i', { scaleY: 0 }, { scaleY: 1, transformOrigin: 'top center', ease: 'none', scrollTrigger: { trigger: '.landing-journey-track', start: 'top 70%', end: 'bottom 55%', scrub: .5 } });
    gsap.fromTo('.landing-intelligence-stack article', { autoAlpha: 0, y: 30 }, { autoAlpha: 1, y: 0, duration: .6, stagger: .13, ease: 'power3.out', clearProps: 'transform,opacity,visibility', scrollTrigger: { trigger: '.landing-intelligence-stack', start: 'top 80%', once: true } });
    gsap.fromTo('.landing-final > :not(.landing-final-orbit)', { autoAlpha: 0, y: 20 }, { autoAlpha: 1, y: 0, duration: .6, stagger: .06, ease: 'power2.out', clearProps: 'transform,opacity,visibility', scrollTrigger: { trigger: '.landing-final', start: 'top 78%', once: true } });
    ScrollTrigger.refresh();
  }, outlet);
  return () => { navTrigger?.kill(); context.revert(); lenis?.destroy(); nav?.classList.remove('is-scrolled'); };
}
