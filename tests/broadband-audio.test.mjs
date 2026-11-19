import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBroadbandAudio, AUDIO_BANDS } from '../source/broadband-audio.mjs';
import { aWeightingDb } from '../source/wave-audio.mjs';

const rate = 24000;
const tone = (frequencies, seconds = 2, gain = .1) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) =>
  frequencies.reduce((sum, frequency) => sum + gain * Math.sin(2 * Math.PI * frequency * i / rate), 0));
const near = (actual, expected, tolerance = .04) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test('recorded 1 kHz tone is calibrated against the analytical A-weight, independently of file gain', () => {
  const a = analyzeBroadbandAudio(tone([1000]), rate, { levelDbA: 60, durationSeconds: 2 });
  const b = analyzeBroadbandAudio(tone([1000], 2, .7), rate, { levelDbA: 60, durationSeconds: 2 });
  const i = AUDIO_BANDS.indexOf(1000);
  near(a.bandLevelsDb[i], 60 - aWeightingDb(1000));
  near(a.bandLevelsDb[i], b.bandLevelsDb[i], 1e-5);
  assert.ok(a.retainedAWeightedFraction > .999);
  assert.equal(a.frames.length, 4);
});

test('excluded 8 kHz energy is not redistributed to the transmitted 1 kHz band', () => {
  const a = analyzeBroadbandAudio(tone([1000, 8000]), rate, { levelDbA: 60, durationSeconds: 2 });
  const expectedBand = 60 - 10 * Math.log10(10 ** (aWeightingDb(1000) / 10) + 10 ** (aWeightingDb(8000) / 10));
  near(a.bandLevelsDb[AUDIO_BANDS.indexOf(1000)], expectedBand);
  near(a.retainedAWeightedFraction, 10 ** (aWeightingDb(1000) / 10) / (10 ** (aWeightingDb(1000) / 10) + 10 ** (aWeightingDb(8000) / 10)), .002);
  assert.ok(a.analysisBandLevelDbA < 58);
  assert.ok(a.warnings.some(message => message.includes('대역 밖')));
});

test('overlapping analysis windows, quiet periods and terminal partial blocks preserve the whole-clip energy average', () => {
  const samples = tone([250, 1000], 1.3);
  for (let i = Math.round(rate * .3); i < Math.round(rate * .8); i++) samples[i] = 0;
  const result = analyzeBroadbandAudio(samples, rate, { levelDbA: 67, durationSeconds: 2 });
  near(result.durationSeconds, 1.3, 1e-10);
  near(result.frames.at(-1).durationSec, .3, 1e-10);
  for (let band = 0; band < 21; band++) {
    const mean = result.frames.reduce((sum, frame) => sum + 10 ** (frame.bandLevelsDb[band] / 10) * frame.durationSec, 0) / result.durationSeconds;
    near(10 * Math.log10(mean), result.bandLevelsDb[band], 1e-8);
  }
  const rawRms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
  near(result.inputRms, rawRms, 1e-6);
});

test('low-frequency calibration is stable under start phase and noninteger cycle counts', () => {
  for (const frequency of [50, 1000 * 10 ** (-13 / 10), 63, 80]) {
    const results = [0, Math.PI / 2].map(phase => {
      const samples = Float32Array.from({ length: rate * 2 }, (_, i) => .1 * Math.sin(2 * Math.PI * frequency * i / rate + phase));
      const result = analyzeBroadbandAudio(samples, rate, { levelDbA: 60, durationSeconds: 2 });
      const band = AUDIO_BANDS.findIndex(f => Math.abs(Math.log(f / frequency)) < .1);
      const expected = 60 - aWeightingDb(frequency);
      near(result.bandLevelsDb[band], expected, .22);
      return result.bandLevelsDb[band];
    });
    near(results[0], results[1], .2);
  }
});

test('recording limits, silent clips and bad samples fail explicitly', () => {
  assert.throws(() => analyzeBroadbandAudio(new Float32Array(rate), rate), /소리/);
  assert.throws(() => analyzeBroadbandAudio(tone([1000]), 8000), /샘플레이트/);
  assert.throws(() => analyzeBroadbandAudio(tone([1000]), rate, { durationSeconds: 61 }), /60초/);
  assert.throws(() => analyzeBroadbandAudio(tone([1000]), rate, { offsetSeconds: 3 }), /0.1초/);
  const invalid = tone([1000]); invalid[3] = NaN;
  assert.throws(() => analyzeBroadbandAudio(invalid, rate), /샘플/);
});
