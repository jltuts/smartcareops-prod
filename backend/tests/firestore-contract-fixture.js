import assert from 'node:assert/strict';
export function database() {
  const documents = new Map(); let tail = Promise.resolve(), fail = false;
  const snapshot = path => ({ id: path.split('/').at(-1), exists: documents.has(path), data: () => structuredClone(documents.get(path)) });
  const ref = path => ({ path, collection: name => collection(`${path}/${name}`), get: async () => snapshot(path) });
  const collection = path => ({ doc: id => ref(`${path}/${id}`), limit: limit => ({ path, limit, get: async () => query(path, limit) }) });
  const query = (path, limit) => ({ docs: [...documents.keys()].filter(key => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/')).slice(0, limit).map(snapshot) });
  return { documents, failNext() { fail = true; }, collection,
    runTransaction(change) {
      const work = tail.then(async () => {
        const writes = [];
        const result = await change({ async get(target) { assert.equal(writes.length, 0); return target.limit ? query(target.path, target.limit) : snapshot(target.path); }, set(target, value) { writes.push([target.path, structuredClone(value)]); } });
        if (fail) { fail = false; throw new Error('Storage unavailable'); }
        for (const [path, value] of writes) documents.set(path, value); return result;
      }); tail = work.catch(() => {}); return work;
    }, async terminate() {},
  };
}
