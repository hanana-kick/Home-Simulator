import { createNeighborModel, NEIGHBOR_DEFAULTS, NEIGHBOR_SCENARIOS } from './neighbors.mjs';

const ROUTES = {
  'shared-wall': { label: '옆집 · 벽으로 연결', short: '공유 벽', receiver: '옆집의 가정한 방' },
  'floor-above': { label: '윗집 · 천장으로 연결', short: '천장 · 슬래브', receiver: '윗집의 가정한 방' },
  'floor-below': { label: '아랫집 · 바닥으로 연결', short: '바닥 · 슬래브', receiver: '아랫집의 가정한 방' },
  detached: { label: '떨어진 이웃집 · 실외 경로', short: '실외 공간', receiver: '맞은편 이웃집의 방' },
};
const SIDES = { west: '도면 왼쪽', east: '도면 오른쪽', north: '도면 위쪽', south: '도면 아래쪽' };
const SCENARIO_COPY = {
  conversation: '한 사람의 대화 음성',
  livestream: '진행자의 말소리와 가끔 높아지는 목소리',
  singing: '한 사람의 노래 · 반주 스피커는 별도 설정',
};
const $ = id => document.getElementById(id);
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const db = value => Number.isFinite(value) ? value.toFixed(1) : '—';
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const isFloor = route => route === 'floor-above' || route === 'floor-below';
const option = (value, label) => `<option value="${escape(value)}">${escape(label)}</option>`;

function insideRoom(room, x, z) {
  let inside = false;
  for (let i = 0, j = room.poly.length - 1; i < room.poly.length; j = i++) {
    const a = room.poly[i], b = room.poly[j];
    if (((a[1] > z) !== (b[1] > z)) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function scenarioNumber(id, key, label, value, min, max, step = 1, unit = '') {
  const fieldId = `neighbor-${id}-${key}`;
  return `<div class="neighbor-field"><label for="${fieldId}">${label}</label><div class="neighbor-input-unit"><input id="${fieldId}" data-scenario="${id}" data-scenario-key="${key}" type="number" min="${min}" max="${max}" step="${step}" value="${value}">${unit ? `<span>${unit}</span>` : ''}</div></div>`;
}

function scenarioCard(id, scenario, index) {
  return `<article class="neighbor-scenario" aria-labelledby="neighbor-${id}-title">
    <div class="neighbor-card-heading"><span class="neighbor-scenario-number">0${index + 1}</span><h3 id="neighbor-${id}-title">${escape(scenario.label)}</h3><span class="neighbor-assumption-tag">가정</span></div>
    <p class="neighbor-scenario-description" id="neighbor-${id}-description">${SCENARIO_COPY[id]}</p>
    <p class="neighbor-metric-label">활동 중 · 이 소음원만의 기여</p>
    <div class="neighbor-main-value"><output id="neighbor-${id}-active">—</output><span>dBA</span></div>
    <p class="neighbor-source-summary" id="neighbor-${id}-source-summary"></p>
    <div class="neighbor-comparison"><p><span>이웃 배경소음 대비 소음원</span><strong id="neighbor-${id}-difference">계산 대기</strong></p><div class="neighbor-comparison-track" id="neighbor-${id}-track" role="img" aria-label="배경소음과 비교 계산 대기"><span class="neighbor-background-mark"></span><span class="neighbor-source-mark" id="neighbor-${id}-mark" hidden></span></div><div class="neighbor-comparison-axis"><span>−40 dB</span><span>배경과 같음</span><span>+40 dB</span></div></div>
    <dl class="neighbor-metrics"><div><dt>큰 소리 구간 · 소음원만</dt><dd><span id="neighbor-${id}-loud">—</span> dBA</dd></div><div><dt>전체 시간 평균 · 소음원만</dt><dd><span id="neighbor-${id}-session">—</span> dBA</dd></div><div><dt>활동 중 + 이웃 배경소음</dt><dd><span id="neighbor-${id}-total">—</span> dBA</dd></div></dl>
    <p class="neighbor-session-note" id="neighbor-${id}-session-note"></p>
    <div class="neighbor-sensitivity"><p>이웃 경계 차음을 바꾼 활동 중 기여</p><div class="neighbor-sensitivity-values" id="neighbor-${id}-sensitivity"><span>차음 −10 dB<b>—</b></span><span>기준 가정<b>—</b></span><span>차음 +10 dB<b>—</b></span></div></div>
    <details class="neighbor-details neighbor-scenario-editor"><summary>이 시나리오의 소리 조정</summary><div class="neighbor-editor-body">
      ${id === 'livestream' ? `<div class="neighbor-field"><label for="neighbor-stream-mode">유튜브 사용 방식</label><select id="neighbor-stream-mode"><option value="hosting">라이브 방송 진행 · 사람 음성</option><option value="watching">영상 시청 · 스피커 소리</option></select></div>` : ''}
      <p class="neighbor-field-note">아래 크기는 자유음장 1 m 기준의 입력 가정입니다. 활동의 공식 표준값이 아닙니다.</p>
      <label class="neighbor-check"><input type="checkbox" data-scenario="${id}" data-scenario-key="voiceEnabled" ${scenario.voiceEnabled ? 'checked' : ''}> 사람 음성 포함</label>
      <fieldset class="neighbor-component-fields" id="neighbor-${id}-voice-fields"><legend class="neighbor-sr-only">${escape(scenario.label)} 음성 설정</legend><div class="neighbor-fields-two">
        ${scenarioNumber(id, 'typicalLevel', '평소 구간 크기', scenario.typicalLevel, 30, 100, 1, 'dBA')}
        ${scenarioNumber(id, 'loudLevel', '큰 소리 구간 크기', scenario.loudLevel, 30, 110, 1, 'dBA')}
        ${scenarioNumber(id, 'pitch', '목소리 높낮이 · F0', scenario.pitch, 80, 350, 1, 'Hz')}
        ${scenarioNumber(id, 'duty', '전체 시간 중 발성 비율', Math.round(scenario.duty * 100), 0, 100, 1, '%')}
      </div>${scenarioNumber(id, 'loudFraction', '발성 중 큰 소리 비율', Math.round((scenario.loudFraction ?? (id === 'livestream' ? .05 : .1)) * 100), 0, 100, 1, '%')}</fieldset>
      <label class="neighbor-check"><input type="checkbox" data-scenario="${id}" data-scenario-key="speakerEnabled" ${scenario.speakerEnabled ? 'checked' : ''}> 스피커 소리 포함</label>
      <fieldset class="neighbor-component-fields" id="neighbor-${id}-speaker-fields" ${scenario.speakerEnabled ? '' : 'disabled'}><legend class="neighbor-sr-only">${escape(scenario.label)} 스피커 설정</legend><div class="neighbor-fields-two">${scenarioNumber(id, 'speakerLevel', '스피커 크기 · 1 m', scenario.speakerLevel, 30, 100, 1, 'dBA')}${scenarioNumber(id, 'speakerDuty', '전체 시간 중 재생 비율', Math.round(scenario.speakerDuty * 100), 0, 100, 1, '%')}</div></fieldset>
      <p class="neighbor-field-note">스피커는 음성과 같은 위치의 광대역 대체 소리로 계산합니다. 큰 소리 구간은 LAFmax 측정값이 아닙니다.</p>
      <button type="button" class="neighbor-text-button" data-reset-scenario="${id}">이 시나리오 기본 가정으로</button>
    </div></details>
  </article>`;
}

export function initNeighborUI(data, { getAcousticState, setSource, onChooseSourcePosition }) {
  const stage = $('neighborStage'), sidebar = $('neighborSidebar');
  if (!stage || !sidebar) throw new Error('이웃집 영향 화면의 표시 영역이 없습니다.');
  const model = createNeighborModel(data);
  const config = { ...NEIGHBOR_DEFAULTS };
  const initialState = getAcousticState();
  const initialRoomId = initialState.sourceRoomId ?? data.rooms.find(room => insideRoom(room, initialState.source.x, initialState.source.z))?.id;
  const initialBoundary = model.boundaries.find(face => face.roomId === initialRoomId);
  if (initialBoundary) { config.boundaryRoomId = initialRoomId; config.boundarySide = initialBoundary.side; }
  const scenarioIds = Object.keys(NEIGHBOR_SCENARIOS);
  const overrides = Object.fromEntries(scenarioIds.map(id => [id, { ...NEIGHBOR_SCENARIOS[id] }]));
  const interiorRooms = data.rooms.filter(room => room.kind === 'interior');
  let active = false, worker = null, timer = 0, inFlight = false, queued = false, sequence = 0;
  let lastRows = null, dirty = true, fallbackInProgress = false;

  stage.classList.add('neighbor-stage');
  sidebar.classList.add('neighbor-sidebar');
  stage.innerHTML = `<div class="neighbor-stage-inner">
    <div class="neighbor-title-row"><div><p class="neighbor-eyebrow">NEIGHBOR IMPACT</p><h2>이웃집에 전달되는 소리</h2></div><div class="neighbor-title-actions"><span class="neighbor-compute-status" id="neighborStatus" role="status">계산 대기</span><a class="neighbor-jump-link" href="#neighborSidebar">조건 설정으로 ↓</a></div></div>
    <div class="neighbor-assumption-banner"><strong>이웃집 구조 미입력 · 아래 조건을 가정한 비교</strong><p>수신 위치는 가정한 이웃 방의 공간 평균입니다. 실내 소음 지도의 한 지점 결과와는 기준이 다릅니다.</p></div>
    <section class="neighbor-route-section" aria-label="가정한 소음 전달 경로"><div class="neighbor-section-caption"><h3>가정한 전달 경로</h3><span>실제 배치·축척 아님</span></div><div class="neighbor-route-diagram" id="neighborRouteDiagram">
      <div class="neighbor-home-node"><span class="neighbor-node-eyebrow">우리집</span><strong id="neighborSourcePlace">—</strong><p id="neighborSourcePosition"></p><span class="neighbor-node-room" id="neighborBoundaryRoom">—</span></div>
      <div class="neighbor-route-connector"><span class="neighbor-route-arrow" aria-hidden="true">→</span><strong id="neighborRouteLabel">—</strong><span id="neighborRouteDetail"></span></div>
      <div class="neighbor-home-node neighbor-receiver-node"><span class="neighbor-node-eyebrow" id="neighborReceiverLabel">이웃집</span><strong>가정한 방의 공간 평균</strong><p id="neighborReceiverGeometry"></p><span class="neighbor-node-room" id="neighborReceiverBackground">배경 30 dBA</span></div>
    </div><p class="neighbor-route-summary" id="neighborRouteSummary"></p><p class="neighbor-calculation-notice" id="neighborCalculationNotice" hidden></p></section>
    <div class="neighbor-results-heading"><h3>활동별 비교</h3><p>같은 위치·같은 이웃집 조건으로 계산</p></div>
    <div class="neighbor-error" id="neighborError" role="alert" hidden></div>
    <div class="neighbor-scenario-grid">${scenarioIds.map((id, index) => scenarioCard(id, overrides[id], index)).join('')}</div>
    <section class="neighbor-reading-note"><h3>표시값 읽기</h3><p><strong>활동 중</strong>은 평소 구간의 소리입니다. <strong>전체 시간 평균</strong>은 평소·큰 소리 구간의 에너지를 발성 비율로 가중하고, 스피커 재생 비율을 따로 더합니다. 음성과 스피커가 모두 켜져 있으면 두 소리를 합산합니다.</p><p>차음 ±10 dB는 이웃 경계의 차음 가정만 바꾼 비교이며 신뢰구간이 아닙니다. 열린 창의 투과율은 그대로입니다. 배경소음과의 차이는 들림·수면 방해·민원 여부를 판정하지 않습니다. 구조를 타는 진동, 발걸음·충격음과 우회 전달은 계산하지 않습니다.</p><a href="./acoustic-notes.html" target="_blank" rel="noopener">계산 가정·재질 수치·출처 보기 <span aria-hidden="true">↗</span></a></section>
  </div>`;

  sidebar.innerHTML = `<div class="neighbor-sidebar-heading"><p class="neighbor-eyebrow">COMPARISON SETUP</p><h2>이웃집 가정</h2><a class="neighbor-jump-link neighbor-return-link" href="#neighborStage">비교 결과로 ↑</a></div>
    <section class="neighbor-settings-section"><h3><span>01</span> 연결 경로</h3>
      <div class="neighbor-field"><label for="neighborRoute">우리집과 이웃집의 관계</label><select id="neighborRoute">${Object.entries(ROUTES).map(([key, route]) => option(key, route.label)).join('')}</select></div>
      <div class="neighbor-field"><label for="neighborBoundaryRoomSelect" id="neighborBoundaryRoomLabel">이웃집에 접한 우리집 방</label><select id="neighborBoundaryRoomSelect"></select></div>
      <div class="neighbor-field" id="neighborBoundarySideField"><label for="neighborBoundarySide">이웃집을 가정할 방향</label><select id="neighborBoundarySide"></select><p class="neighbor-field-note">현재 도면에서 실제 외부에 접하는 면만 표시합니다. 방위는 도면 기준입니다.</p></div>
      <div class="neighbor-field" id="neighborGapField" hidden><label for="neighborGap">건물 외벽 사이 거리</label><div class="neighbor-input-unit"><input id="neighborGap" type="number" min="0.5" max="30" step="0.5" value="${config.gapM}"><span>m</span></div></div>
      <p class="neighbor-field-note" id="neighborBoundaryNote"></p>
    </section>
    <section class="neighbor-settings-section"><h3><span>02</span> 우리집 소음원</h3>
      <div class="neighbor-field"><label for="neighborSourceRoom">세 활동을 비교할 위치</label><select id="neighborSourceRoom">${data.rooms.map(room => option(room.id, room.name)).join('')}<option value="custom" disabled>도면에서 지정한 위치</option></select></div>
      <button class="button neighbor-wide-button" type="button" id="neighborChoosePosition">도면에서 위치 지정 <span aria-hidden="true">↗</span></button><p class="neighbor-field-note">실내 소음 지도와 위치·높이, 우리집 창·문 설정을 공유합니다. 음성 크기는 활동별 카드에서 바꿉니다.</p>
      <button class="neighbor-text-button" type="button" id="neighborHouseOpenings">우리집 창·문 설정 <span aria-hidden="true">↗</span></button><p class="neighbor-field-note" id="neighborOpeningsSummary"></p>
    </section>
    <section class="neighbor-settings-section"><h3><span>03</span> 이웃 방·차음</h3>
      <div class="neighbor-field"><label for="neighborPartition">경계 벽체 차음 가정</label><select id="neighborPartition"></select><p class="neighbor-field-note">벽체·슬래브의 실제 구조와 두께는 미확인입니다. 실크벽지 마감과 벽체 차음은 별도 조건입니다.</p></div>
      <div id="neighborWindowSettings" hidden><label class="neighbor-check neighbor-window-check"><input id="neighborWindowOpen" type="checkbox"> 이웃집 창문 열림</label><div class="neighbor-field"><label for="neighborWindowArea">이웃집 창문 면적</label><div class="neighbor-input-unit"><input id="neighborWindowArea" type="number" min="0.1" max="20" step="0.1" value="${config.neighborWindowAreaM2}"><span>m²</span></div></div><p class="neighbor-field-note">서로 마주 보는 외벽·창을 가정합니다. 우리집 창 상태는 실내 지도 설정을 따릅니다.</p></div>
      <div class="neighbor-field"><label for="neighborBackground">이웃 방의 배경소음</label><div class="neighbor-input-unit"><input id="neighborBackground" type="number" min="0" max="70" step="1" value="${config.background}"><span>dBA</span></div><p class="neighbor-field-note">이웃 방의 별도 가정값입니다. 우리집 실내 지도 배경소음과 분리됩니다.</p></div>
      <details class="neighbor-details neighbor-advanced"><summary>이웃 방·차음의 상세 조건</summary><div class="neighbor-editor-body">
        <div class="neighbor-fields-two"><div class="neighbor-field"><label for="neighborFloorArea">이웃 방 바닥 면적</label><div class="neighbor-input-unit"><input id="neighborFloorArea" type="number" min="4" max="100" step="0.5" value="${config.receiverFloorAreaM2}"><span>m²</span></div></div><div class="neighbor-field"><label for="neighborHeight">이웃 방 높이</label><div class="neighbor-input-unit"><input id="neighborHeight" type="number" min="2" max="4" step="0.1" value="${config.receiverHeightM}"><span>m</span></div></div></div>
        <div class="neighbor-field"><label for="neighborRt60">닫힌 방 잔향시간 · 가정</label><div class="neighbor-input-unit"><input id="neighborRt60" type="number" min="0.15" max="2" step="0.05" value="${config.receiverRt60}"><span>초</span></div></div>
        <div class="neighbor-field"><label for="neighborSeparatingArea">전달 경계 면적</label><div class="neighbor-input-unit"><input id="neighborSeparatingArea" type="number" min="0.1" max="100" step="0.1" value="${config.separatingAreaM2}"><span>m²</span></div><p class="neighbor-field-note" id="neighborAreaNote"></p></div>
        <div class="neighbor-field"><label for="neighborTlOffset">차음 성능 보정 · 모든 대역</label><div class="neighbor-input-unit"><input id="neighborTlOffset" type="number" min="-20" max="20" step="1" value="${config.tlOffsetDb}"><span>dB</span></div><p class="neighbor-field-note">양수는 차음 성능이 높은 조건, 음수는 낮은 조건입니다. 시험 성적서가 있으면 해당 대역별 값과 함께 검토해야 합니다.</p></div>
      </div></details>
    </section>
    <p class="neighbor-sidebar-footnote">공기전달음의 조건별 비교입니다. 실제 이웃집 평면·벽체·주변 소음의 실측값을 입력한 예측이 아닙니다.</p>`;

  function currentScenario(id) { return { ...NEIGHBOR_SCENARIOS[id], ...overrides[id] }; }
  function updateScenarioControls(id) {
    const scenario = currentScenario(id);
    stage.querySelectorAll(`[data-scenario="${id}"]`).forEach(input => {
      const key = input.dataset.scenarioKey;
      if (input.type === 'checkbox') input.checked = Boolean(scenario[key]);
      else input.value = String(['duty', 'speakerDuty', 'loudFraction'].includes(key) ? Math.round((scenario[key] ?? 0) * 100) : scenario[key]);
    });
    $(`neighbor-${id}-voice-fields`).disabled = !scenario.voiceEnabled;
    $(`neighbor-${id}-loudLevel`).min = String(scenario.typicalLevel);
    $(`neighbor-${id}-speaker-fields`).disabled = !scenario.speakerEnabled;
    $(`neighbor-${id}-loudLevel`).min = scenario.typicalLevel;
    const watching = id === 'livestream' && !scenario.voiceEnabled && scenario.speakerEnabled;
    if (id === 'livestream') $('neighbor-stream-mode').value = watching ? 'watching' : 'hosting';
    $(`neighbor-${id}-title`).textContent = watching ? '유튜브 영상 시청' : NEIGHBOR_SCENARIOS[id].label;
    $(`neighbor-${id}-description`).textContent = watching ? '영상의 스피커 재생 · 재생 크기는 직접 지정' : SCENARIO_COPY[id];
    updateScenarioSummary(id);
  }

  function updateScenarioSummary(id) {
    const scenario = currentScenario(id), pieces = [];
    if (scenario.voiceEnabled) pieces.push(`음성 ${scenario.typicalLevel} dBA · ${scenario.pitch} Hz`);
    if (scenario.speakerEnabled) pieces.push(`스피커 ${scenario.speakerLevel} dBA`);
    $(`neighbor-${id}-source-summary`).textContent = pieces.length ? `1 m 기준 · ${pieces.join(' / ')}` : '음성·스피커 꺼짐';
    const activity = [];
    if (scenario.voiceEnabled) activity.push(`발성 ${Math.round(scenario.duty * 100)}% · 발성 중 큰 소리 ${Math.round((scenario.loudFraction ?? 0) * 100)}%`);
    if (scenario.speakerEnabled) activity.push(`스피커 재생 ${Math.round(scenario.speakerDuty * 100)}%`);
    $(`neighbor-${id}-session-note`).textContent = activity.length ? activity.join(' / ') : '모든 소음원을 끈 조건';
  }

  function updateBoundaryOptions() {
    const rooms = isFloor(config.route) ? interiorRooms : interiorRooms.filter(room => model.boundaries.some(face => face.roomId === room.id));
    if (!rooms.some(room => room.id === config.boundaryRoomId)) config.boundaryRoomId = rooms[0]?.id ?? interiorRooms[0]?.id;
    $('neighborBoundaryRoomSelect').innerHTML = rooms.map(room => option(room.id, room.name)).join('');
    $('neighborBoundaryRoomSelect').value = config.boundaryRoomId;
    const faces = model.boundaries.filter(face => face.roomId === config.boundaryRoomId);
    if (!faces.some(face => face.side === config.boundarySide)) config.boundarySide = faces[0]?.side ?? 'north';
    $('neighborBoundarySide').innerHTML = faces.map(face => option(face.side, SIDES[face.side] ?? face.label)).join('');
    $('neighborBoundarySide').value = config.boundarySide;
    $('neighborBoundarySideField').hidden = isFloor(config.route);
    $('neighborBoundaryRoomLabel').textContent = isFloor(config.route) ? '슬래브에 접한 우리집 방' : '외벽이 있는 우리집 방';
    $('neighborGapField').hidden = config.route !== 'detached';
    $('neighborWindowSettings').hidden = config.route !== 'detached';
    const face = faces.find(face => face.side === config.boundarySide);
    const room = interiorRooms.find(item => item.id === config.boundaryRoomId);
    const available = isFloor(config.route) ? Math.min(room?.modelAreaM2 ?? room?.area ?? 0, config.receiverFloorAreaM2) : config.route === 'detached' ? face?.facadeAreaM2 * Math.min(data.wallHeightM, config.receiverHeightM) / data.wallHeightM : face?.availableAreaM2;
    $('neighborBoundaryNote').textContent = isFloor(config.route)
      ? '선택한 방의 천장 또는 바닥 건너편에 이웃 방을 가정합니다. 발걸음·의자 끌기 등의 충격음은 포함하지 않습니다.'
      : config.route === 'shared-wall' ? '현재 외벽 위치에 이웃 방을 붙인 가정입니다. 실제 인접 세대의 위치를 의미하지 않습니다.' : '선택한 외벽에서 나온 소리가 실외를 거쳐 이웃 방으로 전달되는 가정입니다.';
    $('neighborAreaNote').textContent = Number.isFinite(available) ? `선택한 면의 최대 ${available.toFixed(2)} m² 이내로 계산합니다. 입력 면적이 더 크면 이 값으로 제한됩니다.` : '선택한 경계의 실제 면적 이내로 계산합니다.';
    $('neighborPartition').innerHTML = isFloor(config.route)
      ? option('floor', '콘크리트 슬래브 약 150 mm · 가정') + option('masonry', '콘크리트 약 200 mm · 비교 가정') + option('lightweight', '경량 구조 · 비교 가정')
      : option('masonry', '조적·콘크리트 약 200 mm · 가정') + option('lightweight', '경량 칸막이 · 비교 가정');
    if (!isFloor(config.route) && config.partitionProfile === 'floor') config.partitionProfile = 'masonry';
    $('neighborPartition').value = config.partitionProfile;
    updateSharedSummary();
  }

  function updateSharedSummary() {
    const { source, settings } = getAcousticState();
    const sourceRoom = data.rooms.find(room => insideRoom(room, source.x, source.z));
    const boundaryRoom = data.rooms.find(room => room.id === config.boundaryRoomId);
    $('neighborSourceRoom').value = sourceRoom?.id ?? 'custom';
    $('neighborSourcePlace').textContent = sourceRoom?.name ?? '도면에서 지정한 위치';
    $('neighborSourcePosition').textContent = `소음원 높이 ${source.y.toFixed(1)} m · 세 활동 공통`;
    $('neighborBoundaryRoom').textContent = `전달 경계: ${boundaryRoom?.name ?? '—'}${isFloor(config.route) ? '' : ` · ${SIDES[config.boundarySide]}`}`;
    $('neighborRouteLabel').textContent = ROUTES[config.route].short;
    $('neighborRouteDetail').textContent = config.route === 'detached' ? `외벽 사이 ${config.gapM} m` : isFloor(config.route) ? '공기전달음' : '벽체를 통한 전달';
    $('neighborReceiverLabel').textContent = ROUTES[config.route].receiver;
    $('neighborReceiverGeometry').textContent = `${config.receiverFloorAreaM2} m² · 높이 ${config.receiverHeightM} m · 닫힌 방 잔향 ${config.receiverRt60}초`;
    $('neighborReceiverBackground').textContent = `이웃 배경소음 ${config.background} dBA${config.route === 'detached' ? ` · 창 ${config.neighborWindowOpen ? '열림' : '닫힘'}` : ''}`;
    $('neighborRouteDiagram').dataset.route = config.route;
    const openCount = Object.values(settings.doorStates ?? {}).filter(Boolean).length;
    $('neighborOpeningsSummary').textContent = `현재 우리집 창·문 ${openCount}개 열림 · 이웃집 계산에 반영`;
    $('neighborRouteSummary').textContent = config.route === 'detached'
      ? '우리집 내부 전달 → 선택 외벽·개구부 → 실외 거리 감쇠 → 이웃 외벽·창 → 이웃 방의 확산음'
      : `우리집 내부 전달 → ${boundaryRoom?.name ?? '선택한 방'}의 ${isFloor(config.route) ? '슬래브' : '공유 벽'} → 이웃 방의 확산음`;
  }

  function showError(message) {
    lastRows = null;
    dirty = true;
    $('neighborStatus').textContent = '계산 오류';
    $('neighborError').textContent = `조건을 계산하지 못했습니다. ${message}`;
    $('neighborError').hidden = false;
    stage.classList.remove('neighbor-pending');
    stage.setAttribute('aria-busy', 'false');
    for (const id of scenarioIds) {
      for (const metric of ['active', 'loud', 'session', 'total']) $(`neighbor-${id}-${metric}`).textContent = '—';
      $(`neighbor-${id}-difference`).textContent = '계산 결과 없음';
      $(`neighbor-${id}-mark`).hidden = true;
      $(`neighbor-${id}-sensitivity`).querySelectorAll('b').forEach(value => { value.textContent = '—'; });
    }
  }

  function renderRows(rows) {
    for (const row of rows) {
      if (!scenarioIds.includes(row.id)) continue;
      const id = row.id;
      $(`neighbor-${id}-active`).textContent = db(row.active.sourceOnlyDbA);
      $(`neighbor-${id}-loud`).textContent = db(row.loud.sourceOnlyDbA);
      $(`neighbor-${id}-session`).textContent = db(row.session.sourceOnlyDbA);
      $(`neighbor-${id}-total`).textContent = db(row.active.totalDbA);
      const difference = row.active.aboveBackgroundDb;
      const description = Number.isFinite(difference) ? Math.abs(difference) < .05 ? '배경소음과 같음' : `배경보다 ${Math.abs(difference).toFixed(1)} dB ${difference > 0 ? '높음' : '낮음'}` : '소음원 꺼짐';
      $(`neighbor-${id}-difference`).textContent = description;
      const mark = $(`neighbor-${id}-mark`);
      mark.hidden = !Number.isFinite(difference);
      if (Number.isFinite(difference)) mark.style.left = `${clamp(50 + difference / 40 * 50, 0, 100)}%`;
      $(`neighbor-${id}-track`).setAttribute('aria-label', `이웃 배경소음 대비 소음원: ${description}. 표시 범위 −40에서 +40 dB.`);
      const sensitivity = row.sensitivity?.active ?? row.active.sensitivity ?? [];
      $(`neighbor-${id}-sensitivity`).innerHTML = [-10, 0, 10].map(offset => {
        const result = sensitivity.find(item => item.offsetDb === offset);
        const value = offset === 0 ? result?.sourceOnlyDbA ?? row.active.sourceOnlyDbA : result?.sourceOnlyDbA;
        return `<span>${offset === 0 ? '기준 가정' : `차음 ${offset > 0 ? '+' : '−'}10 dB`}<b>${db(value)} <small>dBA</small></b></span>`;
      }).join('');
    }
    const details = rows[0]?.active?.details;
    const notices = Array.isArray(details?.notices) ? [...details.notices] : details?.notice ? [details.notice] : [];
    if (details?.actualBoundarySide && details.actualBoundarySide !== config.boundarySide && !isFloor(config.route)) notices.push(`현재 경계는 ${SIDES[details.actualBoundarySide] ?? details.actualBoundarySide} 면을 사용합니다.`);
    $('neighborCalculationNotice').textContent = notices.join(' ');
    $('neighborCalculationNotice').hidden = !notices.length;
    $('neighborStatus').textContent = '계산 완료';
    $('neighborError').hidden = true;
    stage.classList.remove('neighbor-pending');
    stage.setAttribute('aria-busy', 'false');
  }

  function receive(message) {
    if (message.id !== sequence) return;
    inFlight = false;
    if (queued || timer) {
      queued = false;
      clearTimeout(timer); timer = 0;
      if (active) requestCalculation();
      else dirty = true;
      return;
    }
    if (message.error) { showError(message.error); return; }
    lastRows = message.rows;
    dirty = false;
    renderRows(lastRows);
  }

  function runFallback(message) {
    try { receive({ id: message.id, rows: model.compareScenarios(message.source, message.settings, message.config, message.overrides) }); }
    catch (error) { receive({ id: message.id, error: error.message }); }
  }

  function requestCalculation() {
    timer = 0;
    if (!active) { dirty = true; return; }
    if (inFlight) { queued = true; return; }
    inFlight = true;
    $('neighborStatus').textContent = '계산 중';
    stage.classList.add('neighbor-pending');
    stage.setAttribute('aria-busy', 'true');
    const state = getAcousticState();
    const message = { id: ++sequence, source: { ...state.source }, settings: structuredClone(state.settings), config: { ...config }, overrides: structuredClone(overrides) };
    if (worker) { try { worker.postMessage(message); return; } catch { worker.terminate(); worker = null; } }
    runFallback(message);
  }

  function schedule() {
    dirty = true;
    if (inFlight) queued = true;
    updateSharedSummary();
    clearTimeout(timer);
    if (!active) return;
    $('neighborStatus').textContent = '조건 변경 · 계산 대기';
    stage.classList.add('neighbor-pending');
    stage.setAttribute('aria-busy', 'true');
    timer = setTimeout(requestCalculation, 140);
  }

  function bindConfigNumber(id, key, min, max) {
    $(id).addEventListener('change', () => {
      const value = $(id).valueAsNumber;
      if (!Number.isFinite(value)) { $(id).value = config[key]; return; }
      config[key] = clamp(value, min, max);
      $(id).value = config[key];
      if (key === 'receiverHeightM' || key === 'receiverFloorAreaM2') updateBoundaryOptions();
      schedule();
    });
  }

  $('neighborRoute').value = config.route;
  $('neighborRoute').addEventListener('change', () => {
    const previous = config.route;
    config.route = $('neighborRoute').value;
    if (isFloor(config.route) && !isFloor(previous)) config.partitionProfile = 'floor';
    if (!isFloor(config.route) && isFloor(previous)) config.partitionProfile = 'masonry';
    updateBoundaryOptions(); schedule();
  });
  $('neighborBoundaryRoomSelect').addEventListener('change', () => { config.boundaryRoomId = $('neighborBoundaryRoomSelect').value; updateBoundaryOptions(); schedule(); });
  $('neighborBoundarySide').addEventListener('change', () => { config.boundarySide = $('neighborBoundarySide').value; updateBoundaryOptions(); schedule(); });
  $('neighborPartition').addEventListener('change', () => { config.partitionProfile = $('neighborPartition').value; schedule(); });
  $('neighborWindowOpen').addEventListener('change', () => { config.neighborWindowOpen = $('neighborWindowOpen').checked; schedule(); });
  $('neighborSourceRoom').addEventListener('change', () => {
    const room = data.rooms.find(item => item.id === $('neighborSourceRoom').value);
    if (room) { setSource({ x: room.center[0], z: room.center[1] }); schedule(); }
  });
  $('neighborChoosePosition').addEventListener('click', () => onChooseSourcePosition('source'));
  $('neighborHouseOpenings').addEventListener('click', () => onChooseSourcePosition('openings'));
  for (const [id, key, min, max] of [
    ['neighborGap', 'gapM', .5, 30], ['neighborWindowArea', 'neighborWindowAreaM2', .1, 20],
    ['neighborBackground', 'background', 0, 70], ['neighborFloorArea', 'receiverFloorAreaM2', 4, 100],
    ['neighborHeight', 'receiverHeightM', 2, 4], ['neighborRt60', 'receiverRt60', .15, 2],
    ['neighborSeparatingArea', 'separatingAreaM2', .1, 100], ['neighborTlOffset', 'tlOffsetDb', -20, 20],
  ]) bindConfigNumber(id, key, min, max);

  stage.addEventListener('change', event => {
    const input = event.target;
    if (!input.dataset.scenario) return;
    const id = input.dataset.scenario, key = input.dataset.scenarioKey;
    if (input.type === 'checkbox') overrides[id][key] = input.checked;
    else {
      const value = input.valueAsNumber;
      if (!Number.isFinite(value)) { updateScenarioControls(id); return; }
      const bounded = clamp(value, +input.min, +input.max);
      overrides[id][key] = ['duty', 'speakerDuty', 'loudFraction'].includes(key) ? bounded / 100 : bounded;
      if (key === 'typicalLevel' || key === 'loudLevel') overrides[id].loudLevel = Math.max(overrides[id].typicalLevel, overrides[id].loudLevel);
      if (key === 'typicalLevel' && overrides[id].loudLevel < bounded) overrides[id].loudLevel = bounded;
    }
    updateScenarioControls(id); schedule();
  });
  $('neighbor-stream-mode').addEventListener('change', () => {
    const watching = $('neighbor-stream-mode').value === 'watching';
    overrides.livestream.voiceEnabled = !watching;
    overrides.livestream.speakerEnabled = watching;
    updateScenarioControls('livestream'); schedule();
  });
  stage.addEventListener('click', event => {
    const button = event.target.closest('[data-reset-scenario]');
    if (!button) return;
    const id = button.dataset.resetScenario;
    overrides[id] = { ...NEIGHBOR_SCENARIOS[id] };
    updateScenarioControls(id); schedule();
  });

  try {
    worker = new Worker(new URL('./neighbor-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data: message }) => {
      if (message.error && message.id === undefined) { useFallback(); return; }
      receive(message);
    };
    worker.onerror = event => { event.preventDefault(); useFallback(); };
    worker.onmessageerror = () => useFallback();
    worker.postMessage({ type: 'init', data });
  } catch { worker = null; }

  function useFallback() {
    if (fallbackInProgress) return;
    fallbackInProgress = true;
    worker?.terminate(); worker = null;
    sequence++; inFlight = false; queued = false;
    clearTimeout(timer); timer = 0;
    if (active) requestCalculation();
    else dirty = true;
    fallbackInProgress = false;
  }

  updateBoundaryOptions();
  for (const id of scenarioIds) updateScenarioControls(id);
  return {
    activate() {
      active = true;
      updateSharedSummary();
      if (dirty || !lastRows) schedule();
    },
    deactivate() {
      active = false;
      clearTimeout(timer); timer = 0;
    },
    refresh() { schedule(); },
  };
}
