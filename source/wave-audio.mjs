/** Local recorded audio -> pressure at a hypothetical free-field 1 m reference.
 * The file's digital amplitude is NOT a sound-level measurement. Calibration
 * uses the user's chosen full-band dBA for the selected, gently tapered clip.
 * A spectral low-pass is applied AFTER calibration, with no gain restoration.
 * No dependency, upload, microphone, or playback is used by this module.
 */
const P0 = 20e-6;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export function aWeightingDb(frequency) {
  const f2 = frequency * frequency;
  if (!(frequency > 0)) return -Infinity;
  const ra = (12194 ** 2 * f2 * f2) /
    ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  return 20 * Math.log10(ra) + 2;
}

function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let length = 2; length <= n; length *= 2) {
    const angle = (inverse ? 2 : -2) * Math.PI / length;
    const wrStep = Math.cos(angle), wiStep = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let wr = 1, wi = 0;
      for (let j = 0; j < length / 2; j++) {
        const a = start + j, b = a + length / 2;
        const tr = wr * re[b] - wi * im[b], ti = wr * im[b] + wi * re[b];
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const next = wr * wrStep - wi * wiStep;
        wi = wr * wiStep + wi * wrStep; wr = next;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

function raisedEdge(index, count, edge) {
  const distance = Math.min(index, count - 1 - index);
  return distance >= edge ? 1 : .5 - .5 * Math.cos(Math.PI * Math.max(0, distance) / edge);
}

export function prepareAudioWaveform(monoSamples, sampleRate, options = {}) {
  if (!monoSamples?.length || !Number.isFinite(sampleRate) || sampleRate < 1000 || sampleRate > 384000)
    throw new Error('녹음 파일의 샘플 또는 샘플레이트가 올바르지 않습니다.');
  const targetRate = Number(options.targetRate);
  const cutoffHz = Number(options.cutoffHz);
  const duration = clamp(Number(options.duration) || .3, .15, .5);
  const levelDbA = clamp(Number(options.levelDbA) || 60, 20, 110);
  if (!(targetRate > 2 * cutoffHz && cutoffHz >= 40 && cutoffHz < sampleRate / 2))
    throw new Error('녹음 파일과 음파 격자의 주파수 범위가 맞지 않습니다.');
  const start = Math.floor(Math.max(0, Number(options.offsetSeconds) || 0) * sampleRate);
  if (start >= monoSamples.length) throw new Error('선택한 시작 시간이 녹음 파일의 길이를 넘었습니다.');
  const count = Math.max(2, Math.round(duration * sampleRate));
  if (count > 192000) throw new Error('선택한 녹음 구간이 너무 큽니다.');
  let nfft = 1; while (nfft < count * 2) nfft *= 2;
  const re = new Float64Array(nfft), im = new Float64Array(nfft);
  const pad = Math.floor((nfft - count) / 2), edge = Math.max(4, Math.round(.025 * sampleRate));
  let rawMean = 0, available = Math.min(count, monoSamples.length - start);
  for (let i = 0; i < available; i++) {
    const value = monoSamples[start + i];
    if (!Number.isFinite(value)) throw new Error('녹음 파일에 유효하지 않은 샘플이 있습니다.');
    rawMean += value;
  }
  rawMean /= available;
  let fullEnergy = 0;
  for (let i = 0; i < count; i++) {
    const value = (i < available ? monoSamples[start + i] - rawMean : 0) * raisedEdge(i, count, edge);
    re[pad + i] = value; fullEnergy += value * value;
  }
  fft(re, im);
  let aEnergy = 0;
  for (let i = 1; i < nfft; i++) {
    const frequency = Math.min(i, nfft - i) * sampleRate / nfft;
    aEnergy += (re[i] ** 2 + im[i] ** 2) * 10 ** (aWeightingDb(frequency) / 10);
  }
  const aRms = Math.sqrt(aEnergy / (nfft * count));
  if (!(aRms > 1e-9)) throw new Error('선택한 구간에 보정할 수 있는 소리가 없습니다. 다른 구간을 선택하세요.');
  const calibration = P0 * 10 ** (levelDbA / 20) / aRms;
  // Smooth 80–100% cutoff transition, zero at and above the grid cutoff.
  // Very-low-frequency recording DC/wind is excluded below 20 Hz.
  for (let i = 0; i < nfft; i++) {
    const f = Math.min(i, nfft - i) * sampleRate / nfft;
    const highpass = f <= 10 ? 0 : f >= 20 ? 1 : .5 - .5 * Math.cos(Math.PI * (f - 10) / 10);
    const lowpass = f <= cutoffHz * .8 ? 1 : f >= cutoffHz ? 0 : .5 + .5 * Math.cos(Math.PI * (f / cutoffHz - .8) / .2);
    re[i] *= highpass * lowpass * calibration;
    im[i] *= highpass * lowpass * calibration;
  }
  fft(re, im, true);
  const length = Math.ceil(duration * targetRate) + 1;
  const values = new Float64Array(length), weights = new Float64Array(length);
  const taper = Math.max(3, Math.round(.01 * targetRate));
  let integral = 0, weightSum = 0;
  for (let i = 0; i < length; i++) {
    const x = pad + Math.min(count - 1, i * sampleRate / targetRate);
    const a = Math.floor(x), f = x - a;
    values[i] = (re[a] * (1 - f) + re[Math.min(a + 1, nfft - 1)] * f) * raisedEdge(i, length, taper);
    // A smooth finite-window correction removes residual numerical DC after
    // cropping. It does not restore removed high-frequency sound energy.
    weights[i] = Math.sin(Math.PI * i / (length - 1)) ** 2;
    integral += values[i]; weightSum += weights[i];
  }
  const correction = integral / weightSum;
  let lowEnergy = 0;
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    samples[i] = values[i] - correction * weights[i];
    lowEnergy += samples[i] ** 2;
  }
  samples[0] = samples[length - 1] = 0;
  const lowBandRmsPa = Math.sqrt(lowEnergy / (length - 1));
  const fullBandRmsPa = Math.sqrt(fullEnergy / count) * calibration;
  return {
    samples, sampleRate: targetRate, units: 'Pa at 1m', cutoffHz,
    fullBandLevelDbA: levelDbA, lowBandRmsPa, fullBandRmsPa,
    retainedEnergyFraction: fullBandRmsPa > 0 ? lowBandRmsPa ** 2 / fullBandRmsPa ** 2 : 0,
    duration, offsetSeconds: start / sampleRate,
    preparation: '선택 구간의 A보정 크기 보정 → 격자 대역 필터 → 시간창·DC 정리. 전 대역 측정값 아님.',
  };
}
