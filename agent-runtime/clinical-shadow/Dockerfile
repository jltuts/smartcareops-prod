FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY agent-runtime/clinical-shadow/package.json agent-runtime/clinical-shadow/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
RUN node -e "const fs=require('node:fs'),path=require('node:path'),root='/app/node_modules',dirs=new Set(['test','tests','__tests__']); const walk=p=>{for(const entry of fs.readdirSync(p,{withFileTypes:true})){const target=path.join(p,entry.name); if(entry.isDirectory()&&dirs.has(entry.name)){fs.rmSync(target,{recursive:true,force:true}); continue;} if(entry.isDirectory()) walk(target); else if(/\.(pem|key)$/i.test(entry.name)) fs.rmSync(target,{force:true});}}; walk(root);"

COPY agent-runtime/clinical-shadow/*.js ./agent-runtime/clinical-shadow/
COPY agent-runtime/clinical-shadow/policy/*.json ./agent-runtime/clinical-shadow/policy/
COPY backend/src/agent-platform/clinical-adk-agent.js backend/src/agent-platform/clinical-adk-runtime.js backend/src/agent-platform/clinical-shadow.js backend/src/agent-platform/policy-managed-retrieval.js ./backend/src/agent-platform/
COPY backend/src/clinical/contracts.js ./backend/src/clinical/contracts.js
COPY backend/src/notifications/contracts.js ./backend/src/notifications/contracts.js
COPY backend/src/resources/contracts.js backend/src/resources/investigator.js ./backend/src/resources/
COPY backend/src/hospital/contracts.js ./backend/src/hospital/contracts.js
COPY shared/gemini-resilience.mjs ./shared/gemini-resilience.mjs

USER node
EXPOSE 8080
CMD ["node", "agent-runtime/clinical-shadow/server.js"]
