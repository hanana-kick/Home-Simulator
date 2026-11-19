import { aWeightingDb } from './wave-audio.mjs';

export const AUDIO_BANDS = Object.freeze([50,63,80,100,125,160,200,250,315,400,500,630,800,1000,1250,1600,2000,2500,3150,4000,5000]);
const EXACT_CENTERS = AUDIO_BANDS.map((_, i) => 1000 * 10 ** ((i - 13) / 10));
const EDGES = [...EXACT_CENTERS.map(f => f * 10 ** -.05), EXACT_CENTERS.at(-1) * 10 ** .05];
const db = energy => energy > 1e-30 ? 10 * Math.log10(energy) : -300;
const weighted = bands => bands.reduce((sum, value, i) => sum + value * 10 ** (aWeightingDb(EXACT_CENTERS[i]) / 10), 0);

// Unnormalized radix-2 FFT; zero padding changes bin spacing, not input energy.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [re[i], re[j]] = [re[j], re[i]];
  }
  for (let size = 2; size <= n; size *= 2) {
    const angle = -2 * Math.PI / size, stepR = Math.cos(angle), stepI = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let wr = 1, wi = 0;
      for (let j = 0; j < size / 2; j++) {
        const a = start + j, b = a + size / 2;
        const r = wr * re[b] - wi * im[b], q = wr * im[b] + wi * re[b];
        re[b] = re[a] - r; im[b] = im[a] - q; re[a] += r; im[a] += q;
        const nextR = wr * stepR - wi * stepI;
        wi = wr * stepI + wi * stepR; wr = nextR;
      }
    }
  }
}

/**
 * Analyze a LOCAL recording as 21 unweighted 1/3-octave band levels.
 *
 * Selected audio is calibrated to a USER-ASSUMED full-band LAeq at the declared
 * source reference. A digital sample is never treated as a measured pascal.
 * Calibration uses every positive FFT bin's A weight BEFORE excluding bands.
 * Returned levels use p0² as energy reference (not raw digital full scale).
 *
 * One-second Hann analysis windows, advanced on 0.5 s time blocks, suppress
 * phase-dependent low-frequency boundary leakage. Reflection pads both ends.
 * Each sample's squared window coverage is normalized across ALL frames, so
 * the complete clip's unweighted energy is preserved even at partial blocks.
 * One-sided bin energy is |FFT(xw)|² / (Nfft * Nblock), with factor 2 except
 * DC/Nyquist. Frames are smoothed spectral estimates, not sound-level-meter
 * rectangular time-window measurements.
 * Exact base-10 band edges, nominal 50–5000 Hz: 44.67–5623.41 Hz.
 * This finite-record FFT estimate is not an IEC 61260 certified filter bank.
 * Leakage near band edges and blocks below 0.5 s are disclosed in the result.
 */
export function analyzeBroadbandAudio(samples, sampleRate, options = {}) {
  if (!samples?.length || !Number.isFinite(sampleRate) || sampleRate < 12000 || sampleRate > 192000)
    throw new Error('50Hz–5kHz 분석에는 12–192kHz 샘플레이트의 녹음이 필요합니다.');
  const levelDbA = Number(options.levelDbA ?? 60);
  const offsetSeconds = Number(options.offsetSeconds ?? 0);
  const requestedDuration = Number(options.durationSeconds ?? 10);
  if (!Number.isFinite(levelDbA) || levelDbA < 0 || levelDbA > 140) throw new Error('보정 크기는 0–140dBA 범위여야 합니다.');
  if (!Number.isFinite(offsetSeconds) || offsetSeconds < 0) throw new Error('분석 시작 시간은 0 이상의 숫자여야 합니다.');
  if (!Number.isFinite(requestedDuration) || requestedDuration < .1 || requestedDuration > 60)
    throw new Error('분석 구간은 0.1–60초 범위여야 합니다.');
  const start = Math.floor(offsetSeconds * sampleRate);
  const count = Math.min(samples.length - start, Math.round(requestedDuration * sampleRate));
  if (count < Math.ceil(.1 * sampleRate)) throw new Error('선택 구간에 0.1초 이상의 녹음이 남아 있어야 합니다.');
  let mean = 0, peak = 0, clipped = 0;
  for (let i = 0; i < count; i++) {
    const value = samples[start + i];
    if (!Number.isFinite(value)) throw new Error('녹음에 유효하지 않은 샘플이 있습니다.');
    mean += value; peak = Math.max(peak, Math.abs(value));
    if (Math.abs(value) >= .999) clipped++;
  }
  mean /= count;
  const blockSize = Math.round(sampleRate * .5);
  const windowSize = Math.round(sampleRate), window = Float64Array.from({ length: windowSize }, (_, i) => Math.sin(Math.PI * (i + .5) / windowSize) ** 2);
  const coverage = new Float64Array(count), blocks = [];
  const reflect = index => {
    const period = 2 * (count - 1), value = (index % period + period) % period;
    return value < count ? value : period - value;
  };
  for (let offset = 0; offset < count; offset += blockSize) {
    const size = Math.min(blockSize, count - offset), first = Math.floor(offset + size / 2 - windowSize / 2);
    blocks.push({ offset, size, first });
    for (let i = 0; i < windowSize; i++) coverage[reflect(first + i)] += window[i] ** 2;
  }
  let nfft = 1; while (nfft < windowSize) nfft *= 2;
  const binBand = new Int16Array(nfft / 2 + 1).fill(-1);
  const aBin = new Float64Array(binBand.length);
  for (let k = 1; k < binBand.length; k++) {
    const frequency = k * sampleRate / nfft;
    aBin[k] = 10 ** (aWeightingDb(frequency) / 10);
    if (frequency >= EDGES[0] && frequency < EDGES.at(-1))
      binBand[k] = Math.min(20, Math.max(0, Math.floor(10 * Math.log10(frequency / EDGES[0]) + 1e-12)));
  }
  const rawFrames = [], average = AUDIO_BANDS.map(() => 0);
  let fullAEnergy = 0, selectedAEnergy = 0, fullEnergy = 0;
  for (let i = 0; i < count; i++) fullEnergy += (samples[start + i] - mean) ** 2 / count;
  for (const { offset, size, first } of blocks) {
    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    for (let i = 0; i < windowSize; i++) {
      const j = reflect(first + i);
      re[i] = (samples[start + j] - mean) * window[i] / Math.sqrt(coverage[j]);
    }
    fft(re, im);
    const energies = AUDIO_BANDS.map(() => 0);
    let frameA = 0, frameSelectedA = 0;
    for (let k = 1; k <= nfft / 2; k++) {
      const energy = (re[k] ** 2 + im[k] ** 2) * (k === nfft / 2 ? 1 : 2) / (nfft * size);
      frameA += energy * aBin[k];
      const band = binBand[k];
      if (band >= 0) { energies[band] += energy; frameSelectedA += energy * aBin[k]; }
    }
    const weight = size / count;
    fullAEnergy += frameA * weight; selectedAEnergy += frameSelectedA * weight;
    energies.forEach((value, band) => { average[band] += value * weight; });
    rawFrames.push({ startSec: offset / sampleRate, durationSec: size / sampleRate, energies, aEnergy: frameA });
  }
  if (!(fullAEnergy > 1e-18)) throw new Error('선택 구간에 분석할 수 있는 소리가 없습니다. 다른 구간을 선택하세요.');
  const gain = 10 ** (levelDbA / 10) / fullAEnergy;
  const bandLevelsDb = average.map(value => db(value * gain));
  const frames = rawFrames.map(frame => ({
    startSec: frame.startSec, durationSec: frame.durationSec,
    bandLevelsDb: frame.energies.map(value => db(value * gain)),
    fullBandLevelDbA: db(frame.aEnergy * gain),
  }));
  const retained = selectedAEnergy / fullAEnergy;
  const warnings = [];
  if (retained < .95) warnings.push(`입력의 A가중 에너지 ${(100 * (1 - retained)).toFixed(1)}%가 50Hz–5kHz 분석대역 밖에 있습니다. 이 성분은 이웃집 계산에서 제외됩니다.`);
  if (clipped / count > .001) warnings.push('디지털 최대 진폭 부근의 표본이 있습니다. 녹음 클리핑 여부를 확인하세요.');
  if (count / sampleRate < 1) warnings.push('1초보다 짧은 구간입니다. 최대 1초 평균 대신 전체 구간 평균을 사용합니다.');
  return {
    bandsHz: [...AUDIO_BANDS], bandLevelsDb, frames,
    offsetSeconds: start / sampleRate, durationSeconds: count / sampleRate,
    fullBandLevelDbA: levelDbA, analysisBandLevelDbA: db(weighted(average) * gain),
    exactAnalysisBandLevelDbA: db(selectedAEnergy * gain),
    retainedAWeightedFraction: retained,
    inputMean: mean, inputRms: Math.sqrt(fullEnergy), inputPeak: peak,
    clippingFraction: clipped / count, frameSeconds: .5, analysisWindowSeconds: 1,
    fftLength: nfft, binSpacingHz: sampleRate / nfft,
    bandEdgesHz: [...EDGES], reference: 'user-calibrated 1 m full-band LAeq',
    method: '1초 Hann 창·0.5초 간격·양끝 반사·표본별 창 에너지 정규화 → 전체대역 A보정 → 1/3옥타브 합산',
    calibrationNotice: '파일의 디지털 진폭은 실측 음압이 아닙니다. 지정한 1m 전체대역 크기로 보정한 입력입니다.',
    maximumNotice: '0.5초 간격·끝맞춤 스펙트럼의 1초 평균 중 최대 · 1초 분석창으로 평활됨 · LAFmax나 순간 음압 피크가 아닙니다.',
    warnings,
  };
}
