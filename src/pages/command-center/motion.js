import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';
import 'lenis/dist/lenis.css';

gsap.registerPlugin(ScrollTrigger);

export function mountCommandCenterMotion(root) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const desktop = window.matchMedia('(min-width: 901px) and (pointer: fine)').matches;
  const lenis = desktop && !reducedMotion ? new Lenis({ autoRaf: true, duration: 0.9, smoothWheel: true, syncTouch: false }) : null;
  lenis?.on('scroll', ScrollTrigger.update);

  const nav = root.querySelector('.command-center-nav');
  const overview = root.querySelector('.command-center-overview');
  const siteHeader = document.querySelector('.site-header');
  const updateHeaderHeight = () => root.style.setProperty('--command-center-header-height', `${Math.ceil(siteHeader?.getBoundingClientRect().height || 0)}px`);
  updateHeaderHeight();
  const headerObserver = siteHeader && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateHeaderHeight) : null;
  if (headerObserver) headerObserver.observe(siteHeader);
  const navLinks = [...(nav?.querySelectorAll('a[href^="#"]') || [])];
  let pendingLink = null, navigationTimer = 0, navigationEnd = null, navigationToken = 0;
  const setActiveLink = link => {
    navLinks.forEach(item => {
      const active = item === link;
      item.classList.toggle('active', active);
      if (active) item.setAttribute('aria-current', 'location');
      else item.removeAttribute('aria-current');
    });
  };
  const stopNavigationTracking = () => {
    window.clearTimeout(navigationTimer);
    if (navigationEnd) window.removeEventListener('scrollend', navigationEnd);
    navigationTimer = 0;
    navigationEnd = null;
    pendingLink = null;
  };
  const navigate = event => {
    const link = event.target.closest('a[href^="#"]');
    if (!link) return;
    const target = root.querySelector(link.hash);
    if (!target) return;
    event.preventDefault();
    stopNavigationTracking();
    const activeLink = navLinks.find(item => item.hash === link.hash) || link;
    pendingLink = activeLink;
    const token = ++navigationToken;
    const complete = () => {
      if (token !== navigationToken) return;
      stopNavigationTracking();
      setActiveLink(activeLink);
    };
    navigationTimer = window.setTimeout(complete, 2500);
    setActiveLink(activeLink);
    window.history.pushState({}, '', link.hash);
    const offset = (siteHeader?.getBoundingClientRect().height || 0) + (nav?.getBoundingClientRect().height || 0) + 20;
    if (lenis) lenis.scrollTo(target, { offset: -offset, duration: 0.8, onComplete: complete });
    else {
      navigationEnd = complete;
      window.addEventListener('scrollend', complete, { once: true });
      window.scrollTo({ top: window.scrollY + target.getBoundingClientRect().top - offset, behavior: reducedMotion ? 'auto' : 'smooth' });
    }
  };
  nav?.addEventListener('click', navigate);
  overview?.addEventListener('click', navigate);

  const sectionObserver = new IntersectionObserver(entries => {
    if (pendingLink) return;
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (!visible) return;
    const link = navLinks.find(item => item.hash === `#${visible.target.id}`);
    if (link) setActiveLink(link);
  }, { rootMargin: '-18% 0px -66% 0px', threshold: 0 });
  navLinks.forEach(link => {
    const target = root.querySelector(link.hash);
    if (target) sectionObserver.observe(target);
  });

  if (reducedMotion) return () => {
    stopNavigationTracking();
    sectionObserver.disconnect();
    nav?.removeEventListener('click', navigate);
    overview?.removeEventListener('click', navigate);
    headerObserver?.disconnect();
    root.style.removeProperty('--command-center-header-height');
  };

  const context = gsap.context(() => {
    // The operational network remains stable while supporting panels reveal below it.
    const sections = root.querySelectorAll('.pattern-panel, .predictive-panel, .caretwin-panel, .ops-supporting');
    sections.forEach(section => gsap.fromTo(section,
      { autoAlpha: 0.9, y: 18 },
      { autoAlpha: 1, y: 0, duration: 0.55, ease: 'power2.out', clearProps: 'transform,opacity,visibility', scrollTrigger: { trigger: section, start: 'top 92%', once: true } },
    ));
  }, root);

  const animatedNodes = new WeakSet();
  const animatedAlerts = new Set();
  let frame = 0;
  const revealNewContent = () => {
    frame = 0;
    const groups = [
      ['.simulation-metric', 0.025],
      ['.predictive-horizon', 0.07],
      ['.caretwin-plan', 0.07],
    ];
    for (const [selector, stagger] of groups) {
      const fresh = [...root.querySelectorAll(selector)].filter(item => !animatedNodes.has(item));
      fresh.forEach(item => animatedNodes.add(item));
      if (fresh.length) gsap.fromTo(fresh, { autoAlpha: 0.88, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.35, stagger, ease: 'power2.out', clearProps: 'transform,opacity,visibility' });
    }
    const alert = root.querySelector('.pattern-alert');
    const alertId = alert?.dataset.alertId;
    if (alert && alertId && !animatedAlerts.has(alertId)) {
      animatedAlerts.add(alertId);
      gsap.fromTo(alert, { autoAlpha: 0.86, y: -8, boxShadow: '0 0 0 rgba(52,41,26,0)' }, { autoAlpha: 1, y: 0, boxShadow: '0 10px 30px rgba(79,50,29,.13)', duration: 0.5, ease: 'power2.out', clearProps: 'transform,opacity,visibility,boxShadow' });
    }
    ScrollTrigger.refresh();
  };
  const scheduleReveal = () => { if (!frame) frame = window.requestAnimationFrame(revealNewContent); };
  const observer = new MutationObserver(scheduleReveal);
  observer.observe(root, { childList: true, subtree: true });
  scheduleReveal();

  return () => {
    stopNavigationTracking();
    if (frame) window.cancelAnimationFrame(frame);
    observer.disconnect();
    sectionObserver.disconnect();
    nav?.removeEventListener('click', navigate);
    overview?.removeEventListener('click', navigate);
    headerObserver?.disconnect();
    root.style.removeProperty('--command-center-header-height');
    context.revert();
    lenis?.destroy();
  };
}
