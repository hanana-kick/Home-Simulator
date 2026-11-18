import test from 'node:test';
import assert from 'node:assert/strict';
import { aWeightingDb, prepareAudioWaveform } from '../source/wave-audio.mjs';

function signal(frequencies, duration = .3) {
  const fs = 48000, samples = new Float32Array(Math.round(fs * duration));
  for (let i = 0; i < samples.length; i++) for (const [f, a] of frequencies) samples[i] += a * Math.sin(2 * Math.PI * f * i / fs);
  return samples;
}
const options = { targetRate: 6600, cutoffHz: 343, levelDbA: 60, duration: .3 };

test('A weighting follows the 1 kHz reference and published octave-band corrections', () => {
  assert.ok(Math.abs(aWeightingDb(1000)) < .01);
  assert.ok(Math.abs(aWeightingDb(125) + 16.1) < .1);
  assert.ok(Math.abs(aWeightingDb(250) + 8.6) < .1);
  assert.ok(Math.abs(aWeightingDb(500) + 3.2) < .1);
});

test('recorded-audio calibration is independent of digital recording gain', () => {
  const original = signal([[160, .3], [1000, .5]]);
  const quiet = Float32Array.from(original, x => x * .02);
  const a = prepareAudioWaveform(original, 48000, options);
  const b = prepareAudioWaveform(quiet, 48000, options);
  assert.ok(Math.abs(a.lowBandRmsPa / b.lowBandRmsPa - 1) < 1e-6);
  assert.equal(a.fullBandLevelDbA, 60);
  assert.equal(a.samples[0], 0);
  assert.equal(a.samples.at(-1), 0);
  const integral = a.samples.reduce((sum, x) => sum + x, 0) / a.sampleRate;
  assert.ok(Math.abs(integral) < 1e-9);
});

test('low-pass removes high audio frequencies without reallocating their energy', () => {
  const low = prepareAudioWaveform(signal([[160, 1]]), 48000, options);
  const high = prepareAudioWaveform(signal([[2000, 1]]), 48000, options);
  const mixed = prepareAudioWaveform(signal([[160, .2], [2000, 1]]), 48000, options);
  assert.ok(low.retainedEnergyFraction > .75);
  assert.ok(high.retainedEnergyFraction < 1e-5, String(high.retainedEnergyFraction));
  assert.ok(mixed.lowBandRmsPa < low.lowBandRmsPa * .1);
  const louder = prepareAudioWaveform(signal([[160, 1]]), 48000, { ...options, levelDbA: 66 });
  assert.ok(Math.abs(20 * Math.log10(louder.lowBandRmsPa / low.lowBandRmsPa) - 6) < .001);
});

test('silent/invalid clips and offsets fail explicitly', () => {
  assert.throws(() => prepareAudioWaveform(new Float32Array(48000), 48000, options), /소리/);
  assert.throws(() => prepareAudioWaveform(signal([[160, 1]]), 48000, { ...options, offsetSeconds: 1 }), /시작 시간/);
  assert.throws(() => prepareAudioWaveform(signal([[160, 1]]), 48000, { ...options, targetRate: 100 }), /주파수/);
});
