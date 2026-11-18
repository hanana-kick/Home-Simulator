/**
 * Three-dimensional, time-domain, linear acoustic finite-volume solver.
 * Pressure is in Pa, face particle velocity in m/s, and source Q in m³/s.
 *
 * dp/dt = -rho*c² div(u) + rho*c² Q/V
 * (rho*h + m') du/dt + R*u = p_left - p_right
 *
 * Pressure and velocity are staggered in time. Resistive sheets and locally
 * reactive boundary admittances use a trapezoidal passive update. Every face
 * flux enters its two cells with opposite signs; a sheet REPLACES an air face.
 * The entire CAD interior and the assumed adjoining room are discretized.
 * Walls are zero-thickness acoustic mass sheets between their actual two air
 * faces, not elastic solids. Their structural bending/flanking are not solved.
 *
 * Normal-incidence sheet reference: t=2*rho*c/(2*rho*c+R+i*omega*m').
 * The real wall admittance is derived from r=+sqrt(1-alpha). Alpha therefore
 * denotes a NORMAL-incidence proxy, not a measured random-incidence wallpaper
 * coefficient. On transmitting walls it is a passive parallel loss model.
 * Boundary discretization background: Toyoda et al., AST 39 (2018), 336–341,
 * https://www.jstage.jst.go.jp/article/ast/39/5/39_E1806/_pdf
 *
 * The resolved bandwidth is c/(10*max(dx,dy,dz)), a dispersion target, not an
 * exact accuracy guarantee. Source filtering precedes simulation and NEVER
 * restores removed high-frequency energy. Output SPL is unweighted low-band
 * early-response RMS, not full-band dBA, steady LAeq, RT60, or a legal rating.
 */
import { prepareAudioWaveform } from './wave-audio.mjs';

export const WAVE_PHYSICS = Object.freeze({ rho: 1.21, c: 343, referencePressure: 20e-6 });
const { rho: RHO, c: C, referencePressure: P0 } = WAVE_PHYSICS;
const K = RHO * C * C;
const Z0 = RHO * C;
const EPS = 1e-8;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const finite = (x, fallback) => Number.isFinite(Number(x)) ? Number(x) : fallback;
const spl = rms => rms > 0 ? 20 * Math.log10(rms / P0) : null;

export const WAVE_DEFAULTS = Object.freeze({
  dx: .10, duration: .3, sliceY: 1.2, neighborDepth: 3,
  partitionMass: 400, partitionResistance: 400, wallAlpha: .03,
  sourceMode: 'conversation', toneFrequency: 125,
});

export function waveNumerics(config = {}, wallHeight = 2.3) {
  const dx = clamp(finite(config.dx, WAVE_DEFAULTS.dx), .05, .25);
  const dz = dx;
  const ny = Math.ceil(wallHeight / dx - 1e-9);
  const dy = wallHeight / ny;
  const dt = .9 / (C * Math.sqrt(1 / dx ** 2 + 1 / dy ** 2 + 1 / dz ** 2));
  return { dx, dy, dz, dt, sampleRate: 1 / dt, cutoffHz: C / (10 * Math.max(dx, dy, dz)), ny };
}

/** Locally reactive, positive-real shunt, per square metre. */
export function boundaryAdmittance(alpha) {
  const r = Math.sqrt(1 - clamp(alpha, 0, 1));
  return (1 - r) / (Z0 * (1 + r));
}

/**
 * General full-cell finite-volume kernel, also exposed for independent physics
 * benchmarks. faces = {a,b,area,length,mass?,resistance?}; length is the sum of
 * the two AIR half-cell lengths, excluding solid sheet thickness. Boundary
 * admittance is sum(area/Z) per cell. No pressure or velocity normalization.
 */
export function createPressureCore({ cellCount, volume, faces, boundary = [], dt, initialPressure, initialVelocity }) {
  if (!(cellCount > 0 && volume > 0 && dt > 0)) throw new Error('Invalid wave grid.');
  const count = faces.length;
  const p = new Float64Array(cellCount), u = new Float64Array(count), flux = new Float64Array(cellCount);
  const rmsSum = new Float64Array(cellCount);
  const a = new Int32Array(count), b = new Int32Array(count);
  const velocityDecay = new Float64Array(count), velocityDrive = new Float64Array(count);
  const pressureDrive = new Float64Array(count), kineticWeight = new Float64Array(count);
  const pressureDecay = new Float64Array(cellCount), pressureInverse = new Float64Array(cellCount);
  const stiffness = new Float64Array(cellCount);
  for (let i = 0; i < count; i++) {
    const face = faces[i];
    if (!(face.a >= 0 && face.a < cellCount && face.b >= 0 && face.b < cellCount && face.a !== face.b && face.area > 0 && face.length > 0 && (face.mass ?? 0) >= 0 && (face.resistance ?? 0) >= 0)) throw new Error('Invalid passive face.');
    a[i] = face.a; b[i] = face.b;
    const mass = RHO * face.length + (face.mass || 0), resistance = face.resistance || 0;
    const denominator = mass + resistance * dt / 2;
    velocityDecay[i] = (mass - resistance * dt / 2) / denominator;
    velocityDrive[i] = dt / denominator;
    pressureDrive[i] = K * dt * face.area / volume;
    kineticWeight[i] = face.area * mass / 2;
    const g = K * face.area / (volume * mass);
    stiffness[face.a] += g; stiffness[face.b] += g;
  }
  let maxStiffness = 0;
  for (let i = 0; i < cellCount; i++) {
    if ((boundary[i] || 0) < 0) throw new Error('Boundary must be passive.');
    const loss = K * dt * (boundary[i] || 0) / (2 * volume);
    pressureDecay[i] = (1 - loss) / (1 + loss);
    pressureInverse[i] = 1 / (1 + loss);
    maxStiffness = Math.max(maxStiffness, stiffness[i]);
  }
  const maximumDt = maxStiffness > 0 ? Math.sqrt(2 / maxStiffness) : Infinity;
  if (dt > maximumDt * (1 + 1e-8)) throw new Error('CFL stability limit exceeded.');
  if (initialPressure) p.set(initialPressure);
  if (initialVelocity) u.set(initialVelocity);
  let steps = 0;
  const sourceCoefficient = K * dt / volume;
  return {
    pressure: p, velocity: u, rmsSum, dt, maximumDt,
    get steps() { return steps; },
    /** source = {indices, weights, volumeVelocity}. Q is volume velocity. */
    step(source) {
      flux.fill(0);
      for (let i = 0; i < count; i++) {
        const ai = a[i], bi = b[i];
        const velocity = velocityDecay[i] * u[i] + velocityDrive[i] * (p[ai] - p[bi]);
        u[i] = velocity;
        const change = pressureDrive[i] * velocity;
        flux[ai] -= change; flux[bi] += change;
      }
      if (source && source.volumeVelocity) {
        const drive = sourceCoefficient * source.volumeVelocity;
        for (let i = 0; i < source.indices.length; i++) flux[source.indices[i]] += drive * source.weights[i];
      }
      for (let i = 0; i < cellCount; i++) {
        const value = pressureDecay[i] * p[i] + pressureInverse[i] * flux[i];
        p[i] = value;
        rmsSum[i] += value * value;
      }
      steps++;
    },
    energy() {
      let energy = 0;
      for (let i = 0; i < cellCount; i++) energy += volume * p[i] * p[i] / (2 * K);
      for (let i = 0; i < count; i++) energy += kineticWeight[i] * u[i] * u[i];
      return energy;
    },
    /** Conserved leapfrog energy for the lossless unforced graph. */
    modifiedEnergy() {
      let energy = this.energy();
      for (let i = 0; i < count; i++) energy += dt * faces[i].area * u[i] * (p[a[i]] - p[b[i]]) / 2;
      return energy;
    },
  };
}

function inPolygon(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function normalizeConfig(config) {
  return {
    ...WAVE_DEFAULTS, ...config,
    duration: clamp(finite(config?.duration, .3), .15, .5),
    neighborDepth: clamp(finite(config?.neighborDepth, 3), 2, 6),
    partitionMass: clamp(finite(config?.partitionMass, 400), 0, 1000),
    partitionResistance: clamp(finite(config?.partitionResistance, 400), 0, 10000),
    wallAlpha: clamp(finite(config?.wallAlpha, .03), 0, 1),
  };
}

/** Generate a full-band reference before filtering. Synthetic voices are
 * harmonic vowel-like comparisons, not intelligible speech or vocal identity. */
export function createWaveReference(source, config, numerics) {
  const mode = config.sourceMode || 'conversation';
  const duration = config.duration, rate = 24000, count = Math.ceil(duration * rate);
  const level = clamp(finite(source.level, 60), 20, 110);
  const pitch = clamp(finite(source.pitch, mode === 'singing' ? 220 : 160), 60, 800);
  const samples = new Float32Array(count);
  let lowestFrequency = pitch;
  if (mode === 'tone') {
    const frequency = finite(config.toneFrequency, 125);
    if (!(frequency >= 20 && frequency <= numerics.cutoffHz)) throw new Error(`순음은 격자 지원 범위 20–${Math.floor(numerics.cutoffHz)} Hz에서 지정하세요.`);
    lowestFrequency = frequency;
    for (let i = 0; i < count; i++) samples[i] = Math.cos(2 * Math.PI * frequency * i / rate);
  } else if (mode === 'pulse') {
    // Ricker reference pressure has zero integral on the infinite line. The
    // finite filtered record is DC corrected by prepareAudioWaveform as well.
    const f = Math.min(finite(config.toneFrequency, 125), numerics.cutoffHz * .42);
    const center = Math.max(.045, 4 / f);
    for (let i = 0; i < count; i++) {
      const t = Math.PI * f * (i / rate - center);
      samples[i] = (1 - 2 * t * t) * Math.exp(-t * t);
    }
    lowestFrequency = 20;
  } else if (mode === 'pink') {
    // Deterministic multi-sine pink-like reference, with octave-uniform power.
    for (let j = 0; j < 96; j++) {
      const f = 40 * (8000 / 40) ** (j / 95), phase = (j * 2.3999632297) % (2 * Math.PI);
      for (let i = 0; i < count; i++) samples[i] += Math.cos(2 * Math.PI * f * i / rate + phase) / Math.sqrt(96);
    }
    lowestFrequency = 40;
  } else {
    for (let h = 1; h * pitch <= 8000; h++) {
      const f = h * pitch;
      const gaussian = (center, width) => Math.exp(-.5 * (Math.log(f / center) / width) ** 2);
      const tract = .3 + 5 * gaussian(550, .26) + 2.6 * gaussian(1500, .18) + 1.5 * gaussian(2600, .15);
      const amplitude = Math.sqrt(tract / h ** 2.4);
      for (let i = 0; i < count; i++) samples[i] += amplitude * Math.cos(2 * Math.PI * f * i / rate + h * .37);
    }
  }
  const prepared = prepareAudioWaveform(samples, rate, {
    targetRate: numerics.sampleRate, cutoffHz: numerics.cutoffHz, duration, levelDbA: level,
  });
  // A coarse grid can resolve no harmonic at all. Do not turn finite-window
  // spectral skirts into a fictitious audible fundamental in that situation.
  if (lowestFrequency >= numerics.cutoffHz) {
    prepared.samples.fill(0); prepared.lowBandRmsPa = 0; prepared.retainedEnergyFraction = 0;
  }
  return { ...prepared, mode, lowestFrequency, hasResolvedContent: prepared.lowBandRmsPa > 1e-12 };
}

function geometry(data, config, numerics) {
  const rooms = data.rooms.filter(room => room.kind !== 'exterior');
  const height = finite(data.wallHeightM, 2.3);
  const neighbor = { x0: 7.8, x1: 10.3, z0: -.2 - config.neighborDepth, z1: -.2, height };
  const { dx, dy, dz, ny } = numerics;
  const minX = Math.floor((Math.min(...rooms.flatMap(r => r.poly.map(p => p[0]))) - .3 - dx) / dx) * dx;
  const maxX0 = Math.max(...rooms.flatMap(r => r.poly.map(p => p[0]))) + .3 + dx;
  const minZ = Math.floor((neighbor.z0 - dx) / dz) * dz;
  const maxZ0 = Math.max(...rooms.flatMap(r => r.poly.map(p => p[1]))) + .3 + dz;
  const nx = Math.ceil((maxX0 - minX) / dx), nz = Math.ceil((maxZ0 - minZ) / dz);
  const maxX = minX + nx * dx, maxZ = minZ + nz * dz;
  const denseCount = nx * ny * nz;
  if (denseCount > 1500000) throw new Error('격자 크기가 브라우저 계산 한도를 넘었습니다. 격자 간격을 늘리세요.');
  const roomAt = (x, z) => rooms.findIndex(room => inPolygon(x, z, room.poly));
  const openings = (data.openings || []).map((opening, i) => {
    const span = (opening.lo + opening.hi) / 2;
    const p = opening.axis === 'x' ? { x: opening.k, z: span } : { x: span, z: opening.k };
    const a = roomAt(p.x - (opening.axis === 'x' ? .16 : 0), p.z - (opening.axis === 'z' ? .16 : 0));
    const b = roomAt(p.x + (opening.axis === 'x' ? .16 : 0), p.z + (opening.axis === 'z' ? .16 : 0));
    return { ...opening, id: `opening-${i}`, exterior: a < 0 || b < 0 };
  });
  const walls = (data.objects || []).filter(object => ['wallInner', 'wallOuter'].includes(object.group) && object.shape === 'box').map(object => {
    // Short jamb strips can be narrower than wall thickness. Their opening
    // identifies the physical plane even when the smallest extent does not.
    const associatedOpening = openings.find(o => o.label === object.label && Math.abs(object.p[o.axis === 'x' ? 0 : 2] - o.k) < .001);
    const axis = associatedOpening?.axis || (object.s[0] <= object.s[2] ? 'x' : 'z');
    return { axis, k: object.p[axis === 'x' ? 0 : 2], thickness: object.s[axis === 'x' ? 0 : 2],
      lo: object.p[axis === 'x' ? 2 : 0] - object.s[axis === 'x' ? 2 : 0] / 2,
      hi: object.p[axis === 'x' ? 2 : 0] + object.s[axis === 'x' ? 2 : 0] / 2,
      bottom: object.p[1] - object.s[1] / 2, top: object.p[1] + object.s[1] / 2 };
  });
  const index = (ix, iy, iz) => (iy * nz + iz) * nx + ix;
  const ids = new Int32Array(denseCount); ids.fill(-1);
  const denseMask = new Uint8Array(denseCount);
  const cx = [], cy = [], cz = [], owners = [], channels = [], denseIds = [];
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
    const x = minX + (ix + .5) * dx, z = minZ + (iz + .5) * dz;
    let owner = roomAt(x, z);
    const isNeighbor = x > neighbor.x0 - EPS && x < neighbor.x1 - EPS && z > neighbor.z0 - EPS && z < neighbor.z1 - EPS;
    const possibleOpenings = openings.filter(o => {
      const normal = o.axis === 'x' ? x : z, span = o.axis === 'x' ? z : x;
      return span >= o.lo && span < o.hi && Math.abs(normal - o.k) <= .1 + (o.exterior ? dx : .001);
    });
    for (let iy = 0; iy < ny; iy++) {
      const y = (iy + .5) * dy;
      const opening = possibleOpenings.find(o => y >= o.sill && y < o.head);
      const mask = owner >= 0 ? 1 : isNeighbor ? 2 : opening ? 3 : 0;
      if (!mask) continue;
      const dense = index(ix, iy, iz), id = cx.length;
      ids[dense] = id; denseMask[dense] = mask;
      cx.push(ix); cy.push(iy); cz.push(iz); owners.push(owner >= 0 ? owner : isNeighbor ? -2 : -3);
      channels.push(opening || null); denseIds.push(dense);
    }
  }
  return { rooms, neighbor, height, openings, walls, nx, ny, nz, minX, maxX, minZ, maxZ, ids, denseMask, cx, cy, cz, owners, channels, denseIds, index, roomAt };
}

export function createWaveSimulation(data, { source = {}, settings = {}, config: inputConfig = {}, referenceWaveform } = {}) {
  const config = normalizeConfig(inputConfig), height = finite(data.wallHeightM, 2.3);
  const numerics = waveNumerics(config, height), { dx, dy, dz, dt } = numerics;
  const grid = geometry(data, config, numerics), { nx, ny, nz, ids, cx, cy, cz, index } = grid;
  const count = cx.length, volume = dx * dy * dz;
  const positions = id => ({ x: grid.minX + (cx[id] + .5) * dx, y: (cy[id] + .5) * dy, z: grid.minZ + (cz[id] + .5) * dz });
  const actualSource = { x: finite(source.x, 9.05), y: finite(source.y, 1.2), z: finite(source.z, 1.15), level: finite(source.level, 60), pitch: finite(source.pitch, config.sourceMode === 'singing' ? 220 : 160) };
  const sourceRoom = grid.roomAt(actualSource.x, actualSource.z);
  if (sourceRoom < 0 || actualSource.y <= 0 || actualSource.y >= height) throw new Error('음파의 음원은 집 내부의 바닥과 천장 사이에 놓아야 합니다. 마당은 이 3D 계산 영역에 포함하지 않습니다.');
  const faces = [], connected = new Uint8Array(count), boundary = new Float64Array(count);
  const wallY = boundaryAdmittance(config.wallAlpha);
  let sheetFaces = 0, sharedFaces = 0, openingSheetFaces = 0, openFaces = 0;
  const axes = [
    { axis: 'x', d: [1, 0, 0], h: dx, area: dy * dz, positive: 1, negative: 2 },
    { axis: 'y', d: [0, 1, 0], h: dy, area: dx * dz, positive: 4, negative: 8 },
    { axis: 'z', d: [0, 0, 1], h: dz, area: dx * dy, positive: 16, negative: 32 },
  ];
  const getId = (ix, iy, iz) => ix >= 0 && ix < nx && iy >= 0 && iy < ny && iz >= 0 && iz < nz ? ids[index(ix, iy, iz)] : -1;
  const isOpen = opening => Boolean(settings.doorStates?.[opening.id]);
  function connect(a, b, axis, mass = 0, resistance = 0, surfaceY = 0, type = 'air') {
    faces.push({ a, b, area: axis.area, length: axis.h, mass, resistance });
    connected[a] |= axis.positive; connected[b] |= axis.negative;
    if (surfaceY) { boundary[a] += axis.area * surfaceY; boundary[b] += axis.area * surfaceY; }
    if (type !== 'air') sheetFaces++;
    if (type === 'shared') sharedFaces++;
    if (type === 'opening') openingSheetFaces++;
  }
  for (let a = 0; a < count; a++) {
    const pa = positions(a);
    for (const axis of axes) {
      const [sx, sy, sz] = axis.d;
      const b = getId(cx[a] + sx, cy[a] + sy, cz[a] + sz);
      if (b >= 0) {
        let opening;
        if (axis.axis !== 'y') {
          const pb = positions(b), span = axis.axis === 'x' ? pa.z : pa.x;
          opening = grid.openings.find(o => o.axis === axis.axis && pa[axis.axis] < o.k + EPS && pb[axis.axis] >= o.k + EPS && span >= o.lo && span < o.hi && pa.y >= o.sill && pa.y < o.head);
        }
        if (opening && !isOpen(opening)) {
          const wooden = opening.kind === 'door';
          connect(a, b, axis, wooden ? 12 : 15, wooden ? 120 : 60, boundaryAdmittance(wooden ? .06 : .03), 'opening');
        } else { connect(a, b, axis); if (opening) openFaces++; }
        continue;
      }
      if (axis.axis === 'y') continue;
      // A thin wall's two air faces are linked only when the intervening CAD
      // object actually spans this cross-section. No diagonal or corner links.
      for (let offset = 2; offset <= Math.ceil(.36 / axis.h) + 1; offset++) {
        const other = getId(cx[a] + sx * offset, cy[a], cz[a] + sz * offset);
        if (other < 0) continue;
        const pb = positions(other), span = axis.axis === 'x' ? pa.z : pa.x;
        const wall = grid.walls.find(w => w.axis === axis.axis && w.k > pa[axis.axis] && w.k < pb[axis.axis] && span >= w.lo - EPS && span < w.hi - EPS && pa.y >= w.bottom - EPS && pa.y < w.top - EPS && pa[axis.axis] < w.k - w.thickness / 2 + axis.h && pb[axis.axis] > w.k + w.thickness / 2 - axis.h);
        if (wall) {
          const shared = axis.axis === 'z' && grid.owners[a] === -2 && grid.rooms[grid.owners[other]]?.id === 'room6';
          connect(a, other, axis, shared ? config.partitionMass : 400, shared ? config.partitionResistance : 400, wallY, shared ? 'shared' : 'wall');
        }
        break;
      }
    }
  }
  // Every unconnected cell face is a surface. Open exterior collars terminate
  // in characteristic admittance; opaque exterior walls/floor/ceiling reflect
  // with the selected loss proxy. There is no simulated outdoor air volume.
  for (let a = 0; a < count; a++) {
    const opening = grid.channels[a], p = positions(a);
    const exteriorCollar = grid.owners[a] === -3 && opening?.exterior && Math.abs(p[opening.axis] - opening.k) >= .1 - EPS;
    for (const axis of axes) {
      for (const bit of [axis.positive, axis.negative]) {
        if (!(connected[a] & bit)) boundary[a] += axis.area * (exteriorCollar ? 1 / Z0 : wallY);
      }
    }
  }
  const core = createPressureCore({ cellCount: count, volume, faces, boundary, dt });
  const steps = Math.ceil(config.duration / dt);
  if (config.sourceMode === 'recording' && !referenceWaveform) throw new Error('녹음 파형을 먼저 선택하고 준비하세요.');
  let reference = referenceWaveform || createWaveReference(actualSource, config, numerics);
  if (referenceWaveform) {
    if (!reference.samples?.length || reference.units !== 'Pa at 1m' || !(reference.sampleRate >= 2 * numerics.cutoffHz) || !(reference.cutoffHz > 0 && reference.cutoffHz <= numerics.cutoffHz * 1.00001)) throw new Error('입력 파형은 이 격자의 지원 대역으로 필터된 1 m 기준 압력(Pa)이어야 합니다.');
    reference = { ...reference, mode: 'recording', hasResolvedContent: reference.lowBandRmsPa > 1e-12 };
  }
  // Qdot=4*pi*p_1m/rho. Integrate the pressure reference once, then inject
  // midpoint Q into continuity; injecting p or Qdot here would be incorrect.
  const q = new Float64Array(steps + 1);
  const pressureAt = time => {
    const x = time * reference.sampleRate, i = Math.floor(x), f = x - i;
    if (i < 0 || i >= reference.samples.length - 1) return 0;
    const value = reference.samples[i] * (1 - f) + reference.samples[i + 1] * f;
    if (!Number.isFinite(value)) throw new Error('입력 파형에 유효하지 않은 압력이 있습니다.');
    return value;
  };
  let before = pressureAt(0);
  for (let i = 1; i <= steps; i++) {
    const after = pressureAt(i * dt);
    q[i] = q[i - 1] + (4 * Math.PI / RHO) * (before + after) * dt / 2;
    before = after;
  }
  function nearest(position, allowedOwner) {
    let best = -1, distance = Infinity;
    for (let i = 0; i < count; i++) {
      if (allowedOwner !== undefined && grid.owners[i] !== allowedOwner) continue;
      const p = positions(i), d = (p.x - position.x) ** 2 + (p.y - position.y) ** 2 + (p.z - position.z) ** 2;
      if (d < distance) { distance = d; best = i; }
    }
    return best;
  }
  const sourceCell = nearest(actualSource, sourceRoom);
  const sourceIndices = [], sourceWeights = [];
  const gx = (actualSource.x - grid.minX) / dx - .5, gy = actualSource.y / dy - .5, gz = (actualSource.z - grid.minZ) / dz - .5;
  let weightTotal = 0;
  for (let ix = Math.floor(gx); ix <= Math.floor(gx) + 1; ix++) for (let iy = Math.floor(gy); iy <= Math.floor(gy) + 1; iy++) for (let iz = Math.floor(gz); iz <= Math.floor(gz) + 1; iz++) {
    const id = getId(ix, iy, iz);
    if (id < 0 || grid.owners[id] !== sourceRoom) continue;
    const weight = (1 - Math.abs(ix - gx)) * (1 - Math.abs(iy - gy)) * (1 - Math.abs(iz - gz));
    if (weight > 0) { sourceIndices.push(id); sourceWeights.push(weight); weightTotal += weight; }
  }
  if (!weightTotal) { sourceIndices.push(sourceCell); sourceWeights.push(1); weightTotal = 1; }
  for (let i = 0; i < sourceWeights.length; i++) sourceWeights[i] /= weightTotal;
  const forcing = { indices: sourceIndices, weights: sourceWeights, volumeVelocity: 0 };
  // The home probe is a listener, deliberately separated from the singular
  // injection cell. Positions are snapped to air-cell centres and disclosed.
  const homeRoom = grid.rooms[sourceRoom];
  const candidate = { x: homeRoom.center?.[0] ?? actualSource.x, y: clamp(actualSource.y, dy / 2, height - dy / 2), z: homeRoom.center?.[1] ?? actualSource.z };
  if (Math.hypot(candidate.x - actualSource.x, candidate.z - actualSource.z) < .7) candidate.x += .8;
  let ownProbe = nearest(candidate, sourceRoom);
  if (Math.hypot(positions(ownProbe).x - actualSource.x, positions(ownProbe).z - actualSource.z) < .4) ownProbe = nearest({ ...candidate, x: actualSource.x - .8 }, sourceRoom);
  const neighborProbe = nearest({ x: 9.05, y: clamp(actualSource.y, dy / 2, height - dy / 2), z: -.2 - config.neighborDepth / 2 }, -2);
  const probeIds = { source: ownProbe, neighbor: neighborProbe };
  const traceTimes = new Float32Array(steps + 1), traces = { source: new Float32Array(steps + 1), neighbor: new Float32Array(steps + 1) };
  const peaks = { source: 0, neighbor: 0 };
  const sourceCalibration = {
    mode: reference.mode || config.sourceMode, units: 'Pa at 1m',
    fullBandLevelDbA: reference.fullBandLevelDbA, fullBandRmsPa: reference.fullBandRmsPa,
    lowBandRmsPa: reference.lowBandRmsPa, lowBandDbSPL: spl(reference.lowBandRmsPa),
    retainedEnergyFraction: reference.retainedEnergyFraction,
    cutoffHz: numerics.cutoffHz, hasResolvedContent: reference.hasResolvedContent,
    finalVolumeVelocity: q.at(-1), inputWeighting: 'A', outputWeighting: 'unweighted resolved band',
  };
  const metadata = {
    domain: { minX: grid.minX, maxX: grid.maxX, minY: 0, maxY: height, minZ: grid.minZ, maxZ: grid.maxZ, nx, ny, nz },
    ...numerics, airCells: count, faces: faces.length, sheetFaces, sharedFaces, openingSheetFaces, openFaces,
    steps, duration: steps * dt, requestedDuration: config.duration,
    neighbor: grid.neighbor, source: actualSource,
    probes: { source: positions(ownProbe), neighbor: positions(neighborProbe) }, sourceCalibration,
    rooms: grid.rooms.map((room, i) => ({ id: room.id, name: room.name, airCells: grid.owners.filter(owner => owner === i).length })),
    assumptions: {
      wallHeight: height, sharedMassKgM2: config.partitionMass, sharedResistancePaSM: config.partitionResistance,
      otherWallMassKgM2: 400, otherWallResistancePaSM: 400, doorMassKgM2: 12, glassMassKgM2: 15,
      wallAlphaNormalIncidence: config.wallAlpha, outside: 'matched termination at exterior openings; no outdoor grid',
      geometry: 'cell-centre voxelization; thin sheet across solid wall thickness; no cut cells or diagonal links',
      pressureMeaning: 'physical signed Pa and elapsed-window unweighted low-band RMS; early response only',
      unmodelled: 'elastic bending, studs, flanking, structure-borne paths, furniture, sub-grid gaps, full speech bandwidth',
    },
  };
  let step = 0;
  return {
    metadata,
    get finished() { return step >= steps; },
    get progress() { return step / steps; },
    step(count = 64) {
      const until = Math.min(steps, step + Math.max(0, Math.floor(count)));
      while (step < until) {
        forcing.volumeVelocity = (q[step] + q[step + 1]) / 2;
        core.step(forcing); step++;
        traceTimes[step] = step * dt;
        for (const name of ['source', 'neighbor']) {
          const pressure = core.pressure[probeIds[name]];
          traces[name][step] = pressure; peaks[name] = Math.max(peaks[name], Math.abs(pressure));
        }
      }
      return { step, time: step * dt, progress: step / steps, finished: step >= steps };
    },
    frame(sliceY = config.sliceY) {
      const iy = clamp(Math.floor(finite(sliceY, 1.2) / dy), 0, ny - 1);
      const pressure = new Float32Array(nx * nz), rms = new Float32Array(nx * nz), mask = new Uint8Array(nx * nz);
      let maxAbsPressurePa = 0;
      for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
        const dense = index(ix, iy, iz), id = ids[dense], out = iz * nx + ix;
        mask[out] = grid.denseMask[dense];
        if (id >= 0) { pressure[out] = core.pressure[id]; rms[out] = Math.sqrt(core.rmsSum[id] / Math.max(1, step)); maxAbsPressurePa = Math.max(maxAbsPressurePa, Math.abs(pressure[out])); }
      }
      const probes = {};
      for (const name of ['source', 'neighbor']) {
        const rmsPa = Math.sqrt(core.rmsSum[probeIds[name]] / Math.max(1, step));
        probes[name] = { position: positions(probeIds[name]), times: traceTimes.slice(0, step + 1), pressure: traces[name].slice(0, step + 1), rmsPa, peakAbsPa: peaks[name], lowBandDbSPL: spl(rmsPa) };
      }
      return {
        step, time: step * dt, progress: step / steps, finished: step >= steps,
        slice: { pressure, rms, mask, width: nx, height: nz, originX: grid.minX + dx / 2, originZ: grid.minZ + dz / 2, dx, dz, sliceY: (iy + .5) * dy },
        probes,
        metrics: { maxAbsPressurePa, sourceRmsPa: probes.source.rmsPa, neighborRmsPa: probes.neighbor.rmsPa, neighborLowBandDbSPL: probes.neighbor.lowBandDbSPL, energyJ: core.energy() },
      };
    },
  };
}
