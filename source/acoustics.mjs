/**
 * Approximate airborne room acoustics, in metres and octave-band energies.
 *
 * This is a steady-state engineering comparison model, not a wave solver or a
 * prediction of a measured Korean dwelling. Direct sound uses physical wall and
 * opening intersections. Reverberant sound uses a seven-room diffuse energy
 * balance, including transmission through openings even without line of sight.
 * Ceilings remain present acoustically in every visual cutaway mode.
 *
 * Source level is free-field dBA at 1 m from an omnidirectional point source.
 * Below 0.25 m distance is held at 0.25 m (unresolved near field). No phase,
 * modal resonances, diffraction edges, structure-borne/flanking paths, door
 * undercuts, or measured airtightness are represented. Surface absorption and
 * partition transmission loss are deliberately separate model inputs.
 *
 * References and provenance:
 * - A weights: ASHRAE Fundamentals, Ch. 8, Sound and Vibration.
 *   https://handbook.ashrae.org/handbooks/F21/IP/F21_Ch08/F21_Ch08_ip.aspx
 * - Masonry and hollow door proxy TL: UFC 3-450-01 (2022), Tables C-8/C-13.
 *   https://nibs-s3-wbdg3-production.s3.us-east-1.amazonaws.com/FFC/DOD/UFC/ufc_3_450_01_2022.pdf
 * - Low-absorption hard finish proxy: pyroomacoustics hard_surface database.
 *   https://github.com/LCAV/pyroomacoustics/blob/master/pyroomacoustics/data/materials.json
 * - Direct + diffuse field / room constant:
 *   https://strutt.arup.com/help/Building_Acoustics/Lw2LpR.htm
 *
 * Ordinary Korean silk wallpaper is PVC-coated paper, not acoustic silk fabric.
 * Its absorption table below is a hard-surface proxy, NOT product test data.
 * Lightweight/glass/furnishing coefficients are explicit comparison assumptions.
 */

export const BANDS = Object.freeze([125, 250, 500, 1000, 2000, 4000, 8000]);
export const A_WEIGHTING = Object.freeze([-16.1, -8.6, -3.2, 0, 1.2, 1, -1.1]);
const A_ENERGY = A_WEIGHTING.map(db => 10 ** (db / 10));
const EPSILON = 1e-7;
const MIN_DISTANCE = 0.25;
const C = 343;
const FOUR_PI = 4 * Math.PI;

export const MATERIALS = Object.freeze({
  wallpaper: {
    label: '실크벽지 · PVC 코팅 · 단단한 바탕면',
    absorption: [0.02, 0.02, 0.03, 0.03, 0.04, 0.05, 0.05],
    provenance: 'hard_surface 대용값 · 해당 벽지 제품의 측정값 아님',
  },
  ceiling: {
    label: '벽지 마감 천장',
    absorption: [0.02, 0.02, 0.03, 0.03, 0.04, 0.05, 0.05],
    provenance: '단단한 벽지 바탕면 대용값',
  },
  floor: {
    label: '단단한 주거 바닥',
    absorption: [0.02, 0.03, 0.03, 0.04, 0.04, 0.05, 0.05],
    provenance: '비교용 가정값',
  },
  tile: {
    label: '욕실 타일',
    absorption: [0.01, 0.01, 0.01, 0.02, 0.02, 0.02, 0.02],
    provenance: '단단한 타일 비교용 가정값',
  },
  glass: {
    label: '일반 유리 창호',
    absorption: [0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03],
    transmissionLoss: [18, 21, 25, 29, 30, 27, 32],
    provenance: '단판 유리·프레임을 단순화한 비교용 가정값 · 제품 등급 아님',
  },
  door: {
    label: '일반 실내 목문',
    absorption: [0.06, 0.06, 0.06, 0.06, 0.06, 0.06, 0.06],
    transmissionLoss: [12, 17, 18, 19, 22, 30, 35],
    provenance: 'UFC 속 빈 목문 대용 차음값 · 틈새별 실측 아님',
  },
  furnishings: {
    label: '생활 집기 추가 흡음',
    equivalentAbsorptionPerFloorM2: [0.05, 0.08, 0.15, 0.20, 0.25, 0.25, 0.20],
    provenance: '바닥면적당 추가 등가흡음면적 가정 · 개별 가구 측정값 아님',
  },
});

export const WALL_PROFILES = Object.freeze({
  masonry: {
    label: '약 200mm 조적·콘크리트 가정',
    transmissionLoss: [37, 41, 45, 49, 53, 57, 61],
    provenance: 'UFC 8인치 고밀도 벽체 설계용 대용값 · 실제 벽체 미확인',
  },
  lightweight: {
    label: '차음이 낮은 경량벽 가정',
    transmissionLoss: [15, 20, 25, 30, 34, 38, 40],
    provenance: '민감도 비교용 가정값 · 특정 석고보드 벽체 성적서 아님',
  },
});

export const SOURCE_PRESETS = Object.freeze({
  quiet: { label: '작은 목소리', type: 'voice', level: 45, pitch: 160 },
  conversation: { label: '보통 대화', type: 'voice', level: 60, pitch: 160 },
  raised: { label: '큰 목소리', type: 'voice', level: 72, pitch: 160 },
  shout: { label: '고함', type: 'voice', level: 85, pitch: 160 },
});

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const energyToDb = energy => 10 * Math.log10(Math.max(energy, 1e-30));
const dbToEnergy = db => 10 ** (db / 10);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export function aWeightedLevel(bandsDb) {
  return energyToDb(bandsDb.reduce((sum, db, i) => sum + dbToEnergy(db) * A_ENERGY[i], 0));
}

/** Exact free-field spherical divergence for the model's 1 m reference. */
export function freeFieldLevel(levelAtOneMetre, metres) {
  return levelAtOneMetre - 20 * Math.log10(Math.max(MIN_DISTANCE, metres));
}

/** Solid angle of an axis-aligned wall rectangle as seen from a point (sr).
 * Exact area integration avoids a midpoint inverse-square singularity next to
 * a large window; one planar face can subtend at most one hemisphere (2π).
 */
export function rectangleSolidAngle(patch, point) {
  const d = Math.max(1e-12, Math.abs(point[patch.axis] - patch.k));
  const spanAxis = patch.axis === 'x' ? 'z' : 'x';
  const u0 = patch.lo - point[spanAxis], u1 = patch.hi - point[spanAxis];
  const v0 = patch.bottom - point.y, v1 = patch.top - point.y;
  const F = (u, v) => Math.atan2(u * v, d * Math.hypot(d, u, v));
  return clamp(Math.abs(F(u1, v1) - F(u0, v1) - F(u1, v0) + F(u0, v0)), 0, 2 * Math.PI);
}

function normalSource(source = {}) {
  return {
    x: finite(source.x, 0), y: finite(source.y, 1.5), z: finite(source.z, 0),
    level: clamp(finite(source.level, 60), 20, 110),
    pitch: clamp(finite(source.pitch, 160), 80, 400),
    type: ['voice', 'pink', 'white', 'tone'].includes(source.type) ? source.type : 'voice',
    frequency: clamp(finite(source.frequency, 500), 125, 8000),
  };
}

// Smooth octave filter approximation prevents discontinuities when F0 crosses
// an octave edge. Formants stay fixed while harmonic spacing follows F0.
function distributeFrequency(energies, frequency, energy) {
  // The displayed model covers the 125 Hz to 8 kHz octave bands. A very low
  // fundamental below the first band's lower edge is omitted, not spuriously
  // moved into 125 Hz. Higher harmonics still represent low-pitched voices.
  if (frequency < BANDS[0] / Math.SQRT2 || frequency > BANDS.at(-1) * Math.SQRT2) return;
  const bandPosition = Math.log2(frequency / BANDS[0]);
  if (bandPosition <= 0) { energies[0] += energy; return; }
  if (bandPosition >= BANDS.length - 1) { energies[BANDS.length - 1] += energy; return; }
  const lower = Math.floor(bandPosition), fraction = bandPosition - lower;
  energies[lower] += energy * (1 - fraction);
  energies[lower + 1] += energy * fraction;
}

function sourceEnergies(source) {
  const s = normalSource(source);
  const energies = BANDS.map(() => 0);
  if (s.type === 'pink') energies.fill(1);
  else if (s.type === 'white') BANDS.forEach((f, i) => { energies[i] = f; });
  else if (s.type === 'tone') distributeFrequency(energies, s.frequency, 1);
  else {
    // Synthetic voiced speech: harmonics + fixed vocal-tract resonances and a
    // modest unvoiced tail. Not a recording, measured speaker, or ITU P.50 match.
    for (let harmonic = 1; harmonic * s.pitch <= 11000; harmonic++) {
      const f = harmonic * s.pitch;
      const gaussian = (center, width) => Math.exp(-0.5 * (Math.log(f / center) / width) ** 2);
      const vocalTract = 0.3 + 5 * gaussian(550, 0.26) + 2.6 * gaussian(1500, 0.18)
        + 1.5 * gaussian(2600, 0.15) + 0.6 * gaussian(3600, 0.14);
      distributeFrequency(energies, f, vocalTract / harmonic ** 2.4);
    }
    const total = energies.reduce((sum, e) => sum + e, 0);
    [0, 0.005, 0.01, 0.015, 0.025, 0.02, 0.005].forEach((share, i) => {
      energies[i] += total * share;
    });
  }
  const weighted = energies.reduce((sum, e, i) => sum + e * A_ENERGY[i], 0);
  const multiplier = dbToEnergy(s.level) / Math.max(weighted, 1e-30);
  return energies.map(e => e * multiplier);
}

/** Unweighted octave SPLs normalized to the selected free-field dBA at 1 m. */
export function sourceSpectrum(source) { return sourceEnergies(source).map(energyToDb); }

function pointInPolygon(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, az] = polygon[i], [bx, bz] = polygon[j];
    if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) inside = !inside;
  }
  return inside;
}

function polygonMetrics(polygon) {
  let doubleArea = 0, perimeter = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    doubleArea += a[0] * b[1] - b[0] * a[1];
    perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return { area: Math.abs(doubleArea) / 2, perimeter };
}

function gaussianSolve(matrix, rhs) {
  const n = rhs.length, a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = a[col][col];
    if (Math.abs(divisor) < 1e-12) throw new Error('음향 에너지 행렬이 특이합니다.');
    for (let k = col; k <= n; k++) a[col][k] /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const scale = a[row][col];
      for (let k = col; k <= n; k++) a[row][k] -= scale * a[col][k];
    }
  }
  return a.map(row => Math.max(0, row[n]));
}

export function createAcousticModel(data) {
  const wallHeight = finite(data.wallHeightM, 2.3);
  const rooms = data.rooms.map(room => {
    const metrics = polygonMetrics(room.poly);
    return { ...room, ...metrics, volume: metrics.area * wallHeight, wallHeight };
  });
  const roomAt = (x, z) => rooms.find(room => pointInPolygon(x, z, room.poly)) || null;
  const interiors = rooms.filter(room => room.kind !== 'exterior');
  const roomIndex = new Map(interiors.map((room, i) => [room.id, i]));
  const points = rooms.flatMap(room => room.poly);
  const bounds = {
    minX: Math.min(...points.map(p => p[0])), maxX: Math.max(...points.map(p => p[0])),
    minZ: Math.min(...points.map(p => p[1])), maxZ: Math.max(...points.map(p => p[1])),
  };

  function isPositionValid(point) {
    if (![point?.x, point?.y, point?.z].every(Number.isFinite)) return false;
    const room = roomAt(point.x, point.z);
    return !!room && point.y >= 0.05 && point.y <= wallHeight - 0.05;
  }

  const barriers = (data.objects || []).filter(o => o.wall && o.shape === 'box').map(o => {
    // Tiny jamb strips can be shorter than wall thickness. Their associated
    // opening identifies the wall plane more reliably than the smaller extent.
    const associatedOpening = (data.openings || []).find(opening => opening.label === o.label
      && Math.abs(o.p[opening.axis === 'x' ? 0 : 2] - opening.k) < 0.001);
    const axis = associatedOpening?.axis || (o.s[0] <= o.s[2] ? 'x' : 'z');
    const normal = axis === 'x' ? 0 : 2, span = axis === 'x' ? 2 : 0;
    return {
      id: o.id, label: o.label, type: 'wall', axis, k: o.p[normal],
      lo: o.p[span] - o.s[span] / 2, hi: o.p[span] + o.s[span] / 2,
      bottom: Math.max(0, o.p[1] - o.s[1] / 2), top: Math.min(wallHeight, o.p[1] + o.s[1] / 2),
      thickness: o.s[normal],
    };
  });

  function adjacentRooms(patch, spanPosition = (patch.lo + patch.hi) / 2) {
    const offset = (patch.thickness || 0.2) / 2 + 0.015;
    return [-1, 1].map(sign => {
      const x = patch.axis === 'x' ? patch.k + sign * offset : spanPosition;
      const z = patch.axis === 'z' ? patch.k + sign * offset : spanPosition;
      return roomAt(x, z);
    });
  }

  const openings = (data.openings || []).map((o, index) => {
    const bottom = Math.max(0, o.sill), top = Math.min(wallHeight, o.head);
    const mid = (o.lo + o.hi) / 2;
    const patch = {
      ...o, id: `opening-${index}`, index, type: o.kind === 'door' ? 'door' : 'glass',
      bottom, top, thickness: 0.2, isDoor: o.kind === 'door' || o.kind === 'glassDoor' || o.sill < 0.1,
      canOpen: true,
      center: { x: o.axis === 'x' ? o.k : mid, y: (bottom + top) / 2, z: o.axis === 'z' ? o.k : mid },
    };
    patch.roomIds = adjacentRooms(patch).map(room => room?.id || null);
    return patch;
  });

  // Split long wall faces where their adjacent room changes. This gives each
  // shared partition area to exactly one room pair, including nonrectangular
  // living room and wall strips above/below windows.
  const patches = [];
  for (const patch of [...barriers, ...openings]) {
    const dim = patch.axis === 'x' ? 1 : 0;
    const splits = [...new Set([patch.lo, patch.hi, ...points.map(p => p[dim]).filter(v => v > patch.lo + EPSILON && v < patch.hi - EPSILON)])].sort((a, b) => a - b);
    for (let i = 0; i < splits.length - 1; i++) {
      const lo = splits[i], hi = splits[i + 1];
      if (hi - lo < EPSILON || patch.top - patch.bottom < EPSILON) continue;
      const adjacent = adjacentRooms(patch, (lo + hi) / 2);
      if (!adjacent.some(room => room && room.kind !== 'exterior')) continue;
      patches.push({
        ...patch, lo, hi, area: (hi - lo) * (patch.top - patch.bottom),
        roomIds: adjacent.map(room => room?.id || null),
        indices: adjacent.map(room => roomIndex.get(room?.id) ?? -1),
        center: { x: patch.axis === 'x' ? patch.k : (lo + hi) / 2, y: (patch.bottom + patch.top) / 2, z: patch.axis === 'z' ? patch.k : (lo + hi) / 2 },
      });
    }
  }

  const rayPatches = [...barriers, ...openings];
  function normalSettings(settings = {}) {
    const doorStates = Object.fromEntries(openings.map(opening => {
      const state = settings.doorStates?.[opening.id] ?? settings.doorStates?.[opening.index] ?? false;
      const fraction = state === true || state === 'open' ? 1 : clamp(finite(state, 0), 0, 1);
      return [opening.id, fraction];
    }));
    return {
      wallProfile: WALL_PROFILES[settings.wallProfile] ? settings.wallProfile : 'masonry',
      doorStates, furnished: settings.furnished !== false,
      background: settings.background === null || settings.background === false ? null : clamp(finite(settings.background, 30), 0, 80),
      reverberation: settings.reverberation !== false,
    };
  }

  function transmission(patch, settings) {
    const cached = settings.transmissionById?.get(patch.id);
    if (cached) return cached;
    const loss = patch.type === 'wall' ? WALL_PROFILES[settings.wallProfile].transmissionLoss : MATERIALS[patch.type].transmissionLoss;
    const openness = patch.type === 'wall' ? 0 : settings.doorStates[patch.id] || 0;
    return loss.map(db => openness + (1 - openness) * dbToEnergy(-db));
  }

  function trace(from, to, settings, wantCrossings = false) {
    const energies = BANDS.map(() => 1), crossings = [], hits = [];
    for (const patch of rayPatches) {
      const delta = to[patch.axis] - from[patch.axis];
      if (Math.abs(delta) < EPSILON) continue;
      const t = (patch.k - from[patch.axis]) / delta;
      if (t <= EPSILON || t >= 1 - EPSILON) continue;
      const spanAxis = patch.axis === 'x' ? 'z' : 'x';
      const span = from[spanAxis] + t * (to[spanAxis] - from[spanAxis]);
      const y = from.y + t * (to.y - from.y);
      if (span < patch.lo - EPSILON || span > patch.hi + EPSILON || y < patch.bottom - EPSILON || y > patch.top + EPSILON) continue;
      hits.push({ patch, t });
    }
    hits.sort((a, b) => a.t - b.t || (a.patch.type === 'wall' ? -1 : 1));
    const seen = new Set();
    for (const { patch } of hits) {
      // Joined rectangles and opening edge seams are one physical wall crossing.
      const key = `${patch.axis}:${patch.k.toFixed(5)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const tau = transmission(patch, settings);
      tau.forEach((value, i) => { energies[i] *= value; });
      if (wantCrossings) crossings.push({ id: patch.id, label: patch.label, type: patch.type, lossDb: tau.map(value => -energyToDb(value)) });
    }
    return { energies, crossings };
  }

  let cacheKey = '', cache = null;
  function prepare(sourceInput, settingsInput) {
    const source = normalSource(sourceInput), settings = normalSettings(settingsInput);
    if (!isPositionValid(source)) throw new RangeError('소음원을 바닥 영역 안, 천장 아래에 배치하세요.');
    const key = JSON.stringify([source, settings]);
    if (key === cacheKey) return cache;
    settings.transmissionById = new Map(rayPatches.map(patch => [patch.id, transmission(patch, settings)]));
    const sourceRoom = roomAt(source.x, source.z);
    const sourceIndex = roomIndex.get(sourceRoom.id) ?? -1;
    const sourceBands = sourceEnergies(source);
    const n = interiors.length;
    const absorption = interiors.map(room => BANDS.map((_, b) => {
      const wet = room.id === 'room3' || /욕실|bathroom/i.test(room.name);
      const wallAlpha = wet ? MATERIALS.tile.absorption[b] : MATERIALS.wallpaper.absorption[b];
      const floorAlpha = wet ? MATERIALS.tile.absorption[b] : MATERIALS.floor.absorption[b];
      let area = room.perimeter * wallHeight * wallAlpha
        + room.area * (floorAlpha + MATERIALS.ceiling.absorption[b]);
      if (settings.furnished && !wet) area += room.area * MATERIALS.furnishings.equivalentAbsorptionPerFloorM2[b];
      return area;
    }));
    const transmissions = patches.map(patch => transmission(patch, settings));
    patches.forEach(patch => {
      if (patch.type === 'wall') return;
      const openness = settings.doorStates[patch.id] || 0;
      for (const index of patch.indices) {
        if (index < 0) continue;
        const room = interiors[index], wet = room.id === 'room3' || /욕실|bathroom/i.test(room.name);
        BANDS.forEach((_, b) => {
          const baseAlpha = wet ? MATERIALS.tile.absorption[b] : MATERIALS.wallpaper.absorption[b];
          absorption[index][b] += patch.area * ((1 - openness) * MATERIALS[patch.type].absorption[b] - baseAlpha);
        });
      }
    });
    const averages = interiors.map((room, i) => BANDS.map((_, b) => clamp(absorption[i][b] / (2 * room.area + room.perimeter * wallHeight), 0, 0.95)));
    const diffuse = interiors.map(() => BANDS.map(() => 0));
    const rt60 = interiors.map(() => BANDS.map(() => 0));
    const exteriorPatches = patches.map((patch, i) => ({ patch, tau: transmissions[i] })).filter(({ patch }) => patch.indices.filter(i => i >= 0).length === 1);
    if (settings.reverberation && n > 0) {
      for (let b = 0; b < BANDS.length; b++) {
        const matrix = interiors.map((_, i) => interiors.map((__, j) => i === j ? Math.max(0.001, absorption[i][b]) : 0));
        const rhs = interiors.map(() => 0);
        patches.forEach((patch, p) => {
          const [i, j] = patch.indices, transfer = patch.area * transmissions[p][b];
          if (i === j) return;
          if (i >= 0) matrix[i][i] += transfer;
          if (j >= 0) matrix[j][j] += transfer;
          if (i >= 0 && j >= 0 && i !== j) { matrix[i][j] -= transfer; matrix[j][i] -= transfer; }
        });
        if (sourceIndex >= 0) rhs[sourceIndex] = 4 * FOUR_PI * sourceBands[b] * (1 - averages[sourceIndex][b]);
        else {
          // Outdoor source power crossing a facade enters that room's diffuse
          // balance; no fictitious enclosed "garden reverberation" is created.
          for (const { patch, tau } of exteriorPatches) {
            const index = patch.indices.find(i => i >= 0);
            const outsideSign = patch.indices[0] >= 0 ? 1 : -1;
            const signedDistance = (source[patch.axis] - patch.k) * outsideSign;
            if (signedDistance <= 0) continue;
            const outside = { ...patch.center, [patch.axis]: patch.k + outsideSign * (patch.thickness / 2 + 0.015) };
            const incidentTau = trace(source, outside, settings).energies[b];
            const solidAngle = rectangleSolidAngle(patch, source);
            rhs[index] += 4 * sourceBands[b] * solidAngle * tau[b] * incidentTau * (1 - averages[index][b]);
          }
          // Approximate visibility is sampled at patch centres. Bound any
          // overlapping angular contributions by the source's radiated power.
          const injected = rhs.reduce((sum, value) => sum + value, 0);
          const available = 4 * FOUR_PI * sourceBands[b];
          if (injected > available) rhs.forEach((value, i) => { rhs[i] = value * available / injected; });
        }
        const solution = gaussianSolve(matrix, rhs);
        interiors.forEach((room, i) => {
          diffuse[i][b] = solution[i];
          // Local Sabine decay with neighbouring rooms/outdoors treated as sinks.
          // Coupled-room late decay can differ; this is labelled a local estimate.
          rt60[i][b] = 24 * Math.log(10) / C * room.volume / Math.max(0.001, matrix[i][i]);
        });
      }
    }
    cacheKey = key;
    cache = { source, settings, sourceRoom, sourceIndex, sourceBands, diffuse, rt60, exteriorPatches };
    return cache;
  }

  function evaluatePrepared(prepared, receiver, detail = true) {
    if (!isPositionValid(receiver)) throw new RangeError('청취점을 바닥 영역 안, 천장 아래에 배치하세요.');
    const { source, settings, sourceBands, diffuse, rt60, exteriorPatches } = prepared;
    const receiverRoom = roomAt(receiver.x, receiver.z), receiverIndex = roomIndex.get(receiverRoom.id) ?? -1;
    const r = distance(source, receiver), effectiveR = Math.max(MIN_DISTANCE, r);
    const path = trace(source, receiver, settings, detail);
    const direct = sourceBands.map((value, b) => value / (effectiveR * effectiveR) * path.energies[b]);
    const reverberant = receiverIndex >= 0 ? [...diffuse[receiverIndex]] : BANDS.map(() => 0);
    if (receiverIndex < 0 && settings.reverberation) {
      // Facade radiation into outdoor half-space, attenuated by other barriers.
      for (const { patch, tau } of exteriorPatches) {
        const index = patch.indices.find(i => i >= 0), outsideSign = patch.indices[0] >= 0 ? 1 : -1;
        if ((receiver[patch.axis] - patch.k) * outsideSign <= 0) continue;
        const outside = { ...patch.center, [patch.axis]: patch.k + outsideSign * (patch.thickness / 2 + 0.015) };
        const visibility = trace(outside, receiver, settings).energies;
        const solidAngle = rectangleSolidAngle(patch, receiver);
        // Diffuse aperture radiance: E_out = E_room * tau * Ω / (4π).
        // Solid-angle integration is bounded at the facade and approaches a
        // cosine-directive radiator in the far field, rather than a point spike.
        for (let b = 0; b < BANDS.length; b++) reverberant[b] += diffuse[index][b] * tau[b] * visibility[b] * solidAngle / FOUR_PI;
      }
    }
    const sourceOnly = direct.map((e, b) => e + reverberant[b]);
    const backgroundPerBand = settings.background === null ? 0 : dbToEnergy(settings.background) / A_ENERGY.reduce((sum, e) => sum + e, 0);
    const backgroundBands = BANDS.map(() => backgroundPerBand);
    const total = sourceOnly.map((e, b) => e + backgroundBands[b]);
    const weighted = energies => energyToDb(energies.reduce((sum, e, b) => sum + e * A_ENERGY[b], 0));
    const result = {
      levelDbA: weighted(total), sourceOnlyDbA: weighted(sourceOnly),
      directDbA: weighted(direct), reverberantDbA: weighted(reverberant),
      distance: r, roomId: receiverRoom.id,
      rt60: receiverIndex < 0 ? null : [...rt60[receiverIndex]],
    };
    if (detail) Object.assign(result, {
      bandsDb: total.map(energyToDb), sourceOnlyBandsDb: sourceOnly.map(energyToDb),
      sourceBandsDb: sourceBands.map(energyToDb),
      directBandsDb: direct.map(energyToDb), reverberantBandsDb: reverberant.map(energyToDb),
      crossings: path.crossings, nearFieldLimited: r < MIN_DISTANCE,
    });
    return result;
  }

  function evaluate(source, receiver, settings = {}) {
    return evaluatePrepared(prepare(source, settings), receiver);
  }

  function sampleGrid(source, settings = {}, options = {}) {
    const step = clamp(finite(options.step, 0.18), 0.08, 1);
    const height = clamp(finite(options.height, 1.2), 0.05, wallHeight - 0.05);
    const prepared = prepare(source, settings), cells = [];
    for (let z = bounds.minZ + step / 2; z < bounds.maxZ; z += step) {
      for (let x = bounds.minX + step / 2; x < bounds.maxX; x += step) {
        if (!roomAt(x, z)) continue;
        const receiver = { x, y: height, z };
        const result = evaluatePrepared(prepared, receiver, false);
        cells.push({ x, z, roomId: result.roomId, levelDbA: result.levelDbA, sourceOnlyDbA: result.sourceOnlyDbA });
      }
    }
    return { cells, step, height, bounds: { ...bounds } };
  }

  function roomSummary(source, settings = {}, height = 1.2) {
    const prepared = prepare(source, settings);
    return rooms.map(room => {
      const receiver = { x: room.center[0], y: clamp(height, 0.05, wallHeight - 0.05), z: room.center[1] };
      const result = evaluatePrepared(prepared, receiver, false);
      return { id: room.id, name: room.name, x: receiver.x, z: receiver.z, ...result };
    });
  }

  return { rooms, barriers, openings, bounds, wallHeight, roomAt, isPositionValid, evaluate, sampleGrid, roomSummary };
}
