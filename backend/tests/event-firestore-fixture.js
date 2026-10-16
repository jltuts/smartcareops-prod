import assert from 'node:assert/strict';

export function eventDatabase() {
  const documents = new Map();
  let tail = Promise.resolve(), fail = false;
  const ref = path => ({ path, get: async () => snapshot(path) });
  const snapshot = path => ({ id: path.split('/').at(-1), ref: ref(path), exists: documents.has(path),
    data: () => structuredClone(documents.get(path)) });
  const execute = query => {
    let rows = [...documents.keys()]
      .filter(key => key.startsWith(`${query.path}/`) && !key.slice(query.path.length + 1).includes('/'))
      .map(path => ({ path, value: documents.get(path) }));
    for (const [field, operator, expected] of query.filters) {
      assert(['<=', '=='].includes(operator));
      rows = rows.filter(({ value }) => value[field] !== null && value[field] !== undefined &&
        (operator === '==' ? value[field] === expected : value[field] <= expected));
    }
    if (query.order) rows.sort((left, right) => String(left.value[query.order]).localeCompare(String(right.value[query.order])));
    return { docs: rows.slice(0, query.maximum).map(({ path }) => snapshot(path)) };
  };
  const query = (path, filters = [], order = null, maximum = Infinity) => ({
    path, filters, order, maximum, query: true,
    where(field, operator, value) { return query(path, [...filters, [field, operator, value]], order, maximum); },
    orderBy(field) { return query(path, filters, field, maximum); },
    limit(value) { return query(path, filters, order, value); },
    doc(id) { return ref(`${path}/${id}`); },
    get() { return Promise.resolve(execute(this)); },
  });
  return {
    documents,
    failNext() { fail = true; },
    collection: path => query(path),
    runTransaction(change) {
      const work = tail.then(async () => {
        const writes = [];
        const transaction = {
          async get(target) { assert.equal(writes.length, 0); return target.query ? execute(target) : snapshot(target.path); },
          set(target, value) { writes.push([target.path, structuredClone(value)]); },
          create(target, value) {
            assert.equal(documents.has(target.path) || writes.some(([path]) => path === target.path), false);
            writes.push([target.path, structuredClone(value)]);
          },
        };
        const result = await change(transaction);
        if (fail) { fail = false; throw new Error('Storage unavailable'); }
        for (const [path, value] of writes) documents.set(path, value);
        return result;
      });
      tail = work.catch(() => {});
      return work;
    },
  };
}
