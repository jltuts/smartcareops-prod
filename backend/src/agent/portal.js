// Self-contained fictional page: no shared intake imports, data APIs, storage,
// network submission, external assets, or real hospital integration.
export const hospitalDemo = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Hospital Intake Demo</title>
<style>body{margin:0;background:#d9d9cf;color:#151515;font:16px Arial,sans-serif}main{max-width:1000px;margin:24px auto;padding:24px;background:#f4f4ea;border:3px double #333}header{border-bottom:3px solid #333;margin-bottom:20px}h1{font-size:26px}strong.notice{display:block;background:#fff2a8;padding:12px}form{display:grid;grid-template-columns:1fr 1fr;gap:14px 24px;margin-top:20px}label{display:grid;gap:5px;font-weight:bold}input,textarea{box-sizing:border-box;width:100%;padding:9px;border:1px solid #555;background:white;color:#111;font:16px Arial}textarea{min-height:65px}button{padding:14px;border:2px outset #777;background:#d5d5d5;color:#111;font-weight:bold;font-size:16px;cursor:pointer}.wide{grid-column:1/-1}#receipt{border:3px solid #28653b;padding:24px;margin-top:20px;background:#e7f3e7}#receipt h2{color:#175529}dt{font-weight:bold;margin-top:10px}dd{margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere}[hidden]{display:none!important}@media(max-width:600px){main{margin:8px;padding:14px}form{grid-template-columns:1fr}}</style></head><body><main>
<header><p>LEGACY ADMISSIONS TERMINAL · TRAINING ONLY</p><h1>Hospital Intake Demo</h1></header>
<strong class="notice">FICTIONAL HOSPITAL — FICTIONAL PATIENTS ONLY. This form sends nothing to a hospital.</strong>
<p>Copy reported information only. Leave unknown fields blank. No clinical decisions are made here.</p>
<form id="intake-form" autocomplete="off">
${['Patient Name', 'Reported Symptoms', 'Onset / Duration', 'Shortness of Breath', 'Chest Pain', 'Blood Pressure', 'Temperature', 'Heart Rate', 'SpO2', 'Blood Glucose'].map((name, index) => `<label>${name}<input name="${name}" id="field-${index}" maxlength="4000"></label>`).join('')}
<label class="wide">Notes<textarea name="Notes" maxlength="8000"></textarea></label>
<button class="wide" type="submit">SUBMIT INTAKE</button></form>
<section id="receipt" hidden aria-live="polite"><h2>INTAKE RECEIVED</h2><p>Case ID: <strong id="case-id"></strong></p><p>Fictional receipt only. Nothing has been dispatched or sent to a real hospital.</p><dl id="received-fields"></dl></section>
<script>document.querySelector('form').addEventListener('submit', event => {event.preventDefault();const form=event.currentTarget;const values=[...new FormData(form)];if(!values.some(([,v])=>v.trim())){form.querySelector('input').focus();return;}const receipt=document.querySelector('#receipt');if(!receipt.hidden)return;document.querySelector('#case-id').textContent='DEMO-'+crypto.randomUUID().slice(0,8).toUpperCase();for(const [key,value] of values){const dt=document.createElement('dt');dt.textContent=key;const dd=document.createElement('dd');dd.textContent=value;document.querySelector('#received-fields').append(dt,dd);}form.hidden=true;receipt.hidden=false;receipt.scrollIntoView({block:'start'});});</script>
</main></body></html>`;

export function serveHospital(response) {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(hospitalDemo);
}
