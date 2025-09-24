/* global mqtt, L, AIRCHASE_CONFIG */
'use strict';

/* ========================= 0) CONFIG ========================= */
const DEFAULTS = { host: 'localhost', wsPort: 8083, vehicle: 'pace_vehicle' };
function buildConfig(){
  const q = new URLSearchParams(location.search);
  const base = Object.assign({}, DEFAULTS, (window.AIRCHASE_CONFIG || {}));
  if (q.has('host'))    base.host    = q.get('host');
  if (q.has('port'))    base.wsPort  = Number(q.get('port'));
  if (q.has('wsport'))  base.wsPort  = Number(q.get('wsport'));
  if (q.has('vehicle')) base.vehicle = q.get('vehicle');
  return base;
}
const CONFIG = buildConfig();

/* ========================= 1) SMALL UTILS ========================= */
const qs  = (id) => document.getElementById(id);
const qsa = (sel) => Array.from(document.querySelectorAll(sel));
const clamp = (x,min,max)=> Math.max(min, Math.min(max,x));

const RATE = { lastMs: 0, emaDt: null, hintedHz: null };
function updateConnInfo(){
  const hz = RATE.hintedHz || (RATE.emaDt ? (1000 / RATE.emaDt) : 0);
  qs('connInfo').textContent =
    `ws://${CONFIG.host}:${CONFIG.wsPort} • vehicle ${CONFIG.vehicle}` + (hz ? ` • ~${hz.toFixed(1)} Hz` : '');
}

/* formatting (no decimals except lat/lon) */
const F = {
  int: (x)=> (Number.isFinite(+x) ? Math.round(+x).toString() : '—'),
  deg: (x)=> (Number.isFinite(+x) ? Math.round(+x) : '—'),
  alt: (x)=> (Number.isFinite(+x) ? Math.round(+x) : '—'),
  lat: (x)=> (Number.isFinite(+x) ? (+x).toFixed(4) : '—'),
  lon: (x)=> (Number.isFinite(+x) ? (+x).toFixed(4) : '—'),
};

/* ========================= 2) UNITS ========================= */
const SpeedUnits = ['kn','m/s','km/h','mph'];
const TempUnits  = ['°C','°F','K'];
const AltUnits   = ['m','ft'];

let speedUnitIdx = 0; // kn
let tempUnitIdx  = 0; // °C
let altUnitIdx   = 0; // m

const MS_TO_KTS = 1.943844;
const MS_TO_KMH = 3.6;
const MS_TO_MPH = 2.23693629;
const M_TO_FT   = 3.280839895;

function speedUnit(){ return SpeedUnits[speedUnitIdx]; }
function tempUnit(){ return TempUnits[tempUnitIdx]; }
function altUnit(){  return AltUnits[altUnitIdx]; }

function toSpeedUnit(mps, unit = speedUnit()){
  if (!Number.isFinite(mps)) return NaN;
  switch(unit){
    case 'kn':   return mps * MS_TO_KTS;
    case 'm/s':  return mps;
    case 'km/h': return mps * MS_TO_KMH;
    case 'mph':  return mps * MS_TO_MPH;
    default:     return mps;
  }
}
function fromKnots(kn, unit = speedUnit()){
  const mps = Number.isFinite(kn) ? kn / MS_TO_KTS : NaN;
  return toSpeedUnit(mps, unit);
}
function tempToUnit(c, unit = tempUnit()){
  if (!Number.isFinite(c)) return NaN;
  switch(unit){
    case '°C': return c;
    case '°F': return c * 9/5 + 32;
    case 'K' : return c + 273.15;
    default:   return c;
  }
}
function altToUnit(m, unit = altUnit()){
  if (!Number.isFinite(m)) return NaN;
  return unit === 'ft' ? (m * M_TO_FT) : m;
}
function altSuffix(){ return altUnit(); }

/* gauge scale in CURRENT speed units */
function gaugeSpeedScale(){
  const unit = speedUnit();
  return {
    max:   fromKnots(140, unit),
    amber: fromKnots(60,  unit),
    red:   fromKnots(100, unit),
  };
}

/* ========================= 3) EASINGS / TWEENS ========================= */
const Easings = {
  off:    (t)=> 1,
  linear: (t)=> t,
  soft:   (t)=> Math.sin((Math.PI/2)*t), // smooth ease-out
  snappy: (t)=> { const s=1.70158; t=t-1; return 1 + t*t*((s+1)*t + s); }, // easeOutBack
};
const ANIM = { mode: 'soft' }; // off | linear | soft | snappy
const activeTweens = new Map();
const nowMs = ()=> performance.now();
const normalizeDeg = (a)=> (a%360 + 360)%360;
function shortestDeltaDeg(from, to){
  let d = normalizeDeg(to) - normalizeDeg(from);
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}
function currentAnimDuration(){
  if (ANIM.mode === 'off') return 0;
  if (RATE.hintedHz && RATE.hintedHz > 0) return clamp(1000 / RATE.hintedHz, 120, 1200);
  if (RATE.emaDt) return clamp(RATE.emaDt, 120, 1200);
  return 400;
}
function startTween(key, from, to, durMs, type, updater){
  if (activeTweens.has(key)) activeTweens.delete(key);
  activeTweens.set(key, {
    from, to, start: nowMs(), dur: Math.max(80, durMs|0),
    ease: Easings[type] || Easings.soft, update: updater
  });
  updater(from);
}
function startAngleTween(key, from, to, durMs, type, updater){
  if (activeTweens.has(key)) activeTweens.delete(key);
  const base = normalizeDeg(from);
  const delta = shortestDeltaDeg(from, to);
  activeTweens.set(key, {
    from: 0, to: delta, start: nowMs(), dur: Math.max(80, durMs|0),
    ease: Easings[type] || Easings.soft,
    update: (v)=> updater(normalizeDeg(base + v))
  });
}
function tickTweens(){
  const t = nowMs();
  for (const [k, tw] of activeTweens) {
    const p = clamp((t - tw.start) / tw.dur, 0, 1);
    const e = (ANIM.mode === 'off') ? 1 : tw.ease(p);
    const v = tw.from + (tw.to - tw.from) * e;
    tw.update(v);
    if (p >= 1) activeTweens.delete(k);
  }
  requestAnimationFrame(tickTweens);
}
requestAnimationFrame(tickTweens);

/* ========================= 4) AGGREGATION (scalar + angle) ========================= */
const AGG = {
  mode: 'normal', // normal | avg | ema
  horizon: 10,    // seconds (time-constant for EMA; window for AVG)
  store: new Map(), // key -> {type:'scalar'|'angle', samples:[{t,v}], ema:number, lastT:number}
  push(key, val, type='scalar'){
    if (!Number.isFinite(val)) return;
    const t = performance.now() / 1000;
    let e = this.store.get(key);
    if (!e) e = { type, samples: [], ema: val, lastT: t };
    e.type = type;
    e.samples.push({ t, v: val });
    const cut = t - this.horizon;
    while (e.samples.length && e.samples[0].t < cut) e.samples.shift();

    const dt = Math.max(0.001, t - e.lastT);
    const alpha = 1 - Math.exp(-dt / this.horizon); // ~10s time-constant

    if (e.type === 'angle') {
      const prev = e.ema;
      const next = normalizeDeg(prev + alpha * shortestDeltaDeg(prev, val));
      e.ema = next;
    } else {
      e.ema = e.ema + alpha * (val - e.ema);
    }
    e.lastT = t;
    this.store.set(key, e);
  },
  meanAngle(samples){
    if (!samples.length) return NaN;
    let sx=0, sy=0;
    for (const s of samples) { const r = s.v*Math.PI/180; sx += Math.cos(r); sy += Math.sin(r); }
    return normalizeDeg(Math.atan2(sy, sx)*180/Math.PI);
  },
  meanScalar(samples){
    if (!samples.length) return NaN;
    let s=0; for (const o of samples) s+=o.v; return s/samples.length;
  },
  value(key){
    const e = this.store.get(key);
    if (!e) return NaN;
    if (this.mode === 'avg') {
      return (e.type === 'angle') ? this.meanAngle(e.samples) : this.meanScalar(e.samples);
    }
    if (this.mode === 'ema') return e.ema;
    return NaN;
  }
};
function presentValue(key, latest){
  if (AGG.mode === 'normal') return latest;
  const v = AGG.value(key);
  return Number.isFinite(v) ? v : latest;
}

/* ========================= 5) MAP ========================= */
let client=null, connected=false;
let map, vehMarker, ac2Marker, vehPath, ac2Path, didFit=false;
let haveVeh=false, haveAc2=false;
let lastAc2 = null; // {lat,lon,ts}

function makeDivIcon(cls){
  return L.divIcon({ className:`marker ${cls}`, html:`<div class="arrow"></div>`, iconSize:[28,28], iconAnchor:[14,14] });
}
function initMap(){
  if (map) return;
  const start=[51.66,-2.06];
  map = L.map('map',{
    zoomControl:true,
    attributionControl:true,
    preferCanvas:true
  }).setView(start, 13); // not too close initially
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,attribution:'© OpenStreetMap'}).addTo(map);
  vehPath = L.polyline([], {color:'#60a5fa', weight:3.5, opacity:0.95}).addTo(map);
  ac2Path = L.polyline([], {color:'#f87171', weight:3.5, opacity:0.95}).addTo(map);
  vehMarker = L.marker(start,{icon:makeDivIcon('veh')}).addTo(map);
  ac2Marker = L.marker(start,{icon:makeDivIcon('ac2')}).addTo(map);
  setTimeout(()=> map.invalidateSize(), 0);
}
function updateTrail(poly,lat,lon,maxPts=10000){
  const pts = poly.getLatLngs(); pts.push([lat,lon]); if(pts.length>maxPts) pts.shift(); poly.setLatLngs(pts);
}
function setArrowRotation(marker,deg){
  const el = marker.getElement(); if(!el) return; const arrow = el.querySelector('.arrow');
  if(!arrow) return;
  const curStr = arrow.style.transform || '';
  const m = curStr.match(/rotate\((-?\d+(\.\d+)?)deg\)/);
  const current = m ? parseFloat(m[1]) : 0;
  const dur = currentAnimDuration();
  startAngleTween(`mark:${marker._leaflet_id}`, current, deg, dur, ANIM.mode, (v)=>{
    arrow.style.transform = `rotate(${v}deg)`;
  });
}
function maybeFit(){
  if (didFit || !haveVeh || !haveAc2) return;
  const b = L.latLngBounds(vehMarker.getLatLng(), ac2Marker.getLatLng());
  map.fitBounds(b.pad(0.2), { maxZoom: 16 });
  didFit = true;
}

/* ========================= 6) GAUGES ========================= */
function polarToXY(cx, cy, r, angleDeg){
  const rad = (angleDeg - 90) * Math.PI / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}
function arcPath(cx, cy, r, startDeg, endDeg){
  const [sx, sy] = polarToXY(cx, cy, r, startDeg);
  const [ex, ey] = polarToXY(cx, cy, r, endDeg);
  const largeArc = (endDeg - startDeg) > 180 ? 1 : 0;
  return `M ${sx} ${sy} A ${r} ${r} 0 ${largeArc} 1 ${ex} ${ey}`;
}
function buildGauge(svg, opts){
  if (!svg) return;
  const svgns = "http://www.w3.org/2000/svg";
  const w = 200, h = 120, cx = 100, cy = 110, r = 90;
  const startDeg = 270, endDeg = 450, span = endDeg - startDeg;
  const max = Math.round(opts.max), amber = Math.round(opts.amber), red = Math.round(opts.red);

  svg.innerHTML = "";
  const mk = (tag, attrs) => { const el = document.createElementNS(svgns, tag); for (const k in attrs) el.setAttribute(k, attrs[k]); return el; };
  const angFor = v => startDeg + (v/max) * span;

  svg.appendChild(mk('path', { d: arcPath(cx, cy, r, startDeg, endDeg), class: 'track' }));
  svg.appendChild(mk('path', { d: arcPath(cx, cy, r, angFor(red), angFor(max)), class: 'band-red' }));

  const prog = mk('path', { d: arcPath(cx, cy, r, startDeg, endDeg), class: 'zone-green' });
  prog.id = svg.id + '-progress';
  svg.appendChild(prog);
  const len = prog.getTotalLength();
  prog.style.strokeDasharray = `${len} ${len}`;
  prog.style.strokeDashoffset = `${len}`;

  const ticks = document.createElementNS(svgns, 'g'); ticks.setAttribute('class', 'ticks');
  const stepMinor = max <= 80 ? 5 : 10;
  const stepMajor = max <= 80 ? 10 : 20;
  for (let v = 0; v <= max+1e-6; v += stepMinor) {
    const major = (v % stepMajor) === 0;
    const angle = angFor(v);
    const [x1, y1] = polarToXY(cx, cy, r, angle);
    const [x2, y2] = polarToXY(cx, cy, r - (major ? 12 : 7), angle);
    ticks.appendChild(mk('line', { x1, y1, x2, y2, class: `tick${major ? ' major' : ''}` }));
  }
  [0, Math.round(max/2), Math.round(max)].forEach(v=>{
    const angle = angFor(v);
    const [tx, ty] = polarToXY(cx, cy, r - 24, angle);
    const t = mk('text', { x: tx, y: ty, 'text-anchor': 'middle', 'dominant-baseline': 'middle', class: 'tick-label' });
    t.textContent = String(v);
    ticks.appendChild(t);
  });
  svg.appendChild(ticks);

  const needle = mk('line', { x1: cx, y1: cy, x2: cx, y2: cy - (r - 24), class: 'needle' });
  needle.id = svg.id + '-needle';
  svg.appendChild(needle);

  // Store geometry
  svg.dataset.max   = String(max);
  svg.dataset.amber = String(amber);
  svg.dataset.red   = String(red);
  svg.dataset.len   = String(len);
  svg.dataset.cx    = String(cx);
  svg.dataset.cy    = String(cy);
  svg.dataset.r     = String(r - 24);
  svg.dataset.start = String(startDeg);
  svg.dataset.span  = String(span);
  svg.dataset.val   = "0";
}
function renderGaugeAt(svg, value){
  if (!svg) return;
  const max   = Number(svg.dataset.max || 140);
  const amber = Number(svg.dataset.amber || 60);
  const red   = Number(svg.dataset.red || 100);
  const len   = Number(svg.dataset.len || 0);
  const cx    = Number(svg.dataset.cx || 100);
  const cy    = Number(svg.dataset.cy || 110);
  const rn    = Number(svg.dataset.r  || 66);
  const start = Number(svg.dataset.start || 270);
  const span  = Number(svg.dataset.span  || 180);

  const k = clamp(value || 0, 0, max);
  const frac = k / max;
  const angle = start + frac * span;

  let cls = 'zone-green'; if (k >= red) cls = 'zone-red'; else if (k >= amber) cls = 'zone-amber';
  const prog = qs(svg.id + '-progress');
  if (prog) { prog.setAttribute('class', cls); prog.style.strokeDashoffset = String(len - len * frac); }

  const needle = qs(svg.id + '-needle');
  if (needle) {
    const [x, y] = polarToXY(cx, cy, rn, angle);
    needle.setAttribute('x1', cx); needle.setAttribute('y1', cy);
    needle.setAttribute('x2', x);  needle.setAttribute('y2', y);
  }
}
function animateGauge(svgId, target){
  const svg = qs(svgId); if (!svg) return;
  const from = Number(svg.dataset.val || 0);
  const to   = Number(target || 0);
  const dur  = currentAnimDuration();
  startTween(`gauge:${svgId}`, from, to, dur, ANIM.mode, (v)=>{
    svg.dataset.val = String(v);
    renderGaugeAt(svg, v);
  });
}
function rebuildGauges(){
  const scale = gaugeSpeedScale();
  buildGauge(qs('vehGauge'),  scale);
  buildGauge(qs('ac2Gauge'),  scale);
  buildGauge(qs('windGauge'), scale);
}

/* ========================= 7) STATE & UI HELPERS ========================= */
const ALT_MAX_M = 1000; // fixed bar range in metres
const UI = {
  veh: { spd_mps: NaN, hdg_deg: NaN, lat: NaN, lon: NaN, alt_m: NaN },
  ac2: { spd_mps: NaN, hdg_deg: NaN, lat: NaN, lon: NaN, alt_m: NaN },
  wx:  { temp_c: NaN, wind_mps: NaN, wind_dir_deg: NaN },
};

function putText(id, text){ const el=qs(id); if (el) el.textContent = text; }
function setNumber(id, targetVal, formatter = F.int){
  const el = qs(id); if (!el) return;
  const current = parseFloat(el.textContent);
  const dur = currentAnimDuration();
  if (!Number.isFinite(current)) { el.textContent = formatter(targetVal); return; }
  startTween(`num:${id}`, current, targetVal, dur, ANIM.mode, (v)=> { el.textContent = formatter(v); });
}
function setSpeedValue(id, mps){ setNumber(id, toSpeedUnit(mps), F.int); }
function setTempValue(id, c){ setNumber(id, tempToUnit(c), F.int); }
function setAltValue(id, m){ setNumber(id, altToUnit(m), F.int); }
function setCompassNeedle(id, deg){
  const el = qs(id); if (!el) return;
  const style = getComputedStyle(el);
  const curStr = style.getPropertyValue('--angle') || '0deg';
  const m = curStr.match(/(-?\d+(\.\d+)?)deg/);
  const cur = m ? parseFloat(m[1]) : 0;
  const dur = currentAnimDuration();
  startAngleTween(`ang:${id}`, cur, deg, dur, ANIM.mode, (v)=> el.style.setProperty('--angle', `${v}deg`) );
}
function setMarkerHeading(marker, deg){ setArrowRotation(marker, deg); }

function setMarkerLatLon(marker, lat, lon){
  const cur = marker.getLatLng(); const dur = currentAnimDuration();
  startTween(`latm:${marker._leaflet_id}`, cur.lat, lat, dur, ANIM.mode, (v)=> marker.setLatLng([v, marker.getLatLng().lng]));
  startTween(`lonm:${marker._leaflet_id}`, cur.lng, lon, dur, ANIM.mode, (v)=> marker.setLatLng([marker.getLatLng().lat, v]));
}
function setLatLonText(idLat, idLon, lat, lon){
  const elLat = qs(idLat), elLon = qs(idLon);
  if (!elLat || !elLon) return;
  const curLat = parseFloat(elLat.textContent), curLon = parseFloat(elLon.textContent);
  const dur = currentAnimDuration();
  if (Number.isFinite(curLat)) startTween(`lat:${idLat}`, curLat, lat, dur, ANIM.mode, (v)=> putText(idLat, F.lat(v))); else putText(idLat, F.lat(lat));
  if (Number.isFinite(curLon)) startTween(`lon:${idLon}`, curLon, lon, dur, ANIM.mode, (v)=> putText(idLon, F.lon(v))); else putText(idLon, F.lon(lon));
}

/* Altimeter (percent from 0..ALT_MAX_M) */
function setAltBar(barId, markerId, value_m){
  const bar = qs(barId); const mk = qs(markerId);
  if (!bar || !mk) return;
  const curPct = parseFloat(getComputedStyle(bar).getPropertyValue('--pct')) || 0;
  const tgtPct = clamp((value_m/ALT_MAX_M)*100, 0, 100);
  const dur = currentAnimDuration();
  startTween(`alt:${barId}`, curPct, tgtPct, dur, ANIM.mode, (v)=> {
    bar.style.setProperty('--pct', v.toFixed(2));
  });
}

/* ========================= 8) MQTT ========================= */
function connect(){
  if (connected) {
    if (client) { client.end(true); client = null; }
    connected = false;
    qs('status').className = 'statusdot bad';
    qs('connectToggle').textContent = 'Connect';
    return;
  }
  initMap();
  updateConnInfo();

  const url = `ws://${CONFIG.host}:${CONFIG.wsPort}/`;
  client = mqtt.connect(url,{keepalive:30,reconnectPeriod:1000, queueQoSZero:false});

  client.on('connect', ()=>{
    connected = true;
    qs('status').className = 'statusdot ok';
    qs('connectToggle').textContent = 'Disconnect';
    client.subscribe(`airchase/fused/${CONFIG.vehicle}`);
    setTimeout(()=> map && map.invalidateSize(), 0);
  });
  client.on('reconnect', ()=> qs('status').className = 'statusdot warn');
  client.on('close', ()=>{ qs('status').className = 'statusdot bad'; connected=false; qs('connectToggle').textContent='Connect'; });
  client.on('error', ()=> qs('status').className = 'statusdot warn');

  client.on('message',(topic,payload)=>{
    try{
      const m = JSON.parse(payload.toString());
      const log = qs('log'); if (log) log.textContent = JSON.stringify(m) + "\n" + log.textContent;

      // cadence / Hz
      const now = Date.now();
      if (RATE.lastMs) {
        const dt = now - RATE.lastMs;
        RATE.emaDt = RATE.emaDt ? (0.9*RATE.emaDt + 0.1*dt) : dt;
      }
      RATE.lastMs = now;
      RATE.hintedHz = (m.meta && Number(m.meta.rate_hz)) || RATE.hintedHz;
      updateConnInfo();

      const veh = m.vehicle||{};
      const pos = veh.pos||{};
      const wx  = veh.weather||{};
      const ac2 = (m.ac2||{}).pos||{};

      /* ---- VEH SPEED ---- */
      const vSpd = Number(pos.spd_mps);
      if (Number.isFinite(vSpd)) {
        UI.veh.spd_mps = vSpd;
        AGG.push('veh_spd', vSpd, 'scalar');
        const shown = presentValue('veh_spd', vSpd);
        setSpeedValue('vehSpeedVal', shown);
        animateGauge('vehGauge', toSpeedUnit(shown));
      }

      /* ---- VEH POS / HDG / ALT ---- */
      if (pos.lat!==undefined && pos.lon!==undefined){
        const lat = Number(pos.lat), lon = Number(pos.lon);
        const alt = Number(pos.alt_m);
        const hdg = Number(pos.hdg_deg);

        // HDG (angle agg)
        if (Number.isFinite(hdg)) {
          UI.veh.hdg_deg = hdg;
          AGG.push('veh_hdg', hdg, 'angle');
          const hShown = presentValue('veh_hdg', hdg);
          setNumber('vehHdgVal', hShown, F.deg);
          setCompassNeedle('vehNeedle', hShown);
          if (vehMarker) setMarkerHeading(vehMarker, hShown);
        }

        // ALT (scalar)
        if (Number.isFinite(alt))  {
          UI.veh.alt_m = alt;
          setAltValue('vehAltVal', alt);
          setAltBar('vehAltBar','vehAltMarker', alt);
        }

        // Lat/Lon (only display agg; marker uses raw)
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          UI.veh.lat = lat; UI.veh.lon = lon;
          AGG.push('veh_lat', lat, 'scalar');
          AGG.push('veh_lon', lon, 'scalar');
          const ltShown = presentValue('veh_lat', lat);
          const lnShown = presentValue('veh_lon', lon);
          setLatLonText('vehLat','vehLon', ltShown, lnShown);

          if (vehMarker){
            setMarkerLatLon(vehMarker, lat, lon);
            updateTrail(vehPath, lat, lon);
            haveVeh=true;
          }
        }
      }

      /* ---- WEATHER ---- */
      const tC = Number(wx.temp_c);
      if (Number.isFinite(tC)) {
        UI.wx.temp_c = tC;
        AGG.push('temp', tC, 'scalar');
        const tShown = presentValue('temp', tC);
        setTempValue('tempVal', tShown);
      }

      const wSpd = Number(wx.wind_mps);
      if (Number.isFinite(wSpd)) {
        UI.wx.wind_mps = wSpd;
        AGG.push('wind', wSpd, 'scalar');
        const wShown = presentValue('wind', wSpd);
        setNumber('windVal', toSpeedUnit(wShown), F.int);
        animateGauge('windGauge', toSpeedUnit(wShown));
      }

      const wdir = Number(wx.wind_dir_deg);
      if (Number.isFinite(wdir)) {
        UI.wx.wind_dir_deg = wdir;
        AGG.push('wind_dir', wdir, 'angle');
        const wdShown = presentValue('wind_dir', wdir);
        setNumber('winddirVal', wdShown, F.deg);
        setCompassNeedle('windNeedle', wdShown);
      }

      /* ---- AC2 ---- */
      if (ac2.lat!==undefined && ac2.lon!==undefined){
        const alat = Number(ac2.lat), alon = Number(ac2.lon);
        const aalt = Number(ac2.alt_m);
        const ahdg = Number(ac2.hdg_deg);
        const ts   = ac2.ts ? Date.parse(ac2.ts) : NaN;

        let aSpd = Number(ac2.spd_mps);
        if (!Number.isFinite(aSpd) || aSpd<=0) {
          if (Number.isFinite(ts) && lastAc2){
            const dt = (ts - lastAc2.ts)/1000;
            if (dt > 0.05) {
              const d = haversineMeters({lat:lastAc2.lat,lon:lastAc2.lon},{lat:alat,lon:alon});
              aSpd = d / dt;
            }
          }
        }
        if (Number.isFinite(ts)) lastAc2 = { lat:alat, lon:alon, ts };

        if (Number.isFinite(aSpd)) {
          UI.ac2.spd_mps = aSpd;
          AGG.push('ac2_spd', aSpd, 'scalar');
          const aShown = presentValue('ac2_spd', aSpd);
          setSpeedValue('ac2SpeedVal', aShown);
          animateGauge('ac2Gauge', toSpeedUnit(aShown));
        }

        if (Number.isFinite(ahdg)) {
          UI.ac2.hdg_deg = ahdg;
          AGG.push('ac2_hdg', ahdg, 'angle');
          const h2Shown = presentValue('ac2_hdg', ahdg);
          setNumber('ac2HdgVal', h2Shown, F.deg);
          setCompassNeedle('ac2Needle', h2Shown);
          if (ac2Marker) setMarkerHeading(ac2Marker, h2Shown);
        }

        if (Number.isFinite(aalt))  {
          UI.ac2.alt_m = aalt;
          setAltValue('ac2AltVal', aalt);
          setAltBar('ac2AltBar','ac2AltMarker', aalt);
        }

        if (Number.isFinite(alat) && Number.isFinite(alon)) {
          UI.ac2.lat = alat; UI.ac2.lon = alon;
          AGG.push('ac2_lat', alat, 'scalar');
          AGG.push('ac2_lon', alon, 'scalar');
          const ltShown = presentValue('ac2_lat', alat);
          const lnShown = presentValue('ac2_lon', alon);
          setLatLonText('ac2Lat','ac2Lon', ltShown, lnShown);

          if (ac2Marker){
            setMarkerLatLon(ac2Marker, alat, alon);
            updateTrail(ac2Path, alat, alon);
            haveAc2=true;
          }
        }
      }

      maybeFit();
    }catch(e){
      console.error("Bad payload", e);
    }
  });
}

/* haversine */
function toRad(d){ return d*Math.PI/180; }
function haversineMeters(a, b){
  const R=6371000;
  const dLat=toRad(b.lat-a.lat), dLon=toRad(b.lon-a.lon);
  const s = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}

/* ========================= 9) UI HOOKS ========================= */
function toggleTheme(){
  const light = document.body.classList.toggle('light');
  localStorage.setItem('airchaseTheme', light ? 'light' : 'dark');
  const b = qs('themeBtn'); if (b) b.textContent = light ? 'Light' : 'Dark';
}
function cycleAnim(){
  const order = ['soft','snappy','linear','off'];
  const i = order.indexOf(ANIM.mode);
  ANIM.mode = order[(i+1) % order.length];
  const b = qs('animBtn'); if (b) b.textContent = `Anim: ${ANIM.mode[0].toUpperCase()}${ANIM.mode.slice(1)}`;
}
function repaintAllForAggAndUnits(){
  // speeds + gauges
  if (Number.isFinite(UI.veh.spd_mps)) { const v=presentValue('veh_spd', UI.veh.spd_mps); setSpeedValue('vehSpeedVal', v); animateGauge('vehGauge', toSpeedUnit(v)); }
  if (Number.isFinite(UI.ac2.spd_mps)) { const v=presentValue('ac2_spd', UI.ac2.spd_mps); setSpeedValue('ac2SpeedVal', v); animateGauge('ac2Gauge', toSpeedUnit(v)); }
  if (Number.isFinite(UI.wx.wind_mps)) { const v=presentValue('wind', UI.wx.wind_mps); setNumber('windVal', toSpeedUnit(v), F.int); animateGauge('windGauge', toSpeedUnit(v)); }

  // temp
  if (Number.isFinite(UI.wx.temp_c))   { const v=presentValue('temp', UI.wx.temp_c); setTempValue('tempVal', v); }

  // headings + compasses
  if (Number.isFinite(UI.veh.hdg_deg)) { const v=presentValue('veh_hdg', UI.veh.hdg_deg); setNumber('vehHdgVal', v, F.deg); setCompassNeedle('vehNeedle', v); }
  if (Number.isFinite(UI.ac2.hdg_deg)) { const v=presentValue('ac2_hdg', UI.ac2.hdg_deg); setNumber('ac2HdgVal', v, F.deg); setCompassNeedle('ac2Needle', v); }
  if (Number.isFinite(UI.wx.wind_dir_deg)) { const v=presentValue('wind_dir', UI.wx.wind_dir_deg); setNumber('winddirVal', v, F.deg); setCompassNeedle('windNeedle', v); }

  // alt values + bar range labels
  if (Number.isFinite(UI.veh.alt_m)) setAltValue('vehAltVal', UI.veh.alt_m);
  if (Number.isFinite(UI.ac2.alt_m)) setAltValue('ac2AltVal', UI.ac2.alt_m);
  const maxLabVeh = qs('vehAltMaxLbl'), maxLabAc2 = qs('ac2AltMaxLbl');
  const topVal = altToUnit(ALT_MAX_M);
  if (maxLabVeh) maxLabVeh.textContent = `${F.int(topVal)} ${altSuffix()}`;
  if (maxLabAc2) maxLabAc2.textContent = `${F.int(topVal)} ${altSuffix()}`;

  // lat/lon (agg only affects displayed text)
  if (Number.isFinite(UI.veh.lat) && Number.isFinite(UI.veh.lon)) {
    const lt=presentValue('veh_lat', UI.veh.lat), ln=presentValue('veh_lon', UI.veh.lon);
    setLatLonText('vehLat','vehLon', lt, ln);
  }
  if (Number.isFinite(UI.ac2.lat) && Number.isFinite(UI.ac2.lon)) {
    const lt=presentValue('ac2_lat', UI.ac2.lat), ln=presentValue('ac2_lon', UI.ac2.lon);
    setLatLonText('ac2Lat','ac2Lon', lt, ln);
  }
}
function cycleAgg(){
  const order = ['normal','avg','ema'];
  const i = order.indexOf(AGG.mode);
  AGG.mode = order[(i+1) % order.length];
  const label = AGG.mode==='normal' ? 'Normal' : (AGG.mode==='avg' ? 'Avg (10s)' : 'EMA (10s)');
  const b = qs('aggBtn'); if (b) b.textContent = `Agg: ${label}`;
  repaintAllForAggAndUnits();
}
function cycleSpeedUnit(){
  speedUnitIdx = (speedUnitIdx + 1) % SpeedUnits.length;
  const b = qs('speedUnitBtn'); if (b) b.textContent = `Speed: ${speedUnit()}`;
  qsa('.speedUnit').forEach(el => el.textContent = speedUnit());
  rebuildGauges();
  repaintAllForAggAndUnits();
}
function cycleTempUnit(){
  tempUnitIdx = (tempUnitIdx + 1) % TempUnits.length;
  const b = qs('tempUnitBtn'); if (b) b.textContent = `Temp: ${tempUnit()}`;
  qsa('.tempUnit').forEach(el => el.textContent = tempUnit());
  repaintAllForAggAndUnits();
}
function cycleAltUnit(){
  altUnitIdx = (altUnitIdx + 1) % AltUnits.length;
  const b = qs('altUnitBtn'); if (b) b.textContent = `Alt: ${altUnit()}`;
  // update unit labels near values and the top label for the bar
  qsa('.altUnit').forEach(el => el.textContent = altSuffix());
  repaintAllForAggAndUnits();
}
function openLogs(){ qs('logsOverlay')?.classList.remove('hidden'); }
function closeLogs(){ qs('logsOverlay')?.classList.add('hidden'); }
function setLayoutHeightFromHeader(){
  const hdr = qs('hdr'); const layout = qs('layout'); if(!hdr||!layout) return;
  const h = hdr.offsetHeight + 16;
  layout.style.setProperty('--header-h', `${h}px`);
  setTimeout(()=> { if (map) map.invalidateSize(); }, 0);
}

/* ========================= 10) BOOT ========================= */
window.addEventListener('DOMContentLoaded', ()=>{
  updateConnInfo();

  const saved = localStorage.getItem('airchaseTheme');
  if(saved==='light'){ document.body.classList.add('light'); const b=qs('themeBtn'); if (b) b.textContent='Light'; }

  initMap();
  rebuildGauges();

  // header button labels (guard if not present)
  const bSpd = qs('speedUnitBtn'); if (bSpd) bSpd.textContent = `Speed: ${speedUnit()}`;
  const bTmp = qs('tempUnitBtn');  if (bTmp) bTmp.textContent  = `Temp: ${tempUnit()}`;
  const bAlt = qs('altUnitBtn');   if (bAlt) bAlt.textContent  = `Alt: ${altUnit()}`;
  const bAni = qs('animBtn');      if (bAni) bAni.textContent      = `Anim: ${ANIM.mode[0].toUpperCase()}${ANIM.mode.slice(1)}`;
  const bAgg = qs('aggBtn');       if (bAgg) bAgg.textContent       = `Agg: Normal`;

  const topVal = altToUnit(ALT_MAX_M);
  putText('vehAltMaxLbl', `${F.int(topVal)} ${altSuffix()}`);
  putText('ac2AltMaxLbl', `${F.int(topVal)} ${altSuffix()}`);

  setLayoutHeightFromHeader();
  let t; window.addEventListener('resize', ()=>{ clearTimeout(t); t=setTimeout(()=> setLayoutHeightFromHeader(), 120); });

  // hooks (guarded)
  qs('connectToggle')?.addEventListener('click', connect);
  qs('logsBtn')?.addEventListener('click', openLogs);
  qs('closeLogs')?.addEventListener('click', closeLogs);
  qs('themeBtn')?.addEventListener('click', toggleTheme);
  qs('animBtn')?.addEventListener('click', cycleAnim);
  qs('aggBtn')?.addEventListener('click', cycleAgg);
  qs('speedUnitBtn')?.addEventListener('click', cycleSpeedUnit);
  qs('tempUnitBtn')?.addEventListener('click', cycleTempUnit);
  qs('altUnitBtn')?.addEventListener('click', cycleAltUnit);
});
