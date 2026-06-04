const CITY_GEO = {
  kokrajhar: [26.4012, 90.2715],
  jorhat: [26.7509, 94.2037],
  vijayapura: [16.8302, 75.71],
  raichur: [16.2076, 77.3463],
  tuni: [17.3556, 82.5511],
  rajamahendravaram: [17.0005, 81.804],
  rajahmundry: [17.0005, 81.804],
  kannauj: [27.0556, 79.917],
  hardoi: [27.3953, 80.131],
  kanchipuram: [12.8342, 79.7036],
  varanasi: [25.3176, 82.9739],
  meerut: [28.9845, 77.7064],
  khatauli: [29.2806, 77.725],
  bijoypur: [22.5726, 88.3639],
  kolkata: [22.5726, 88.3639],
  chennai: [13.0827, 80.2707],
  bangalore: [12.9716, 77.5946],
  bengaluru: [12.9716, 77.5946],
  mumbai: [19.076, 72.8777],
  delhi: [28.7041, 77.1025],
  hyderabad: [17.385, 78.4867],
  secunderabad: [17.4399, 78.4983],
  nalgonda: [17.0575, 79.2707],
  miryalaguda: [16.8722, 79.5625],
  warangal: [17.9689, 79.5941],
  gonda: [27.1335, 81.9619],
  pune: [18.5204, 73.8567],
  ahmedabad: [23.0225, 72.5714],
  kochi: [9.9312, 76.2673],
  coimbatore: [11.0168, 76.9558],
  lucknow: [26.8467, 80.9462],
  jaipur: [26.9124, 75.7873],
  patna: [25.5941, 85.1376],
  guwahati: [26.1445, 91.7362],
  bhubaneswar: [20.2961, 85.8245],
  visakhapatnam: [17.6868, 83.2185],
  vizag: [17.6868, 83.2185],
  indore: [22.7196, 75.8577],
  bhopal: [23.2599, 77.4126],
  nagpur: [21.1458, 79.0882],
  surat: [21.1702, 72.8311],
  vadodara: [22.3072, 73.1812],
  agra: [27.1767, 78.0081],
  kanpur: [26.4499, 80.3319],
  allahabad: [25.4358, 81.8463],
  prayagraj: [25.4358, 81.8463],
  thane: [19.2183, 72.9781],
  nashik: [19.9975, 73.7898],
  mangalore: [12.9141, 74.856],
  mysore: [12.2958, 76.6394],
  mysuru: [12.2958, 76.6394],
  thiruvananthapuram: [8.5241, 76.9366],
  trivandrum: [8.5241, 76.9366],
  madurai: [9.9252, 78.1198],
  tiruchirapalli: [10.7905, 78.7047],
  salem: [11.6643, 78.146],
  erode: [11.341, 77.7172],
  tirupati: [13.6288, 79.4192],
  guntur: [16.3067, 80.4365],
  vellore: [12.9165, 79.1325],
  kadapa: [14.4673, 78.8242],
  kurnool: [15.8281, 78.0373],
  nizamabad: [18.6725, 78.0941],
  nandyal: [15.4778, 78.4836],
  nuzvid: [16.7867, 80.8456],
  belgaum: [15.8497, 74.4977],
  kolhapur: [16.705, 74.2433],
  rajkot: [22.3039, 70.8022],
  bilaspur: [22.0797, 82.1409],
  kota: [25.2138, 75.8648],
  alwar: [27.553, 76.6346],
  bhilwara: [25.3463, 74.6364],
  bikaner: [28.0229, 73.3119],
  etawah: [26.7855, 79.015],
  buldhana: [20.5292, 76.1842],
  wardha: [20.7453, 78.6022],
  durg: [21.19, 81.2849],
  sahibganj: [25.2503, 87.6428],
  kangeyam: [11.0067, 77.5614],
  karur: [10.9601, 78.0766],
  perambalur: [11.2333, 78.8833],
  tindivanam: [12.24, 79.65],
  oddanchatram: [10.49, 77.735],
};

function deg2rad(d) {
  return (d * Math.PI) / 180;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizeCityKey(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '');
}

/** Exact / token lookup only — avoids "Nalgonda" matching "Gonda" (UP). */
function resolveCityCoords(name) {
  if (!name) return null;
  const raw = String(name).trim();
  const compact = normalizeCityKey(raw).replace(/\s/g, '');
  if (CITY_GEO[compact]) return { lat: CITY_GEO[compact][0], lng: CITY_GEO[compact][1] };
  const spaced = normalizeCityKey(raw);
  if (CITY_GEO[spaced]) return { lat: CITY_GEO[spaced][0], lng: CITY_GEO[spaced][1] };
  const tokens = raw
    .toLowerCase()
    .split(/[\s,/()\-]+/)
    .map((t) => normalizeCityKey(t).replace(/\s/g, ''))
    .filter((t) => t.length >= 3)
    .sort((a, b) => b.length - a.length);
  for (const t of tokens) {
    if (CITY_GEO[t]) return { lat: CITY_GEO[t][0], lng: CITY_GEO[t][1] };
  }
  return null;
}

function nearestCityName(lat, lng) {
  let best = null;
  let bestDist = Infinity;
  for (const [city, coords] of Object.entries(CITY_GEO)) {
    const d = haversineKm(lat, lng, coords[0], coords[1]);
    if (d < bestDist) {
      bestDist = d;
      best = city;
    }
  }
  if (bestDist > 80) return null;
  return best.charAt(0).toUpperCase() + best.slice(1);
}

module.exports = { CITY_GEO, haversineKm, resolveCityCoords, nearestCityName };
