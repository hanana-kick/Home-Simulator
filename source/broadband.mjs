/** 50–5000 Hz, 1/3-octave airborne comparison model.
 * Each band has its own room-energy network. Material tables are interpolated;
 * no output from the previous seven-band solver is interpolated or reused.
 * These are room-space-average engineering scenarios, not pressure maps, STI,
 * legal criteria, measured construction ratings, or statistical intervals.
 */
import { BANDS as MATERIAL_BANDS, MATERIALS, WALL_PROFILES, createAcousticModel } from './acoustics.mjs';
import { aWeightingDb } from './wave-audio.mjs';

export const THIRD_OCTAVE_BANDS = Object.freeze([50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000]);
export const BROADBAND_DEFAULTS = Object.freeze({
  transferMode: 'element', partitionProfile: 'masonry', partitionBandsDb: null, tlOffsetDb: 0,
  leakAreaCm2: 10, flankEnabled: true, flankDnDb: 55, flankBandsDb: null,
  receiverFloorAreaM2: 7.5, receiverHeightM: 2.3, receiverRt60: .5, receiverRt60Bands: null,
  background: 30, backgroundBandsDb: null,
  measuredTransferBandsDb: null, measuredSourceRoomBandsDb: null,
  measuredSourceRoomScenarioId: 'conversation', assumptionId: 'central',
});

export const BROADBAND_SCENARIOS = Object.freeze({
  conversation: { label: '일상 대화', typicalLevel: 60, loudLevel: 66, pitch: 160, duty: .5, loudFraction: .1, voiceEnabled: true, speakerEnabled: false, speakerLevel: 60, speakerDuty: 1 },
  livestream: { label: '유튜브 라이브 방송', typicalLevel: 66, loudLevel: 78, pitch: 160, duty: .7, loudFraction: .05, voiceEnabled: true, speakerEnabled: false, speakerLevel: 65, speakerDuty: 1 },
  singing: { label: '노래', typicalLevel: 75, loudLevel: 85, pitch: 220, duty: .9, loudFraction: .1, voiceEnabled: true, speakerEnabled: false, speakerLevel: 65, speakerDuty: 1 },
});

/** Construction assumptions, not confidence limits. Offsets apply to the
 * entered central construction; a measured whole-building transfer has one
 * condition only because no measurement uncertainty was supplied. */
export const BROADBAND_CONSTRUCTIONS = Object.freeze([
  { id: 'lower', label: '차음이 낮은 시공 가정', tlOffsetDb: -8, leakScale: 10, flankOffsetDb: -8 },
  { id: 'central', label: '중앙 시공 가정', tlOffsetDb: 0, leakScale: 1, flankOffsetDb: 0 },
  { id: 'higher', label: '차음이 높은 시공 가정', tlOffsetDb: 8, leakScale: .1, flankOffsetDb: 8 },
]);

const CENTERS = THIRD_OCTAVE_BANDS.map((_, i) => 1000 * 10 ** ((i - 13) / 10));
export const BROADBAND_A_WEIGHTING = Object.freeze(CENTERS.map(aWeightingDb));
const AW = BROADBAND_A_WEIGHTING.map(db => 10 ** (db / 10));
const N = THIRD_OCTAVE_BANDS.length, S = 5.75, A0 = 10;
const zero = () => Array(N).fill(0);
const pow = value => 10 ** (value / 10);
const db = value => value > 0 ? Math.max(-300, 10 * Math.log10(value)) : -300;
const weightedEnergy = values => values.reduce((sum, value, i) => sum + value * AW[i], 0);
const weightedDb = values => weightedEnergy(values) > 1e-29 ? db(weightedEnergy(values)) : null;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const sum = (...arrays) => zero().map((_, b) => arrays.reduce((total, array) => total + array[b], 0));
const scale = (values, factor) => values.map(value => value * factor);
const UFC_BANDS = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000];

export const BROADBAND_PARTITIONS = Object.freeze({
  masonry: {
    label: '약 203 mm 고밀도 콘크리트·조적 설계 대용값',
    frequencies: UFC_BANDS, values: [34, 36, 37, 41, 45, 49, 53, 57, 61],
    provenance: 'UFC 3-450-01 (2022), Table C-8, 8-inch dense poured concrete/solid-core masonry, suggested design values. 실제 벽의 실측값 아님.',
    url: 'https://nibs-s3-wbdg3-production.s3.us-east-1.amazonaws.com/FFC/DOD/UFC/ufc_3_450_01_2022.pdf',
  },
  lightweight: {
    label: '경량벽 비교 가정', frequencies: MATERIAL_BANDS, values: WALL_PROFILES.lightweight.transmissionLoss,
    provenance: '임의 비교 가정. 125 Hz 미만은 6 dB/oct 감소를 가정한 확장; 시험성적서 아님.',
  },
  nrcExample: {
    label: 'NRC 실험실 석고벽 조립체 예시', frequencies: THIRD_OCTAVE_BANDS,
    values: [21.7, 15, 16.4, 12.1, 17.9, 26.7, 34.9, 42.3, 47.9, 52.9, 55.7, 59.9, 61.9, 63.2, 62.4, 59, 48.7, 44.1, 47.4, 51.3, 55.4],
    provenance: 'NRC IR-761, TL-93-002, p77. 양쪽 16 mm Type-X 석고보드 각 1겹, 90 mm steel studs @406 mm, 75 mm mineral fibre. 실제 공유벽과 동일하다는 뜻 아님.',
    url: 'https://nrc-publications.canada.ca/eng/view/object/?id=04ac8069-a5d2-4038-8787-da064b073e7f',
  },
});

function number(value, fallback, minimum, maximum, label) {
  if (value == null) return fallback;
  const result = Number(value);
  if (!Number.isFinite(result) || result < minimum || result > maximum) throw new RangeError(`${label}: ${minimum}–${maximum} 범위의 수가 필요합니다.`);
  return result;
}

function bands(value, label, minimum = -300, maximum = 180) {
  if (value == null) return null;
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== N) throw new RangeError(`${label}: 50–5000 Hz 순서의 21개 값이 필요합니다.`);
  return Array.from(value, value => {
    if (value === null || typeof value === 'boolean' || typeof value === 'string' && !value.trim()) throw new RangeError(`${label}: 결측 대역을 0 dB로 대체할 수 없습니다.`);
    return number(value, NaN, minimum, maximum, label);
  }).map(value => {
    if (!Number.isFinite(value)) throw new RangeError(`${label}: 비어 있거나 유효하지 않은 대역 값이 있습니다.`);
    return value;
  });
}

/** log-frequency interpolation of INPUT material data, never output SPL. */
function interpolate(values, frequencies = MATERIAL_BANDS, extension = 'hold') {
  return THIRD_OCTAVE_BANDS.map(f => {
    if (f < frequencies[0]) return extension === 'tl' ? Math.max(0, values[0] + 6 * Math.log2(f / frequencies[0])) : values[0];
    if (f >= frequencies.at(-1)) return values.at(-1);
    const upper = frequencies.findIndex(value => value >= f);
    if (upper === 0) return values[0];
    const fraction = Math.log(f / frequencies[upper - 1]) / Math.log(frequencies[upper] / frequencies[upper - 1]);
    return values[upper - 1] * (1 - fraction) + values[upper] * fraction;
  });
}

function normalizeConfig(input = {}, requireTransfer = true) {
  const c = { ...BROADBAND_DEFAULTS, ...input };
  if (!['element', 'apparent', 'dnt'].includes(c.transferMode)) throw new RangeError('전달 모드는 element, apparent, dnt 중 하나여야 합니다.');
  if (!BROADBAND_PARTITIONS[c.partitionProfile]) throw new RangeError('지원하지 않는 벽체 입력입니다.');
  c.tlOffsetDb = number(c.tlOffsetDb, 0, -40, 40, '벽체 보정');
  c.leakAreaCm2 = number(c.leakAreaCm2, 10, 0, S * 10000, '등가 개구면적');
  c.flankDnDb = number(c.flankDnDb, 55, 0, 140, '정규화 우회경로 Dn,f');
  c.receiverFloorAreaM2 = number(c.receiverFloorAreaM2, 7.5, 1, 200, '이웃 바닥면적');
  c.receiverHeightM = number(c.receiverHeightM, 2.3, 1.8, 5, '이웃 높이');
  c.receiverRt60 = number(c.receiverRt60, .5, .05, 10, '이웃 전체 잔향시간');
  c.background = c.background === null ? null : number(c.background, 30, 0, 100, '배경소음');
  c.partitionBandsDb = bands(c.partitionBandsDb, '원소 R', 0, 160);
  c.flankBandsDb = bands(c.flankBandsDb, '정규화 우회경로 Dn,f', 0, 160);
  c.receiverRt60Bands = bands(c.receiverRt60Bands, '이웃 전체 잔향시간', .05, 10);
  c.backgroundBandsDb = bands(c.backgroundBandsDb, '배경소음');
  c.measuredTransferBandsDb = bands(c.measuredTransferBandsDb, '현장 전달곡선', -20, 160);
  c.measuredSourceRoomBandsDb = bands(c.measuredSourceRoomBandsDb, '작업실 공간평균 L1');
  if (requireTransfer && c.transferMode !== 'element' && !c.measuredTransferBandsDb) throw new RangeError('현장 R′ 또는 DnT 모드에는 해당 정의로 측정한 21대역 전달곡선이 필요합니다.');
  if (c.measuredSourceRoomBandsDb && !BROADBAND_SCENARIOS[c.measuredSourceRoomScenarioId]) throw new RangeError('작업실 실측 L1을 적용할 활동을 선택하세요.');
  c.flankEnabled = c.flankEnabled !== false;
  return c;
}

function inputCurves(c) {
  const profile = BROADBAND_PARTITIONS[c.partitionProfile];
  const partitionBandsDb = c.partitionBandsDb || interpolate(profile.values, profile.frequencies, 'tl');
  const backgroundEnergy = c.background === null ? 0 : pow(c.background) / AW.reduce((a, b) => a + b, 0);
  return {
    partitionBandsDb: [...partitionBandsDb], measuredTransferBandsDb: c.measuredTransferBandsDb && [...c.measuredTransferBandsDb],
    flankBandsDb: c.flankBandsDb ? [...c.flankBandsDb] : Array(N).fill(c.flankDnDb),
    receiverRt60Bands: c.receiverRt60Bands ? [...c.receiverRt60Bands] : Array(N).fill(c.receiverRt60),
    backgroundBandsDb: c.backgroundBandsDb ? [...c.backgroundBandsDb] : Array(N).fill(db(backgroundEnergy)),
    provenance: { partition: c.partitionBandsDb ? '사용자 입력 원소 R 곡선; 출처는 저장된 입력 설명 참조' : profile.provenance,
      absorption: '125 Hz 미만 흡음계수는 125 Hz 대용값 유지. 단단한 벽지 바탕면 및 생활집기 가정.',
      receiverRt60: '현재 수음 조건의 전체 잔향시간. 별도 탈출 손실을 다시 더하지 않음.',
      flank: 'A0=10㎡로 정규화된 독립 Dn,f 경로의 현장값 또는 명시적 가정. 실험실 값을 접합 보정 없이 이식하지 않음.',
      background: c.backgroundBandsDb ? '사용자 입력 대역별 비보정 배경 SPL' : '50–5000 Hz 대역별 동일 에너지를 갖는 배경 가정; A합이 입력값과 일치' },
    notices: ['재질 입력표만 로그 주파수로 보간하며 21대역 방 에너지 방정식은 각각 독립적으로 계산합니다.',
      '50–80 Hz 및 작은 방에서는 확산음장 가정의 오차가 커질 수 있습니다. 대역 수가 정확도를 보장하지 않습니다.'],
  };
}

/** Absolute unweighted 1 m band SPL. A provided spectrum is never normalized. */
export function broadbandSourceBands(source = {}) {
  const supplied = bands(source.bandLevelsDb, '1 m 음원 스펙트럼');
  if (supplied) return supplied;
  const level = number(source.level, 60, 0, 140, '1 m 음원 크기');
  const pitch = number(source.pitch, 160, 40, 1000, '기본주파수');
  const out = zero();
  let fullWeighted = 0;
  function add(frequency, energy) {
    fullWeighted += energy * pow(aWeightingDb(frequency));
    const band = Math.floor(10 * Math.log10(frequency / 1000) + 13.5);
    if (band >= 0 && band < N) out[band] += energy;
  }
  if (source.type === 'tone') add(number(source.frequency, 500, 20, 20000, '순음 주파수'), 1);
  else if (source.type === 'pink' || source.type === 'white') {
    for (let i = 0; i < 600; i++) { const f = 20 * 1000 ** ((i + .5) / 600); add(f, source.type === 'white' ? f : 1); }
  } else {
    for (let h = 1; h * pitch <= 8000; h++) {
      const f = h * pitch, gaussian = (center, width) => Math.exp(-.5 * (Math.log(f / center) / width) ** 2);
      const tract = .3 + 5 * gaussian(550, .26) + 2.6 * gaussian(1500, .18) + 1.5 * gaussian(2600, .15);
      add(f, tract / h ** 2.4);
    }
    // A small explicit unvoiced component; it is not an intelligibility model.
    const voiced = out.reduce((a, b) => a + b, 0);
    for (let i = 0; i < 120; i++) { const f = 300 * (8000 / 300) ** ((i + .5) / 120); add(f, voiced * .06 / 120); }
  }
  return out.map(energy => db(energy * pow(level) / Math.max(1e-30, fullWeighted)));
}

function solve(matrix, rhs) {
  const n = rhs.length, a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let j = i + 1; j < n; j++) if (Math.abs(a[j][i]) > Math.abs(a[pivot][i])) pivot = j;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    if (Math.abs(a[i][i]) < 1e-14) throw new Error('방 에너지 네트워크에 손실이 부족하여 해를 구할 수 없습니다.');
    for (let j = i + 1; j < n; j++) {
      const factor = a[j][i] / a[i][i];
      for (let k = i; k <= n; k++) a[j][k] -= factor * a[i][k];
    }
  }
  const out = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let value = a[i][n];
    for (let j = i + 1; j < n; j++) value -= a[i][j] * out[j];
    out[i] = Math.max(0, value / a[i][i]);
  }
  return out;
}

export function createBroadbandModel(data) {
  // Only CAD-derived geometry is reused. No legacy acoustic evaluate() call.
  const geometry = createAcousticModel(data), rooms = geometry.rooms.filter(room => room.kind !== 'exterior');
  const roomIndex = new Map(rooms.map((room, i) => [room.id, i]));
  const workshop = roomIndex.get('room6');
  if (workshop === undefined) throw new Error('작업실 room6가 필요합니다.');
  const points = geometry.rooms.flatMap(room => room.poly), patches = [];
  for (const patch of [...geometry.barriers, ...geometry.openings]) {
    const dim = patch.axis === 'x' ? 1 : 0;
    const splits = [...new Set([patch.lo, patch.hi, ...points.map(p => p[dim]).filter(v => v > patch.lo + 1e-7 && v < patch.hi - 1e-7)])].sort((a, b) => a - b);
    for (let i = 0; i + 1 < splits.length; i++) {
      const lo = splits[i], hi = splits[i + 1], span = (lo + hi) / 2, offset = patch.thickness / 2 + .015;
      const indices = [-1, 1].map(sign => {
        const room = geometry.roomAt(patch.axis === 'x' ? patch.k + sign * offset : span, patch.axis === 'z' ? patch.k + sign * offset : span);
        return roomIndex.get(room?.id) ?? -1;
      });
      if (!indices.some(i => i >= 0) || indices[0] === indices[1]) continue;
      const area = (hi - lo) * (patch.top - patch.bottom);
      if (area <= 1e-9) continue;
      const shared = patch.type === 'wall' && patch.axis === 'z' && Math.abs(patch.k + .1) < .015 && indices.includes(workshop) && lo >= 7.8 - 1e-6 && hi <= 10.3 + 1e-6;
      patches.push({ ...patch, lo, hi, area, indices, shared });
    }
  }
  const actualSharedArea = patches.filter(patch => patch.shared).reduce((sum, patch) => sum + patch.area, 0);
  if (Math.abs(actualSharedArea - S) > .02) throw new Error(`작업실 북측 공유벽은 5.75㎡여야 합니다. 현재 도면 접면: ${actualSharedArea.toFixed(3)}㎡`);
  const alpha = Object.fromEntries(['wallpaper', 'ceiling', 'floor', 'tile', 'door', 'glass'].map(key => [key, interpolate(MATERIALS[key].absorption)]));
  const furniture = interpolate(MATERIALS.furnishings.equivalentAbsorptionPerFloorM2);
  const doorTl = interpolate([2, 7, 12, 17, 18, 19, 22, 30, 35], UFC_BANDS);
  const glassTl = interpolate(MATERIALS.glass.transmissionLoss, MATERIAL_BANDS, 'tl');
  const transferCache = new Map();

  function prepare(source, settings, config, construction) {
    const c = normalizeConfig(config), curves = inputCurves(c);
    const measuredL1 = c.measuredSourceRoomBandsDb;
    const position = { x: Number(source.x), y: Number(source.y), z: Number(source.z) };
    const sourceRoom = geometry.roomAt(position.x, position.z);
    if (!measuredL1 && (!geometry.isPositionValid(position) || sourceRoom?.kind === 'exterior')) throw new RangeError('광대역 음원은 집 안의 실내 공간에 있어야 합니다.');
    const sourceIndex = roomIndex.get(sourceRoom?.id) ?? workshop;
    const doorStates = Object.fromEntries(geometry.openings.map(opening => {
      const state = settings.doorStates?.[opening.id] ?? settings.doorStates?.[opening.index] ?? false;
      return [opening.id, state === true || state === 'open' ? 1 : clamp(Number(state) || 0, 0, 1)];
    }));
    const effectiveConstruction = c.transferMode === 'element' ? construction : BROADBAND_CONSTRUCTIONS[1];
    const cacheKey = JSON.stringify([sourceIndex, settings.wallProfile, settings.furnished, doorStates, c, effectiveConstruction]);
    if (transferCache.has(cacheKey)) return transferCache.get(cacheKey);
    const volume = c.receiverFloorAreaM2 * c.receiverHeightM;
    const absorption = curves.receiverRt60Bands.map(time => .16 * volume / time);
    const leak = c.transferMode === 'element' ? Math.min(S, c.leakAreaCm2 * effectiveConstruction.leakScale / 10000) : 0;
    const opaqueArea = S - leak;
    const r = curves.partitionBandsDb.map(value => clamp(value + c.tlOffsetDb + effectiveConstruction.tlOffsetDb, 0, 160));
    const flankDn = curves.flankBandsDb.map(value => clamp(value + effectiveConstruction.flankOffsetDb, 0, 160));
    const pathAreas = c.transferMode === 'element' ? {
      wall: r.map(value => opaqueArea * pow(-value)),
      leak: Array(N).fill(leak),
      flank: flankDn.map(value => c.flankEnabled ? A0 * pow(-value) : 0),
    } : c.transferMode === 'apparent' ? { apparent: c.measuredTransferBandsDb.map(value => S * pow(-value)) }
      : { dnt: c.measuredTransferBandsDb.map((value, b) => absorption[b] * pow(-value) * curves.receiverRt60Bands[b] / .5) };
    const equivalentArea = sum(...Object.values(pathAreas));
    if (c.transferMode === 'element' && equivalentArea.some((value, b) => value > absorption[b] + 1e-9)) throw new RangeError('입력한 전체 잔향시간과 열린 전달경로가 수동적인 방의 에너지 수지를 만족하지 않습니다. 등가투과면적이 전체 등가흡음면적보다 큽니다. 잔향시간·누기·우회 입력을 확인하세요.');
    const l1Gain = zero(), receiverGain = zero(), originalRoomGain = zero();
    const wet = rooms.map(room => room.id === 'room3' || /욕실|bathroom/i.test(room.name));
    const interiorWallTl = settings.wallProfile === 'lightweight' ? interpolate(WALL_PROFILES.lightweight.transmissionLoss, MATERIAL_BANDS, 'tl')
      : interpolate(BROADBAND_PARTITIONS.masonry.values, UFC_BANDS);
    if (!measuredL1) for (let b = 0; b < N; b++) {
      const coupled = c.transferMode === 'element', n = rooms.length + (coupled ? 1 : 0), neighborIndex = rooms.length;
      const matrix = Array.from({ length: n }, () => Array(n).fill(0)), rhs = Array(n).fill(0);
      rooms.forEach((room, i) => {
        matrix[i][i] = room.perimeter * geometry.wallHeight * alpha[wet[i] ? 'tile' : 'wallpaper'][b]
          + room.area * (alpha[wet[i] ? 'tile' : 'floor'][b] + alpha.ceiling[b]);
        if (settings.furnished !== false && !wet[i]) matrix[i][i] += room.area * furniture[b];
      });
      for (const patch of patches) {
        const [i, j] = patch.indices;
        if (patch.type !== 'wall') {
          const openness = doorStates[patch.id] || 0;
          for (const index of patch.indices) if (index >= 0) matrix[index][index] += patch.area * ((1 - openness) * alpha[patch.type][b] - alpha[wet[index] ? 'tile' : 'wallpaper'][b]);
        }
        if (patch.shared) continue; // original outdoors sink is REPLACED
        const openness = patch.type === 'wall' ? 0 : doorStates[patch.id] || 0;
        const tl = patch.type === 'wall' ? interiorWallTl[b] : patch.type === 'door' ? doorTl[b] : glassTl[b];
        const transfer = patch.area * (openness + (1 - openness) * pow(-tl));
        if (i >= 0) matrix[i][i] += transfer;
        if (j >= 0) matrix[j][j] += transfer;
        if (i >= 0 && j >= 0) { matrix[i][j] -= transfer; matrix[j][i] -= transfer; }
      }
      if (coupled) {
        const coupling = equivalentArea[b];
        matrix[workshop][workshop] -= leak * alpha.wallpaper[b];
        matrix[workshop][workshop] += coupling;
        matrix[neighborIndex][neighborIndex] = absorption[b]; // total measured/assumed A, not A+B
        matrix[workshop][neighborIndex] -= coupling;
        matrix[neighborIndex][workshop] -= coupling;
      }
      rhs[sourceIndex] = 16 * Math.PI; // 4 * radiated power in normalized pressure units
      const values = solve(matrix, rhs);
      l1Gain[b] = values[workshop]; originalRoomGain[b] = values[sourceIndex];
      receiverGain[b] = coupled ? values[neighborIndex] : l1Gain[b] * equivalentArea[b] / absorption[b];
    }
    const notices = [...curves.notices,
      '방의 공간평균 확산 에너지 계산입니다. 같은 방 안의 미세 음원좌표·높이·귀 위치·지향성에 따른 차이는 계산하지 않습니다.',
      '공유벽 면적 5.75㎡는 작업실 북측 실제 도면 접면이며, 이웃 방 크기·잔향시간·시공 상태는 입력 가정입니다.',
      '흡음과 차음은 별도 입력입니다. 일반 실크벽지를 흡음재로 취급하지 않습니다.',
      '현재 수음 조건의 전체 T를 고정한 비교입니다. 조건별 내부흡음은 A2−등가투과면적으로 해석됩니다.'];
    if (c.transferMode === 'element') notices.push('누기는 면적×τ=1인 이상적 개구의 상한 가정입니다. 밀폐 틈새의 실제 주파수 응답은 다를 수 있습니다.', '우회 Dn,f는 A0=10㎡ 정규화 경로입니다. 구조·접합을 실제로 해석한 예측값이 아닙니다.', '세 시공 조건은 명시적 가정이며 확률적 신뢰구간이나 실제 최악·최선 한계가 아닙니다.');
    else notices.push('현장 전달곡선에 포함된 누기·우회는 다시 더하지 않습니다.', measuredL1 ? '작업실 공간평균 실측 L1을 그대로 경계값으로 사용합니다.' : '현장 전달곡선 + 가정 음원·방 음장의 혼합 근거입니다. L1은 실측이 아니며 강한 결합에 따른 원실 부하 변화는 이 모드에서 계산하지 않습니다.');
    if (measuredL1 && c.transferMode === 'element') notices.push('작업실 공간평균 L1 입력이 자유음장 1 m 입력과 집 내부 전달 계산을 완전히 대체합니다.');
    if (equivalentArea.some((value, b) => value / absorption[b] > .1)) notices.push('강하게 결합된 방의 감쇠는 단일 지수형이 아닐 수 있습니다. 하나의 전체 잔향시간을 국소 손실계수로 해석한 추가 근사이며, 입력 T 재현을 검증한 계산이 아닙니다.');
    const prepared = { config: c, construction: effectiveConstruction, curves, pathAreas, equivalentArea, absorption, l1Gain, receiverGain, originalRoomGain, measuredL1,
      background: c.backgroundBandsDb ? c.backgroundBandsDb.map(pow) : c.background === null ? zero() : curves.backgroundBandsDb.map(pow),
      details: { boundaryRoomId: 'room6', boundaryRoomName: '작업실', boundarySide: 'north', separatingAreaM2: S, actualSharedAreaM2: actualSharedArea,
        sourceRoomId: sourceRoom?.id || null, receiverVolumeM3: volume, receiverFloorAreaM2: c.receiverFloorAreaM2, receiverHeightM: c.receiverHeightM,
        receiverRt60Bands: [...curves.receiverRt60Bands], receiverAbsorptionM2: absorption, partitionBandsDb: r, basePartitionBandsDb: curves.partitionBandsDb,
        flankBandsDb: flankDn, backgroundBandsDb: curves.backgroundBandsDb, opaqueAreaM2: opaqueArea, leakAreaCm2: leak * 10000,
        transferMode: c.transferMode, parallelPathsIncluded: c.transferMode === 'element', measuredSourceRoom: Boolean(measuredL1),
        sourceFieldModel: measuredL1 ? 'measured workshop space-average L1' : 'per-band diffuse room-energy network',
        coupledReceiver: c.transferMode === 'element' && !measuredL1, fixedTotalReceiverRt60: true,
        provenance: curves.provenance, notices, missingInputs: [], fieldLabel: '이웃 방 공간평균 · 50–5000 Hz 공기전달음' } };
    if (transferCache.size > 36) transferCache.clear();
    transferCache.set(cacheKey, prepared);
    return prepared;
  }

  function resultFromEnergy(inputEnergy, prepared, extraDetails = {}) {
    const l1 = prepared.measuredL1 ? prepared.measuredL1.map(pow) : inputEnergy.map((value, b) => value * prepared.l1Gain[b]);
    const received = prepared.measuredL1 ? l1.map((value, b) => value * prepared.equivalentArea[b] / prepared.absorption[b]) : inputEnergy.map((value, b) => value * prepared.receiverGain[b]);
    const total = sum(received, prepared.background);
    const sourceOnlyDbA = weightedDb(received), totalDbA = weightedDb(total), backgroundDbA = weightedDb(prepared.background);
    const energy = weightedEnergy(received);
    const labels = { wall: '공유벽 원소', leak: '등가 개구 · τ=1 상한', flank: '정규화 우회 Dn,f', apparent: '현장 R′ · 전체 경로', dnt: '현장 DnT · 전체 경로' };
    const routeContributions = Object.entries(prepared.pathAreas).map(([id, areas]) => {
      const values = l1.map((value, b) => value * areas[b] / prepared.absorption[b]);
      return { id, label: labels[id], bandsDb: values.map(db), levelDbA: weightedDb(values), fraction: energy > 0 ? weightedEnergy(values) / energy : 0, equivalentTransmissionAreaM2: [...areas] };
    });
    return {
      bandsHz: [...THIRD_OCTAVE_BANDS], sourceOnlyDbA, totalDbA, backgroundDbA,
      aboveBackgroundDb: sourceOnlyDbA === null || backgroundDbA === null ? null : sourceOnlyDbA - backgroundDbA,
      totalRiseDb: totalDbA === null || backgroundDbA === null ? null : totalDbA - backgroundDbA,
      sourceBandsDb: inputEnergy.map(db), sourceRoomBandsDb: l1.map(db), receiverBandsDb: received.map(db),
      backgroundBandsDb: prepared.background.map(db), totalBandsDb: total.map(db),
      originalSourceRoomBandsDb: prepared.measuredL1 ? null : inputEnergy.map((value, b) => db(value * prepared.originalRoomGain[b])),
      routeContributions, construction: { ...prepared.construction, leakAreaCm2: prepared.details.leakAreaCm2 },
      silent: sourceOnlyDbA === null, details: { ...prepared.details, ...extraDetails },
    };
  }

  function evaluate(source, settings = {}, config = {}) {
    const c = normalizeConfig(config);
    const construction = BROADBAND_CONSTRUCTIONS.find(item => item.id === c.assumptionId) || BROADBAND_CONSTRUCTIONS[1];
    const prepared = prepare(source, settings, c, construction);
    const input = c.measuredSourceRoomBandsDb ? zero() : broadbandSourceBands(source).map(pow);
    const result = resultFromEnergy(input, prepared);
    result.sensitivity = (c.transferMode === 'element' ? BROADBAND_CONSTRUCTIONS : [BROADBAND_CONSTRUCTIONS[1]]).map(condition => {
      const value = resultFromEnergy(input, prepare(source, settings, c, condition));
      return { id: condition.id, label: condition.label, sourceOnlyDbA: value.sourceOnlyDbA, totalDbA: value.totalDbA, deltaDb: value.sourceOnlyDbA === null || result.sourceOnlyDbA === null ? null : value.sourceOnlyDbA - result.sourceOnlyDbA };
    });
    return result;
  }

  function recordingWindows(recording, prepared) {
    if (!Array.isArray(recording.frames) || !recording.frames.length) throw new RangeError('녹음 구간별 대역 자료가 없습니다.');
    const frames = recording.frames.map(frame => ({
      duration: number(frame.durationSec, NaN, .0001, 3600, '녹음 프레임 길이'),
      energy: (bands(frame.bandLevelsDb, '녹음 프레임 스펙트럼') || []).map(pow),
    }));
    if (frames.some(frame => !Number.isFinite(frame.duration) || frame.energy.length !== N)) throw new RangeError('녹음 프레임 시간 또는 스펙트럼이 없습니다.');
    const boundaries = [0], prefix = [zero()];
    for (const frame of frames) {
      boundaries.push(boundaries.at(-1) + frame.duration);
      prefix.push(sum(prefix.at(-1), scale(frame.energy, frame.duration)));
    }
    const duration = boundaries.at(-1), window = Math.min(1, duration);
    function integral(time) {
      if (time <= 0) return zero();
      if (time >= duration) return [...prefix.at(-1)];
      let low = 0, high = frames.length;
      while (high - low > 1) { const middle = (low + high) >> 1; if (boundaries[middle] <= time) low = middle; else high = middle; }
      return sum(prefix[low], scale(frames[low].energy, time - boundaries[low]));
    }
    // Candidate windows begin at input-frame boundaries. For the supplied
    // 0.5 s analysis frames this is explicitly a 0.5 s evaluation interval,
    // not an instantaneous maximum or a continuously searched peak.
    let loud = null, loudEnergy = -1, loudStart = 0;
    const starts = [...new Set([...boundaries.filter(time => time + window <= duration + 1e-8 && time < duration), Math.max(0, duration - window)])];
    for (const start of starts.length ? starts : [0]) {
      const from = integral(start), to = integral(start + window);
      const spectrum = to.map((value, b) => Math.max(0, (value - from[b]) / window));
      const received = spectrum.map((value, b) => value * prepared.receiverGain[b]);
      const level = weightedEnergy(received);
      if (level > loudEnergy) { loudEnergy = level; loud = spectrum; loudStart = start; }
    }
    const suppliedAverage = bands(recording.bandLevelsDb, '녹음 평균 스펙트럼');
    const average = scale(prefix.at(-1), 1 / duration);
    const summaryDifferenceDb = suppliedAverage ? weightedDb(average) - weightedDb(suppliedAverage.map(pow)) : null;
    return { average, loud,
      details: { recorded: true, recordingDurationSeconds: duration, loudWindowSeconds: window, loudWindowStartSeconds: loudStart,
        loudStatistic: duration < 1 ? '1초 미만 녹음의 전체 평균' : recording.analysisWindowSeconds
          ? '1초 분석창·0.5초 간격의 구간 최대(평활된 스펙트럼, 마지막 끝맞춤 포함)'
          : '0.5초 간격·마지막 끝맞춤 1초 평균 중 최대',
        analysisWindowSeconds: recording.analysisWindowSeconds ?? null,
        recordingAverageBasis: '프레임별 비보정 대역 에너지를 실제 구간 길이로 가중한 전체 평균', summaryDifferenceDb,
        dutyApplied: false, loudFractionApplied: false, separateSpeakerApplied: false, loudAvailable: true,
        fullBandLevelDbA: recording.fullBandLevelDbA ?? null, analysisBandLevelDbA: recording.analysisBandLevelDbA ?? null,
        retainedAWeightedFraction: recording.retainedAWeightedFraction ?? null } };
  }

  function compareScenarios(source, settings = {}, config = {}, overrides = {}) {
    const globalConfig = normalizeConfig(config);
    const scenarios = Object.entries(BROADBAND_SCENARIOS).map(([id, preset]) => {
      const override = overrides[id] || {}, a = { ...preset, ...override };
      const measuredHere = globalConfig.measuredSourceRoomBandsDb && globalConfig.measuredSourceRoomScenarioId === id;
      const scopedConfig = { ...globalConfig, measuredSourceRoomBandsDb: measuredHere ? globalConfig.measuredSourceRoomBandsDb : null };
      // Spectra belong to an explicit scenario override. Do not accidentally
      // reuse one global recording for all three activity cards.
      const sourcePosition = { x: source.x, y: source.y, z: source.z, type: 'voice', pitch: number(a.pitch, preset.pitch, 40, 1000, '기본주파수') };
      const importedSpectrum = bands(override.bandLevelsDb, '활동별 입력 스펙트럼');
      const recordedFrames = Array.isArray(override.frames) && override.frames.length > 0;
      const assumed = !measuredHere && !importedSpectrum && !recordedFrames;
      let inputs = null;
      if (assumed) {
        const duty = number(a.duty, preset.duty, 0, 1, '음성 활동 비율');
        const loudFraction = number(a.loudFraction, preset.loudFraction, 0, 1, '음성 활동 중 큰 구간 비율');
        const speakerDuty = number(a.speakerDuty, preset.speakerDuty, 0, 1, '스피커 활동 비율');
        const typicalLevel = number(a.typicalLevel, preset.typicalLevel, 0, 140, '활동 음원 크기');
        const loudLevel = number(a.loudLevel, preset.loudLevel, 0, 140, '큰 구간 음원 크기');
        const speakerLevel = number(a.speakerLevel, preset.speakerLevel, 0, 140, '스피커 크기');
        const voice = a.voiceEnabled === false ? zero() : broadbandSourceBands({ ...sourcePosition, level: typicalLevel }).map(pow);
        const louder = a.voiceEnabled === false ? zero() : broadbandSourceBands({ ...sourcePosition, level: loudLevel }).map(pow);
        const speaker = a.speakerEnabled ? broadbandSourceBands({ ...sourcePosition, type: 'pink', level: speakerLevel }).map(pow) : zero();
        inputs = {
          active: sum(voice, speaker), loud: sum(louder, speaker),
          session: sum(scale(voice, duty * (1 - loudFraction)), scale(louder, duty * loudFraction), scale(speaker, speakerDuty)),
        };
      }
      const conditions = (globalConfig.transferMode === 'element' ? BROADBAND_CONSTRUCTIONS : [BROADBAND_CONSTRUCTIONS[1]]).map(construction => {
        const prepared = prepare(sourcePosition, settings, scopedConfig, construction);
        let energy, extra;
        if (measuredHere) {
          energy = { active: zero(), loud: zero(), session: zero() };
          extra = { measuredSourceRoom: true, measuredSourceRoomScenarioId: id, dutyApplied: false, loudFractionApplied: false,
            loudAvailable: false, loudStatistic: '입력된 작업실 평균 L1 조건 · 별도 큰 구간 정보 없음',
            timeBasis: '사용자 제공 작업실 공간평균 L1의 측정 시간조건; 활동률 추가 적용 없음' };
        } else if (recordedFrames) {
          const recording = recordingWindows(override, prepared);
          energy = { active: recording.average, loud: recording.loud, session: recording.average };
          extra = recording.details;
        } else if (importedSpectrum) {
          const imported = importedSpectrum.map(pow);
          energy = { active: imported, loud: imported, session: imported };
          extra = { importedSpectrum: true, dutyApplied: false, loudFractionApplied: false, loudAvailable: false,
            loudStatistic: '입력 평균 스펙트럼 · 큰 구간 시간자료 없음', timeBasis: '입력 스펙트럼의 원래 평균 시간조건' };
        } else {
          energy = inputs;
          extra = { assumedActivity: true, dutyApplied: true, loudFractionApplied: true, loudAvailable: true,
            loudStatistic: '가정한 큰 소리 구간의 정상상태 수준 · LAFmax 아님', timeBasis: '음성·큰 구간·스피커의 사용자 활동 비율' };
        }
        const active = resultFromEnergy(energy.active, prepared, extra);
        const loud = resultFromEnergy(energy.loud, prepared, extra);
        const session = resultFromEnergy(energy.session, prepared, extra);
        return { id: construction.id, label: construction.label, active, loud, session, construction: session.construction };
      });
      const central = conditions.find(condition => condition.id === 'central');
      const range = Object.fromEntries(['active', 'loud', 'session'].map(metric => {
        const values = conditions.map(condition => condition[metric].sourceOnlyDbA).filter(value => value !== null);
        return [metric, { min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null }];
      }));
      const sensitivity = conditions.map(condition => ({ id: condition.id, label: condition.label, sourceOnlyDbA: condition.session.sourceOnlyDbA,
        totalDbA: condition.session.totalDbA, deltaDb: condition.session.sourceOnlyDbA === null || central.session.sourceOnlyDbA === null ? null : condition.session.sourceOnlyDbA - central.session.sourceOnlyDbA }));
      return { id, label: preset.label,
        assumptions: { typicalLevel: a.typicalLevel, loudLevel: a.loudLevel, pitch: a.pitch, duty: a.duty, loudFraction: a.loudFraction,
          voiceEnabled: a.voiceEnabled !== false, speakerEnabled: Boolean(a.speakerEnabled), speakerLevel: a.speakerLevel, speakerDuty: a.speakerDuty,
          sourceMode: measuredHere ? 'measured-room' : recordedFrames ? 'recording' : importedSpectrum ? 'absolute-spectrum' : 'assumed-synthetic',
          activityControlsApplied: assumed, measuredSourceRoom: Boolean(measuredHere), recorded: recordedFrames,
          loudAvailable: central.loud.details.loudAvailable, conditionRangeType: globalConfig.transferMode === 'element' ? 'explicit construction assumptions, not a confidence interval' : 'single supplied field-transfer curve; uncertainty not supplied' },
        active: central.active, loud: central.loud, session: central.session, conditions, range, sensitivity };
    });
    return { bandsHz: [...THIRD_OCTAVE_BANDS], scenarios, details: { ...scenarios[0].session.details,
      measuredSourceRoomScenarioId: globalConfig.measuredSourceRoomBandsDb ? globalConfig.measuredSourceRoomScenarioId : null,
      constructionRangeType: globalConfig.transferMode === 'element' ? '세 명시적 시공 가정 · 확률구간 아님' : '현장 전달곡선 1개 · 측정 불확도 자료 없음' } };
  }

  return { rooms, bandsHz: [...THIRD_OCTAVE_BANDS], boundary: { roomId: 'room6', side: 'north', areaM2: S },
    inputBands: config => inputCurves(normalizeConfig(config, false)), evaluate, compareScenarios };
}

