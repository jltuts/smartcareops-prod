# Google Live local restart baseline

Copied from the exact local demo the operator tested at http://localhost:8000:
the upstream example frontend.

Upstream: https://github.com/google-gemini/gemini-live-api-examples/tree/main/gemini-live-ephemeral-tokens-websocket

`client.js` is `geminilive.js`, with module exports and a module-local no-op
console to prevent tokens, raw payloads, and transcripts entering browser logs.
`media.js` is `mediaUtils.js`, with the same logging change, exports, and absolute
worklet URLs. The two files in `public/google-reference` are unchanged copies.
No VAD, queue, chunk-size, resampling, or interruption changes were made.

The local Patient Portal uses this reference in Vite development mode only.
Its UI adapter uses the existing authenticated token endpoint; it never calls the
chat message endpoint, never gates audio by conversation phase, and never reinjects
backend questions. It uses the demo defaults (Puck, temperature 1.0, automatic VAD)
and helpful-assistant instruction. One initial hello starts the conversation.

This is a voice baseline, not clinical intake acceptance. It does not save an
intake, dispatch an emergency, or end automatically. Those integrations require
separate design and verification before a production rollout. Existing case
records, Chat intake, and hosted behavior are unchanged.
