import { waveNumerics } from './wave-engine.mjs';
import { prepareAudioWaveform } from './wave-audio.mjs';

const DEFAULTS = { dx: .10, duration: .3, sliceY: 1.2, neighborDepth: 3, partitionMass: 400, partitionResistance: 400, wallAlpha: .03, sourceMode: 'conversation', toneFrequency: 125 };
const PRESETS = {
  conversation: { label: '일상 대화 · 합성 음성', level: 60, pitch: 160 },
  livestream: { label: '라이브 방송 진행 · 합성 음성', level: 66, pitch: 160 },
  singing: { label: '노래 · 합성 음성', level: 75, pitch: 220 },
  tone: { label: '순음 · 한 주파수' },
  pulse: { label: '짧은 펄스 · 파동 전파 확인' },
  recording: { label: '녹음 파일 · 선택한 구간' },
};
const MATERIAL_PRESETS = { masonry: { mass: 400, resistance: 400 }, lightweight: { mass: 40, resistance: 250 } };
const P0 = 20e-6;
const $ = id => document.getElementById(id);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const finiteText = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const pressureText = value => !Number.isFinite(value) ? '—' : value === 0 ? '0' : Math.abs(value) < .001 ? value.toExponential(2) : value.toPrecision(3);
const voiceMode = mode => ['conversation', 'livestream', 'singing', 'voice'].includes(mode);
const option = (value, label) => `<option value="${escape(value)}">${escape(label)}</option>`;

function insideRoom(room, x, z) {
  let inside = false;
  for (let i = 0, j = room.poly.length - 1; i < room.poly.length; j = i++) {
    const a = room.poly[i], b = room.poly[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function pressureColor(value, limit) {
  const t = clamp(Math.abs(value) / limit, 0, 1), from = [248, 248, 244], to = value < 0 ? [52, 116, 164] : [191, 73, 62];
  return from.map((v, i) => Math.round(v + (to[i] - v) * t));
}

function rmsColor(pa) {
  const level = pa > 0 ? 20 * Math.log10(pa / P0) : -120;
  const stops = [[241, 245, 234], [209, 226, 177], [137, 184, 165], [75, 139, 145], [48, 79, 110]];
  const t = clamp(level / 90, 0, 1) * 4, i = Math.min(3, Math.floor(t));
  return stops[i].map((value, channel) => Math.round(value + (stops[i + 1][channel] - value) * (t - i)));
}

export function initWaveUI(data, { getAcousticState, setSource, onChooseSourcePosition }) {
  const stage = $('waveStage'), sidebar = $('waveSidebar');
  if (!stage || !sidebar) throw new Error('음파 시뮬레이션 표시 영역이 없습니다.');
  const config = { ...DEFAULTS };
  const indoorRooms = data.rooms.filter(room => room.kind === 'interior');
  let active = false, status = 'idle', worker = null, runId = 0, frame = null, metadata = null;
  let viewMode = 'pressure', pressureLimit = .02, traceMode = 'both', placement = false, focusNeighbor = false, mapGeometry = null;
  let wallStarted = 0, wallAccumulated = 0, clockTimer = 0, audioClip = null, audioDecodeId = 0, decoding = false;
  let audioOffset = 0, referenceWaveform = null, runningSource = null, runningSettings = null;
  let sharedFingerprint = '', resizeObserver, imageKey = '', imageBuffer = null;
  const sliceCanvas = document.createElement('canvas');
  const sliceContext = sliceCanvas.getContext('2d');

  stage.classList.add('wave-stage'); sidebar.classList.add('wave-sidebar');
  stage.innerHTML = `<div class="wave-stage-inner">
    <div class="wave-title-row"><div><p class="wave-eyebrow">3D ACOUSTIC WAVE FIELD</p><h2>저주파 음파 분석</h2></div><div class="wave-title-actions"><span class="wave-status" id="waveStatus" role="status">실행 전</span><a class="wave-jump-link" href="#waveSidebar">계산 조건으로 ↓</a></div></div>
    <div class="wave-context"><strong>작업실의 도면 위쪽 벽에 이웃 방이 접한 조건</strong><p id="waveGeometrySummary">이웃 방 폭 2.5m · 깊이 3m · 높이 2.3m 가정. 저주파의 3차원 음압 단면입니다. 대화·방송·노래의 광대역 비교는 ‘이웃집 소음’에서 계산합니다.</p></div>
    <section class="wave-field-card" aria-label="3차원 음압장의 수평 단면">
      <div class="wave-field-toolbar"><div class="wave-view-group"><div class="wave-view-tabs" aria-label="표시할 계산량"><button type="button" id="wavePressureView" aria-pressed="true">순간 음압</button><button type="button" id="waveRmsView" aria-pressed="false">누적 RMS</button></div><button type="button" class="wave-focus-button" id="waveFocusNeighbor" aria-pressed="false">이웃집 확대</button></div><label class="wave-slice-control" for="waveSliceHeight">단면 높이 <input id="waveSliceHeight" type="range" min="0.2" max="2.2" step="0.1" value="${config.sliceY}"><output id="waveSliceHeightValue">1.2 m</output></label></div>
      <div class="wave-map-wrap"><canvas id="waveCanvas" class="wave-canvas" tabindex="0" aria-label="집과 이웃 방의 계산 음압 수평 단면. 소음원 위치 지정 버튼을 누른 후 클릭하거나 방향키로 이동할 수 있습니다."></canvas><p class="wave-map-state" id="waveMapState">평면·경계 미리보기 · 시작을 누르면 음압을 계산합니다.</p></div>
      <div class="wave-legend-row"><div class="wave-legend"><span id="waveLegendTitle">음압 · Pa</span><div class="wave-legend-gradient" id="waveLegendGradient"></div><div class="wave-legend-labels"><span id="waveLegendMin">≤ −0.02</span><span id="waveLegendMid">0</span><span id="waveLegendMax">≥ +0.02</span></div></div><div class="wave-color-range" id="wavePressureRangeField"><label for="wavePressureRange">고정 색 범위</label><select id="wavePressureRange"><option value="0.00001">±0.00001 Pa</option><option value="0.00002">±0.00002 Pa</option><option value="0.0001">±0.0001 Pa</option><option value="0.0005">±0.0005 Pa</option><option value="0.001">±0.001 Pa</option><option value="0.002">±0.002 Pa</option><option value="0.01">±0.01 Pa</option><option value="0.02" selected>±0.02 Pa</option><option value="0.1">±0.1 Pa</option><option value="0.5">±0.5 Pa</option><option value="2">±2 Pa</option></select></div><p class="wave-field-note" id="waveFieldUnitNote">파랑: 음압 음수 · 빨강: 음압 양수. 색 범위는 자동으로 바뀌지 않습니다.</p></div>
      <div class="wave-map-caption"><span id="waveGridCaption">격자 0.10 m · 계산 전</span><span id="waveSliceCaption">계산 전 · 단면 높이 1.2 m</span></div>
    </section>
    <section class="wave-run-panel" aria-label="시뮬레이션 실행"><div class="wave-run-buttons"><button type="button" class="button primary" id="waveStart">시뮬레이션 시작</button><button type="button" class="button" id="wavePause" disabled>일시정지</button><button type="button" class="button" id="waveCancel" disabled>중단</button><button type="button" class="wave-position-button" id="wavePlaceSource" aria-pressed="false">소음원 위치 지정</button></div><div class="wave-progress-row"><progress id="waveProgress" max="1" value="0" aria-label="물리 모사 시간 진행률"></progress><span id="waveProgressText">0%</span></div><div class="wave-run-metrics"><div><span>물리 모사 시간</span><strong id="wavePhysicalTime">0.0 <small>/ 300 ms</small></strong></div><div><span>계산에 걸린 시간</span><strong id="waveWallTime">0.0 <small>초</small></strong></div><div><span>시간 단계</span><strong id="waveStepCount">0 <small>step</small></strong></div></div><p class="wave-run-note" id="waveRunNote">실행은 시작 버튼을 눌렀을 때만 진행됩니다. 화면을 떠나면 일시정지합니다.</p></section>
    <div class="wave-error" id="waveError" role="alert" hidden></div>
    <section class="wave-trace-card" aria-labelledby="waveTraceTitle"><div class="wave-section-heading"><h3 id="waveTraceTitle">두 지점의 압력 기록</h3><span>실제 계산 표본</span></div><div class="wave-trace-controls"><label for="waveTraceMode">기록 보기 <select id="waveTraceMode"><option value="both">양측 · 같은 Pa 축</option><option value="neighbor">이웃집 · 작은 압력 확인</option></select></label><span id="waveTraceScale">Pa 축 · 선택 곡선에 맞춤</span></div><div class="wave-trace-keys"><span id="waveTraceSourceKey"><i class="wave-source-key"></i>P1 · 우리집 측</span><span><i class="wave-neighbor-key"></i>P2 · 이웃 방</span></div><canvas id="waveTraceCanvas" class="wave-trace-canvas" role="img" aria-label="계산 전. 실행하면 우리집 측과 이웃 방 측정점의 시간별 압력 기록을 표시합니다."></canvas><div class="wave-probe-grid"><div class="wave-probe-card"><span class="wave-probe-label">P1 · 우리집 측</span><div><strong id="waveSourceRms">—</strong><small>dB SPL</small></div><p id="waveSourceProbePosition">계산 후 측정점 좌표 표시</p><span id="waveSourcePressure">RMS — Pa</span></div><div class="wave-probe-card wave-probe-neighbor"><span class="wave-probe-label">P2 · 이웃 방</span><div><strong id="waveNeighborRms">—</strong><small>dB SPL</small></div><p id="waveNeighborProbePosition">계산 후 측정점 좌표 표시</p><span id="waveNeighborPressure">RMS — Pa</span></div></div><p class="wave-probe-note">시작 이후 누적 RMS · 계산 대역 내 · A보정 전. 전 대역 음성 dBA 또는 방 전체 평균값이 아닙니다. 지도 표식은 평면 투영이며 측정 높이는 좌표에 표시합니다.</p></section>
    <section class="wave-method-note"><h3>이 화면이 계산하는 것</h3><p>3차원 공기 중 압력·입자속도의 시간 변화를 격자에서 풀어 반사, 간섭, 회절과 경계 투과를 계산합니다. 표시된 색과 압력 기록은 계산된 음장입니다.</p><p id="waveBandNote">격자가 표현할 수 있는 저주파 대역만 계산합니다.</p><p>공유벽은 면밀도·저항을 가진 경계로 가정합니다. 실제 벽판의 휨 진동, 구조를 통한 우회 전달, 시공 틈새는 포함하지 않습니다. 이웃집 실제 구조와 벽체 시험값은 미입력입니다.</p><a href="./acoustic-notes.html" target="_blank" rel="noopener">계산 방법·가정·출처 보기 ↗</a></section>
  </div>`;
  stage.querySelector('.wave-field-card').before(stage.querySelector('.wave-run-panel'));
  sidebar.innerHTML = `<div class="wave-sidebar-heading"><p class="wave-eyebrow">SIMULATION SETUP</p><h2>음파 계산 조건</h2><a class="wave-jump-link wave-return-link" href="#waveStage">계산 화면으로 ↑</a></div>
    <section class="wave-settings-section"><h3><span>01</span> 입력 소리</h3><div class="wave-field"><label for="waveSourceMode">입력 파형</label><select id="waveSourceMode">${Object.entries(PRESETS).map(([key, preset]) => option(key, preset.label)).join('')}</select></div>
      <div id="waveRecordingFields" hidden><div class="wave-field"><label for="waveAudioFile">녹음 파일 · 최대 32 MB</label><input id="waveAudioFile" type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac,.webm"><p class="wave-field-note" id="waveAudioMeta">선택한 짧은 구간을 계산합니다. 파일은 기기 안에서 처리하며 업로드하지 않습니다.</p></div><div class="wave-field"><label for="waveAudioOffset">구간 시작 시간</label><div class="wave-input-unit"><input id="waveAudioOffset" type="number" min="0" max="0" step="0.1" value="0"><span>초</span></div></div></div>
      <div class="wave-field"><label for="waveSourceLevel">1 m 기준 입력 크기 · 보정 가정</label><div class="wave-input-unit"><input id="waveSourceLevel" type="number" min="30" max="100" step="1" value="60"><span>dBA</span></div><p class="wave-field-note" id="waveSourceLevelNote">입력 크기에서 계산 대역 밖의 성분을 제거합니다. 제거된 에너지를 다시 키우지 않습니다.</p></div>
      <div class="wave-field" id="wavePitchField"><label for="waveSourcePitch">목소리 기본주파수 · F0</label><div class="wave-input-unit"><input id="waveSourcePitch" type="number" min="80" max="350" step="1" value="160"><span>Hz</span></div></div>
      <div class="wave-field" id="waveToneField" hidden><label for="waveToneFrequency">순음 주파수</label><div class="wave-input-unit"><input id="waveToneFrequency" type="number" min="40" max="343" step="1" value="125"><span>Hz</span></div></div>
      <p class="wave-source-band-warning" id="waveSourceBandWarning" hidden></p><p class="wave-field-note" id="waveWaveformNote">대화·방송·노래는 크기와 F0가 다른 합성 음성 입력입니다. 실제 문장과 노래를 재현하지 않습니다.</p>
    </section>
    <section class="wave-settings-section"><h3><span>02</span> 우리집 위치·창문</h3><div class="wave-field"><label for="waveSourceRoom">소음원이 있는 방</label><select id="waveSourceRoom">${indoorRooms.map(room => option(room.id, room.name)).join('')}<option value="custom" disabled>현재 실내 계산영역 밖</option></select></div><div class="wave-fields-three"><div class="wave-field"><label for="waveSourceX">X · 도면 오른쪽</label><input id="waveSourceX" type="number" min="0" max="11.5" step="0.05" value="8.9"></div><div class="wave-field"><label for="waveSourceZ">Z · 도면 아래쪽</label><input id="waveSourceZ" type="number" min="0" max="5.3" step="0.05" value="1.2"></div><div class="wave-field"><label for="waveSourceY">높이 · m</label><input id="waveSourceY" type="number" min="0.2" max="2.2" step="0.1" value="1.5"></div></div><p class="wave-field-note">위치·높이·입력 크기와 F0는 실내 지도와 공유합니다. 단면을 클릭해 위치를 지정할 수도 있습니다.</p><button type="button" class="wave-text-button" id="waveOpenings">우리집 창·문 설정 ↗</button><p class="wave-field-note" id="waveOpeningsSummary"></p></section>
    <section class="wave-settings-section"><h3><span>03</span> 이웃 방·벽체 가정</h3><p class="wave-location-note"><strong>작업실 위쪽 벽 · 위치 고정</strong>접한 폭 2.5m / 벽 위치 Z −0.2~0m<br>이웃 방 높이 2.3m</p><div class="wave-field"><label for="waveNeighborDepth">이웃 방 깊이 · 가정</label><div class="wave-input-unit"><input id="waveNeighborDepth" type="number" min="2" max="6" step="0.1" value="3"><span>m</span></div></div>
      <div class="wave-field"><label for="waveMaterialPreset">벽체 비교 가정</label><select id="waveMaterialPreset"><option value="masonry">무거운 벽 · 400 kg/m² 가정</option><option value="lightweight">가벼운 벽 · 40 kg/m² 가정</option><option value="custom">직접 지정</option></select></div><div class="wave-field"><label for="wavePartitionMass">공유벽 면밀도 · 가정</label><div class="wave-input-unit"><input id="wavePartitionMass" type="number" min="1" max="1000" step="1" value="400"><span>kg/m²</span></div><p class="wave-field-note">벽 단위 면적의 질량입니다. 구조·두께의 실측값은 입력되지 않았습니다.</p></div><div class="wave-field"><label for="wavePartitionResistance">공유벽 저항 · 감쇠 가정</label><div class="wave-input-unit wave-input-wide-unit"><input id="wavePartitionResistance" type="number" min="0" max="10000" step="50" value="400"><span>Pa·s/m</span></div></div><div class="wave-field"><label for="waveWallAlpha">표면 흡음률 α · 수직 입사 가정</label><input id="waveWallAlpha" type="number" min="0" max="0.9" step="0.01" value="0.03"><p class="wave-field-note">실크벽지 등 단단한 표면의 저흡음 대체값을 벽·바닥·천장에 적용합니다. 0은 흡음 없음, 1은 완전 흡음입니다. 제품 시험값이 아닙니다.</p></div></section>
    <section class="wave-settings-section"><h3><span>04</span> 계산 격자·모사 시간</h3><div class="wave-field"><label for="waveGridSpacing">수평 격자 간격</label><select id="waveGridSpacing"><option value="0.15">0.15 m · 상한 약 229 Hz</option><option value="0.1" selected>0.10 m · 상한 약 343 Hz</option><option value="0.075">0.075 m · 상한 약 457 Hz</option></select><p class="wave-field-note">작은 격자는 더 높은 주파수를 담지만 계산량이 늘어납니다. 높이 방향은 2.3m에 맞춰 조정됩니다.</p></div><div class="wave-field"><label for="waveDuration">물리 모사 시간</label><select id="waveDuration"><option value="0.15">150 ms</option><option value="0.3" selected>300 ms</option><option value="0.5">500 ms</option></select></div><div class="wave-numerics-note"><strong id="waveSupportedBand">계산 대역 상한 약 343 Hz</strong><p id="waveTimeStep">시간 간격은 격자에 맞춰 설정됩니다.</p><p id="waveCalibrationNote">전 대역 음성 소음과 결과 단위가 다릅니다.</p></div></section>
    <p class="wave-sidebar-footnote">실측 차음 성능 검증이나 생활소음 기준 판정용 모델이 아닙니다. 이 화면의 dB SPL은 계산 대역 안에서의 압력값입니다.</p>`;

  const canvas = $('waveCanvas'), context = canvas.getContext('2d');
  const traceCanvas = $('waveTraceCanvas'), traceContext = traceCanvas.getContext('2d');
  const statuses = { idle: '실행 전', starting: '격자 준비 중', running: '계산 중', paused: '일시정지', cancelled: '계산 중단', done: '계산 완료', changed: '새 조건 · 실행 전', error: '계산 오류' };

  function numericInfo() {
    const result = waveNumerics(config, 2.3);
    return { ...result, cutoffHz: result.cutoffHz ?? 343 / (10 * config.dx), sampleRate: result.sampleRate ?? 1 / result.dt };
  }

  function stateFingerprint() {
    const state = getAcousticState();
    return JSON.stringify([state.source.x, state.source.y, state.source.z, state.source.level, state.source.pitch, state.settings.doorStates]);
  }

  function canRun() {
    if (decoding) return false;
    if (config.sourceMode === 'recording' && !audioClip) return false;
    const source = getAcousticState().source;
    if (!indoorRooms.some(room => insideRoom(room, source.x, source.z))) return false;
    const cutoff = numericInfo().cutoffHz;
    return !(voiceMode(config.sourceMode) && source.pitch >= cutoff || config.sourceMode === 'tone' && config.toneFrequency >= cutoff);
  }

  function updateControls() {
    $('waveStatus').textContent = statuses[status];
    $('waveStatus').dataset.state = status;
    $('waveStart').disabled = ['starting', 'running'].includes(status) || !canRun();
    $('waveStart').textContent = ['paused', 'done', 'cancelled', 'error'].includes(status) ? '처음부터 다시 계산' : '시뮬레이션 시작';
    $('wavePause').disabled = !['running', 'paused'].includes(status);
    $('wavePause').textContent = status === 'paused' ? '계속 계산' : '일시정지';
    $('waveCancel').disabled = !['starting', 'running', 'paused'].includes(status);
    stage.setAttribute('aria-busy', String(status === 'starting'));
  }

  function updateClock() {
    const wall = wallAccumulated + (wallStarted ? performance.now() - wallStarted : 0);
    $('waveWallTime').innerHTML = `${(wall / 1000).toFixed(1)} <small>초</small>`;
  }

  function stopClock() {
    if (wallStarted) wallAccumulated += performance.now() - wallStarted;
    wallStarted = 0; clearInterval(clockTimer); clockTimer = 0; updateClock();
  }

  function startClock() {
    if (!wallStarted) wallStarted = performance.now();
    clearInterval(clockTimer); clockTimer = setInterval(updateClock, 200);
  }

  function setStatus(next) { status = next; updateControls(); }
  function showError(message) {
    if (['starting', 'running', 'paused'].includes(status)) worker?.postMessage({ type: 'cancel', id: runId });
    runId++;
    stopClock(); setStatus('error');
    $('waveError').textContent = message; $('waveError').hidden = false;
    $('waveMapState').textContent = '계산을 진행하지 못했습니다. 아래 오류를 확인하세요.';
    $('waveMapState').hidden = false;
  }

  function resetReadouts() {
    $('waveProgress').value = 0; $('waveProgressText').textContent = '0%';
    $('wavePhysicalTime').innerHTML = `0.0 <small>/ ${Math.round(config.duration * 1000)} ms</small>`;
    $('waveStepCount').innerHTML = '0 <small>step</small>';
    for (const prefix of ['Source', 'Neighbor']) {
      $(`wave${prefix}Rms`).textContent = '—';
      $(`wave${prefix}Pressure`).textContent = 'RMS — Pa';
      $(`wave${prefix}ProbePosition`).textContent = '계산 후 측정점 좌표 표시';
    }
    $('waveTraceCanvas').setAttribute('aria-label', '계산 전. 실행하면 두 측정점의 시간별 압력 기록을 표시합니다.');
  }

  function invalidate(message = '설정이 바뀌었습니다. 시작을 눌러 새 조건으로 계산하세요.') {
    if (['starting', 'running', 'paused'].includes(status)) worker?.postMessage({ type: 'cancel', id: runId });
    runId++; stopClock(); wallAccumulated = 0; updateClock();
    frame = null; metadata = null; referenceWaveform = null; runningSource = null; runningSettings = null; imageKey = '';
    setStatus(status === 'idle' ? 'idle' : 'changed');
    resetReadouts(); $('waveError').hidden = true;
    $('waveCalibrationNote').textContent = '계산을 시작하면 입력의 대역 제한 후 크기와 남은 에너지를 표시합니다.';
    $('waveRunNote').textContent = message;
    $('waveMapState').textContent = '평면·경계 미리보기 · 시작을 누르면 음압을 계산합니다.'; $('waveMapState').hidden = false;
    updateNumericLabels(); drawMap(); drawTraces();
  }

  function syncSharedFields() {
    const { source, sourceRoomId, settings } = getAcousticState();
    const room = indoorRooms.find(item => item.id === sourceRoomId) ?? indoorRooms.find(item => insideRoom(item, source.x, source.z));
    $('waveSourceRoom').value = room?.id ?? 'custom';
    $('waveSourceX').value = source.x.toFixed(2); $('waveSourceY').value = source.y.toFixed(1); $('waveSourceZ').value = source.z.toFixed(2);
    $('waveSourceLevel').value = source.level; $('waveSourcePitch').value = source.pitch;
    const openCount = Object.values(settings.doorStates ?? {}).filter(Boolean).length;
    $('waveOpeningsSummary').textContent = `현재 ${openCount}개 열림 · 계산 시작 시 이 상태를 사용합니다.`;
    updateNumericLabels();
  }

  function updateNumericLabels() {
    const info = numericInfo(), cutoff = Math.floor(info.cutoffHz), source = getAcousticState().source;
    $('waveSupportedBand').textContent = `계산 대역 상한 약 ${Math.round(info.cutoffHz)} Hz`;
    $('waveTimeStep').textContent = Number.isFinite(info.dt) ? `시간 간격 ${(info.dt * 1e6).toFixed(1)} µs · 파장당 10격자 기준 상한` : '파장당 10격자를 확보하는 주파수까지만 입력합니다.';
    $('waveBandNote').textContent = `현재 격자 ${config.dx}m의 계산 대역 상한은 약 ${Math.round(info.cutoffHz)}Hz입니다. 입력의 높은 주파수 성분은 제외하며, 이를 다시 증폭하지 않습니다. 전체 음성의 들림이나 음성 명료도를 이 단면으로 판정할 수 없습니다.`;
    $('waveGridCaption').textContent = metadata ? `격자 ${metadata.domain.nx} × ${metadata.domain.ny} × ${metadata.domain.nz} · ${metadata.airCells.toLocaleString()} 공기 셀` : `수평 격자 ${config.dx} m · 계산 전`;
    $('waveGeometrySummary').textContent = `이웃 방 폭 2.5m · 깊이 ${config.neighborDepth}m · 높이 2.3m 가정. 저주파의 3차원 음압 단면입니다. 대화·방송·노래의 광대역 비교는 ‘이웃집 소음’에서 계산합니다.`;
    $('waveToneFrequency').max = cutoff;
    $('wavePitchField').hidden = !voiceMode(config.sourceMode);
    $('waveToneField').hidden = config.sourceMode !== 'tone';
    $('waveRecordingFields').hidden = config.sourceMode !== 'recording';
    $('waveWaveformNote').textContent = config.sourceMode === 'recording' ? '선택한 구간을 입력한 1m 기준 크기로 보정합니다. 파일의 디지털 음량은 실측 dBA가 아닙니다.' : config.sourceMode === 'pulse' ? '짧은 대역 제한 펄스를 사용합니다. 계산 시작점에서 퍼지는 파동과 반사를 살펴볼 수 있습니다.' : config.sourceMode === 'tone' ? '선택한 주파수의 정상파 형성과 반사를 계산합니다. 실행 초반의 과도 응답도 포함합니다.' : '대화·방송·노래는 크기와 F0가 다른 합성 음성 입력입니다. 실제 문장과 노래를 재현하지 않습니다.';
    let warning = '';
    if (!indoorRooms.some(room => insideRoom(room, source.x, source.z))) warning = '현재 소음원이 실내 계산영역 밖에 있습니다. 방을 선택하거나 단면에서 위치를 지정하세요.';
    else if (voiceMode(config.sourceMode) && source.pitch >= info.cutoffHz) warning = `F0 ${source.pitch}Hz가 계산 상한보다 높습니다. 격자 간격을 줄이거나 목소리 높이를 낮추세요.`;
    else if (config.sourceMode === 'tone' && config.toneFrequency >= info.cutoffHz) warning = `순음 ${config.toneFrequency}Hz가 계산 상한에 도달했습니다. 격자 간격을 줄이거나 주파수를 낮추세요.`;
    $('waveSourceBandWarning').textContent = warning; $('waveSourceBandWarning').hidden = !warning;
    $('waveSliceHeightValue').textContent = `${config.sliceY.toFixed(1)} m`;
    if (!frame) $('waveSliceCaption').textContent = `계산 전 · 단면 높이 ${config.sliceY.toFixed(1)} m`;
    updateControls();
  }

  function ensureWorker() {
    if (worker) return true;
    try {
      worker = new Worker(new URL('./wave-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data: message }) => receive(message);
      worker.onerror = event => {
        event.preventDefault(); worker?.terminate(); worker = null;
        showError('음파 계산 Worker를 실행하지 못했습니다. 새로고침 후 다시 시도하세요. 이 브라우저에서는 계산이 진행되지 않았습니다.');
      };
      worker.onmessageerror = () => {
        worker?.terminate(); worker = null;
        showError('음파 계산 결과를 읽지 못했습니다. 처음부터 다시 계산하세요.');
      };
      worker.postMessage({ type: 'init', data });
      return true;
    } catch (error) {
      worker = null; showError(`별도 계산 스레드를 준비하지 못했습니다. ${error.message}`); return false;
    }
  }

  function receive(message) {
    if (message.id !== runId) return;
    if (message.type === 'error') { showError(message.error); return; }
    if (message.type === 'started') {
      metadata = message.metadata;
      setStatus('running'); updateNumericLabels();
      if (referenceWaveform) $('waveCalibrationNote').textContent = `녹음 대역 제한 후 에너지 ${(referenceWaveform.retainedEnergyFraction * 100).toFixed(1)}% · 1m 기준 저역 RMS ${pressureText(referenceWaveform.lowBandRmsPa)} Pa`;
      else {
        const calibration = metadata.sourceCalibration;
        $('waveCalibrationNote').textContent = calibration ? `1m 기준 저역 RMS ${pressureText(calibration.lowBandRmsPa)} Pa · ${finiteText(calibration.lowBandDbSPL)} dB SPL · 유지 에너지 ${finiteText(calibration.retainedEnergyFraction * 100)}%` : '입력의 전 대역 크기를 보정한 뒤 계산 대역 밖 성분을 제외합니다.';
        if (calibration?.hasResolvedContent === false) {
          $('waveError').textContent = '선택한 입력에는 현재 계산 대역의 성분이 없습니다. 격자 간격이나 목소리 높이·주파수를 바꾸세요.';
          $('waveError').hidden = false;
        }
      }
      $('waveRunNote').textContent = '계산된 시간 단계가 도착할 때마다 단면을 갱신합니다.';
      drawMap();
      if (!active || document.hidden) pauseSimulation();
    } else if (message.type === 'frame' || message.type === 'done') {
      frame = message.frame; imageKey = '';
      updateFrameReadouts(); drawMap(); drawTraces();
      if (message.type === 'done' || frame.finished) {
        stopClock(); setStatus('done');
        $('waveRunNote').textContent = `${(frame.time * 1000).toFixed(1)}ms까지 계산했습니다. 단면 높이와 표시량을 바꾸어 결과를 살펴볼 수 있습니다.`;
      }
    } else if (message.type === 'paused') {
      stopClock(); setStatus('paused');
      $('waveRunNote').textContent = '계산 상태를 보존했습니다. 계속 계산하거나 처음부터 다시 시작할 수 있습니다.';
    } else if (message.type === 'resumed') {
      startClock(); setStatus('running');
      if (!active || document.hidden) pauseSimulation();
    } else if (message.type === 'cancelled') {
      stopClock(); setStatus('cancelled');
      $('waveRunNote').textContent = '계산을 중단했습니다. 표시값은 중단 시점까지의 기록입니다. 다시 실행하면 처음부터 계산합니다.';
    }
  }

  function startSimulation() {
    if (!canRun()) return;
    if (['running', 'paused', 'starting'].includes(status)) worker?.postMessage({ type: 'cancel', id: runId });
    runId++; frame = null; metadata = null; imageKey = ''; referenceWaveform = null;
    stopClock(); wallAccumulated = 0; resetReadouts(); $('waveError').hidden = true;
    const shared = getAcousticState();
    runningSource = { ...shared.source }; runningSettings = structuredClone(shared.settings);
    try {
      if (config.sourceMode === 'recording') {
        const info = numericInfo();
        referenceWaveform = prepareAudioWaveform(audioClip.samples, audioClip.sampleRate, { targetRate: info.sampleRate, cutoffHz: info.cutoffHz, levelDbA: runningSource.level, duration: config.duration, offsetSeconds: audioOffset });
      }
    } catch (error) { showError(error.message); return; }
    if (!ensureWorker()) return;
    setStatus('starting'); startClock();
    $('waveMapState').hidden = false; $('waveMapState').textContent = '3차원 격자와 벽 경계를 준비하고 있습니다.';
    $('waveRunNote').textContent = '입력 조건으로 새 계산을 시작합니다.';
    drawMap(); drawTraces();
    worker.postMessage({ type: 'start', id: runId, source: runningSource, settings: runningSettings, config: { ...config }, ...(referenceWaveform ? { referenceWaveform } : {}) });
  }

  function pauseSimulation() {
    if (status !== 'running' && status !== 'starting') return;
    worker?.postMessage({ type: 'pause', id: runId });
  }

  function updateFrameReadouts() {
    if (!frame) return;
    const progress = clamp(frame.progress ?? frame.time / config.duration, 0, 1);
    $('waveProgress').value = progress; $('waveProgressText').textContent = `${Math.round(progress * 100)}%`;
    $('wavePhysicalTime').innerHTML = `${(frame.time * 1000).toFixed(1)} <small>/ ${Math.round(config.duration * 1000)} ms</small>`;
    $('waveStepCount').innerHTML = `${frame.step.toLocaleString()} <small>step</small>`;
    $('waveMapState').hidden = true;
    $('waveSliceCaption').textContent = `실제 격자 단면 ${frame.slice.sliceY.toFixed(2)} m · t ${(frame.time * 1000).toFixed(1)} ms`;
    for (const [key, prefix] of [['source', 'Source'], ['neighbor', 'Neighbor']]) {
      const probe = frame.probes[key], point = probe.position;
      $(`wave${prefix}Rms`).textContent = finiteText(probe.lowBandDbSPL);
      $(`wave${prefix}Pressure`).textContent = `RMS ${pressureText(probe.rmsPa)} Pa · |p| 최대 ${pressureText(probe.peakAbsPa)} Pa`;
      $(`wave${prefix}ProbePosition`).textContent = `X ${point.x.toFixed(2)} · Z ${point.z.toFixed(2)} · 높이 ${point.y.toFixed(2)} m`;
    }
    traceCanvas.setAttribute('aria-label', `물리 시간 ${(frame.time * 1000).toFixed(1)}ms까지의 압력 기록. 우리집 측 누적 ${finiteText(frame.probes.source.lowBandDbSPL)}dB SPL, 이웃 방 누적 ${finiteText(frame.probes.neighbor.lowBandDbSPL)}dB SPL. 계산 대역 내, A보정 전.`);
    updateClock();
  }

  function canvasSize(element, ctx) {
    const box = element.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return null;
    const dpr = Math.min(2, window.devicePixelRatio || 1), width = Math.round(box.width * dpr), height = Math.round(box.height * dpr);
    if (element.width !== width || element.height !== height) { element.width = width; element.height = height; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { width: box.width, height: box.height, dpr };
  }

  function drawRaster() {
    if (!frame) return;
    const slice = frame.slice, key = `${frame.step}/${slice.sliceY}/${viewMode}/${pressureLimit}`;
    if (imageKey === key) return;
    sliceCanvas.width = slice.width; sliceCanvas.height = slice.height;
    imageBuffer = sliceContext.createImageData(slice.width, slice.height);
    const values = viewMode === 'pressure' ? slice.pressure : slice.rms;
    for (let i = 0; i < values.length; i++) {
      if (!slice.mask[i] || !Number.isFinite(values[i])) continue;
      const color = viewMode === 'pressure' ? pressureColor(values[i], pressureLimit) : rmsColor(values[i]);
      imageBuffer.data[i * 4] = color[0]; imageBuffer.data[i * 4 + 1] = color[1]; imageBuffer.data[i * 4 + 2] = color[2]; imageBuffer.data[i * 4 + 3] = 255;
    }
    sliceContext.putImageData(imageBuffer, 0, 0); imageKey = key;
  }

  function drawMap() {
    if (!active) return;
    const size = canvasSize(canvas, context); if (!size) return;
    const { width: w, height: h } = size;
    context.clearRect(0, 0, w, h); context.fillStyle = '#f4f6f2'; context.fillRect(0, 0, w, h);
    const neighbor = metadata?.neighbor ?? { x0: 7.8, x1: 10.3, z0: -.2 - config.neighborDepth, z1: -.2, height: 2.3 };
    const points = data.rooms.flatMap(room => room.poly);
    const bounds = focusNeighbor
      ? { minX: 7.15, maxX: 10.9, minZ: neighbor.z0 - .3, maxZ: 2.6 }
      : { minX: Math.min(-.3, ...points.map(p => p[0])), maxX: Math.max(11.8, ...points.map(p => p[0])), minZ: neighbor.z0 - .25, maxZ: Math.max(...points.map(p => p[1])) + .2 };
    const pad = w < 500 ? 17 : 27;
    const scale = Math.min((w - pad * 2) / (bounds.maxX - bounds.minX), (h - pad * 2) / (bounds.maxZ - bounds.minZ));
    const ox = (w - (bounds.maxX - bounds.minX) * scale) / 2 - bounds.minX * scale, oz = (h - (bounds.maxZ - bounds.minZ) * scale) / 2 - bounds.minZ * scale;
    mapGeometry = { scale, ox, oz, width: w, height: h };
    const point = (x, z) => [ox + x * scale, oz + z * scale];
    function path(room) { context.beginPath(); room.poly.forEach((p, i) => { const q = point(...p); if (i) context.lineTo(...q); else context.moveTo(...q); }); context.closePath(); }
    for (const room of data.rooms) { path(room); context.fillStyle = room.kind === 'exterior' ? '#e7ecdf' : '#e8ece6'; context.fill(); }
    let p = point(neighbor.x0, neighbor.z0);
    context.fillStyle = '#ebeee1'; context.fillRect(p[0], p[1], (neighbor.x1 - neighbor.x0) * scale, (neighbor.z1 - neighbor.z0) * scale);
    if (frame) {
      drawRaster(); const slice = frame.slice;
      const origin = point(slice.originX - slice.dx / 2, slice.originZ - slice.dz / 2);
      context.imageSmoothingEnabled = false;
      context.drawImage(sliceCanvas, origin[0], origin[1], slice.width * slice.dx * scale, slice.height * slice.dz * scale);
    }
    const sliceY = frame?.slice.sliceY ?? config.sliceY;
    for (const object of data.objects) {
      if (!object.wall || object.shape !== 'box') continue;
      if (object.p[1] - object.s[1] / 2 > sliceY || object.p[1] + object.s[1] / 2 < sliceY) continue;
      context.save(); context.translate(...point(object.p[0], object.p[2])); context.rotate(-(object.ry || 0)); context.fillStyle = '#66736c';
      context.fillRect(-object.s[0] * scale / 2, -object.s[2] * scale / 2, object.s[0] * scale, object.s[2] * scale); context.restore();
    }
    const settings = runningSettings ?? getAcousticState().settings;
    for (const [i, opening] of data.openings.entries()) {
      if (sliceY < opening.sill || sliceY > opening.head) continue;
      const a = opening.axis === 'x' ? point(opening.k, opening.lo) : point(opening.lo, opening.k), b = opening.axis === 'x' ? point(opening.k, opening.hi) : point(opening.hi, opening.k);
      const open = settings.doorStates?.[`opening-${i}`];
      context.beginPath(); context.moveTo(...a); context.lineTo(...b); context.strokeStyle = open ? '#688b68' : '#8b9da1'; context.lineWidth = open ? 1.5 : Math.max(2, scale * .06); context.setLineDash(open ? [3, 3] : []); context.stroke(); context.setLineDash([]);
    }
    p = point(neighbor.x0, neighbor.z0); context.strokeStyle = '#78856a'; context.lineWidth = Math.max(2, scale * .12); context.strokeRect(p[0], p[1], (neighbor.x1 - neighbor.x0) * scale, (neighbor.z1 - neighbor.z0) * scale);
    const wa = point(7.8, -.1), wb = point(10.3, -.1);
    context.beginPath(); context.moveTo(...wa); context.lineTo(...wb); context.strokeStyle = '#a28350'; context.lineWidth = Math.max(3, scale * .2); context.stroke();
    const source = runningSource ?? getAcousticState().source;
    function label(text, x, z, color = '#596952', yOffset = 0) {
      const q = point(x, z); context.font = `${w < 500 ? 10 : 11}px Arial, "Apple SD Gothic Neo", sans-serif`; context.textAlign = 'center'; context.textBaseline = 'middle';
      const lw = context.measureText(text).width + 9; context.fillStyle = '#ffffffdc'; context.fillRect(q[0] - lw / 2, q[1] - 9 + yOffset, lw, 18); context.fillStyle = color; context.fillText(text, q[0], q[1] + yOffset);
    }
    for (const room of data.rooms) {
      const nearby = Math.hypot(source.x - room.center[0], source.z - room.center[1]) * scale < 24;
      label(room.kind === 'exterior' ? `${room.name} · 계산영역 밖` : room.name, ...room.center, room.kind === 'exterior' ? '#6f7d65' : '#59694f', nearby ? 21 : 0);
    }
    label('이웃 방 · 가정', (neighbor.x0 + neighbor.x1) / 2, neighbor.z0 + .45, '#627249');
    function marker(position, name, color, radius = 9) {
      const q = point(position.x, position.z); context.beginPath(); context.arc(...q, radius, 0, Math.PI * 2); context.fillStyle = color; context.fill(); context.strokeStyle = 'white'; context.lineWidth = 2; context.stroke(); context.fillStyle = 'white'; context.font = `bold ${name.length > 1 ? 9 : 10}px Arial`; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(name, q[0], q[1] + .3);
    }
    if (placement) { const q = point(source.x, source.z); context.beginPath(); context.arc(...q, 17, 0, Math.PI * 2); context.fillStyle = '#bd704b25'; context.fill(); }
    marker(source, 'S', '#b87350');
    const probes = frame?.probes;
    if (probes) { marker(probes.source.position, 'P1', '#b27c45', 10); marker(probes.neighbor.position, 'P2', '#3d7788', 10); }
    const bx = pad, by = h - 15;
    context.beginPath(); context.moveTo(bx, by - 3); context.lineTo(bx, by); context.lineTo(bx + scale, by); context.lineTo(bx + scale, by - 3); context.strokeStyle = '#8c9b82'; context.lineWidth = 1; context.stroke(); context.font = '9px Arial'; context.textAlign = 'left'; context.fillStyle = '#7d8b74'; context.fillText('1 m', bx + scale + 6, by + 1);
  }

  function drawTraces() {
    if (!active) return;
    const size = canvasSize(traceCanvas, traceContext); if (!size) return;
    const { width: w, height: h } = size, left = 62, right = 14, top = 18, bottom = 29;
    traceContext.clearRect(0, 0, w, h); traceContext.fillStyle = '#fbfcf9'; traceContext.fillRect(0, 0, w, h);
    const probes = frame?.probes, plotted = probes ? traceMode === 'neighbor' ? [probes.neighbor] : [probes.source, probes.neighbor] : [];
    let maxPressure = .02;
    if (plotted.length) {
      maxPressure = Math.max(1e-8, ...plotted.map(probe => { let maximum = 0; for (const value of probe.pressure) maximum = Math.max(maximum, Math.abs(value)); return maximum; })) * 1.1;
    }
    $('waveTraceScale').textContent = `Pa 축 ±${pressureText(maxPressure)} · 선택 곡선에 맞춤`;
    const x = t => left + clamp(t / config.duration, 0, 1) * (w - left - right), y = pressure => top + (1 - pressure / maxPressure) * (h - top - bottom) / 2;
    traceContext.font = '10px Arial'; traceContext.lineWidth = 1;
    for (const fraction of [-1, 0, 1]) {
      const yy = y(fraction * maxPressure); traceContext.beginPath(); traceContext.moveTo(left, yy); traceContext.lineTo(w - right, yy); traceContext.strokeStyle = fraction === 0 ? '#c4cebe' : '#e5eadf'; traceContext.stroke();
      traceContext.fillStyle = '#65755d'; traceContext.textAlign = 'right'; traceContext.textBaseline = 'middle'; traceContext.fillText(fraction === 0 ? '0' : pressureText(fraction * maxPressure), left - 7, yy);
    }
    for (let i = 0; i <= 3; i++) {
      const time = config.duration * i / 3, xx = x(time); traceContext.textAlign = 'center'; traceContext.textBaseline = 'top'; traceContext.fillStyle = '#65755d'; traceContext.fillText(`${Math.round(time * 1000)}`, xx, h - bottom + 8);
    }
    traceContext.textAlign = 'left'; traceContext.fillText('Pa', 7, 2); traceContext.textAlign = 'right'; traceContext.fillText('ms', w - 2, h - bottom + 8);
    for (const [index, probe] of plotted.entries()) {
      traceContext.beginPath();
      for (let i = 0; i < probe.pressure.length; i++) {
        const xx = x(probe.times[i]), yy = y(probe.pressure[i]); if (i) traceContext.lineTo(xx, yy); else traceContext.moveTo(xx, yy);
      }
      traceContext.strokeStyle = index === 0 && traceMode === 'both' ? '#b27c45' : '#3d7788'; traceContext.lineWidth = 1.3; traceContext.stroke();
    }
    if (!frame) { traceContext.textAlign = 'center'; traceContext.textBaseline = 'middle'; traceContext.font = '11px Arial, "Apple SD Gothic Neo", sans-serif'; traceContext.fillStyle = '#a1aa96'; traceContext.fillText('실행 후 계산된 압력 기록을 표시합니다', (left + w - right) / 2, h * .35); }
  }

  function updateLegend() {
    const rms = viewMode === 'rms';
    $('wavePressureView').setAttribute('aria-pressed', String(!rms)); $('waveRmsView').setAttribute('aria-pressed', String(rms));
    $('waveLegendGradient').classList.toggle('wave-rms-gradient', rms);
    $('waveLegendTitle').textContent = rms ? '계산 대역 RMS · dB SPL' : '순간 음압 · Pa';
    $('waveLegendMin').textContent = rms ? '≤ 0' : `≤ −${pressureLimit}`;
    $('waveLegendMid').textContent = rms ? '45' : '0';
    $('waveLegendMax').textContent = rms ? '≥ 90' : `≥ +${pressureLimit}`;
    $('wavePressureRangeField').hidden = rms;
    $('waveFieldUnitNote').textContent = rms ? '시작 이후 누적 RMS · 20 µPa 기준 · A보정 전. 0~90 dB SPL 범위에 고정하며 범위 밖은 끝 색으로 표시합니다.' : '파랑: 음압 음수 · 빨강: 음압 양수. 모든 공간에 같은 범위를 적용하며 범위 밖은 끝 색으로 표시합니다. 이웃집의 작은 압력은 색 범위를 줄여 확인하세요.';
    imageKey = ''; drawMap();
  }

  function sourceChange(patch) {
    const result = setSource(patch);
    if (result === false) { $('waveError').textContent = '벽이나 실내 계산영역 밖에는 소음원을 놓을 수 없습니다.'; $('waveError').hidden = false; syncSharedFields(); return false; }
    syncSharedFields(); sharedFingerprint = stateFingerprint(); invalidate(); return true;
  }

  function moveSourceFromCanvas(event) {
    if (!placement || !mapGeometry) return;
    const box = canvas.getBoundingClientRect(), x = Math.round(((event.clientX - box.left - mapGeometry.ox) / mapGeometry.scale) * 100) / 100, z = Math.round(((event.clientY - box.top - mapGeometry.oz) / mapGeometry.scale) * 100) / 100;
    if (!indoorRooms.some(room => insideRoom(room, x, z))) { $('waveError').textContent = '소음원은 우리집 실내 공간 안에 지정하세요.'; $('waveError').hidden = false; return; }
    sourceChange({ x, z });
  }

  function bindConfigNumber(id, key, min, max) {
    $(id).addEventListener('change', () => {
      const value = $(id).valueAsNumber;
      if (!Number.isFinite(value)) { $(id).value = config[key]; return; }
      config[key] = clamp(value, min, max); $(id).value = config[key];
      if (key === 'partitionMass' || key === 'partitionResistance') $('waveMaterialPreset').value = 'custom';
      invalidate();
    });
  }

  $('waveStart').addEventListener('click', startSimulation);
  $('wavePause').addEventListener('click', () => { if (status === 'paused') worker?.postMessage({ type: 'resume', id: runId }); else pauseSimulation(); });
  $('waveCancel').addEventListener('click', () => worker?.postMessage({ type: 'cancel', id: runId }));
  $('wavePressureView').addEventListener('click', () => { viewMode = 'pressure'; updateLegend(); });
  $('waveRmsView').addEventListener('click', () => { viewMode = 'rms'; updateLegend(); });
  $('waveTraceMode').addEventListener('change', () => { traceMode = $('waveTraceMode').value; $('waveTraceSourceKey').hidden = traceMode === 'neighbor'; drawTraces(); });
  $('waveFocusNeighbor').addEventListener('click', () => {
    focusNeighbor = !focusNeighbor;
    $('waveFocusNeighbor').setAttribute('aria-pressed', String(focusNeighbor));
    $('waveFocusNeighbor').textContent = focusNeighbor ? '집 전체 보기' : '이웃집 확대';
    drawMap();
  });
  $('wavePressureRange').addEventListener('change', () => { pressureLimit = +$('wavePressureRange').value; updateLegend(); });
  $('waveSliceHeight').addEventListener('input', () => {
    config.sliceY = +$('waveSliceHeight').value; $('waveSliceHeightValue').textContent = `${config.sliceY.toFixed(1)} m`;
    if (metadata && !['changed', 'idle', 'error'].includes(status)) worker?.postMessage({ type: 'view', id: runId, sliceY: config.sliceY });
    else { updateNumericLabels(); drawMap(); }
  });
  $('wavePlaceSource').addEventListener('click', () => {
    placement = !placement; $('wavePlaceSource').setAttribute('aria-pressed', String(placement));
    canvas.classList.toggle('wave-placing', placement);
    $('waveRunNote').textContent = placement ? '우리집 실내를 클릭해 소음원을 옮기세요. 단면에 초점을 둔 뒤 방향키로도 0.1m씩 이동할 수 있습니다.' : '소음원 위치 지정을 마쳤습니다.';
    if (placement) canvas.focus({ preventScroll: true }); drawMap();
  });
  canvas.addEventListener('click', moveSourceFromCanvas);
  canvas.addEventListener('keydown', event => {
    if (!placement) return;
    const delta = { ArrowLeft: [-.1, 0], ArrowRight: [.1, 0], ArrowUp: [0, -.1], ArrowDown: [0, .1] }[event.key];
    if (!delta) return; event.preventDefault(); const source = getAcousticState().source;
    const x = +(source.x + delta[0]).toFixed(2), z = +(source.z + delta[1]).toFixed(2);
    if (indoorRooms.some(room => insideRoom(room, x, z))) sourceChange({ x, z });
  });
  $('waveSourceMode').value = config.sourceMode;
  $('waveSourceMode').addEventListener('change', () => {
    config.sourceMode = $('waveSourceMode').value;
    const preset = PRESETS[config.sourceMode];
    if (Number.isFinite(preset.level)) sourceChange({ level: preset.level, pitch: preset.pitch });
    else invalidate();
    updateNumericLabels();
  });
  for (const [id, key, min, max] of [['waveSourceLevel', 'level', 30, 100], ['waveSourcePitch', 'pitch', 80, 350], ['waveSourceX', 'x', 0, 11.5], ['waveSourceZ', 'z', 0, 5.3], ['waveSourceY', 'y', .2, 2.2]]) {
    $(id).addEventListener('change', () => {
      const value = $(id).valueAsNumber;
      if (!Number.isFinite(value)) { syncSharedFields(); return; }
      sourceChange({ [key]: clamp(value, min, max) });
    });
  }
  $('waveSourceRoom').addEventListener('change', () => { const room = indoorRooms.find(item => item.id === $('waveSourceRoom').value); if (room) sourceChange({ x: room.center[0], z: room.center[1] }); });
  $('waveOpenings').addEventListener('click', () => onChooseSourcePosition('openings'));
  $('waveGridSpacing').addEventListener('change', () => { config.dx = +$('waveGridSpacing').value; invalidate(); });
  $('waveDuration').addEventListener('change', () => { config.duration = +$('waveDuration').value; invalidate(); });
  $('waveMaterialPreset').addEventListener('change', () => {
    const preset = MATERIAL_PRESETS[$('waveMaterialPreset').value]; if (!preset) return;
    config.partitionMass = preset.mass; config.partitionResistance = preset.resistance;
    $('wavePartitionMass').value = preset.mass; $('wavePartitionResistance').value = preset.resistance; invalidate();
  });
  for (const args of [['waveNeighborDepth', 'neighborDepth', 2, 6], ['wavePartitionMass', 'partitionMass', 1, 1000], ['wavePartitionResistance', 'partitionResistance', 0, 10000], ['waveWallAlpha', 'wallAlpha', 0, .9]]) bindConfigNumber(...args);
  $('waveToneFrequency').addEventListener('change', () => { const value = $('waveToneFrequency').valueAsNumber; if (Number.isFinite(value)) config.toneFrequency = clamp(value, 40, numericInfo().cutoffHz); $('waveToneFrequency').value = config.toneFrequency; invalidate(); });
  $('waveAudioOffset').addEventListener('change', () => {
    const value = $('waveAudioOffset').valueAsNumber;
    if (Number.isFinite(value)) audioOffset = clamp(value, 0, Math.max(0, (audioClip?.duration ?? 0) - .01));
    $('waveAudioOffset').value = audioOffset; invalidate();
  });
  $('waveAudioFile').addEventListener('change', async () => {
    const file = $('waveAudioFile').files?.[0], request = ++audioDecodeId;
    audioClip = null; audioOffset = 0; decoding = false; $('waveAudioOffset').value = 0;
    if (!file) { $('waveAudioMeta').textContent = '녹음 파일을 선택하세요. 파일은 기기 안에서 처리합니다.'; invalidate(); return; }
    if (file.size > 32 * 1024 * 1024) { invalidate(); showError('녹음 파일은 32MB 이하로 선택하세요.'); return; }
    decoding = true; invalidate(); $('waveAudioMeta').textContent = '녹음 파일을 기기 안에서 읽고 있습니다.';
    let audioContext;
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) throw new Error('이 브라우저는 녹음 파일 해석을 지원하지 않습니다.');
      audioContext = new Audio();
      const buffer = await audioContext.decodeAudioData(await file.arrayBuffer());
      if (request !== audioDecodeId) return;
      const samples = new Float32Array(buffer.length);
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) { const values = buffer.getChannelData(channel); for (let i = 0; i < samples.length; i++) samples[i] += values[i] / buffer.numberOfChannels; }
      audioClip = { name: file.name, samples, sampleRate: buffer.sampleRate, duration: buffer.duration };
      $('waveAudioOffset').max = Math.max(0, buffer.duration - .01).toFixed(2);
      $('waveAudioMeta').textContent = `${file.name} · ${buffer.duration.toFixed(2)}초 · ${buffer.sampleRate.toLocaleString()}Hz. 선택한 ${Math.round(config.duration * 1000)}ms 구간을 입력한 1m 크기로 보정합니다.`;
      $('waveError').hidden = true;
    } catch (error) {
      if (request === audioDecodeId) showError(`녹음 파일을 읽지 못했습니다. ${error.message}`);
    } finally {
      await audioContext?.close().catch(() => {});
      if (request === audioDecodeId) { decoding = false; updateControls(); }
    }
  });

  resizeObserver = new ResizeObserver(() => { if (active) { drawMap(); drawTraces(); } });
  resizeObserver.observe(canvas); resizeObserver.observe(traceCanvas);
  document.addEventListener('visibilitychange', () => { if (document.hidden) pauseSimulation(); });
  sharedFingerprint = stateFingerprint(); syncSharedFields(); resetReadouts(); updateLegend();
  return {
    activate() { active = true; syncSharedFields(); drawMap(); drawTraces(); },
    deactivate() { active = false; pauseSimulation(); placement = false; $('wavePlaceSource').setAttribute('aria-pressed', 'false'); canvas.classList.remove('wave-placing'); },
    refresh() { const next = stateFingerprint(); if (next !== sharedFingerprint) { sharedFingerprint = next; syncSharedFields(); invalidate(); } },
  };
}
