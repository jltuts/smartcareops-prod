export function brandMarkup({ href = '/', className = '', routeLink = true, connectedCare = false } = {}) {
  const classes = ['smartcareops-brand', className].filter(Boolean).join(' ');
  const linkAttribute = routeLink ? ' data-link' : '';
  return `<a class="${classes}" href="${href}"${linkAttribute}>
    <span class="smartcareops-brand-mark landing-brand-mark" aria-hidden="true"><i></i><i></i></span>
    <span class="smartcareops-brand-copy"><strong>SmartCareOps</strong>${connectedCare ? '<small>Connected care</small>' : ''}</span>
  </a>`;
}
