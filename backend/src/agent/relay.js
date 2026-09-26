import { diagnosticsFor, createAgentDiagnostics } from './diagnostics.js';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { runHandoff } from './loop.js';
import { caseFields } from './cases.js';
import { HandoffError } from './errors.js';

export function createAgentRelay({ cases, portalUrl, origins, run = runHandoff }) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 100000 });
  const jobs = new Set();
  let busy = false;
  sockets.on('connection', ws => {
    const controller = new AbortController();
    let started = false;
    let pending;
    let timer = setTimeout(() => ws.close(1000), 15000);
    const send = event => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 256000) { controller.abort(); ws.terminate(); return; }
      ws.send(JSON.stringify(event));
    };
    const cancel = () => { clearTimeout(timer); controller.abort(); pending?.resolve(false); pending = null; };
    ws.on('close', cancel); ws.on('error', cancel);
    ws.on('message', (raw, binary) => {
      try {
        if (binary) throw new HandoffError('Invalid handoff request.');
        const message = JSON.parse(raw.toString());
        if (message.type === 'cancel') { cancel(); ws.close(1000); return; }
        if (message.type === 'confirm' && pending && message.id === pending.id && typeof message.approved === 'boolean') {
          const waiting = pending; pending = null; waiting.resolve(message.approved); return;
        }
        if (started || message.type !== 'start' || message.fictional !== true) throw new HandoffError('Confirm fictional test data before starting handoff.');
        const intake = cases.get(message.completionToken, message.intake);
        caseFields(intake);
        if (busy) throw new HandoffError('Another demo handoff is running. Retry when it finishes.');
        started = true; busy = true; clearTimeout(timer);
        // A hard wall-clock timeout also covers client disconnect/confirmation.
        timer = setTimeout(cancel, 185000);
        const job = (async () => {
          try {
            await run({ intake, patientCaseId: cases.caseId?.(message.completionToken), portalUrl: portalUrl(), emit: send, signal: controller.signal,
              confirm: detail => new Promise(resolve => {
                const id = randomUUID(); pending = { id, resolve };
                send({ status: 'confirmation', message: 'Action paused for your confirmation', id, ...detail });
              }),
            });
          } catch (error) {
            send({ status: 'failed', diagnostics: diagnosticsFor(error) || createAgentDiagnostics(portalUrl()).fail(error), message: error instanceof HandoffError ? error.message : 'Agentic handoff could not be completed. Check Computer Use access, browser installation, and backend configuration, then retry.' });
          } finally { cancel(); busy = false; ws.close(1000); }
        })();
        jobs.add(job); void job.finally(() => jobs.delete(job));
      } catch (error) {
        send({ status: 'failed', diagnostics: diagnosticsFor(error) || createAgentDiagnostics(portalUrl()).fail(error), message: error instanceof HandoffError ? error.message : 'Invalid handoff request.' });
        cancel(); ws.close(1000);
      }
    });
  });
  return {
    upgrade(request, socket, head) {
      if (request.url !== '/api/agent/handoff' || !origins.includes(request.headers.origin)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
      sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws));
    },
    async close() {
      const closed = new Promise(resolve => sockets.close(resolve));
      for (const ws of sockets.clients) ws.terminate();
      await Promise.all([closed, ...jobs]);
    },
  };
}
