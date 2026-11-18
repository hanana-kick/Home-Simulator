import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { WAVE_PHYSICS, waveNumerics, boundaryAdmittance, createPressureCore, createWaveReference, createWaveSimulation } from '../source/wave-engine.mjs';

const { rho, c } = WAVE_PHYSICS, z0 = rho * c;
const model = JSON.parse(fs.readFileSync(new URL('../cad/model.json', import.meta.url)));

function phasor(trace, dt, frequency) {
  let re = 0, im = 0;
  for (let i = 0; i < trace.length; i++) {
    re += trace[i] * Math.cos(2 * Math.PI * frequency * (i + 1) * dt);
    im -= trace[i] * Math.sin(2 * Math.PI * frequency * (i + 1) * dt);
  }
  return { re, im, magnitude: Math.hypot(re, im), phase: Math.atan2(im, re) };
}

/** Long 1D guide, a special case of the very same finite-volume PDE kernel.
 * A right-travelling Gaussian-windowed plane wave starts well before a sheet.
 * End reflections cannot reach the probes during the retained pulse. */
function tube({ dx = .2, mass = 0, resistance = 0, frequency = 125, duration = .28 } = {}) {
  const n = Math.round(120 / dx), dt = .5 * dx / c, area = 1;
  const faces = Array.from({ length: n - 1 }, (_, i) => ({
    a: i, b: i + 1, area, length: dx,
    mass: i === n / 2 - 1 ? mass : 0, resistance: i === n / 2 - 1 ? resistance : 0,
  }));
  const packet = x => Math.exp(-(((x + 28) / 6) ** 2)) * Math.cos(2 * Math.PI * frequency * (x + 28) / c);
  const initialPressure = Float64Array.from({ length: n }, (_, i) => packet(-60 + (i + .5) * dx));
  const initialVelocity = Float64Array.from({ length: n - 1 }, (_, i) => packet(-60 + (i + 1) * dx + c * dt / 2) / z0);
  const boundary = new Float64Array(n); boundary[0] = boundary[n - 1] = area / z0;
  const core = createPressureCore({ cellCount: n, volume: area * dx, faces, boundary, dt, initialPressure, initialVelocity });
  const indices = [Math.round((10 + 60) / dx - .5), Math.round((20 + 60) / dx - .5)];
  const positions = indices.map(i => -60 + (i + .5) * dx);
  const traces = indices.map(() => new Float64Array(Math.ceil(duration / dt)));
  for (let i = 0; i < traces[0].length; i++) {
    core.step(); traces.forEach((trace, j) => { trace[i] = core.pressure[indices[j]]; });
  }
  return { traces, dt, positions, finalEnergy: core.energy() };
}

test('anisotropic height is exactly 2.3 m and CFL bound is enforced', () => {
  for (const dx of [.15, .1, .075]) {
    const n = waveNumerics({ dx }, 2.3);
    assert.ok(Math.abs(n.ny * n.dy - 2.3) < 1e-14);
    assert.ok(Math.abs(n.cutoffHz - c / (10 * dx)) < 1e-10);
    assert.ok(c * n.dt * Math.sqrt(1 / n.dx ** 2 + 1 / n.dy ** 2 + 1 / n.dz ** 2) < 1);
  }
  assert.throws(() => createPressureCore({ cellCount: 2, volume: 1, faces: [{ a: 0, b: 1, area: 1, length: 1 }], dt: .01 }), /CFL/);
});

test('lossless staggered energy is conserved and resistive corners stay passive', () => {
  const faces = [
    { a: 0, b: 1, area: .01, length: .1 }, { a: 0, b: 2, area: .01, length: .1 },
    { a: 0, b: 3, area: .01, length: .1 }, { a: 1, b: 2, area: .01, length: .1 },
  ];
  const dt = .0001, initialPressure = [1, -.3, .2, 0];
  const core = createPressureCore({ cellCount: 4, volume: .001, faces, dt, initialPressure });
  const initial = core.modifiedEnergy();
  let largestError = 0;
  for (let i = 0; i < 4000; i++) {
    core.step(); largestError = Math.max(largestError, Math.abs(core.modifiedEnergy() / initial - 1));
  }
  assert.ok(largestError < 1e-11, `${largestError}`);
  const lossy = createPressureCore({ cellCount: 4, volume: .001, faces: faces.map(f => ({ ...f, resistance: 100 })), boundary: Array(4).fill(3 * .01 * boundaryAdmittance(1)), dt, initialPressure });
  const start = lossy.energy();
  for (let i = 0; i < 2000; i++) lossy.step();
  assert.ok(lossy.energy() < start * 1e-12);
  assert.ok(lossy.pressure.every(Number.isFinite));
});

test('a zero-mass zero-resistance sheet is the same PDE air face', () => {
  const options = { cellCount: 2, volume: .001, dt: .0001, initialPressure: [1, 0] };
  const a = createPressureCore({ ...options, faces: [{ a: 0, b: 1, area: .01, length: .1 }] });
  const b = createPressureCore({ ...options, faces: [{ a: 0, b: 1, area: .01, length: .1, mass: 0, resistance: 0 }] });
  for (let i = 0; i < 100; i++) { a.step(); b.step(); }
  assert.deepEqual(a.pressure, b.pressure); assert.deepEqual(a.velocity, b.velocity);
});

test('propagated plane wave agrees with passive-sheet mass law and resistance benchmark', () => {
  const frequency = 125, reference = tube({ frequency, dx: .1 });
  const incident = phasor(reference.traces[0], reference.dt, frequency).magnitude;
  const measurements = [];
  for (const [mass, resistance] of [[0, 2 * z0], [2, 0], [5, 0]]) {
    const run = tube({ mass, resistance, frequency, dx: .1 });
    const ratio = phasor(run.traces[0], run.dt, frequency).magnitude / incident;
    const expected = 2 * z0 / Math.hypot(2 * z0 + resistance, 2 * Math.PI * frequency * mass);
    assert.ok(Math.abs(20 * Math.log10(ratio / expected)) < .08, `m=${mass},R=${resistance}: ${ratio} vs ${expected}`);
    measurements.push(ratio);
  }
  assert.ok(measurements[2] < measurements[1]);
  assert.ok(Math.abs(measurements[0] - .5) < .01);
  const coarseReference = tube({ frequency, dx: .2 }), coarseSheet = tube({ frequency, dx: .2, mass: 5 });
  const coarseRatio = phasor(coarseSheet.traces[0], coarseSheet.dt, frequency).magnitude / phasor(coarseReference.traces[0], coarseReference.dt, frequency).magnitude;
  const expectedMass5 = 2 * z0 / Math.hypot(2 * z0, 2 * Math.PI * frequency * 5);
  assert.ok(Math.abs(measurements[2] - expectedMass5) < .4 * Math.abs(coarseRatio - expectedMass5));
});

test('propagated wavelength and delay converge when the grid is refined', () => {
  const frequency = 125;
  const errors = [];
  for (const dx of [.25, .125]) {
    const run = tube({ dx, frequency });
    const p1 = phasor(run.traces[0], run.dt, frequency), p2 = phasor(run.traces[1], run.dt, frequency);
    const distance = run.positions[1] - run.positions[0], exactPhase = -2 * Math.PI * frequency * distance / c;
    let phase = p2.phase - p1.phase;
    phase += 2 * Math.PI * Math.round((exactPhase - phase) / (2 * Math.PI));
    const measuredWavelength = -2 * Math.PI * distance / phase;
    const error = Math.abs(measuredWavelength / (c / frequency) - 1);
    assert.ok(error < .02, `dx=${dx} wavelength error=${error}`);
    errors.push(error);
    // Carrier phase divided by frequency is an actual propagation delay;
    // it is not advanced directly by the rendering frame rate.
    const delay = -phase / (2 * Math.PI * frequency);
    assert.ok(Math.abs(delay / (distance / c) - 1) < .025);
  }
  assert.ok(errors[1] < errors[0] * .4, `${errors}`);
});

function freeFieldPulse() {
  const nx = 51, dx = .2, n = nx ** 3, volume = dx ** 3;
  const dt = .9 * dx / (c * Math.sqrt(3));
  const index = (x, y, z) => (y * nx + z) * nx + x;
  const faces = [];
  for (let y = 0; y < nx; y++) for (let z = 0; z < nx; z++) for (let x = 0; x < nx; x++) {
    const a = index(x, y, z);
    if (x + 1 < nx) faces.push({ a, b: index(x + 1, y, z), area: dx ** 2, length: dx });
    if (y + 1 < nx) faces.push({ a, b: index(x, y + 1, z), area: dx ** 2, length: dx });
    if (z + 1 < nx) faces.push({ a, b: index(x, y, z + 1), area: dx ** 2, length: dx });
  }
  const core = createPressureCore({ cellCount: n, volume, faces, dt });
  const center = (nx - 1) / 2, source = index(center, center, center);
  const receivers = [index(center + 5, center, center), index(center + 10, center, center)];
  const t0 = .012, sigma = .004, amplitude = 1e-5;
  const Q = t => amplitude * Math.exp(-(((t - t0) / sigma) ** 2));
  const exact = (t, r) => {
    const shifted = t - r / c - t0;
    return rho / (4 * Math.PI * r) * -2 * shifted / sigma ** 2 * amplitude * Math.exp(-((shifted / sigma) ** 2));
  };
  const duration = .029, steps = Math.ceil(duration / dt), traces = receivers.map(() => new Float64Array(steps));
  for (let i = 0; i < steps; i++) {
    core.step({ indices: [source], weights: [1], volumeVelocity: Q((i + .5) * dt) });
    receivers.forEach((receiver, j) => { traces[j][i] = core.pressure[receiver]; });
  }
  return { dt, traces, exact };
}

test('3D monopole has physical arrival, calibrated pressure, and inverse-distance amplitude', () => {
  const { traces, dt, exact } = freeFieldPulse();
  const fits = [], peaks = [];
  for (let j = 0; j < traces.length; j++) {
    const r = j + 1;
    let dot = 0, referenceEnergy = 0, squaredError = 0, maxPressure = 0;
    for (let i = 0; i < traces[j].length; i++) {
      const predicted = exact((i + 1) * dt, r);
      dot += predicted * traces[j][i]; referenceEnergy += predicted ** 2;
      squaredError += (traces[j][i] - predicted) ** 2;
      maxPressure = Math.max(maxPressure, Math.abs(traces[j][i]));
    }
    fits.push(dot / referenceEnergy); peaks.push(maxPressure);
    assert.ok(Math.abs(dot / referenceEnergy - 1) < .08, `r=${r} Pa calibration=${dot / referenceEnergy}`);
    assert.ok(Math.sqrt(squaredError / referenceEnergy) < .12, `r=${r} propagation error=${Math.sqrt(squaredError / referenceEnergy)}`);
    // Causality of nearest-face propagation: a cell cannot respond before any
    // path of at least r/dx face updates reaches it.
    assert.ok(traces[j].slice(0, (j + 1) * 5 - 1).every(value => value === 0));
  }
  assert.ok(Math.abs(20 * Math.log10(peaks[0] / peaks[1]) - 6.0206) < .5, `${peaks}`);
});

test('source filtering preserves removed energy and explicitly reports no resolved fundamental', () => {
  const config = { duration: .15, sourceMode: 'conversation' }, numerics = waveNumerics({ dx: .15 });
  const a = createWaveReference({ level: 60, pitch: 160 }, config, numerics);
  const b = createWaveReference({ level: 70, pitch: 160 }, config, numerics);
  assert.ok(a.retainedEnergyFraction > 0 && a.retainedEnergyFraction < .9);
  assert.ok(Math.abs(20 * Math.log10(b.lowBandRmsPa / a.lowBandRmsPa) - 10) < 1e-6);
  const unsupported = createWaveReference({ level: 60, pitch: 400 }, config, numerics);
  assert.equal(unsupported.hasResolvedContent, false);
  assert.equal(unsupported.lowBandRmsPa, 0); assert.ok(unsupported.samples.every(value => value === 0));
});

test('real house includes all indoor rooms, adjoining wall, exact ceiling, door topology and physical traces', () => {
  const base = { source: { x: 9.05, y: 1.2, z: 1.15, level: 60, pitch: 160 }, config: { dx: .15, duration: .15 } };
  const simulation = createWaveSimulation(model, base);
  const meta = simulation.metadata;
  assert.equal(meta.rooms.length, 7); assert.ok(meta.rooms.every(room => room.airCells > 0));
  assert.equal(meta.domain.maxY, 2.3); assert.ok(meta.sharedFaces > 0 && meta.sheetFaces > meta.sharedFaces);
  assert.equal(meta.neighbor.z1, -.2); assert.equal(meta.neighbor.z0, -3.2);
  assert.ok(Math.abs(meta.sourceCalibration.finalVolumeVelocity) < 1e-8);
  simulation.step(1);
  assert.equal(simulation.frame().probes.neighbor.rmsPa, 0);
  simulation.step(10000);
  const frame = simulation.frame();
  assert.equal(frame.finished, true); assert.ok(frame.probes.neighbor.rmsPa > 0);
  assert.ok(frame.slice.pressure.every(Number.isFinite)); assert.ok(frame.metrics.energyJ > 0);
  assert.ok(frame.probes.source.pressure.some(value => value > 0) && frame.probes.source.pressure.some(value => value < 0));
  assert.ok(Math.abs(frame.probes.neighbor.times.at(-1) - meta.duration) < 1e-7);
  const upper = simulation.frame(2.29); assert.ok(upper.slice.sliceY < 2.3);
  const open = createWaveSimulation(model, { ...base, settings: { doorStates: { 'opening-9': true } } });
  assert.ok(open.metadata.openFaces > 0);
  assert.ok(open.metadata.openingSheetFaces < meta.openingSheetFaces);
  assert.throws(() => createWaveSimulation(model, { ...base, source: { x: 3, y: 1, z: 6.5 } }), /마당/);
});
