import { createAcousticModel, BANDS } from './acoustics.mjs';

const COLOR_STOPS = [[220,233,237],[127,184,179],[164,196,124],[225,197,117],[216,140,83],[189,76,60]];
function heatColor(db, alpha=1) {
  const t=Math.max(0,Math.min(1,(db-20)/75))*(COLOR_STOPS.length-1), i=Math.min(COLOR_STOPS.length-2,Math.floor(t)), f=t-i;
  const c=COLOR_STOPS[i].map((v,k)=>Math.round(v+(COLOR_STOPS[i+1][k]-v)*f));
  return `rgba(${c.join(',')},${alpha})`;
}
const $ = id => document.getElementById(id);
const rounded = value => Number.isFinite(value) ? String(Math.round(value)) : '—';
const coord = value => Number(value).toFixed(2);
const roomOptions = rooms => rooms.map(r=>`<option value="${r.id}">${r.name}</option>`).join('');

export function initNoiseUI(data, { onStateChange } = {}) {
  const model = createAcousticModel(data);
  const source={x:8.9,z:1.2,y:1.5,level:60,pitch:160,type:'voice',frequency:500};
  const receiver={x:2.9,z:3.2,y:1.2};
  const settings={wallProfile:'masonry',doorStates:{},furnished:true,background:30};
  let placement='source', results=null, grid=null, roomResults=[], active=false, pending=false, sequence=0, timer=0, inFlight=false, queued=false, pointer=null, dragStart=null, mapGeometry=null, resizeObserver;
  let worker=null, audioContext=null, audioNodes=[], audioTimer=0, errorTimer=0;
  const options=roomOptions(data.rooms);
  $('noiseSidebar').innerHTML=`
    <section class="receiver-card" aria-label="청취점 계산 결과">
      <p class="result-title">청취점 예상 소음 <span>모델 추정</span></p>
      <div class="receiver-value"><output id="receiverLevel" aria-live="polite">—</output><small>dBA</small></div>
      <p class="receiver-place" id="receiverPlace">큰 방 · 높이 1.2m</p>
      <dl class="result-breakdown"><div><dt>지정 소음원 기여</dt><dd id="sourceContribution">— dBA</dd></div><div><dt>배경 소음</dt><dd id="backgroundContribution">30 dBA</dd></div></dl>
      <p class="small-metric" id="distanceMetric">소음원과의 거리 — m</p>
    </section>
    <section class="noise-section"><h3 class="noise-heading"><span>01</span> 소음원 설정</h3>
      <div class="noise-field"><label for="sourceRoom">소음원 공간</label><select id="sourceRoom">${options}</select></div>
      <div class="noise-field"><label for="noiseType">소음 종류</label><select id="noiseType"><option value="voice">사람 음성</option><option value="pink">핑크 노이즈 · 옥타브별 균일</option><option value="white">화이트 노이즈 · 광대역</option><option value="tone">순음 · 단일 주파수</option></select></div>
      <div class="noise-field" id="voicePresetField"><label for="voicePreset">목소리 크기 프리셋</label><select id="voicePreset"><option value="54">작은 목소리 · 54 dBA</option><option value="60" selected>보통 대화 · 60 dBA</option><option value="66">힘주어 말하기 · 66 dBA</option><option value="72">큰 목소리 · 72 dBA</option><option value="78">매우 큰 목소리 · 78 dBA</option><option value="custom">직접 지정</option></select></div>
      <div class="noise-field"><label for="sourceLevel">1m 기준 소음 크기</label><div class="range-row"><input id="sourceLevel" type="range" min="30" max="100" step="1" value="60"><div class="range-number"><input id="sourceLevelNumber" type="number" aria-label="1m 기준 소음 크기 수치" min="30" max="100" step="1" value="60"><span>dBA</span></div></div><p class="field-note">자유음장 1m 기준입니다. 실내 반사음은 별도로 더해집니다.</p></div>
      <div class="noise-field" id="pitchField"><label for="voicePitch">목소리 높낮이 · 기본주파수 F0</label><div class="range-row"><input id="voicePitch" type="range" min="80" max="350" step="1" value="160"><div class="range-number"><input id="voicePitchNumber" type="number" aria-label="목소리 기본주파수 수치" min="80" max="350" step="1" value="160"><span>Hz</span></div></div><p class="field-note">배음의 분포가 바뀌며, 지정한 1m 소음 크기는 유지됩니다.</p></div>
      <div class="noise-field" id="toneField" hidden><label for="toneFrequency">순음 주파수</label><div class="range-row"><input id="toneFrequency" type="range" min="125" max="8000" step="25" value="500"><div class="range-number"><input id="toneFrequencyNumber" type="number" aria-label="순음 주파수 수치" min="125" max="8000" step="25" value="500"><span>Hz</span></div></div></div>
      <button type="button" id="previewSound" class="button audio-button">합성 음색 미리듣기 · 3초</button><p class="field-note" id="audioNote">음색 확인용 합성음입니다. 기기의 재생 음량은 계산 dBA와 다릅니다.</p>
    </section>
    <section class="noise-section"><h3 class="noise-heading"><span>02</span> 위치와 청취 높이</h3>
      <div class="noise-field"><label for="receiverRoom">청취 공간</label><select id="receiverRoom">${options}</select></div>
      <div class="fields-two"><div class="noise-field"><label for="sourceHeight">소음원 높이 (m)</label><input id="sourceHeight" type="number" min="0.2" max="2.2" step="0.1" value="1.5"></div><div class="noise-field"><label for="receiverHeight">청취 높이 (m)</label><input id="receiverHeight" type="number" min="0.2" max="2.2" step="0.1" value="1.2"></div></div>
      <details class="noise-details"><summary>정밀 위치 입력</summary><div class="coordinate-fields"><label for="sourceX">소음원 X (m)<input id="sourceX" type="number" min="0" max="11.5" step="0.05" value="6.7"></label><label for="sourceZ">소음원 Z (m)<input id="sourceZ" type="number" min="0" max="8.6" step="0.05" value="3.8"></label><label for="receiverX">청취점 X (m)<input id="receiverX" type="number" min="0" max="11.5" step="0.05" value="2.9"></label><label for="receiverZ">청취점 Z (m)<input id="receiverZ" type="number" min="0" max="8.6" step="0.05" value="3.2"></label></div><p class="field-note">X: 도면 오른쪽 / Z: 도면 아래쪽. 벽 내부에는 배치할 수 없습니다.</p></details>
    </section>
    <section class="noise-section noise-settings"><h3 class="noise-heading"><span>03</span> 벽·문·실내 조건</h3>
      <div class="noise-field"><label for="wallProfile">벽체 차음 가정</label><select id="wallProfile"><option value="masonry">조적·콘크리트 약 200mm</option><option value="lightweight">경량 칸막이 · 비교용 가정</option></select><p class="field-note">실제 벽체 구조는 미확인입니다. 실크벽지와 벽체 차음은 별도 조건입니다.</p></div>
      <p class="model-note"><strong>일반 실크벽지 · PVC 코팅 마감</strong>단단한 바탕 위 저흡음 표면으로 가정합니다. 욕실은 타일 마감이며, 전용 흡음벽지의 성능을 적용하지 않습니다.</p>
      <label class="setting">가구에 의한 추가 흡음<input id="acousticFurnished" class="switch" type="checkbox" checked></label><p class="field-note">일반 가구가 있는 실내의 비교용 흡음 가정입니다.</p>
      <div class="noise-field"><label for="backgroundLevel">배경 소음</label><div class="range-row"><input id="backgroundLevel" type="range" min="0" max="60" step="1" value="30"><div class="range-number"><input id="backgroundLevelNumber" type="number" aria-label="배경 소음 수치" min="0" max="60" step="1" value="30"><span>dBA</span></div></div></div>
      <details class="noise-details" id="doorsDetails"><summary>창·문 열림 설정 <span id="doorCount">0개 열림</span></summary><p class="field-note">체크하면 열림입니다. 소음 계산은 이 설정을 따르며, 3D 뷰어의 문 각도와는 별개입니다.</p><div class="door-actions"><button type="button" id="closeAllDoors">모두 닫기</button><button type="button" id="openAllDoors">모두 열기</button></div><div class="door-list" id="doorList"></div></details>
    </section>
    <section class="noise-section"><h3 class="noise-heading"><span>04</span> 공간별 예상 소음</h3><table class="room-results"><thead><tr><th>공간 중앙 · 같은 청취 높이</th><th>dBA</th></tr></thead><tbody id="roomResults"></tbody></table><p class="field-note">배경 소음 포함. 방 전체의 평균값이 아닙니다.</p>
      <details class="noise-details"><summary>청취점의 주파수별 소음</summary><div class="spectrum" id="noiseSpectrum"></div><p class="field-note">125Hz–8kHz 옥타브 대역 · A보정 전 소음원 기여 (dB SPL)</p><p class="field-note" id="reverbEstimate"></p></details>
    </section>
    <details class="noise-details"><summary>계산 가정과 근거</summary><div class="model-note"><strong>공기전달음의 상대 비교</strong><p>거리 감쇠, 벽·창·문 투과와 방 사이의 확산음 에너지 전달을 계산합니다. 실크벽지 흡음계수는 단단한 표면의 대체값이며 제품 시험값이 아닙니다.</p><p>실제 구조·틈새·천장과 바닥을 통한 우회 전달, 충격음, 저주파 공진 및 음성 명료도는 재현하지 않습니다. 실측 소음도와 동일한 값으로 해석할 수 없습니다.</p><p>소음원 0.25m 이내는 근접장 특이점을 막기 위해 거리를 0.25m로 제한합니다. 표시용 천장 생략과 무관하게 실내 천장을 포함합니다.</p><p><a href="./acoustic-notes.html" target="_blank" rel="noopener">모델·재질 수치와 출처 보기</a></p></div></details>`;

  $('sourceRoom').value='room6'; $('receiverRoom').value='room14';
  for (const [index,o] of data.openings.entries()) {
    const id=`opening-${index}`; settings.doorStates[id]=false;
    const label=document.createElement('label'); label.className='door-row';
    const openingLabel=o.label==='마당 전면 외벽'?(o.sill<.1?'마당 출입 유리문':'마당 쪽 작은 창'):o.label;
    const text=document.createElement('span');text.textContent=openingLabel;
    const box=document.createElement('input');box.type='checkbox';box.id=`door-${index}`;box.setAttribute('aria-label',openingLabel+' 열기');box.dataset.opening=id;
    box.addEventListener('change',()=>{settings.doorStates[id]=box.checked;updateDoorCount();schedule();});label.append(text,box);$('doorList').append(label);
  }
  function updateDoorCount(){ $('doorCount').textContent=Object.values(settings.doorStates).filter(Boolean).length+'개 열림'; }
  for (const [id,value] of [['closeAllDoors',false],['openAllDoors',true]]) $(id).onclick=()=>{for(const input of $('doorList').querySelectorAll('input')) {input.checked=value;settings.doorStates[input.dataset.opening]=value;}updateDoorCount();schedule();};
  function warn(message) { $('mapError').textContent=message; $('mapError').hidden=false; clearTimeout(errorTimer);errorTimer=setTimeout(()=>$('mapError').hidden=true,3200); }
  function numberValue(input, min, max) {const n=input.valueAsNumber;if(!Number.isFinite(n))return null;return Math.max(min,Math.min(max,n));}
  function bindPair(rangeId,numberId,min,max,update){
    const range=$(rangeId), number=$(numberId);
    range.addEventListener('input',()=>{number.value=range.value;update(+range.value);schedule();});
    number.addEventListener('change',()=>{const n=numberValue(number,min,max);if(n===null){number.value=range.value;return;}number.value=range.value=String(n);update(n);schedule();});
  }
  function levelUpdated(n){source.level=n;$('voicePreset').value=['54','60','66','72','78'].includes(String(n))?String(n):'custom';}
  bindPair('sourceLevel','sourceLevelNumber',30,100,levelUpdated);
  bindPair('voicePitch','voicePitchNumber',80,350,n=>{source.pitch=n;stopAudio();});
  bindPair('toneFrequency','toneFrequencyNumber',125,8000,n=>{source.frequency=n;stopAudio();});
  bindPair('backgroundLevel','backgroundLevelNumber',0,60,n=>settings.background=n);
  $('voicePreset').onchange=()=>{const v=$('voicePreset').value;if(v==='custom')return;source.level=+v;$('sourceLevel').value=$('sourceLevelNumber').value=v;schedule();};
  $('noiseType').onchange=()=>{source.type=$('noiseType').value;$('pitchField').hidden=source.type!=='voice';$('voicePresetField').hidden=source.type!=='voice';$('toneField').hidden=source.type!=='tone';stopAudio();schedule();};
  $('wallProfile').onchange=()=>{settings.wallProfile=$('wallProfile').value;schedule();};
  $('acousticFurnished').onchange=()=>{settings.furnished=$('acousticFurnished').checked;schedule();};
  for(const [id,target] of [['sourceRoom',source],['receiverRoom',receiver]]) $(id).onchange=()=>{const room=data.rooms.find(r=>r.id===$(id).value);target.x=room.center[0];target.z=room.center[1];syncPositions();schedule();};
  for(const [prefix,target] of [['source',source],['receiver',receiver]]) {
    $(prefix+'Height').addEventListener('change',()=>{const el=$(prefix+'Height'),n=numberValue(el,.2,+(data.wallHeightM-.1).toFixed(2));if(n!==null)target.y=n;el.value=target.y;syncPositions();schedule();});
    for(const [axis,suffix] of [['x','X'],['z','Z']]) $(prefix+suffix).addEventListener('change',()=>{
      const el=$(prefix+suffix),n=el.valueAsNumber, candidate={...target,[axis]:n};
      if(Number.isFinite(n)&&model.isPositionValid(candidate)){target[axis]=n;syncPositions();schedule();}
      else{el.value=coord(target[axis]);warn('벽이나 평면도 밖에는 배치할 수 없습니다.');}
    });
  }
  function syncPositions(){
    for(const [prefix,target] of [['source',source],['receiver',receiver]]){
      $(prefix+'X').value=coord(target.x);$(prefix+'Z').value=coord(target.z);
      const room=model.roomAt(target.x,target.z);if(room)$(prefix+'Room').value=room.id;
    }
    $('mapSubtitle').textContent=`청취 높이 ${receiver.y.toFixed(1)}m · 배경 소음 포함`;
  }
  function choosePlacement(target){placement=target;$('placeSource').setAttribute('aria-pressed',String(target==='source'));$('placeReceiver').setAttribute('aria-pressed',String(target==='receiver'));$('mapHelp').textContent=`평면도를 눌러 ${target==='source'?'소음원을':'청취점을'} 옮기세요. 점을 드래그해서도 이동할 수 있습니다.`;drawMap();}
  $('placeSource').onclick=()=>choosePlacement('source');$('placeReceiver').onclick=()=>choosePlacement('receiver');
  function requestCalculation(){
    timer=0;if(inFlight){queued=true;return;}inFlight=true;pending=true;const id=++sequence;
    $('computeStatus').textContent='계산 중';
    const message={type:'compute',id,source:{...source},receiver:{...receiver},settings:structuredClone(settings)};
    if(worker){worker.postMessage(message);return;}
    try{
      const started=performance.now();receive({id,result:model.evaluate(message.source,message.receiver,message.settings),grid:model.sampleGrid(message.source,message.settings,{step:.16,height:message.receiver.y}),rooms:model.rooms.map(room=>({id:room.id,name:room.name,...model.evaluate(message.source,{x:room.center[0],z:room.center[1],y:message.receiver.y},message.settings)})),elapsed:Math.round(performance.now()-started)});
    }catch(error){receive({id,error:error.message});}
  }
  function schedule(){pending=true;clearTimeout(timer);timer=setTimeout(requestCalculation,110);drawMap();onStateChange?.();}
  function receive(message){
    if(message.id!==sequence)return;inFlight=false;
    if(queued||timer){queued=false;clearTimeout(timer);timer=0;requestCalculation();return;}
    pending=false;
    if(message.error){$('computeStatus').textContent='계산 오류';warn(message.error);console.error(message.error);return;}
    results=message.result;grid=message.grid;roomResults=message.rooms;
    $('computeStatus').textContent='계산 완료';updateResults();drawMap();
  }
  try{
    worker=new Worker(new URL('./acoustics-worker.js',import.meta.url),{type:'module'});
    worker.onmessage=event=>receive(event.data);
    worker.onerror=()=>{worker.terminate();worker=null;inFlight=false;queued=false;requestCalculation();};
    worker.postMessage({type:'init',data});
  }catch{worker=null;}
  function updateResults(){
    $('receiverLevel').textContent=rounded(results.levelDbA);
    $('receiverLevel').setAttribute('aria-label',`${rounded(results.levelDbA)} 데시벨 에이`);
    $('sourceContribution').textContent=rounded(results.sourceOnlyDbA)+' dBA';
    $('backgroundContribution').textContent=settings.background+' dBA';
    $('receiverPlace').textContent=`${model.roomAt(receiver.x,receiver.z)?.name||'실외'} · 높이 ${receiver.y.toFixed(1)}m`;
    $('distanceMetric').textContent=`소음원과의 거리 ${results.distance.toFixed(2)}m`;
    $('roomResults').replaceChildren();
    for(const room of roomResults){const row=document.createElement('tr'),name=document.createElement('td'),value=document.createElement('td'),sw=document.createElement('span');sw.className='room-color';sw.style.background=heatColor(room.levelDbA);name.append(sw,document.createTextNode(room.name));value.textContent=rounded(room.levelDbA);row.append(name,value);$('roomResults').append(row);}
    $('noiseSpectrum').replaceChildren();
    for(const [i,frequency] of BANDS.entries()){
      const column=document.createElement('div');column.className='spectrum-column';
      const band=(results.sourceOnlyBandsDb||results.bandsDb)[i],hasEnergy=Number.isFinite(band)&&band>-299;
      const val=document.createElement('span');val.textContent=hasEnergy?rounded(band):'—';if(!hasEnergy)val.title='해당 대역에 소음원 에너지 없음';
      const bar=document.createElement('div');bar.className='spectrum-bar';bar.style.height=(hasEnergy?Math.max(2,Math.min(65,band/100*65)):0)+'px';
      const label=document.createElement('small');label.textContent=frequency>=1000?frequency/1000+'k':frequency;column.append(val,bar,label);$('noiseSpectrum').append(column);
    }
    const rt=results.rt60?.[3];$('reverbEstimate').textContent=Number.isFinite(rt)&&rt>0?`청취 공간 1kHz 잔향 감쇠시간 추정: ${rt.toFixed(1)}초. 확산음 가정에 따른 값입니다.`:'실외는 실내 잔향시간을 표시하지 않습니다.';
  }
  const canvas=$('noiseMap'),ctx=canvas.getContext('2d');
  function drawMap(){
    if(!active||!canvas.clientWidth||!canvas.clientHeight)return;
    const w=canvas.clientWidth,h=canvas.clientHeight,dpr=Math.min(2,devicePixelRatio||1);
    if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
    const b=model.bounds,pad=w<500?15:30;
    const scale=Math.min((w-2*pad)/(b.maxX-b.minX),(h-2*pad)/(b.maxZ-b.minZ));
    const ox=(w-(b.maxX-b.minX)*scale)/2-b.minX*scale,oz=(h-(b.maxZ-b.minZ)*scale)/2-b.minZ*scale;
    mapGeometry={scale,ox,oz,w,h};
    const point=(x,z)=>[ox+x*scale,oz+z*scale];
    function roomPath(room){ctx.beginPath();room.poly.forEach((p,i)=>{const q=point(...p);if(i)ctx.lineTo(...q);else ctx.moveTo(...q);});ctx.closePath();}
    for(const room of data.rooms){roomPath(room);ctx.fillStyle=room.kind==='exterior'?'#e7ecdd':'#e5e8e1';ctx.fill();}
    if(grid){
      for(const room of data.rooms){
        ctx.save();roomPath(room);ctx.clip();
        for(const cell of grid.cells){if(cell.roomId!==room.id)continue;const p=point(cell.x-grid.step/2,cell.z-grid.step/2);ctx.fillStyle=heatColor(cell.levelDbA,.88);ctx.fillRect(p[0],p[1],grid.step*scale+.6,grid.step*scale+.6);}
        ctx.restore();
      }
    }
    for(const room of data.rooms){roomPath(room);ctx.strokeStyle='#b2bdb0';ctx.lineWidth=.7;ctx.stroke();}
    for(const object of data.objects){
      if(!(object.wall||object.group==='garden'&&object.mat==='wall')||object.shape!=='box')continue;
      const lo=object.p[1]-object.s[1]/2,hi=object.p[1]+object.s[1]/2;
      if(object.wall&&(lo>receiver.y||hi<receiver.y))continue;
      const p=point(object.p[0],object.p[2]);ctx.save();ctx.translate(...p);ctx.rotate(-(object.ry||0));ctx.fillStyle=object.group==='garden'?'#a6b29c':'#65766b';ctx.fillRect(-object.s[0]*scale/2,-object.s[2]*scale/2,object.s[0]*scale,object.s[2]*scale);ctx.restore();
    }
    for(const [i,o] of data.openings.entries()){
      if(receiver.y<o.sill||receiver.y>o.head)continue;
      const a=o.axis==='x'?point(o.k,o.lo):point(o.lo,o.k),b=o.axis==='x'?point(o.k,o.hi):point(o.hi,o.k);
      const open=settings.doorStates[`opening-${i}`];ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.lineWidth=open?1.4:Math.max(2,.065*scale);ctx.strokeStyle=open?'#568568':'#718f98';ctx.setLineDash(open?[4,4]:[]);ctx.stroke();ctx.setLineDash([]);
    }
    for(const room of data.rooms){
      const p=point(...room.center),value=roomResults.find(r=>r.id===room.id)?.levelDbA;
      const closeToMarker=[source,receiver].some(s=>Math.hypot((s.x-room.center[0])*scale,(s.z-room.center[1])*scale)<36);
      const offset=closeToMarker?(room.id==='garden'?32:-31):0;
      const label=room.name,small=w<500,font=small?10:12;
      ctx.font=`500 ${font}px Arial, "Apple SD Gothic Neo", sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';
      const bw=ctx.measureText(label).width+14,bh=small?29:33;
      ctx.fillStyle='#ffffffdf';ctx.beginPath();ctx.roundRect(p[0]-bw/2,p[1]-bh/2+offset,bw,bh,4);ctx.fill();ctx.fillStyle='#3a5144';ctx.fillText(label,p[0],p[1]-5+offset);
      ctx.font=`${small?9:10}px Arial,sans-serif`;ctx.fillStyle='#687b65';ctx.fillText(Number.isFinite(value)?rounded(value)+' dBA':'—',p[0],p[1]+8+offset);
    }
    const sp=point(source.x,source.z),rp=point(receiver.x,receiver.z);
    ctx.beginPath();ctx.moveTo(...sp);ctx.lineTo(...rp);ctx.strokeStyle='#49645775';ctx.lineWidth=1.2;ctx.setLineDash([3,4]);ctx.stroke();ctx.setLineDash([]);
    for(const [key,p,color,label] of [['source',sp,'#c75b32','S'],['receiver',rp,'#355f70','R']]){
      if(placement===key){ctx.beginPath();ctx.arc(...p,18,0,Math.PI*2);ctx.fillStyle=color+'22';ctx.fill();ctx.strokeStyle=color+'55';ctx.lineWidth=1;ctx.stroke();}
      ctx.beginPath();ctx.arc(...p,11,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();ctx.strokeStyle='white';ctx.lineWidth=2;ctx.stroke();ctx.fillStyle='white';ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='bold 11px Arial';ctx.fillText(label,p[0],p[1]+.5);
    }
    const barLength=scale,x=Math.max(4,ox+b.minX*scale),y=Math.min(h-7,oz+b.maxZ*scale+16);
    ctx.beginPath();ctx.moveTo(x,y-3);ctx.lineTo(x,y);ctx.lineTo(x+barLength,y);ctx.lineTo(x+barLength,y-3);ctx.strokeStyle='#91a088';ctx.lineWidth=1;ctx.stroke();ctx.font='9px Arial';ctx.fillStyle='#7f8e74';ctx.textAlign='left';ctx.fillText('1m',x+barLength+5,y-1);
    if(pending){ctx.fillStyle='#f5f6f224';ctx.fillRect(0,0,w,h);}
  }
  function pointerPosition(event){const r=canvas.getBoundingClientRect();return{x:event.clientX-r.left,y:event.clientY-r.top};}
  function movePoint(point,quiet=false){if(!mapGeometry)return;const {ox,oz,scale}=mapGeometry;const target=placement==='source'?source:receiver,candidate={...target,x:Math.round((point.x-ox)/scale*100)/100,z:Math.round((point.y-oz)/scale*100)/100};if(!model.isPositionValid(candidate)){if(!quiet)warn('벽이나 평면도 밖에는 배치할 수 없습니다.');return;}target.x=candidate.x;target.z=candidate.z;syncPositions();schedule();}
  canvas.addEventListener('pointerdown',event=>{if(event.button!==0)return;const p=pointerPosition(event);if(mapGeometry){const {ox,oz,scale}=mapGeometry;const near=[['source',source],['receiver',receiver]].map(([key,s])=>({key,d:Math.hypot(p.x-ox-s.x*scale,p.y-oz-s.z*scale)})).sort((a,b)=>a.d-b.d)[0];if(near.d<24)choosePlacement(near.key);}pointer=event.pointerId;dragStart=p;canvas.setPointerCapture(event.pointerId);movePoint(p);});
  canvas.addEventListener('pointermove',event=>{if(event.pointerId!==pointer)return;const p=pointerPosition(event);if(dragStart&&Math.hypot(p.x-dragStart.x,p.y-dragStart.y)<3)return;movePoint(p,true);});
  const release=()=>{pointer=null;dragStart=null;};canvas.addEventListener('pointerup',release);canvas.addEventListener('pointercancel',release);
  canvas.addEventListener('keydown',event=>{const deltas={ArrowLeft:[-.1,0],ArrowRight:[.1,0],ArrowUp:[0,-.1],ArrowDown:[0,.1]};const d=deltas[event.key];if(!d)return;event.preventDefault();const target=placement==='source'?source:receiver,candidate={...target,x:target.x+d[0],z:target.z+d[1]};if(model.isPositionValid(candidate)){target.x=+candidate.x.toFixed(2);target.z=+candidate.z.toFixed(2);syncPositions();schedule();}else warn('벽이나 평면도 밖에는 배치할 수 없습니다.');});
  function stopAudio(){clearTimeout(audioTimer);for(const n of audioNodes){try{n.stop?.();n.disconnect();}catch{}}audioNodes=[];$('previewSound').textContent='합성 음색 미리듣기 · 3초';}
  async function previewSound(){
    if(audioNodes.length){stopAudio();return;}
    try{
      const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)throw new Error('이 브라우저에서 오디오 미리듣기를 지원하지 않습니다.');
      audioContext??=new Audio();await audioContext.resume();const start=audioContext.currentTime;
      const gain=audioContext.createGain();gain.gain.setValueAtTime(0,start);gain.gain.linearRampToValueAtTime(.035,start+.08);gain.gain.setValueAtTime(.035,start+2.8);gain.gain.linearRampToValueAtTime(0,start+3);gain.connect(audioContext.destination);audioNodes.push(gain);
      if(source.type==='voice'){
        // A voiced vowel-like sound, deliberately not a natural recording or calibrated SPL.
        const oscillator=audioContext.createOscillator(),N=96,real=new Float32Array(N),imag=new Float32Array(N);
        for(let n=1;n<N;n++){const f=n*source.pitch;if(f>8000)break;const envelope=.12+2.2*Math.exp(-Math.pow((f-650)/230,2))+1.1*Math.exp(-Math.pow((f-1250)/300,2))+.7*Math.exp(-Math.pow((f-2500)/550,2));imag[n]=envelope/n;}
        oscillator.setPeriodicWave(audioContext.createPeriodicWave(real,imag));oscillator.frequency.value=source.pitch;
        const envelope=audioContext.createGain();for(let i=0;i<12;i++){const t=start+i*.25;envelope.gain.setValueAtTime(.2,t);envelope.gain.linearRampToValueAtTime(.9,t+.07);envelope.gain.linearRampToValueAtTime(.25,t+.22);}oscillator.connect(envelope);envelope.connect(gain);oscillator.start();oscillator.stop(start+3);audioNodes.push(oscillator,envelope);
      }else if(source.type==='tone'){
        const oscillator=audioContext.createOscillator();oscillator.type='sine';oscillator.frequency.value=source.frequency;oscillator.connect(gain);oscillator.start();oscillator.stop(start+3);audioNodes.push(oscillator);
      }else{
        const buffer=audioContext.createBuffer(1,audioContext.sampleRate*3,audioContext.sampleRate),channel=buffer.getChannelData(0);let b0=0,b1=0,b2=0;
        for(let i=0;i<channel.length;i++){const white=Math.random()*2-1;if(source.type==='pink'){b0=.99765*b0+white*.099046;b1=.963*b1+white*.2965164;b2=.57*b2+white*1.0526913;channel[i]=(b0+b1+b2+white*.1848)*.2;}else channel[i]=white;}
        const sound=audioContext.createBufferSource();sound.buffer=buffer;sound.connect(gain);sound.start();audioNodes.push(sound);
      }
      $('previewSound').textContent='미리듣기 중지';audioTimer=setTimeout(stopAudio,3100);
    }catch(error){$('audioNote').textContent=error.message;stopAudio();}
  }
  $('previewSound').onclick=previewSound;
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopAudio();});
  resizeObserver=new ResizeObserver(()=>drawMap());resizeObserver.observe(canvas);
  syncPositions();
  function setSource(patch) {
    const next={...source};
    for(const key of ['x','y','z','level','pitch','frequency'])if(Number.isFinite(patch[key]))next[key]=patch[key];
    if(['voice','pink','white','tone'].includes(patch.type))next.type=patch.type;
    next.y=Math.max(.2,Math.min(+(data.wallHeightM-.1).toFixed(2),next.y));
    next.level=Math.max(30,Math.min(100,next.level));next.pitch=Math.max(80,Math.min(350,next.pitch));next.frequency=Math.max(125,Math.min(8000,next.frequency));
    if(!model.isPositionValid(next))return false;
    Object.assign(source,next);$('sourceHeight').value=source.y;
    $('sourceLevel').value=$('sourceLevelNumber').value=source.level;levelUpdated(source.level);
    $('voicePitch').value=$('voicePitchNumber').value=source.pitch;
    $('toneFrequency').value=$('toneFrequencyNumber').value=source.frequency;
    $('noiseType').value=source.type;$('pitchField').hidden=source.type!=='voice';$('voicePresetField').hidden=source.type!=='voice';$('toneField').hidden=source.type!=='tone';
    stopAudio();syncPositions();schedule();return true;
  }
  function setAcousticState(input) {
    // Validate every field before changing the shared source or opening state.
    const nextSource={...source,...input?.source}, incoming=input?.settings??{};
    const ranges={x:[0,11.5],z:[0,8.6],y:[.2,2.2],level:[30,100],pitch:[80,350],frequency:[125,8000]};
    for(const [key,[min,max]] of Object.entries(ranges))if(!Number.isFinite(nextSource[key])||nextSource[key]<min||nextSource[key]>max)return false;
    if(!['voice','pink','white','tone'].includes(nextSource.type)||!model.isPositionValid(nextSource))return false;
    const nextSettings={...settings,doorStates:{...settings.doorStates}};
    if(incoming.wallProfile!==undefined){if(!['masonry','lightweight'].includes(incoming.wallProfile))return false;nextSettings.wallProfile=incoming.wallProfile;}
    for(const key of ['furnished','reverberation'])if(incoming[key]!==undefined){if(typeof incoming[key]!=='boolean')return false;nextSettings[key]=incoming[key];}
    if(incoming.background!==undefined){if(!Number.isFinite(incoming.background)||incoming.background<0||incoming.background>60)return false;nextSettings.background=incoming.background;}
    for(const [key,value] of Object.entries(incoming.doorStates??{})){
      if(!(key in nextSettings.doorStates)||![true,false,0,1].includes(value))return false;
      nextSettings.doorStates[key]=Boolean(value);
    }
    Object.assign(settings,nextSettings);
    $('wallProfile').value=settings.wallProfile;$('acousticFurnished').checked=settings.furnished;
    $('backgroundLevel').value=$('backgroundLevelNumber').value=settings.background;
    for(const input of $('doorList').querySelectorAll('input'))input.checked=settings.doorStates[input.dataset.opening];
    updateDoorCount();return setSource(nextSource);
  }
  return {activate(){active=true;drawMap();if(!results&&!inFlight)requestCalculation();},deactivate(){active=false;stopAudio();},getState(){return{source:{...source},sourceRoomId:model.roomAt(source.x,source.z)?.id,settings:structuredClone(settings)};},setSource,setAcousticState,beginSourcePlacement(){choosePlacement("source");canvas.focus({preventScroll:true});},openDoorSettings(){$("doorsDetails").open=true;$("doorsDetails").scrollIntoView({block:"center"});$("doorsDetails").querySelector("summary").focus({preventScroll:true});},drawMap};
}
