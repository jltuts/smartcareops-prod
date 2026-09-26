import { defineConfig } from 'vite';

const proxy = {
  '/api/auth': { target: 'http://127.0.0.1:8080' },
  '/api/notifications': { target: 'http://127.0.0.1:8080' },
  '/api/regional': { target: 'http://127.0.0.1:8080' },
  '/api/operations': { target: 'http://127.0.0.1:8080' },
  '/api/clinical': { target: 'http://127.0.0.1:8080' },
  '/api/ambulances': { target: 'http://127.0.0.1:8080' },
  '/api/dispatcher': { target: 'http://127.0.0.1:8080' },
  '/api/doctor': { target: 'http://127.0.0.1:8080' },
  '/api/cases': { target: 'http://127.0.0.1:8080' },
  '/api/intake-finalization': { target: 'http://127.0.0.1:8080' },
  '/hospital-demo': { target: 'http://127.0.0.1:8080' },
  '/api/agent': { target: 'ws://127.0.0.1:8080', ws: true },
  '/api/live': {
    target: 'ws://127.0.0.1:8080',
    ws: true,
  },
};

export default defineConfig({
  server: {
    host: '0.0.0.0',
    allowedHosts: [
      'formless-mozella-hyperhilariously.ngrok-free.dev',
    ],
    proxy,
  },

  preview: {
    host: '0.0.0.0',
    allowedHosts: [
      'formless-mozella-hyperhilariously.ngrok-free.dev',
    ],
    proxy,
  },
});
