import {
  BANDS, A_WEIGHTING, MATERIALS, WALL_PROFILES, createAcousticModel, sourceSpectrum,
} from './acoustics.mjs';

export const NEIGHBOR_PARTITIONS = Object.freeze({
  masonry: { ...WALL_PROFILES.masonry },
  lightweight: { ...WALL_PROFILES.lightweight },
  floor: {
    label: '150mm 콘크리트 슬래브 가정',
    transmissionLoss: [40, 40, 49, 58, 67, 76, 76],
    provenance: 'ASHRAE 2023 Ch.49 Table 40, 150mm solid concrete floor/ceiling. 8kHz는 4kHz 값 유지 가정. 실제 슬래브 미확인; 공기전달음만 계산.',
    source: 'https://handbook.ashrae.org/handbooks/A23/SI/a23_ch49/a23_ch49_si.aspx',
  },
});

export const NEIGHBOR_DEFAULTS = Object.freeze({
  route: 'shared-wall', boundaryRoomId: 'room6', boundarySide: 'north', gapM: 3,
  partitionProfile: 'masonry', tlOffsetDb: 0, separatingAreaM2: 5.75,
  receiverFloorAreaM2: 7.5, receiverHeightM: 2.3, receiverRt60: 0.5,
  neighborWindowOpen: false, neighborWindowAreaM2: 1.5, background: 30,
});

/** Editable design scenarios; livestreaming and singing are not standard levels.
 * All levels refer to free-field dBA at 1 m during active sound, not LAFmax.
 * Speaker playback has its own activity fraction independent of voice pauses.
 */
export const NEIGHBOR_SCENARIOS = Object.freeze({
  conversation: {
    label: '일상 대화', typicalLevel: 60, loudLevel: 66, pitch: 160, duty: 0.5, loudFraction: 0.1,
    voiceEnabled: true, speakerEnabled: false, speakerLevel: 60, speakerDuty: 1,
  },
  livestream: {
    label: '유튜브 라이브 방송', typicalLevel: 66, loudLevel: 78, pitch: 160, duty: 0.7, loudFraction: 0.05,
    voiceEnabled: true, speakerEnabled: false, speakerLevel: 65, speakerDuty: 1,
  },
  singing: {
    label: '노래', typicalLevel: 75, loudLevel: 85, pitch: 220, duty: 0.9, loudFraction: 0.1,
    voiceEnabled: true, speakerEnabled: false, speakerLevel: 65, speakerDuty: 1,
  },
});

/**
 * Hypothetical neighbouring dwelling, using octave-band transmitted power.
 *
 * Shared wall / airborne floor:
 *   E2 = (E1,diffuse*S + 4*integral(E1,direct*cos(theta)*dS))*tau / A2,total
 *   A2,total = 0.161*V2/T2,closed + S*tau.
 * The exact direct-source solid angle is integrated over rectangular pieces;
 * barrier visibility is sampled within those pieces. Source-side samples are
 * INSIDE the selected physical opaque boundary. Its TL is then applied once.
 *
 * Detached:
 *   the existing house engine first transmits through its real facades; exterior
 *   pressure samples illuminate a separate synthetic receiving facade. Only the
 *   neighbour's composite wall/window TL is applied in this second stage.
 *
 * Source-side fields are held fixed (one-way coupling). Receiver fields are
 * room-average diffuse estimates, not a specific neighbour's bed or ear point.
 * Impact, structural/flanking transmission, diffraction and exterior reflections
 * are not included. ±10 dB conditions are assumptions, NOT confidence intervals.
 *
 * References:
 * NRC Bradley et al., 2005, Eq.1: L2(f)=L1(f)-TL(f)+10log(S/A2(f)).
 * https://publications-cnrc.canada.ca/eng/view/accepted/?id=c8de3148-8775-4f7a-a450-3aefbb05d127
 * Arup facade break-in (free field outside, low/moderate absorption inside):
 * https://strutt.arup.com/help/Building_Acoustics/NoiseOutIn.htm
 * Floor TL: ASHRAE 2023, Ch.49, Table40 (see NEIGHBOR_PARTITIONS.floor).
 */

const WEIGHTS = A_WEIGHTING.map(value => 10 ** (value / 10));
const ZERO = () => BANDS.map(() => 0);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const pow = value => 10 ** (value / 10);
const db = value => 10 * Math.log10(Math.max(1e-30, value));
const weightedEnergy = bands => bands.reduce((sum, value, i) => sum + value * WEIGHTS[i], 0);
const weightedDb = bands => db(weightedEnergy(bands));
const sum = (...arrays) => BANDS.map((_, band) => arrays.reduce((total, array) => total + array[band], 0));
const scale = (array, amount) => array.map(value => value * amount);
const SIDES = { west: { axis: 'x', sign: -1, label: '서측' }, east: { axis: 'x', sign: 1, label: '동측' }, north: { axis: 'z', sign: -1, label: '북측' }, south: { axis: 'z', sign: 1, label: '남측' } };

function solidAngle(rectangle, point) {
  const d = Math.max(1e-12, Math.abs(point[rectangle.axis] - rectangle.k));
  const u0 = rectangle.u0 - point[rectangle.uAxis], u1 = rectangle.u1 - point[rectangle.uAxis];
  const v0 = rectangle.v0 - point[rectangle.vAxis], v1 = rectangle.v1 - point[rectangle.vAxis];
  const F = (u, v) => Math.atan2(u * v, d * Math.hypot(d, u, v));
  return clamp(Math.abs(F(u1, v1) - F(u0, v1) - F(u1, v0) + F(u0, v0)), 0, 2 * Math.PI);
}

function subdivide(rectangles, maxStep = 0.65) {
  const pieces = [];
  for (const rectangle of rectangles) {
    const nx = Math.max(1, Math.ceil((rectangle.u1 - rectangle.u0) / maxStep));
    const ny = Math.max(1, Math.ceil((rectangle.v1 - rectangle.v0) / maxStep));
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const u0 = rectangle.u0 + (rectangle.u1 - rectangle.u0) * i / nx;
      const u1 = rectangle.u0 + (rectangle.u1 - rectangle.u0) * (i + 1) / nx;
      const v0 = rectangle.v0 + (rectangle.v1 - rectangle.v0) * j / ny;
      const v1 = rectangle.v0 + (rectangle.v1 - rectangle.v0) * (j + 1) / ny;
      const area = (u1 - u0) * (v1 - v0);
      if (area < 1e-10) continue;
      pieces.push({ ...rectangle, u0, u1, v0, v1, area, center: { [rectangle.axis]: rectangle.k, [rectangle.uAxis]: (u0 + u1) / 2, [rectangle.vAxis]: (v0 + v1) / 2 } });
    }
  }
  return pieces;
}

function normalConfig(input, rooms, boundaries) {
  const c = { ...NEIGHBOR_DEFAULTS, ...input };
  c.route = ['shared-wall', 'floor-above', 'floor-below', 'detached'].includes(c.route) ? c.route : 'shared-wall';
  const first = rooms.find(room => room.kind !== 'exterior');
  if (!rooms.some(room => room.id === c.boundaryRoomId && room.kind !== 'exterior')) c.boundaryRoomId = first.id;
  const sides = boundaries.filter(boundary => boundary.roomId === c.boundaryRoomId);
  if (!SIDES[c.boundarySide]) c.boundarySide = sides[0]?.side || 'north';
  c.partitionProfile = input?.partitionProfile === undefined && c.route.startsWith('floor') ? 'floor'
    : NEIGHBOR_PARTITIONS[c.partitionProfile] ? c.partitionProfile : c.route.startsWith('floor') ? 'floor' : 'masonry';
  c.gapM = clamp(finite(c.gapM, 3), 0.5, 30);
  c.tlOffsetDb = clamp(finite(c.tlOffsetDb, 0), -30, 30);
  c.separatingAreaM2 = clamp(finite(c.separatingAreaM2, 8), 0.1, 100);
  c.receiverFloorAreaM2 = clamp(finite(c.receiverFloorAreaM2, 14), 4, 100);
  c.receiverHeightM = clamp(finite(c.receiverHeightM, 2.3), 2, 4);
  c.receiverRt60 = clamp(finite(c.receiverRt60, 0.5), 0.15, 2.5);
  c.neighborWindowOpen = c.neighborWindowOpen === true;
  c.neighborWindowAreaM2 = clamp(finite(c.neighborWindowAreaM2, 1.5), 0, 30);
  c.background = c.background === null ? null : clamp(finite(c.background, 30), 0, 80);
  return c;
}

export function createNeighborModel(data) {
  const acoustic = createAcousticModel(data);
  const rooms = acoustic.rooms, roomMap = new Map(rooms.map(room => [room.id, room]));
  if (!rooms.some(room => room.kind !== 'exterior')) throw new Error('이웃 비교에는 실내 공간이 필요합니다.');
  const H = acoustic.wallHeight;
  const allPoints = rooms.flatMap(room => room.poly);
  const boundaryCandidates = [];

  for (const room of rooms.filter(room => room.kind !== 'exterior')) {
    let signedArea = 0;
    for (let i = 0; i < room.poly.length; i++) {
      const a = room.poly[i], b = room.poly[(i + 1) % room.poly.length];
      signedArea += a[0] * b[1] - b[0] * a[1];
    }
    for (let i = 0; i < room.poly.length; i++) {
      const a = room.poly[i], b = room.poly[(i + 1) % room.poly.length];
      const dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz);
      if (length < 0.05 || (Math.abs(dx) > 1e-6 && Math.abs(dz) > 1e-6)) continue;
      const nx = (signedArea > 0 ? dz : -dz) / length, nz = (signedArea > 0 ? -dx : dx) / length;
      const axis = Math.abs(nx) > 0.5 ? 'x' : 'z', sign = axis === 'x' ? Math.sign(nx) : Math.sign(nz);
      const side = axis === 'x' ? sign < 0 ? 'west' : 'east' : sign < 0 ? 'north' : 'south';
      const uAxis = axis === 'x' ? 'z' : 'x', dim = axis === 'x' ? 1 : 0;
      const k = axis === 'x' ? a[0] : a[1], lo = Math.min(a[dim], b[dim]), hi = Math.max(a[dim], b[dim]);
      const splits = [...new Set([lo, hi, ...allPoints.map(point => point[dim]).filter(value => value > lo && value < hi)])].sort((x, y) => x - y);
      const externalSegments = [];
      for (let j = 0; j < splits.length - 1; j++) {
        const u0 = splits[j], u1 = splits[j + 1];
        const probe = { [axis]: k + sign * 0.24, [uAxis]: (u0 + u1) / 2 };
        const neighbour = acoustic.roomAt(probe.x, probe.z);
        if (neighbour && neighbour.kind !== 'exterior') continue;
        if (externalSegments.length && Math.abs(externalSegments.at(-1).u1 - u0) < 1e-7) externalSegments.at(-1).u1 = u1;
        else externalSegments.push({ u0, u1 });
      }
      for (const segment of externalSegments) {
        if (segment.u1 - segment.u0 < 0.15) continue;
        const opaqueRectangles = [];
        for (const wall of acoustic.barriers) {
          if (wall.group && wall.group !== 'wallOuter') continue;
          if (wall.axis !== axis || Math.abs(wall.k - sign * wall.thickness / 2 - k) > 0.015) continue;
          const u0 = Math.max(segment.u0, wall.lo), u1 = Math.min(segment.u1, wall.hi);
          if (u1 <= u0) continue;
          opaqueRectangles.push({ axis, sign, k, uAxis, vAxis: 'y', u0, u1, v0: wall.bottom, v1: wall.top });
        }
        // A room-polygon gap at an internal wall junction is not an exterior
        // facade. Require an actual outer-wall object or external opening.
        const externalOpening = acoustic.openings.some(opening => opening.axis === axis
          && Math.abs(opening.k - sign * opening.thickness / 2 - k) < 0.015
          && opening.hi > segment.u0 && opening.lo < segment.u1
          && opening.roomIds.includes(room.id)
          && opening.roomIds.some(id => !id || roomMap.get(id)?.kind === 'exterior'));
        if (!opaqueRectangles.length && !externalOpening) continue;
        const opaqueArea = opaqueRectangles.reduce((total, rect) => total + (rect.u1 - rect.u0) * (rect.v1 - rect.v0), 0);
        const facade = { axis, sign, k, uAxis, vAxis: 'y', ...segment, v0: 0, v1: H };
        boundaryCandidates.push({ roomId: room.id, side, label: `${room.name} ${SIDES[side].label} 외벽`,
          availableAreaM2: opaqueArea, opaqueAreaM2: opaqueArea, facadeAreaM2: (segment.u1 - segment.u0) * H,
          facade, opaqueRectangles });
      }
    }
  }
  // A side may have several disjoint exterior strips; expose the largest face
  // rather than silently combining different facade planes or directions.
  const boundaryMap = new Map();
  for (const candidate of boundaryCandidates) {
    const key = `${candidate.roomId}:${candidate.side}`, current = boundaryMap.get(key);
    if (!current || candidate.facadeAreaM2 > current.facadeAreaM2) boundaryMap.set(key, candidate);
  }
  const boundaries = [...boundaryMap.values()];
  let cachedKey = '', cachedGeometry = null;

  function horizontalRectangles(room, upper) {
    const xs = [...new Set(room.poly.map(point => point[0]))].sort((a, b) => a - b);
    const zs = [...new Set(room.poly.map(point => point[1]))].sort((a, b) => a - b);
    const rectangles = [];
    for (let j = 0; j < zs.length - 1; j++) for (let i = 0; i < xs.length - 1; i++) {
      const x = (xs[i] + xs[i + 1]) / 2, z = (zs[j] + zs[j + 1]) / 2;
      if (acoustic.roomAt(x, z)?.id !== room.id) continue;
      rectangles.push({ axis: 'y', sign: upper ? 1 : -1, k: upper ? H : 0, uAxis: 'x', vAxis: 'z', u0: xs[i], u1: xs[i + 1], v0: zs[j], v1: zs[j + 1] });
    }
    return rectangles;
  }

  function geometry(source, settings, configInput) {
    const config = normalConfig(configInput, rooms, boundaries);
    const position = { x: Number(source.x), y: Number(source.y), z: Number(source.z) };
    if (!acoustic.isPositionValid(position)) throw new RangeError('소음원은 기존 집 또는 마당의 유효한 위치에 있어야 합니다.');
    const relevantConfig = { ...config }; delete relevantConfig.partitionProfile; delete relevantConfig.tlOffsetDb;
    delete relevantConfig.neighborWindowOpen; delete relevantConfig.neighborWindowAreaM2; delete relevantConfig.background;
    const key = JSON.stringify([position, { ...settings, background: null }, relevantConfig]);
    if (key === cachedKey) return { ...cachedGeometry, config };
    const room = roomMap.get(config.boundaryRoomId), notices = [];
    let boundary = null, rectangles, availableArea;
    if (config.route.startsWith('floor')) {
      rectangles = horizontalRectangles(room, config.route === 'floor-above');
      availableArea = Math.min(room.area, config.receiverFloorAreaM2);
    } else {
      const candidates = boundaries.filter(item => item.roomId === room.id && (config.route === 'detached' || item.opaqueAreaM2 > 0.05));
      boundary = candidates.find(item => item.side === config.boundarySide) || candidates[0];
      if (!boundary) throw new RangeError('선택한 방에 계산 가능한 외부 접면이 없습니다. 다른 방이나 상·하층 경로를 선택하세요.');
      if (boundary.side !== config.boundarySide) notices.push(`선택한 방향에는 외벽이 없어 ${SIDES[boundary.side].label} 외벽을 사용했습니다.`);
      if (config.route === 'shared-wall') {
        rectangles = boundary.opaqueRectangles;
        availableArea = boundary.opaqueAreaM2;
        notices.push('기존 창·문을 제외한 불투명 벽 부분만 공유벽으로 가정했습니다.');
      } else {
        const outward = boundary.facade.sign;
        // Gap is measured between facade exterior faces, with existing wall
        // thickness added between its inside room face and the outside edge.
        const receiving = { ...boundary.facade, k: boundary.facade.k + outward * (0.2 + config.gapM), sign: -outward,
          v1: Math.min(H, config.receiverHeightM) };
        rectangles = [receiving];
        availableArea = (receiving.u1 - receiving.u0) * (receiving.v1 - receiving.v0);
        notices.push('이웃 외벽은 선택한 외벽과 평행하며 창 위치는 균등 면적비로 가정했습니다.');
      }
    }
    const area = Math.min(config.separatingAreaM2, availableArea);
    if (area < config.separatingAreaM2 - 1e-7) notices.push(`접면 면적을 사용 가능한 ${area.toFixed(2)}㎡로 제한했습니다.`);
    const pieces = subdivide(rectangles), geometricArea = pieces.reduce((total, piece) => total + piece.area, 0);
    const areaScale = area / geometricArea;
    const referenceSource = { ...position, type: 'pink', pitch: 160, level: 60 };
    const referenceEnergy = sourceSpectrum(referenceSource).map(pow);
    const directFluxRatio = ZERO(), diffuseFluxRatio = ZERO();
    const modelSettings = { ...settings, background: null };
    let samples = 0;
    for (const piece of pieces) {
      const scaledArea = piece.area * areaScale;
      if (config.route === 'detached') {
        const point = { ...piece.center, y: clamp(piece.center.y, 0.05, H - 0.05) };
        if (acoustic.roomAt(point.x, point.z)?.kind === 'interior') throw new RangeError('가정한 이웃 외벽이 기존 집 실내와 겹칩니다. 방향이나 거리를 바꾸세요.');
        const field = acoustic.evaluateExterior(referenceSource, point, modelSettings);
        const d = Math.max(0.25, Math.hypot(position.x - point.x, position.y - point.y, position.z - point.z));
        const directCosine = Math.max(0, (position[piece.axis] - point[piece.axis]) * piece.sign / d);
        const faceCenter = { ...boundary.facade, x: boundary.facade.axis === 'x' ? boundary.facade.k : (boundary.facade.u0 + boundary.facade.u1) / 2,
          y: H / 2, z: boundary.facade.axis === 'z' ? boundary.facade.k : (boundary.facade.u0 + boundary.facade.u1) / 2 };
        const faceDistance = Math.max(0.25, Math.hypot(faceCenter.x - point.x, faceCenter.y - point.y, faceCenter.z - point.z));
        const facadeCosine = Math.max(0, (faceCenter[piece.axis] - point[piece.axis]) * piece.sign / faceDistance);
        for (let b = 0; b < BANDS.length; b++) {
          directFluxRatio[b] += pow(field.directBandsDb[b]) / referenceEnergy[b] * directCosine * scaledArea;
          diffuseFluxRatio[b] += pow(field.reverberantBandsDb[b]) / referenceEnergy[b] * facadeCosine * scaledArea;
        }
      } else {
        const point = { ...piece.center, [piece.axis]: piece.k - piece.sign * 0.035 };
        point.y = clamp(point.y, 0.05, H - 0.05);
        if (acoustic.roomAt(point.x, point.z)?.id !== room.id) continue;
        const field = acoustic.evaluate(referenceSource, point, modelSettings);
        const d2 = Math.max(0.25, field.distance) ** 2;
        const sourceOnInside = (position[piece.axis] - piece.k) * piece.sign < 0;
        const omega = sourceOnInside ? solidAngle(piece, position) * areaScale : 0;
        for (let b = 0; b < BANDS.length; b++) {
          const pathTransmission = clamp(pow(field.directBandsDb[b]) * d2 / referenceEnergy[b], 0, 1);
          directFluxRatio[b] += pathTransmission * omega;
          diffuseFluxRatio[b] += pow(field.reverberantBandsDb[b]) / referenceEnergy[b] * scaledArea / 4;
        }
      }
      samples++;
    }
    if (!samples) throw new RangeError('선택한 접면에서 유효한 실내 표본을 찾지 못했습니다.');
    const intrinsicAbsorption = 0.161 * config.receiverFloorAreaM2 * config.receiverHeightM / config.receiverRt60;
    const details = {
      actualBoundarySide: boundary?.side || null, boundaryLabel: boundary?.label || `${room.name} ${config.route === 'floor-above' ? '천장' : '바닥'}`,
      boundaryRoomId: room.id, boundaryRoomName: room.name, sourceRoomId: acoustic.roomAt(position.x, position.z).id,
      separatingAreaM2: area, requestedSeparatingAreaM2: config.separatingAreaM2, availableAreaM2: availableArea,
      facadeAreaM2: boundary?.facadeAreaM2 || null, opaqueAreaM2: boundary?.opaqueAreaM2 || null,
      receiverVolumeM3: config.receiverFloorAreaM2 * config.receiverHeightM,
      receiverFloorAreaM2: config.receiverFloorAreaM2, receiverHeightM: config.receiverHeightM,
      receiverRt60Closed: config.receiverRt60, intrinsicAbsorptionM2: intrinsicAbsorption,
      gapM: config.route === 'detached' ? config.gapM : null, sampleCount: samples, notices,
      fieldLabel: '이웃 방 평균 · 공기전달음 추정', oneWayCoupling: true,
      ignoredPaths: ['구조전달·측로전달', '충격음', '회절·실외 반사', '실제 틈새와 시공 상태'],
    };
    cachedKey = key;
    cachedGeometry = { config, position, area, intrinsicAbsorption, directFluxRatio, diffuseFluxRatio, details };
    return cachedGeometry;
  }

  function transfer(g, config, relativeOffset = 0) {
    const totalOffset = config.tlOffsetDb + relativeOffset;
    const profile = NEIGHBOR_PARTITIONS[config.partitionProfile];
    const wallTau = profile.transmissionLoss.map(loss => pow(-clamp(loss + totalOffset, 0, 120)));
    const windowArea = config.route === 'detached' ? Math.min(g.area, config.neighborWindowAreaM2) : 0;
    const windowFraction = windowArea / g.area;
    const tau = wallTau.map((value, band) => {
      if (!windowArea) return value;
      const windowTau = config.neighborWindowOpen ? 1 : pow(-clamp(MATERIALS.glass.transmissionLoss[band] + totalOffset, 0, 120));
      return value * (1 - windowFraction) + windowTau * windowFraction;
    });
    const absorption = tau.map(value => g.intrinsicAbsorption + g.area * value);
    const gain = tau.map((value, band) => 4 * (g.directFluxRatio[band] + g.diffuseFluxRatio[band]) * value / absorption[band]);
    return { gain, absorption, transmissionLossDb: tau.map(value => -db(value)), windowArea,
      relativeOffsetDb: relativeOffset, totalOffsetDb: totalOffset, profileLabel: profile.label };
  }

  function pack(energy, g, config, t) {
    const sourcePower = weightedEnergy(energy), silent = sourcePower <= 0;
    const backgroundPerBand = config.background === null ? 0 : pow(config.background) / WEIGHTS.reduce((total, value) => total + value, 0);
    const total = energy.map(value => value + backgroundPerBand);
    const sourceOnlyDbA = silent ? null : db(sourcePower);
    const totalDbA = weightedEnergy(total) <= 0 ? null : weightedDb(total);
    const aboveBackgroundDb = silent || config.background === null ? null : sourceOnlyDbA - config.background;
    return {
      route: config.route, boundaryRoomId: config.boundaryRoomId, sourceRoomId: g.details.sourceRoomId,
      sourceOnlyDbA, totalDbA, backgroundDbA: config.background, aboveBackgroundDb,
      totalRiseDb: totalDbA === null || config.background === null ? null : totalDbA - config.background,
      silent, receivedBandsDb: total.map(db), bandsDb: total.map(db), sourceOnlyBandsDb: energy.map(db),
      transmissionLossDb: t.transmissionLossDb, receiverAbsorptionM2: t.absorption,
      details: { ...g.details, partitionProfile: config.partitionProfile, partitionLabel: t.profileLabel,
        tlOffsetDb: t.totalOffsetDb, neighborWindowOpen: config.route === 'detached' && config.neighborWindowOpen,
        neighborWindowAreaM2: t.windowArea, effectiveAbsorptionM2: t.absorption,
        sensitivityAppliesTo: config.route === 'detached' ? '이웃 수음측의 닫힌 외벽·창 TL만 변경 · 열린 창은 영향 없음' : '선택한 공유벽 또는 슬래브 TL만 변경' },
    };
  }

  function conditions(inputEnergy, g, config) {
    return [-10, 0, 10].map(offsetDb => {
      const t = transfer(g, config, offsetDb), received = inputEnergy.map((value, band) => value * t.gain[band]);
      return { offsetDb, label: offsetDb < 0 ? '차음 −10dB 가정' : offsetDb > 0 ? '차음 +10dB 가정' : '기준 가정',
        ...pack(received, g, config, t) };
    });
  }

  function evaluate(source, settings = {}, configInput = {}) {
    const g = geometry(source, settings, configInput), config = g.config;
    const input = sourceSpectrum(source).map(pow), sensitivity = conditions(input, g, config);
    return { ...sensitivity[1], sensitivity };
  }

  function compareScenarios(source, settings = {}, configInput = {}, overrides = {}) {
    const g = geometry(source, settings, configInput), config = g.config;
    return Object.entries(NEIGHBOR_SCENARIOS).map(([id, preset]) => {
      const input = { ...preset, ...(overrides[id] || {}) };
      const typicalLevel = clamp(finite(input.typicalLevel, preset.typicalLevel), 20, 110);
      const spec = {
        label: String(input.label || preset.label), typicalLevel,
        loudLevel: Math.max(typicalLevel, clamp(finite(input.loudLevel, preset.loudLevel), 20, 110)),
        pitch: clamp(finite(input.pitch, preset.pitch), 80, 400),
        duty: clamp(finite(input.duty, preset.duty), 0, 1),
        loudFraction: clamp(finite(input.loudFraction, preset.loudFraction), 0, 1),
        voiceEnabled: input.voiceEnabled !== false, speakerEnabled: input.speakerEnabled === true,
        speakerLevel: clamp(finite(input.speakerLevel, preset.speakerLevel), 20, 110),
        speakerDuty: clamp(finite(input.speakerDuty, preset.speakerDuty), 0, 1),
      };
      const typicalVoice = spec.voiceEnabled ? sourceSpectrum({ ...source, type: 'voice', level: spec.typicalLevel, pitch: spec.pitch }).map(pow) : ZERO();
      const loudVoice = spec.voiceEnabled ? sourceSpectrum({ ...source, type: 'voice', level: spec.loudLevel, pitch: spec.pitch }).map(pow) : ZERO();
      const speaker = spec.speakerEnabled ? sourceSpectrum({ ...source, type: 'pink', level: spec.speakerLevel }).map(pow) : ZERO();
      const activeInput = sum(typicalVoice, speaker), loudInput = sum(loudVoice, speaker);
      const sessionInput = sum(
        scale(typicalVoice, spec.duty * (1 - spec.loudFraction)),
        scale(loudVoice, spec.duty * spec.loudFraction),
        scale(speaker, spec.speakerDuty),
      );
      const sensitivity = { active: conditions(activeInput, g, config), loud: conditions(loudInput, g, config), session: conditions(sessionInput, g, config) };
      return { id, label: spec.label, assumptions: { ...spec, levelReference: '자유음장 1m dBA · 활동 중',
        scenarioProvenance: '수정 가능한 비교용 가정값 · 라이브 방송/노래의 표준 소음값 아님',
        sessionDefinition: '전체 시간 중 음성 활동 비율과 그 안의 큰소리 비율, 독립된 스피커 활동 비율로 에너지 평균',
        loudDefinition: '큰소리 구간의 정상상태 가정 · 실제 LAFmax가 아님',
        voiceSpectrum: '음성 배음 모델 · 노래 가사/음색의 재현 아님',
        speakerSpectrum: '소음원과 같은 위치의 핑크 노이즈 대용 · 영상/음악별 실제 스펙트럼 아님' },
        active: { ...sensitivity.active[1], sensitivity: sensitivity.active },
        loud: { ...sensitivity.loud[1], sensitivity: sensitivity.loud },
        session: { ...sensitivity.session[1], sensitivity: sensitivity.session },
        sensitivity };
    });
  }

  return { rooms, boundaries, evaluate, compareScenarios };
}
