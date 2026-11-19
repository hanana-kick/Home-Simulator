import { createBroadbandModel, THIRD_OCTAVE_BANDS, BROADBAND_DEFAULTS, BROADBAND_SCENARIOS, BROADBAND_PARTITIONS } from './broadband.mjs';
import { parseBandCsv, formatBandCsv, serializeBroadbandProject, parseBroadbandProject } from './broadband-io.mjs';

const BANDS = THIRD_OCTAVE_BANDS;
const IDS = Object.keys(BROADBAND_SCENARIOS);
const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const db = value => Number.isFinite(value) ? value.toFixed(1) : '—';
const bandPresent = value => Number.isFinite(value) && value > -299.9;
const bandText = value => bandPresent(value) ? db(value) : '—';
const freq = value => value >= 1000 ? `${value / 1000}k` : String(value);
const option = (value, label) => `<option value="${escape(value)}">${escape(label)}</option>`;
const TARGETS = {
  R: { label: '원소 차음 R(f)', key: 'partitionBandsDb', unit: 'dB', min: 0, max: 120 },
  Rprime: { label: '현장 겉보기 차음 R′(f)', key: 'measuredTransferBandsDb', mode: 'apparent', unit: 'dB', min: -20, max: 120 },
  DnT: { label: '현장 표준화 음압차 DnT(f)', key: 'measuredTransferBandsDb', mode: 'dnt', unit: 'dB', min: -20, max: 120 },
  flank: { label: '우회 경로 Dn,f(f)', key: 'flankBandsDb', unit: 'dB', min: 0, max: 120 },
  L1: { label: '작업실 실측 평균 L1(f)', key: 'measuredSourceRoomBandsDb', unit: 'dB SPL', min: -100, max: 140 },
  rt60: { label: '이웃 방 잔향시간 T(f)', key: 'receiverRt60Bands', unit: '초', min: .05, max: 5 },
  background: { label: '이웃 방 배경소음', key: 'backgroundBandsDb', unit: 'dB SPL', min: -100, max: 140 },
};
const MODE_LABELS = { element: '원소 R + 틈새·우회 가정', apparent: '현장 R′ 입력', dnt: '현장 DnT 입력' };
const SERIES = [{ key: 'receiverBandsDb', label: '이 소음원 전달음', color: '#386c51' }, { key: 'backgroundBandsDb', label: '이웃 배경소음', color: '#aa8346' }, { key: 'totalBandsDb', label: '전달음 + 배경', color: '#517c9a' }];

function insideRoom(room, x, z) {
  let inside = false;
  for (let i = 0, j = room.poly.length - 1; i < room.poly.length; j = i++) {
    const a = room.poly[i], b = room.poly[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function numericField(id, label, value, min, max, step = 1, unit = '') {
  return `<div class="bb-field"><label for="${id}">${label}</label><div class="bb-input-unit"><input id="${id}" type="number" value="${value}" min="${min}" max="${max}" step="${step}">${unit ? `<span>${unit}</span>` : ''}</div></div>`;
}

function rangeText(range) {
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return '—';
  return Math.abs(range.max - range.min) < .05 ? db(range.min) : `${db(range.min)}–${db(range.max)}`;
}

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function initBroadbandUI(data, { getAcousticState, setSource, setAcousticState, onChooseSourcePosition }) {
  const stage = $('neighborStage'), sidebar = $('neighborSidebar');
  if (!stage || !sidebar) throw new Error('광대역 이웃집 표시 영역이 없습니다.');
  const model = createBroadbandModel(data);
  let config = structuredClone(BROADBAND_DEFAULTS), scenarioOverrides = structuredClone(BROADBAND_SCENARIOS), recordings = {}, measurementNotes = {};
  let selectedScenario = 'conversation', selectedCondition = 'central', selectedMetric = 'session', editorTarget = 'R', selectedBand = 13;
  let result = null, active = false, dirty = true, timer = 0, sharedFingerprint = '', chartGeometry = null, editorDirty = false;
  let audioWorker = null, analysisId = 0, audioBusy = false, audioTarget = null, decodeId = 0;
  const audioClips = {}, audioOptions = {}, audioMessages = {}, transferSpectra = { apparent: null, dnt: null };
  const rooms = data.rooms.filter(room => room.kind === 'interior');
  stage.classList.add('bb-stage'); sidebar.classList.add('bb-sidebar');

  stage.innerHTML = `<div class="bb-stage-inner">
    <div class="bb-title-row"><div><p class="bb-eyebrow">BROADBAND NEIGHBOR PREDICTION</p><h2>이웃집에 전달되는 활동 소음</h2></div><span class="bb-verification">현장 검증 전</span></div>
    <p class="bb-intro">50 Hz–5 kHz · 21개 1/3옥타브 대역 · 이웃 방의 공간 평균</p>
    <section class="bb-main-controls" aria-label="주요 비교 조건"><div class="bb-field"><label for="bbSourceRoom">우리집 소음원이 있는 방</label><select id="bbSourceRoom">${rooms.map(room => option(room.id, room.name)).join('')}<option value="custom" disabled>현재 실내 공간 밖</option></select></div><div class="bb-field"><label for="bbTransferMode">전달 성능의 입력 방식</label><select id="bbTransferMode">${Object.entries(MODE_LABELS).map(([key, label]) => option(key, label)).join('')}</select></div><a class="bb-controls-link" href="#neighborSidebar">소리·벽체 조건 설정 ↓</a><p class="bb-controls-note">이 모델에서는 방 선택이 결과에 영향을 줍니다. 같은 방 안의 세부 좌표·높이 변화는 반영하지 않습니다.</p></section>
    <div class="bb-context"><strong>접한 위치: 작업실 도면 위쪽 벽 · 5.75 m²</strong><p id="bbGeometryContext">이웃 방 2.5 × 3 × 2.3 m 가정</p><p id="bbDataSource"></p></div>
    <div class="bb-comparison-heading"><h3>세 활동의 전달음 범위</h3><span id="bbComputeStatus" role="status">계산 대기</span></div>
    <p class="bb-range-note" id="bbRangeExplanation">미확인 시공 조건 3개를 계산한 범위입니다. 신뢰구간이나 측정 오차 범위가 아닙니다.</p>
    <div class="bb-error" id="bbError" role="alert" hidden></div>
    <div class="bb-scenario-grid">${IDS.map((id, index) => `<article class="bb-scenario" id="bbCard-${id}"><button type="button" class="bb-card-select" data-select-scenario="${id}" aria-pressed="${id === selectedScenario}"><span class="bb-card-number">0${index + 1}</span><h3>${escape(BROADBAND_SCENARIOS[id].label)}</h3><span class="bb-card-select-label">상세 보기</span></button><div class="bb-card-body"><p class="bb-card-metric" id="bbMetricLabel-${id}">활동 전체 LAeq · 이 소음원만</p><div class="bb-range-value"><output id="bbRange-${id}">—</output><span>dBA</span></div><p class="bb-card-input" id="bbInput-${id}"></p><dl class="bb-condition-values" id="bbConditions-${id}"></dl><p class="bb-card-secondary" id="bbLoud-${id}"></p><p class="bb-card-total" id="bbTotal-${id}"></p></div></article>`).join('')}</div>
    <section class="bb-detail-card" aria-labelledby="bbDetailTitle"><div class="bb-detail-heading"><div><p class="bb-eyebrow">SELECTED ACTIVITY</p><h3 id="bbDetailTitle">일상 대화 상세</h3></div><div class="bb-detail-selects"><label for="bbConditionSelect">시공 조건<select id="bbConditionSelect"></select></label><label for="bbMetricSelect">구간<select id="bbMetricSelect"></select></label></div></div>
      <p class="bb-detail-context" id="bbDetailContext"></p>
      <div class="bb-band-legend">${SERIES.map(series => `<span><i style="background:${series.color}"></i>${series.label}</span>`).join('')}</div>
      <canvas id="bbBandCanvas" class="bb-band-canvas" tabindex="0" role="img" aria-label="21개 주파수 대역의 전달음과 배경소음. 방향키로 대역을 선택할 수 있습니다."></canvas>
      <p class="bb-band-readout" id="bbBandReadout">대역을 선택하면 값을 표시합니다.</p>
      <p class="bb-chart-note">대역별 값은 A보정 전 dB SPL입니다. 위 카드의 dBA는 각 대역에 A보정을 적용해 에너지로 합한 값입니다. 에너지가 없는 대역은 선을 잇지 않고 표에서 ‘—’로 표시합니다.</p>
      <details class="bb-details"><summary>21개 대역 수치 표</summary><div class="bb-table-scroll"><table class="bb-band-table"><thead><tr><th>Hz</th><th>작업실 L1</th><th>전달음</th><th>배경</th><th>합계</th></tr></thead><tbody id="bbBandTable"></tbody></table></div><p class="bb-note">모두 대역 음압 dB SPL · A보정 전</p></details>
      <div class="bb-detail-columns"><section><h4>경로별 기여</h4><p class="bb-note" id="bbPathNote">이 소음원의 전달 에너지 비중</p><div id="bbPathContributions" class="bb-paths"></div></section><section><h4>시공 조건 민감도</h4><div id="bbSensitivity" class="bb-sensitivity"></div><p class="bb-note" id="bbSensitivityNote"></p></section></div>
    </section>
    <section class="bb-assumptions-card"><h3>현재 입력과 남은 확인</h3><ul id="bbMissingInputs"></ul><details class="bb-details"><summary>계산 조건과 모델 안내</summary><ul id="bbModelNotices"></ul><p class="bb-note">세 시공 가정은 중앙 입력에 대해 원소 차음 −8/0/+8 dB, 등가틈새 ×10/×1/×0.1, 우회 경로 Dn,f −8/0/+8 dB를 적용합니다. 현장 R′·DnT 입력 모드는 입력값 한 조건을 사용합니다.</p><a href="./acoustic-notes.html" target="_blank" rel="noopener">방법·가정·자료 출처 보기 ↗</a></details></section>
    <div class="bb-project-bar"><div><h3>계산 조건 저장</h3><p>시나리오·대역 입력·녹음 분석 결과를 JSON으로 보관합니다. 원본 오디오는 포함하지 않습니다.</p></div><div><button type="button" class="button" id="bbExportProject">프로젝트 내보내기</button><label class="button bb-file-button" for="bbImportProject">프로젝트 가져오기<input id="bbImportProject" type="file" accept="application/json,.json"></label></div></div>
    <p class="bb-operation-message" id="bbOperationMessage" role="status"></p>
  </div>`;

  sidebar.innerHTML = `<div class="bb-sidebar-heading"><p class="bb-eyebrow">PREDICTION INPUTS</p><h2>소리·전달 조건</h2><a href="#neighborStage" class="bb-controls-link">비교 결과로 ↑</a></div>
    <section class="bb-settings-section"><h3><span>01</span> 선택 활동</h3><div class="bb-field"><label for="bbScenarioSelect">편집할 활동</label><select id="bbScenarioSelect">${IDS.map(id => option(id, BROADBAND_SCENARIOS[id].label)).join('')}</select></div><p class="bb-input-kind" id="bbInputKind"></p>
      <fieldset class="bb-synthetic-fields" id="bbSyntheticFields"><legend class="bb-sr-only">선택한 활동의 합성 입력</legend><label class="bb-check"><input id="bbVoiceEnabled" type="checkbox" checked> 사람 음성 포함</label><div class="bb-fields-two">${numericField('bbTypicalLevel', '평소 크기 · 1 m', 60, 30, 100, 1, 'dBA')}${numericField('bbLoudLevel', '큰 소리 크기 · 1 m', 66, 30, 110, 1, 'dBA')}${numericField('bbPitch', '목소리 높낮이 F0', 160, 80, 350, 1, 'Hz')}${numericField('bbDuty', '전체 시간 중 발성', 50, 0, 100, 1, '%')}</div>${numericField('bbLoudFraction', '발성 중 큰 소리 구간 비율', 10, 0, 100, 1, '%')}<label class="bb-check"><input id="bbSpeakerEnabled" type="checkbox"> 스피커 포함</label><div class="bb-fields-two">${numericField('bbSpeakerLevel', '스피커 크기 · 1 m', 60, 30, 100, 1, 'dBA')}${numericField('bbSpeakerDuty', '전체 시간 중 재생', 100, 0, 100, 1, '%')}</div><p class="bb-note">활동 크기와 발성 비율은 수정 가능한 가정입니다. 큰 소리 구간은 LAFmax가 아닙니다.</p></fieldset>
      <div class="bb-measured-source" id="bbMeasuredSourceNote" hidden><p>선택 활동에 작업실 실측 L1을 적용했습니다. 음원·활동률을 추가 추정하지 않습니다.</p><button type="button" class="bb-text-button" id="bbClearL1">실측 L1 적용 해제</button></div>
      <details class="bb-details" id="bbRecordingDetails"><summary>이 활동에 녹음 적용</summary><p class="bb-note">파일 전체 길이 3분 이하·32MB 이하. 최대 60초를 분석하며 파일은 기기 안에서 처리합니다.</p><div class="bb-field"><label for="bbAudioFile">오디오 파일 선택</label><input id="bbAudioFile" type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac,.webm"><p class="bb-note" id="bbAudioFileInfo">파일을 선택하세요.</p></div><div class="bb-fields-two">${numericField('bbAudioOffset', '구간 시작 시간', 0, 0, 180, .1, '초')}${numericField('bbAudioDuration', '분석 길이', 10, 1, 60, .5, '초')}</div>${numericField('bbAudioLevel', '선택 구간의 1 m 기준 보정', 60, 30, 100, 1, 'dBA')}<p class="bb-note">파일의 디지털 크기는 실측 음압이 아닙니다. 입력한 dBA로 보정하고 분석 대역 밖 에너지는 복구하지 않습니다.</p><div class="bb-inline-actions"><button type="button" class="button" id="bbAnalyzeAudio">선택 활동에 분석 적용</button><button type="button" class="button" id="bbCancelAudio" disabled>취소</button></div><p class="bb-note" id="bbAudioStatus" role="status"></p><button type="button" class="bb-text-button" id="bbClearRecording" hidden>이 활동의 녹음 적용 해제</button></details>
    </section>
    <section class="bb-settings-section"><h3><span>02</span> 방·창문 조건</h3><p class="bb-note">소음원 방은 상단에서 선택합니다. 같은 방 안의 세부 좌표·높이는 이 공간 평균 계산에 영향을 주지 않습니다.</p><button type="button" class="bb-text-button" id="bbChooseSource">도면에서 소음원 방 선택 ↗</button><button type="button" class="bb-text-button" id="bbOpenings">우리집 창·문 설정 ↗</button><p class="bb-note" id="bbOpeningsSummary"></p><div class="bb-fields-two">${numericField('bbReceiverArea', '이웃 방 바닥 면적', 7.5, 4, 100, .1, 'm²')}${numericField('bbReceiverHeight', '이웃 방 높이', 2.3, 2, 4, .1, 'm')}</div>${numericField('bbRt60', '이웃 방 잔향시간 · 전 대역 가정', .5, .05, 5, .05, '초')}${numericField('bbBackground', '이웃 배경소음 · 스칼라 가정', 30, 0, 80, 1, 'dBA')}<p class="bb-note" id="bbRoomBandOverrides"></p></section>
    <section class="bb-settings-section"><h3><span>03</span> 전달 경계</h3><p class="bb-fixed-boundary">작업실 위쪽 공유벽 2.5 × 2.3 m<br>접한 위치와 5.75m² 면적은 고정합니다.</p><fieldset class="bb-element-fields" id="bbElementFields"><legend class="bb-sr-only">원소 성능과 병렬 전달 가정</legend><div class="bb-field"><label for="bbPartitionProfile">원소 차음 기본 가정</label><select id="bbPartitionProfile"><option value="masonry">조적·콘크리트 약 200mm 설계 대용값</option><option value="lightweight">경량벽 비교 가정 · 실제 우리집 미확인</option><option value="nrcExample">실험실 경량벽 예시 · 우리집 아님</option></select></div>${numericField('bbTlOffset', '원소 차음 보정 · 모든 대역', 0, -20, 20, 1, 'dB')}${numericField('bbLeakArea', '등가 누기 면적 · 가정', 10, 0, 1000, 1, 'cm²')}<p class="bb-note">실제 틈새 전체를 개방 면적으로 바꾼 비교값입니다. 육안으로 본 틈의 면적과 동일하지 않을 수 있습니다.</p><label class="bb-check"><input id="bbFlankEnabled" type="checkbox" checked> 우회 경로 포함</label>${numericField('bbFlankDn', '우회 경로 Dn,f · 전 대역 가정', 55, 0, 120, 1, 'dB')}</fieldset><p class="bb-note" id="bbTransferModeNote"></p><p class="bb-note" id="bbWallBandOverrides"></p></section>
    <section class="bb-settings-section"><h3><span>04</span> 주파수별 데이터</h3><div class="bb-field"><label for="bbSpectrumTarget">입력할 데이터</label><select id="bbSpectrumTarget">${Object.entries(TARGETS).map(([key, value]) => option(key, value.label)).join('')}</select></div><p class="bb-note" id="bbSpectrumTargetNote"></p><div class="bb-field"><label for="bbSpectrumProvenance">출처·측정 조건 또는 가정 메모</label><input id="bbSpectrumProvenance" type="text" maxlength="500" placeholder="시험성적서, 측정일·위치, 자료 이름 등"></div><details class="bb-details" id="bbSpectrumEditor"><summary>21대역 값 편집</summary><div class="bb-editor-table-scroll"><table class="bb-editor-table"><thead><tr><th>주파수 Hz</th><th id="bbEditorUnit">값 · dB</th></tr></thead><tbody id="bbSpectrumInputs"></tbody></table></div><button type="button" class="button bb-wide-button" id="bbApplySpectrum">21대역 입력 적용</button></details><details class="bb-details"><summary>CSV 붙여넣기·파일 입력</summary><p class="bb-note">frequencyHz,value 헤더와 21개 주파수 행이 필요합니다. 빈칸·누락·중복은 적용하지 않습니다.</p><textarea id="bbSpectrumPaste" rows="5" aria-label="주파수별 CSV 붙여넣기" placeholder="frequencyHz,value&#10;50,...&#10;63,..."></textarea><div class="bb-inline-actions"><button type="button" class="button" id="bbApplyCsv">붙여넣기 적용</button><label class="button bb-file-button" for="bbSpectrumFile">CSV 파일<input id="bbSpectrumFile" type="file" accept="text/csv,.csv,.txt"></label></div><div class="bb-inline-actions"><button type="button" class="bb-text-button" id="bbExportSpectrum">현재 대역 CSV</button><button type="button" class="bb-text-button" id="bbSpectrumTemplate">빈 CSV 양식</button></div></details><button type="button" class="bb-text-button" id="bbClearSpectrum">이 대역 입력 해제</button><p class="bb-note" id="bbSpectrumStatus" role="status"></p></section>
  </div>`;

  const canvas = $('bbBandCanvas'), context = canvas.getContext('2d');
  const scenarioKeys = { bbTypicalLevel: 'typicalLevel', bbLoudLevel: 'loudLevel', bbPitch: 'pitch', bbDuty: 'duty', bbLoudFraction: 'loudFraction', bbSpeakerLevel: 'speakerLevel', bbSpeakerDuty: 'speakerDuty' };
  const configKeys = { bbReceiverArea: 'receiverFloorAreaM2', bbReceiverHeight: 'receiverHeightM', bbRt60: 'receiverRt60', bbBackground: 'background', bbTlOffset: 'tlOffsetDb', bbLeakArea: 'leakAreaCm2', bbFlankDn: 'flankDnDb' };
  const percentKeys = ['duty', 'loudFraction', 'speakerDuty'];

  function composedOverrides(overrides = scenarioOverrides, records = recordings) {
    return Object.fromEntries(IDS.map(id => [id, { ...BROADBAND_SCENARIOS[id], ...overrides[id], ...(records[id] ?? {}) }]));
  }
  function fingerprint() { const state = getAcousticState(); return JSON.stringify([state.source.x, state.source.z, state.settings]); }
  function inputKind(id) { return config.measuredSourceRoomBandsDb && config.measuredSourceRoomScenarioId === id ? 'measured' : recordings[id] ? recordings[id].frames?.length ? 'recording' : 'spectrum' : 'synthetic'; }
  function conditionLabel(condition) { return config.transferMode === 'element' ? condition.label : '입력된 현장 전달값'; }
  function currentRow() { return result?.scenarios.find(row => row.id === selectedScenario); }
  function currentCondition() { const row = currentRow(); return row?.conditions.find(condition => condition.id === selectedCondition) ?? row?.conditions[0]; }
  function currentMetric() { return currentCondition()?.[selectedMetric]; }
  function announce(message) { $('bbOperationMessage').textContent = message; }
  function audioMessage(message, id = selectedScenario) { audioMessages[id] = message; if (id === selectedScenario) $('bbAudioStatus').textContent = message; }

  function syncShared() {
    const { source, sourceRoomId, settings } = getAcousticState();
    const room = rooms.find(item => item.id === sourceRoomId) ?? rooms.find(item => insideRoom(item, source.x, source.z));
    $('bbSourceRoom').value = room?.id ?? 'custom';
    $('bbOpeningsSummary').textContent = `현재 우리집 창·문 ${Object.values(settings.doorStates ?? {}).filter(Boolean).length}개 열림 · 이 계산에 반영`;
  }

  function syncConfig() {
    $('bbTransferMode').value = config.transferMode;
    $('bbPartitionProfile').value = config.partitionProfile;
    for (const [id, key] of Object.entries(configKeys)) $(id).value = config[key];
    $('bbFlankEnabled').checked = config.flankEnabled;
    const measured = config.transferMode !== 'element';
    $('bbElementFields').disabled = measured;
    $('bbTransferModeNote').textContent = measured ? '현장 전달 성능에 병렬 경로의 영향이 포함되므로 별도 틈새·우회를 더하지 않습니다. 측정값의 불확도는 입력되지 않았습니다.' : '벽을 통과하는 소리, 등가 누기, 우회 경로를 에너지로 합산합니다. 각 입력은 실제 구조 확인 전의 가정입니다.';
    $('bbGeometryContext').textContent = `이웃 방 ${config.receiverFloorAreaM2}m² · 높이 ${config.receiverHeightM}m · 잔향시간 ${config.receiverRt60Bands ? '21대역 입력' : `${config.receiverRt60}초 가정`}`;
    const key = config.transferMode === 'apparent' ? 'Rprime' : config.transferMode === 'dnt' ? 'DnT' : 'R';
    const source = measurementNotes[key] || (config.transferMode === 'element' && !config.partitionBandsDb ? `${BROADBAND_PARTITIONS[config.partitionProfile].label} · 우리집 실측 아님` : '사용자 입력 · 출처 메모 미입력');
    $('bbDataSource').textContent = `${MODE_LABELS[config.transferMode]} · ${source}`;
    $('bbRangeExplanation').textContent = measured ? '현장 전달값 한 조건을 사용합니다. 측정 불확도가 제공되지 않아 별도의 범위는 만들지 않습니다.' : '미확인 시공 조건 3개를 계산한 범위입니다. 신뢰구간이나 측정 오차 범위가 아닙니다.';
    $('bbRoomBandOverrides').textContent = [config.receiverRt60Bands ? '잔향시간은 대역 입력을 사용합니다.' : '', config.backgroundBandsDb ? '배경소음은 입력한 21대역 모양을 사용합니다.' : config.background === null ? '이 프로젝트는 배경소음을 합산하지 않는 조건입니다.' : '배경의 대역 모양은 동일 대역 에너지로 가정합니다. A보정 합계만 입력한 dBA와 일치시킵니다.'].filter(Boolean).join(' ');
    $('bbRt60').disabled = Boolean(config.receiverRt60Bands); $('bbBackground').disabled = Boolean(config.backgroundBandsDb);
    $('bbWallBandOverrides').textContent = [config.partitionBandsDb ? '원소 R은 21대역 입력을 사용합니다.' : '', config.flankBandsDb ? '우회 Dn,f는 21대역 입력을 사용합니다.' : ''].filter(Boolean).join(' ');
    $('bbPartitionProfile').disabled = measured || Boolean(config.partitionBandsDb);
    $('bbFlankDn').disabled = measured || Boolean(config.flankBandsDb) || !config.flankEnabled;
    renderMissingInputs();
  }

  function syncScenario() {
    const scenario = scenarioOverrides[selectedScenario], kind = inputKind(selectedScenario);
    $('bbScenarioSelect').value = selectedScenario;
    for (const id of IDS) { $(`bbCard-${id}`).classList.toggle('bb-selected', id === selectedScenario); stage.querySelector(`[data-select-scenario="${id}"]`).setAttribute('aria-pressed', String(id === selectedScenario)); }
    for (const [id, key] of Object.entries(scenarioKeys)) $(id).value = percentKeys.includes(key) ? Math.round(scenario[key] * 100) : scenario[key];
    $('bbVoiceEnabled').checked = scenario.voiceEnabled; $('bbSpeakerEnabled').checked = scenario.speakerEnabled;
    $('bbLoudLevel').min = scenario.typicalLevel;
    $('bbSyntheticFields').disabled = kind !== 'synthetic';
    for (const id of ['bbTypicalLevel', 'bbLoudLevel', 'bbPitch', 'bbDuty', 'bbLoudFraction']) $(id).disabled = kind !== 'synthetic' || !scenario.voiceEnabled;
    $('bbSpeakerLevel').disabled = $('bbSpeakerDuty').disabled = kind !== 'synthetic' || !scenario.speakerEnabled;
    $('bbInputKind').textContent = kind === 'measured' ? '작업실 실측 L1 · 녹음·합성 입력을 대체' : kind === 'recording' ? '녹음 분석 구간 · 합성 발성률 미적용' : kind === 'spectrum' ? '입력 평균 스펙트럼 · 합성 발성률 미적용' : '합성 음성·스피커 입력 가정';
    $('bbMeasuredSourceNote').hidden = kind !== 'measured';
    $('bbClearRecording').hidden = !recordings[selectedScenario];
    $('bbDetailTitle').textContent = `${BROADBAND_SCENARIOS[selectedScenario].label} 상세`;
    $('bbMetricSelect').innerHTML = kind === 'recording' ? option('session', '전체 분석구간 LAeq') + option('loud', recordings[selectedScenario].durationSeconds < 1 ? '1초 미만 전체 구간 평균' : '스펙트럼 구간 최대') : kind === 'measured' ? option('session', '측정 L1 조건') : kind === 'spectrum' ? option('session', '입력 스펙트럼 평균') : option('session', '활동 전체 LAeq') + option('active', '평소 구간') + option('loud', '큰 소리 구간');
    if (![...$('bbMetricSelect').options].some(item => item.value === selectedMetric)) selectedMetric = 'session';
    $('bbMetricSelect').value = selectedMetric;
    const clip = audioClips[selectedScenario], options = audioOptions[selectedScenario] ?? { offsetSeconds: 0, durationSeconds: 10, levelDbA: scenario.typicalLevel };
    $('bbAudioOffset').value = options.offsetSeconds; $('bbAudioDuration').value = options.durationSeconds; $('bbAudioLevel').value = options.levelDbA;
    $('bbAudioFileInfo').textContent = clip ? `${clip.name} · ${clip.duration.toFixed(1)}초 · ${clip.sampleRate.toLocaleString()}Hz` : recordings[selectedScenario] ? `${recordings[selectedScenario].fileName ?? '저장된 녹음 분석'} · 원본 파일을 다시 선택하면 재분석할 수 있습니다.` : '파일을 선택하세요.';
    $('bbAnalyzeAudio').disabled = audioBusy || !clip || kind === 'measured';
    $('bbCancelAudio').disabled = !audioBusy;
    $('bbAudioStatus').textContent = audioBusy ? `${BROADBAND_SCENARIOS[audioTarget ?? selectedScenario].label}의 파일을 처리하고 있습니다.` : audioMessages[selectedScenario] ?? (recordings[selectedScenario] ? recordingSummary(recordings[selectedScenario]) : '');
    renderDetails();
  }

  function recordingSummary(recording) {
    return `${finiteDuration(recording.durationSeconds)}초 분석 · 전체 ${db(recording.analysisBandLevelDbA)} dBA(분석 대역) · 입력 A보정 에너지 ${(100 * (recording.retainedAWeightedFraction ?? 0)).toFixed(1)}% 포함. 구간 최대는 1초 분석창·0.5초 간격의 스펙트럼에서 계산하며 LAFmax나 순간 음압 피크가 아닙니다.`;
  }
  function finiteDuration(value) { return Number.isFinite(value) ? value.toFixed(1) : '—'; }

  function schedule() {
    dirty = true; clearTimeout(timer); timer = 0;
    if (!active) return;
    stage.classList.add('bb-pending'); stage.setAttribute('aria-busy', 'true'); $('bbComputeStatus').textContent = '조건 계산 중';
    timer = setTimeout(calculate, 120);
  }

  function calculate() {
    timer = 0;
    if (!active) return;
    try {
      const state = getAcousticState();
      result = model.compareScenarios(state.source, state.settings, config, composedOverrides());
      dirty = false; $('bbError').hidden = true; $('bbComputeStatus').textContent = '계산 완료';
      renderCards(); renderDetails(); renderMissingInputs(); if (!editorDirty) syncEditor();
    } catch (error) {
      result = null; $('bbError').textContent = `입력 조건을 확인하세요. ${error.message}`; $('bbError').hidden = false; $('bbComputeStatus').textContent = '입력 확인 필요';
      renderCards(); renderDetails(); renderMissingInputs();
    }
    stage.classList.remove('bb-pending'); stage.setAttribute('aria-busy', 'false');
  }

  function renderCards() {
    for (const id of IDS) {
      const row = result?.scenarios.find(item => item.id === id), scenario = scenarioOverrides[id], kind = inputKind(id);
      $(`bbRange-${id}`).textContent = rangeText(row?.range.session);
      $(`bbMetricLabel-${id}`).textContent = kind === 'recording' ? '전체 녹음구간 LAeq · 이 소음원만' : kind === 'measured' ? '입력 L1 조건 · 이 소음원만' : kind === 'spectrum' ? '입력 평균 · 이 소음원만' : '활동 전체 LAeq · 이 소음원만';
      $(`bbInput-${id}`).textContent = kind === 'recording' ? `${recordings[id].fileName ?? '녹음 입력'} · ${finiteDuration(recordings[id].durationSeconds)}초 · 1m 보정 ${db(recordings[id].fullBandLevelDbA)}dBA` : kind === 'measured' ? '작업실의 측정 대역값 사용 · 활동률 미적용' : kind === 'spectrum' ? '평균 스펙트럼 입력 · 활동률 미적용' : [scenario.voiceEnabled ? `음성 ${scenario.typicalLevel}dBA · 발성 ${Math.round(scenario.duty * 100)}%` : '', scenario.speakerEnabled ? `스피커 ${scenario.speakerLevel}dBA` : ''].filter(Boolean).join(' / ') || '음성·스피커 꺼짐';
      $(`bbConditions-${id}`).innerHTML = row?.conditions.map(condition => `<div><dt>${escape(conditionLabel(condition))}</dt><dd>${db(condition.session.sourceOnlyDbA)} <small>dBA</small></dd></div>`).join('') ?? '<div><dt>필요한 입력을 확인하세요</dt><dd>—</dd></div>';
      $(`bbLoud-${id}`).textContent = row && row.assumptions.loudAvailable ? `${kind === 'recording' ? recordings[id].durationSeconds < 1 ? '1초 미만 전체 평균' : '스펙트럼 구간 최대 · 1초 분석창' : '큰 소리 구간'}: ${rangeText(row.range.loud)} dBA` : kind === 'measured' || kind === 'spectrum' ? '큰 구간 시간자료·측정 불확도 미입력' : '';
      const totals = row?.conditions.map(condition => condition.session.totalDbA).filter(Number.isFinite) ?? [];
      $(`bbTotal-${id}`).textContent = totals.length ? `이웃 배경소음 포함: ${rangeText({ min: Math.min(...totals), max: Math.max(...totals) })} dBA` : '';
    }
  }

  function renderDetails() {
    const row = currentRow();
    $('bbConditionSelect').innerHTML = row?.conditions.map(condition => option(condition.id, conditionLabel(condition))).join('') ?? option('central', '계산 조건 대기');
    if (!row?.conditions.some(condition => condition.id === selectedCondition)) selectedCondition = row?.conditions[0]?.id ?? 'central';
    $('bbConditionSelect').value = selectedCondition;
    const condition = currentCondition(), metric = currentMetric(), kind = inputKind(selectedScenario);
    $('bbDetailContext').textContent = metric ? `${conditionLabel(condition)} · ${$('bbMetricSelect').selectedOptions[0]?.textContent ?? ''} · 원인음 ${db(metric.sourceOnlyDbA)} dBA / 배경 ${db(metric.backgroundDbA)} dBA / 합계 ${db(metric.totalDbA)} dBA · ${config.backgroundBandsDb ? '배경 모양: 대역 입력' : '배경 모양: 동일 대역 에너지 가정'}` : '필요한 입력을 채우면 주파수별 전달음과 경로 기여를 표시합니다.';
    $('bbBandTable').innerHTML = BANDS.map((band, index) => `<tr><th scope="row">${band}</th><td>${bandText(metric?.sourceRoomBandsDb?.[index])}</td><td>${bandText(metric?.receiverBandsDb?.[index])}</td><td>${bandText(metric?.backgroundBandsDb?.[index])}</td><td>${bandText(metric?.totalBandsDb?.[index])}</td></tr>`).join('');
    $('bbPathNote').textContent = config.transferMode === 'element' ? '이 소음원의 A보정 전달 에너지 비중' : '현장 전달값에 포함된 경로를 별도로 분리하지 않습니다.';
    $('bbPathContributions').innerHTML = metric?.routeContributions?.length ? metric.routeContributions.map(path => `<div class="bb-path"><div><span>${escape(path.label)}</span><strong>${db(path.levelDbA)} dBA</strong></div><div class="bb-path-track"><span style="width:${clamp((path.fraction ?? 0) * 100, 0, 100)}%"></span></div><small>${Number.isFinite(path.fraction) ? (path.fraction * 100).toFixed(1) + '% 에너지' : ''}</small></div>`).join('') : '<p class="bb-note">계산 결과 없음</p>';
    $('bbSensitivity').innerHTML = row?.sensitivity?.map(item => `<div><span>${escape(conditionLabel(item))}</span><strong>${db(item.sourceOnlyDbA)} dBA</strong>${config.transferMode === 'element' ? `<small>중앙 대비 ${Number.isFinite(item.deltaDb) && item.deltaDb > 0 ? '+' : ''}${db(item.deltaDb)} dB</small>` : '<small>불확도 자료 미입력</small>'}</div>`).join('') ?? '';
    $('bbSensitivityNote').textContent = config.transferMode === 'element' ? `${kind === 'recording' ? '전체 녹음구간 LAeq' : kind === 'measured' ? '입력 L1 측정 조건' : kind === 'spectrum' ? '입력 스펙트럼 평균' : '활동 전체 LAeq'}의 조건별 비교입니다. 발생 확률을 부여하지 않았습니다.` : '측정 전달값의 불확도가 없어 임의 범위를 추가하지 않습니다.';
    drawChart();
  }

  function renderMissingInputs() {
    const items = [];
    if (config.transferMode === 'element') {
      items.push(config.partitionBandsDb ? `원소 R 21대역 입력 · ${measurementNotes.R || '자료 출처 미입력'}` : `${BROADBAND_PARTITIONS[config.partitionProfile].label} 사용 · 우리집 벽의 실제 구조·시험값 미입력`);
      items.push(`등가 누기 ${config.leakAreaCm2}cm² · 실제 누기 상태 확인 필요`);
      items.push(config.flankEnabled ? config.flankBandsDb ? `우회 Dn,f 21대역 입력 · ${measurementNotes.flank || '출처 미입력'}` : `우회 Dn,f ${config.flankDnDb}dB 가정 · 실제 경로 확인 필요` : '우회 경로를 계산에서 제외한 조건');
    } else items.push(`${MODE_LABELS[config.transferMode]} · ${measurementNotes[config.transferMode === 'apparent' ? 'Rprime' : 'DnT'] || '측정 출처·조건 미입력'} · 불확도 미입력`);
    items.push(config.receiverRt60Bands ? `이웃 잔향시간 대역 입력 · ${measurementNotes.rt60 || '출처 미입력'}` : `이웃 잔향시간 ${config.receiverRt60}초 가정 · 현장 값 미입력`);
    items.push(config.backgroundBandsDb ? `이웃 배경소음 대역 입력 · ${measurementNotes.background || '출처 미입력'}` : config.background === null ? '배경소음을 합산하지 않는 입력 조건' : `이웃 배경소음 ${config.background}dBA 가정 · 현장 대역값 미입력`);
    $('bbMissingInputs').innerHTML = items.map(item => `<li>${escape(item)}</li>`).join('');
    const notices = [...(currentMetric()?.details?.notices ?? result?.details?.notices ?? [])];
    if (!config.partitionBandsDb) notices.unshift(BROADBAND_PARTITIONS[config.partitionProfile].provenance);
    $('bbModelNotices').innerHTML = notices.map(item => `<li>${escape(item)}</li>`).join('');
  }

  function chartSize() {
    const box = canvas.getBoundingClientRect(); if (box.width < 2 || box.height < 2) return null;
    const ratio = Math.min(2, window.devicePixelRatio || 1), width = Math.round(box.width * ratio), height = Math.round(box.height * ratio);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    context.setTransform(ratio, 0, 0, ratio, 0, 0); return { width: box.width, height: box.height };
  }

  function drawChart() {
    if (!active) return;
    const size = chartSize(); if (!size) return;
    const { width: w, height: h } = size, left = 43, right = 15, top = 23, bottom = 33, metric = currentMetric();
    context.clearRect(0, 0, w, h); context.fillStyle = '#fafcf8'; context.fillRect(0, 0, w, h);
    const values = metric ? SERIES.flatMap(series => metric[series.key] ?? []).filter(bandPresent) : [];
    let min = values.length ? Math.floor(Math.min(...values) / 10) * 10 : 0, max = values.length ? Math.ceil(Math.max(...values) / 10) * 10 : 80;
    if (max - min < 30) min = max - 30;
    const x = index => left + index / (BANDS.length - 1) * (w - left - right), y = value => h - bottom - (value - min) / (max - min) * (h - top - bottom);
    chartGeometry = { left, right, width: w, x, y };
    context.font = '10px Arial, "Apple SD Gothic Neo", sans-serif'; context.lineWidth = 1;
    for (let tick = 0; tick <= 4; tick++) {
      const value = min + (max - min) * tick / 4, yy = y(value);
      context.beginPath(); context.moveTo(left, yy); context.lineTo(w - right, yy); context.strokeStyle = '#e1e8da'; context.stroke();
      context.textAlign = 'right'; context.textBaseline = 'middle'; context.fillStyle = '#617257'; context.fillText(value.toFixed(0), left - 7, yy);
    }
    context.textAlign = 'left'; context.textBaseline = 'top'; context.fillStyle = '#617257'; context.fillText('dB SPL', 5, 4);
    for (const index of [0, 3, 6, 10, 13, 16, 20]) { context.textAlign = 'center'; context.fillText(freq(BANDS[index]), x(index), h - bottom + 11); }
    context.textAlign = 'right'; context.fillText('Hz', w - 2, h - 12);
    if (metric) {
      for (const [seriesIndex, series] of SERIES.entries()) {
        const dataValues = metric[series.key]; context.beginPath(); let started = false;
        for (let i = 0; i < BANDS.length; i++) { const value = dataValues?.[i]; if (!bandPresent(value)) { started = false; continue; } if (!started) context.moveTo(x(i), y(value)); else context.lineTo(x(i), y(value)); started = true; }
        context.strokeStyle = series.color; context.lineWidth = seriesIndex === 0 ? 2.2 : 1.5; context.setLineDash(seriesIndex === 1 ? [4, 3] : seriesIndex === 2 ? [2, 2] : []); context.stroke(); context.setLineDash([]);
      }
      context.beginPath(); context.moveTo(x(selectedBand), top); context.lineTo(x(selectedBand), h - bottom); context.strokeStyle = '#547a4866'; context.setLineDash([3, 3]); context.stroke(); context.setLineDash([]);
      $('bbBandReadout').textContent = `${BANDS[selectedBand]} Hz · 전달음 ${bandText(metric.receiverBandsDb?.[selectedBand])} / 배경 ${bandText(metric.backgroundBandsDb?.[selectedBand])} / 합계 ${bandText(metric.totalBandsDb?.[selectedBand])} dB SPL`;
    } else { context.textAlign = 'center'; context.textBaseline = 'middle'; context.font = '12px Arial, "Apple SD Gothic Neo", sans-serif'; context.fillStyle = '#718466'; context.fillText('계산할 입력을 확인하세요', w / 2, h / 2); $('bbBandReadout').textContent = '계산 대기'; }
  }

  function inputCurve(target = editorTarget) {
    const spec = TARGETS[target];
    if (spec.mode) return config.transferMode === spec.mode ? config.measuredTransferBandsDb : transferSpectra[spec.mode];
    if (target === 'L1') return config.measuredSourceRoomBandsDb;
    try { return model.inputBands(config)[spec.key] ?? null; } catch { return config[spec.key] ?? null; }
  }

  function syncEditor() {
    editorDirty = false;
    const spec = TARGETS[editorTarget], values = inputCurve();
    $('bbSpectrumTarget').value = editorTarget; $('bbSpectrumProvenance').value = measurementNotes[editorTarget] ?? '';
    $('bbEditorUnit').textContent = `값 · ${spec.unit}`;
    $('bbSpectrumTargetNote').textContent = editorTarget === 'L1' ? `현재 선택한 ‘${BROADBAND_SCENARIOS[selectedScenario].label}’에만 작업실의 측정 공간 평균 L1을 적용합니다.` : spec.mode ? '이 입력을 적용하면 해당 현장 전달 모드로 전환합니다. 별도 누기·우회 가정을 더하지 않습니다.' : '스칼라·기본 가정에서 펼친 현재 곡선도 표시합니다. 적용 버튼을 누르면 명시적인 21대역 입력으로 저장합니다.';
    $('bbSpectrumInputs').innerHTML = BANDS.map((band, index) => `<tr><th scope="row">${band}</th><td><input type="number" data-band-index="${index}" aria-label="${band} Hz ${escape(spec.label)} ${spec.unit}" min="${spec.min}" max="${spec.max}" step="${editorTarget === 'rt60' ? '.01' : '.1'}" value="${Number.isFinite(values?.[index]) ? +values[index].toFixed(3) : ''}" placeholder="필수"></td></tr>`).join('');
    $('bbExportSpectrum').disabled = !values;
  }

  function validateCandidate(nextConfig, overrides = scenarioOverrides, records = recordings, source, settings) {
    const state = getAcousticState();
    return model.compareScenarios(source ?? state.source, settings ?? state.settings, nextConfig, composedOverrides(overrides, records));
  }

  function applySpectrum(values, provenance = $('bbSpectrumProvenance').value.trim()) {
    const spec = TARGETS[editorTarget], next = structuredClone(config);
    next[spec.key] = values;
    if (spec.mode) next.transferMode = spec.mode;
    if (editorTarget === 'L1') next.measuredSourceRoomScenarioId = selectedScenario;
    try {
      validateCandidate(next);
      config = next; measurementNotes[editorTarget] = provenance;
      if (spec.mode) transferSpectra[spec.mode] = [...values];
      $('bbSpectrumStatus').textContent = `${spec.label} 21대역을 적용했습니다.`;
      syncConfig(); syncScenario(); syncEditor(); schedule();
    } catch (error) { $('bbSpectrumStatus').textContent = `적용하지 않았습니다. ${error.message}`; }
  }

  function changeMode(mode) {
    if (config.transferMode !== 'element' && config.measuredTransferBandsDb) transferSpectra[config.transferMode] = [...config.measuredTransferBandsDb];
    config.transferMode = mode;
    if (mode !== 'element') config.measuredTransferBandsDb = transferSpectra[mode] ? [...transferSpectra[mode]] : null;
    editorTarget = mode === 'apparent' ? 'Rprime' : mode === 'dnt' ? 'DnT' : 'R';
    syncConfig(); syncScenario(); syncEditor(); schedule();
  }

  function selectScenario(id) {
    if (!IDS.includes(id)) return;
    selectedScenario = id; selectedMetric = 'session'; $('bbAudioFile').value = ''; syncScenario(); renderMissingInputs();
    if (editorTarget === 'L1') syncEditor();
  }

  $('bbSourceRoom').addEventListener('change', () => { const room = rooms.find(item => item.id === $('bbSourceRoom').value); if (room) { setSource({ x: room.center[0], z: room.center[1] }); syncShared(); schedule(); } });
  $('bbTransferMode').addEventListener('change', () => changeMode($('bbTransferMode').value));
  stage.addEventListener('click', event => { const button = event.target.closest('[data-select-scenario]'); if (button) selectScenario(button.dataset.selectScenario); });
  $('bbScenarioSelect').addEventListener('change', () => selectScenario($('bbScenarioSelect').value));
  $('bbConditionSelect').addEventListener('change', () => { selectedCondition = $('bbConditionSelect').value; renderDetails(); });
  $('bbMetricSelect').addEventListener('change', () => { selectedMetric = $('bbMetricSelect').value; renderDetails(); });
  for (const [id, key] of Object.entries(scenarioKeys)) $(id).addEventListener('change', () => {
    const input = $(id), value = input.valueAsNumber;
    if (!Number.isFinite(value)) { syncScenario(); return; }
    const bounded = clamp(value, +input.min, +input.max);
    scenarioOverrides[selectedScenario][key] = percentKeys.includes(key) ? bounded / 100 : bounded;
    if (key === 'typicalLevel') scenarioOverrides[selectedScenario].loudLevel = Math.max(scenarioOverrides[selectedScenario].loudLevel, bounded);
    syncScenario(); schedule();
  });
  for (const [id, key] of [['bbVoiceEnabled', 'voiceEnabled'], ['bbSpeakerEnabled', 'speakerEnabled']]) $(id).addEventListener('change', () => { scenarioOverrides[selectedScenario][key] = $(id).checked; syncScenario(); schedule(); });
  for (const [id, key] of Object.entries(configKeys)) $(id).addEventListener('change', () => { const input = $(id), value = input.valueAsNumber; if (!Number.isFinite(value)) { syncConfig(); return; } config[key] = clamp(value, +input.min, +input.max); syncConfig(); schedule(); });
  $('bbPartitionProfile').addEventListener('change', () => { config.partitionProfile = $('bbPartitionProfile').value; syncConfig(); syncEditor(); schedule(); });
  $('bbFlankEnabled').addEventListener('change', () => { config.flankEnabled = $('bbFlankEnabled').checked; syncConfig(); schedule(); });
  $('bbChooseSource').addEventListener('click', () => onChooseSourcePosition('source'));
  $('bbOpenings').addEventListener('click', () => onChooseSourcePosition('openings'));
  $('bbClearL1').addEventListener('click', () => { config.measuredSourceRoomBandsDb = null; syncScenario(); syncEditor(); schedule(); });
  $('bbClearRecording').addEventListener('click', () => { delete recordings[selectedScenario]; delete audioMessages[selectedScenario]; syncScenario(); schedule(); });
  $('bbSpectrumTarget').addEventListener('change', () => { editorTarget = $('bbSpectrumTarget').value; syncEditor(); });
  $('bbSpectrumInputs').addEventListener('input', () => { editorDirty = true; });
  $('bbSpectrumProvenance').addEventListener('input', () => { editorDirty = true; });
  $('bbApplySpectrum').addEventListener('click', () => {
    const inputs = [...$('bbSpectrumInputs').querySelectorAll('input')], spec = TARGETS[editorTarget];
    if (inputs.some(input => !Number.isFinite(input.valueAsNumber) || input.valueAsNumber < spec.min || input.valueAsNumber > spec.max)) { $('bbSpectrumStatus').textContent = `21개 값을 모두 ${spec.min}~${spec.max} ${spec.unit} 범위로 입력하세요.`; return; }
    applySpectrum(inputs.map(input => input.valueAsNumber));
  });
  function applyCsv(text, name = '') {
    try { const spec = TARGETS[editorTarget]; applySpectrum(parseBandCsv(text, { min: spec.min, max: spec.max }), $('bbSpectrumProvenance').value.trim() || name); }
    catch (error) { $('bbSpectrumStatus').textContent = `CSV를 적용하지 않았습니다. ${error.message}`; }
  }
  $('bbApplyCsv').addEventListener('click', () => applyCsv($('bbSpectrumPaste').value));
  $('bbSpectrumFile').addEventListener('change', async () => { const file = $('bbSpectrumFile').files?.[0]; if (!file) return; if (file.size > 100000) { $('bbSpectrumStatus').textContent = '대역 CSV는 100KB 이하로 선택하세요.'; return; } applyCsv(await file.text(), file.name); $('bbSpectrumFile').value = ''; });
  $('bbExportSpectrum').addEventListener('click', () => { const values = inputCurve(); if (values) download(`home-simulator-${editorTarget}.csv`, formatBandCsv(values), 'text/csv;charset=utf-8'); });
  $('bbSpectrumTemplate').addEventListener('click', () => download('home-simulator-21-bands-template.csv', `frequencyHz,value\n${BANDS.map(band => `${band},`).join('\n')}\n`, 'text/csv;charset=utf-8'));
  $('bbClearSpectrum').addEventListener('click', () => {
    const spec = TARGETS[editorTarget];
    if (spec.mode) { transferSpectra[spec.mode] = null; if (config.transferMode === spec.mode) config.measuredTransferBandsDb = null; }
    else config[spec.key] = null;
    delete measurementNotes[editorTarget]; syncConfig(); syncScenario(); syncEditor(); schedule();
  });
  canvas.addEventListener('pointermove', event => { if (!chartGeometry) return; const box = canvas.getBoundingClientRect(); selectedBand = clamp(Math.round((event.clientX - box.left - chartGeometry.left) / (chartGeometry.width - chartGeometry.left - chartGeometry.right) * (BANDS.length - 1)), 0, BANDS.length - 1); drawChart(); });
  canvas.addEventListener('keydown', event => { const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0; if (!delta) return; event.preventDefault(); selectedBand = clamp(selectedBand + delta, 0, BANDS.length - 1); drawChart(); });

  async function audioDuration(file) {
    const url = URL.createObjectURL(file), media = document.createElement('audio'); media.preload = 'metadata';
    try {
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('파일 길이를 확인하지 못했습니다. 지원되는 다른 오디오 형식으로 시도하세요.')), 15000);
        media.onloadedmetadata = () => { clearTimeout(timeout); if (Number.isFinite(media.duration) && media.duration > 0) resolve(media.duration); else reject(new Error('파일 길이를 확인할 수 없습니다.')); };
        media.onerror = () => { clearTimeout(timeout); reject(new Error('오디오 파일 정보를 읽을 수 없습니다.')); }; media.src = url;
      });
    } finally { media.removeAttribute('src'); media.load(); URL.revokeObjectURL(url); }
  }

  function cancelAudio(message = '분석을 취소했습니다.') {
    const target = audioTarget ?? selectedScenario;
    analysisId++; decodeId++; audioWorker?.terminate(); audioWorker = null; audioBusy = false; audioTarget = null;
    audioMessage(message, target); syncScenario();
  }

  $('bbAudioFile').addEventListener('change', async () => {
    const file = $('bbAudioFile').files?.[0], id = selectedScenario;
    cancelAudio(''); const request = ++decodeId;
    if (!file) return;
    delete audioClips[id]; delete audioMessages[id];
    if (file.size > 32 * 1024 * 1024) { syncScenario(); audioMessage('32MB 이하의 오디오 파일을 선택하세요.', id); return; }
    audioBusy = true; audioTarget = id; syncScenario(); $('bbAudioStatus').textContent = '파일 길이를 확인하고 기기 안에서 읽고 있습니다.';
    let decoder;
    try {
      const duration = await audioDuration(file);
      if (duration > 180.05) throw new Error('파일 전체 길이는 3분 이하여야 합니다. 사용할 구간을 잘라 다시 선택하세요.');
      if (duration < 1) throw new Error('분석할 파일에는 1초 이상의 소리가 필요합니다.');
      if (request !== decodeId) return;
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) throw new Error('이 브라우저는 오디오 디코딩을 지원하지 않습니다.');
      decoder = new Audio(); const buffer = await decoder.decodeAudioData(await file.arrayBuffer());
      if (request !== decodeId) return;
      if (buffer.duration > 180.05) throw new Error('디코딩된 파일이 3분을 넘습니다.');
      const samples = new Float32Array(buffer.length);
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) { const values = buffer.getChannelData(channel); for (let i = 0; i < samples.length; i++) samples[i] += values[i] / buffer.numberOfChannels; }
      audioClips[id] = { name: file.name, samples, sampleRate: buffer.sampleRate, duration: buffer.duration };
      audioOptions[id] = { offsetSeconds: 0, durationSeconds: Math.min(10, Math.floor(buffer.duration * 10) / 10), levelDbA: scenarioOverrides[id].typicalLevel };
      audioMessage('파일을 읽었습니다. 분석 적용을 누르면 선택한 활동에 반영합니다.', id);
    } catch (error) { if (request === decodeId) audioMessage(error.message, id); }
    finally { await decoder?.close().catch(() => {}); if (request === decodeId) { audioBusy = false; audioTarget = null; syncScenario(); } }
  });
  for (const [id, key] of [['bbAudioOffset', 'offsetSeconds'], ['bbAudioDuration', 'durationSeconds'], ['bbAudioLevel', 'levelDbA']]) $(id).addEventListener('change', () => {
    audioOptions[selectedScenario] ??= { offsetSeconds: 0, durationSeconds: 10, levelDbA: scenarioOverrides[selectedScenario].typicalLevel };
    const input = $(id), value = input.valueAsNumber;
    if (Number.isFinite(value)) audioOptions[selectedScenario][key] = clamp(value, +input.min, +input.max);
    input.value = audioOptions[selectedScenario][key];
  });
  $('bbAnalyzeAudio').addEventListener('click', () => {
    const id = selectedScenario, clip = audioClips[id]; if (!clip || audioBusy) return;
    const options = audioOptions[id] ?? { offsetSeconds: 0, durationSeconds: 10, levelDbA: scenarioOverrides[id].typicalLevel };
    if (options.offsetSeconds > clip.duration - 1 || options.durationSeconds < 1) { audioMessage('파일 안에서 1초 이상 남아 있는 구간을 선택하세요.', id); return; }
    audioWorker?.terminate(); const request = ++analysisId; audioBusy = true; audioTarget = id; syncScenario(); $('bbAudioStatus').textContent = '주파수별 에너지와 시간 구간을 분석하고 있습니다.';
    try {
      audioWorker = new Worker(new URL('./broadband-audio-worker.js', import.meta.url), { type: 'module' });
      audioWorker.onmessage = ({ data: message }) => {
        if (message.id !== request || request !== analysisId) return;
        audioBusy = false; audioWorker?.terminate(); audioWorker = null; audioTarget = null;
        if (message.type === 'error') { audioMessage(`분석하지 못했습니다. ${message.error}`, id); syncScenario(); return; }
        if (message.type !== 'result') return;
        const next = { ...recordings, [id]: { ...message.result, fileName: clip.name } };
        try { validateCandidate(config, scenarioOverrides, next); recordings = next; audioMessage(recordingSummary(recordings[id]), id); syncScenario(); schedule(); announce(`${BROADBAND_SCENARIOS[id].label}에 녹음 분석을 적용했습니다.`); }
        catch (error) { audioMessage(`적용하지 않았습니다. ${error.message}`, id); syncScenario(); }
      };
      audioWorker.onerror = event => { event.preventDefault(); if (request !== analysisId) return; cancelAudio('분석 Worker를 실행하지 못했습니다. 새로고침 후 다시 시도하세요.'); };
      audioWorker.onmessageerror = () => { if (request === analysisId) cancelAudio('분석 결과를 읽지 못했습니다. 다시 분석하세요.'); };
      audioWorker.postMessage({ type: 'analyze', id: request, samples: clip.samples, sampleRate: clip.sampleRate, options });
    } catch (error) { cancelAudio(error.message); }
  });
  $('bbCancelAudio').addEventListener('click', () => cancelAudio());

  $('bbExportProject').addEventListener('click', () => {
    try { const state = getAcousticState(); const text = serializeBroadbandProject({ config, scenarioOverrides, recordings, source: state.source, settings: state.settings, selectedScenario, measurementNotes }); download('home-simulator-broadband.json', text, 'application/json'); announce('현재 입력과 분석 결과를 프로젝트 JSON으로 내보냈습니다.'); }
    catch (error) { announce(`내보내지 못했습니다. ${error.message}`); }
  });
  $('bbImportProject').addEventListener('change', async () => {
    const file = $('bbImportProject').files?.[0]; if (!file) return;
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error('프로젝트 파일은 4MB 이하로 선택하세요.');
      const candidate = parseBroadbandProject(await file.text());
      const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
      if (candidate.measurementNotes != null && (!plainObject(candidate.measurementNotes) || Object.values(candidate.measurementNotes).some(value => typeof value !== 'string'))) throw new Error('자료 출처는 데이터 종류별 텍스트 메모여야 합니다.');
      for (const [id, recording] of Object.entries(candidate.recordings ?? {})) if (!plainObject(recording) || !Array.isArray(recording.bandLevelsDb) && !recording.frames?.length) throw new Error(`${id}의 녹음 분석 대역 자료가 없습니다.`);
      for (const [id, override] of Object.entries(candidate.scenarioOverrides ?? {})) if (!plainObject(override)) throw new Error(`${id}의 활동 조건이 올바르지 않습니다.`);
      const nextOverrides = Object.fromEntries(IDS.map(id => [id, { ...BROADBAND_SCENARIOS[id], ...(candidate.scenarioOverrides?.[id] ?? {}) }]));
      validateCandidate(candidate.config, nextOverrides, candidate.recordings ?? {}, candidate.source, candidate.settings);
      if (!setAcousticState) throw new Error('창·문 조건을 함께 복원하는 연결이 준비되지 않았습니다.');
      if (setAcousticState({ source: candidate.source, settings: candidate.settings }) === false) throw new Error('프로젝트의 공유 소음원 조건을 적용하지 못했습니다.');
      cancelAudio('');
      for (const id of IDS) { delete audioClips[id]; delete audioOptions[id]; delete audioMessages[id]; }
      $('bbAudioFile').value = '';
      config = { ...structuredClone(BROADBAND_DEFAULTS), ...candidate.config }; scenarioOverrides = nextOverrides; recordings = candidate.recordings ?? {}; measurementNotes = candidate.measurementNotes ?? {};
      selectedScenario = IDS.includes(candidate.selectedScenario) ? candidate.selectedScenario : 'conversation'; selectedCondition = 'central'; selectedMetric = 'session';
      transferSpectra.apparent = transferSpectra.dnt = null;
      if (config.transferMode !== 'element') transferSpectra[config.transferMode] = config.measuredTransferBandsDb;
      editorTarget = config.transferMode === 'apparent' ? 'Rprime' : config.transferMode === 'dnt' ? 'DnT' : 'R';
      sharedFingerprint = fingerprint(); syncShared(); syncConfig(); syncScenario(); syncEditor(); schedule(); announce(`${file.name}의 조건을 가져왔습니다.`);
    } catch (error) { announce(`가져오지 않았습니다. ${error.message}`); }
    $('bbImportProject').value = '';
  });

  const observer = new ResizeObserver(() => drawChart()); observer.observe(canvas);
  sharedFingerprint = fingerprint(); syncShared(); syncConfig(); syncScenario(); syncEditor(); renderCards();
  return {
    activate() { active = true; syncShared(); if (dirty || !result) schedule(); else drawChart(); },
    deactivate() { active = false; clearTimeout(timer); timer = 0; },
    refresh() { const next = fingerprint(); if (next !== sharedFingerprint) { sharedFingerprint = next; syncShared(); schedule(); } },
  };
}
