// Data protection: precise GPS points are deleted after the company's retention
// period (settings.dataRetentionDays, default 365). Session summaries stay for
// reports and settlements, but trip coordinates are removed from them.
export const DEFAULT_RETENTION_DAYS = 365;
const DAY = 86400000;

export function createRetentionService({ db, now = Date.now, maxSessionsPerCompany = 200 }) {
  async function purgeCompany(companyId, company) {
    const days = Math.max(30, Number(company?.settings?.dataRetentionDays) || DEFAULT_RETENTION_DAYS);
    const cutoff = now() - days * DAY;
    let sessions = 0, points = 0;
    const old = await db.collection(`companies/${companyId}/sessions`).where('startedAtMillis', '<', cutoff).get();
    for (const s of old.docs.slice(0, maxSessionsPerCompany)) {
      const data = s.data() || {};
      if (data.routePurged) continue;
      const route = await db.collection(`${s.ref.path}/route`).get();
      let batch = db.batch(), n = 0;
      for (const r of route.docs) {
        points += (r.data()?.lat || []).length;
        batch.delete(r.ref);
        if (++n === 400) { await batch.commit(); batch = db.batch(); n = 0; }
      }
      const trips = (data.trips || []).map(({ lat, lng, ...rest }) => rest);
      batch.set(s.ref, { trips, routePurged: true }, { merge: true });
      await batch.commit();
      sessions++;
    }
    // Old last-known positions of drivers who stopped using the app.
    const stale = await db.collection(`companies/${companyId}/liveLocations`).where('updatedAtMillis', '<', cutoff).get();
    for (const l of stale.docs) await l.ref.delete();
    return { sessions, points, live: stale.docs.length };
  }

  return {
    async purgeAll() {
      const companies = await db.collection('companies').get();
      const result = { companies: 0, sessions: 0, points: 0, live: 0 };
      for (const c of companies.docs) {
        try {
          const r = await purgeCompany(c.id, c.data());
          result.companies++; result.sessions += r.sessions; result.points += r.points; result.live += r.live;
        } catch (e) { console.error('Retention failed', { companyId: c.id, message: e.message }); }
      }
      return result;
    },
    purgeCompany,
  };
}
