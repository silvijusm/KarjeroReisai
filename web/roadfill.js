// Where GPS points are missing (phone slept, no signal) the route would be a straight line
// across fields. Split the route at such gaps and fill each gap with the road (OSRM), dashed.
const GAP_M = 400, MAX_GAPS = 30;
const cache = new Map();
const dist = (a, b) => {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
async function road(a, b) {
  const key = `${a[1].toFixed(5)},${a[0].toFixed(5)};${b[1].toFixed(5)},${b[0].toFixed(5)}`;
  if (cache.has(key)) return cache.get(key);
  let out = null;
  try {
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${key}?overview=full&geometries=geojson`);
    if (r.ok) {
      const route = (await r.json()).routes?.[0];
      if (route && route.distance <= dist(a, b) * 3 + 2000) out = [a, ...route.geometry.coordinates.map(([lng, lat]) => [lat, lng]), b];
    }
  } catch { /* offline – keep the straight dashed line */ }
  cache.set(key, out);
  return out;
}
export async function fillRoads(lines) {
  const solid = [], estimated = [];
  let gaps = 0;
  for (const line of lines) {
    let cur = [];
    for (const p of line) {
      const prev = cur[cur.length - 1];
      if (prev && dist(prev, p) > GAP_M) {
        if (cur.length > 1) solid.push(cur);
        estimated.push((gaps++ < MAX_GAPS && await road(prev, p)) || [prev, p]);
        cur = [];
      }
      cur.push(p);
    }
    if (cur.length > 1) solid.push(cur);
  }
  return { solid, estimated };
}
