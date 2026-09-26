import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetentionService } from '../retention.js';

function fixture(entries) {
  const data = new Map(Object.entries(entries));
  const ref = path => ({ path, id: path.split('/').at(-1), async delete() { data.delete(path); },
    async set(v, o) { data.set(path, o?.merge ? { ...data.get(path), ...v } : v); } });
  const snap = path => ({ id: path.split('/').at(-1), ref: ref(path), data: () => data.get(path) });
  const query = (col, filters) => ({
    where: (f, op, v) => query(col, [...filters, [f, op, v]]),
    async get() {
      const depth = col.split('/').length + 1;
      const docs = [...data.keys()].filter(k => k.startsWith(col + '/') && k.split('/').length === depth)
        .filter(k => filters.every(([f, op, v]) => op === '<' ? data.get(k)?.[f] < v : data.get(k)?.[f] === v)).map(snap);
      return { docs, size: docs.length };
    },
  });
  const db = { collection: col => query(col, []),
    batch() { const ops = []; return { delete: r => ops.push(() => r.delete()), set: (r, v, o) => ops.push(() => r.set(v, o)), async commit() { for (const o of ops) await o(); } }; } };
  return { db, data };
}
const DAY = 86400000, NOW = 1000 * DAY;

test('old GPS points are deleted, trip summaries kept without coordinates; recent data untouched', async () => {
  const f = fixture({
    'companies/a': { name: 'A' },
    'companies/a/sessions/old': { startedAtMillis: NOW - 400 * DAY, tripsCount: 1, tonnes: 26, trips: [{ n: 1, weightT: 26, lat: 55, lng: 24 }] },
    'companies/a/sessions/old/route/1': { lat: [1, 2], lng: [1, 2] },
    'companies/a/sessions/new': { startedAtMillis: NOW - 10 * DAY, trips: [{ n: 1, lat: 55, lng: 24 }] },
    'companies/a/sessions/new/route/1': { lat: [1], lng: [1] },
    'companies/a/liveLocations/gone': { updatedAtMillis: NOW - 500 * DAY },
    'companies/a/liveLocations/here': { updatedAtMillis: NOW - DAY },
  });
  const r = await createRetentionService({ db: f.db, now: () => NOW }).purgeAll();
  assert.deepEqual(r, { companies: 1, sessions: 1, points: 2, live: 1 });
  assert.equal(f.data.has('companies/a/sessions/old/route/1'), false);
  assert.deepEqual(f.data.get('companies/a/sessions/old').trips, [{ n: 1, weightT: 26 }]);
  assert.equal(f.data.get('companies/a/sessions/old').tonnes, 26);
  assert.equal(f.data.get('companies/a/sessions/old').routePurged, true);
  assert.equal(f.data.has('companies/a/sessions/new/route/1'), true);
  assert.equal(f.data.get('companies/a/sessions/new').trips[0].lat, 55);
  assert.equal(f.data.has('companies/a/liveLocations/here'), true);
});
test('company retention setting is respected (minimum 30 days)', async () => {
  const f = fixture({
    'companies/a': { settings: { dataRetentionDays: 60 } },
    'companies/a/sessions/s': { startedAtMillis: NOW - 90 * DAY },
    'companies/a/sessions/s/route/1': { lat: [1], lng: [1] },
    'companies/b': { settings: { dataRetentionDays: 1 } },
    'companies/b/sessions/s': { startedAtMillis: NOW - 10 * DAY },
    'companies/b/sessions/s/route/1': { lat: [1], lng: [1] },
  });
  await createRetentionService({ db: f.db, now: () => NOW }).purgeAll();
  assert.equal(f.data.has('companies/a/sessions/s/route/1'), false);
  assert.equal(f.data.has('companies/b/sessions/s/route/1'), true);
});
