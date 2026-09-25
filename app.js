/* Static FEC map. Geometry is fetched only as the user selects states or turns on the nationwide view. */
const $ = (id) => document.getElementById(id);
const names = {C00919084: 'Talarico', C00369033: 'Cornyn', C00901918: 'Paxton'};
// Each candidate keeps one color everywhere (map, legend, charts); checked for color-vision separation.
const hues = {C00919084: '#1f6fd1', C00369033: '#e09a12', C00901918: '#d62f45'};
const order = ['C00919084', 'C00369033', 'C00901918'];
const phases = ['pre_primary', 'between_primary_runoff', 'post_runoff'];
// Period is a contiguous span of phases, [start, end) as phase indexes; the masthead slider snaps to phase boundaries.
const phaseEdges = ['Jan 2025', 'Mar 3', 'May 26', 'latest'];
function periodLabel() {
  const [a, b] = state.span;
  if (a === 0 && b === phases.length) return 'All reported';
  if (a === 0) return `Through ${phaseEdges[b]}`;
  if (b === phases.length) return `Since ${['', 'Mar 4', 'May 27'][a]}`;
  return ['', 'Mar 4', 'May 27'][a] + ' – ' + phaseEdges[b];
}
const phaseMonths = {pre_primary: ['2025-01', '2026-03'], between_primary_runoff: ['2026-03', '2026-05'], post_runoff: ['2026-05', '9999-12']};
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
const short = (n) => n >= 1e6 ? '$' + +(n / 1e6).toFixed(1) + 'm' : n >= 1e3 ? '$' + +(n / 1e3).toFixed(1) + 'k' : '$' + Math.round(n);
const people = (n) => n >= 1e6 ? +(n / 1e6).toFixed(1) + 'm' : n >= 1e3 ? +(n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
const monthLabel = (m, style = 'short') => new Date(m + '-15').toLocaleDateString('en-US', {month: style, year: 'numeric'});
const NEUTRAL = '#ece7e0', PALE = '#f4f2ef', EMPTY = '#e6eaeb', CONUS = [[24, -125], [50, -66]];
const levels = {
  zcta: {label: 'ZCTAs', noun: 'ZCTA', title: 'ZIP (ZCTA)'},
  county: {label: 'counties', noun: 'county', title: 'County', national: true},
  cd: {label: 'congressional districts', noun: 'district', title: 'Congressional district', national: true},
  cbsa: {label: 'metro/micro areas', noun: 'metro area', title: 'Metro/micro area', national: true},
  cousub: {label: 'county subdivisions', noun: 'county subdivision', title: 'County subdivision'},
  state: {label: 'states', noun: 'state', title: 'States'},
};
const ramp = ['#fde725', '#5ec962', '#21918c', '#3b528b', '#440154']; // viridis, light to dark
// Statistics shared by the filter and the rankings. value(first, second, population) -> number or null.
const stats = {
  total: {label: () => 'Total raised', value: (a, b) => a[0] + b[0], log: true, format: short},
  capita: {label: () => 'Per 100 residents', value: (a, b, pop) => pop ? 100 * (a[0] + b[0]) / pop : null, log: true, format: (v) => v < 10 ? '$' + +v.toFixed(2) : short(v)},
  share: {label: () => `${names[state.first]}'s share`, value: (a, b) => a[0] + b[0] > 0 ? a[0] / (a[0] + b[0]) : null, log: false, format: (v) => Math.round(100 * v) + '%'},
  avg: {label: () => 'Average contribution', value: (a, b) => a[2] + b[2] > 0 ? (a[0] + b[0]) / (a[2] + b[2]) : null, log: true, format: short},
  count: {label: () => 'Contributions', value: (a, b) => a[2] + b[2], log: true, format: (v) => people(v)},
};
const state = {span: [0, 3], first: 'C00919084', second: 'C00901918', measure: 'lead', level: 'zcta',
  selected: [], nationwide: false, receipts: new Map(), totals: new Map(), areas: {}, unallocated: new Map(),
  population: {}, monthly: null, months: [], geo: new Map(), layer: null, index: new Map(), render: 0, states: null,
  coverage: null, breaks: [], fade: null, chartMode: 'monthly', timeline: false, timeIndex: 0, timeMode: 'cumulative',
  rankBy: 'total', rankDesc: true, rankStates: false,
  filter: {stat: 'total', ranges: {}, all: false, scope: ''}};
const map = L.map('map', {zoomControl: false, doubleClickZoom: false, minZoom: 3, maxZoom: 12, preferCanvas: false,
  worldCopyJump: false, zoomSnap: .25, maxBounds: [[-10, -185], [73, -40]], maxBoundsViscosity: .6});
map.createPane('statePane'); map.getPane('statePane').style.zIndex = 410;
map.createPane('zctaPane'); map.getPane('zctaPane').style.zIndex = 420;
map.fitBounds(CONUS);
const tiles = L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 12, opacity: .3, attribution: 'Basemap: <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map" target="_blank" rel="noopener">USGS The National Map</a>'
}).addTo(map);
map.attributionControl.setPrefix('<a href="https://leafletjs.com/" target="_blank" rel="noopener">Leaflet</a> · <a href="https://www.census.gov/geographies/mapping-files.html" target="_blank" rel="noopener">Census boundaries</a>');

function csv(text) {
  const lines = text.trim().split(/\r?\n/), head = lines.shift().split(',');
  return lines.filter(Boolean).map(line => Object.fromEntries(line.split(',').map((value, index) => [head[index], value])));
}
async function fetchOk(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
  return response;
}
const json = async (url) => (await fetchOk(url)).json();
const file = async (url) => (await fetchOk(url)).text();
async function packed(url) {
  const response = await fetchOk(url);
  if (!globalThis.DecompressionStream) throw new Error('This browser needs gzip stream support to display boundaries.');
  return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
}
function addRows(rows, destination, key) {
  for (const row of rows) {
    const id = key(row);
    let item = destination.get(id);
    if (!item) { item = Object.fromEntries(phases.map(p => [p, [0, 0, 0]])); destination.set(id, item); }
    item[row.phase] = [Number(row.positive_cents) / 100, Number(row.net_cents) / 100, Number(row.count)];
  }
}
function values(store, id) {
  const item = store.get(id);
  if (!item) return [0, 0, 0];
  return phases.slice(...state.span).reduce((sum, phase) => sum.map((n, i) => n + item[phase][i]), [0, 0, 0]);
}
const comparison = (store, key) => [values(store, key + '|' + state.first), values(store, key + '|' + state.second)];
const timeMonth = () => state.months[state.timeIndex];
// State amounts for one candidate: the selected period, or the timeline month (cumulative or single).
function stateValues(code, candidate) {
  if (!state.timeline) return values(state.totals, code + '|' + candidate);
  const end = timeMonth(), sum = [0, 0, 0];
  for (const m of state.months) {
    if (m > end || (state.timeMode === 'month' && m !== end)) continue;
    const v = state.monthly.get(code + '|' + candidate + '|' + m);
    if (v) v.forEach((n, i) => { sum[i] += n; });
  }
  return sum;
}
const stateAmounts = (code) => [stateValues(code, state.first), stateValues(code, state.second)];
function hexBlend(a, b, ratio) {
  const toRGB = x => [1, 3, 5].map(i => parseInt(x.slice(i, i + 2), 16));
  const x = toRGB(a), y = toRGB(b), t = Math.max(0, Math.min(1, ratio));
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
const bin = (value, breaks) => breaks.filter(b => value >= b).length;
const population = (level, id) => state.population[level]?.get(id);

/* The colored set: exactly one level is colored at a time. States when nothing is open (or on the
   timeline); otherwise the open areas, with every other state as plain context. */
const statesColored = () => state.timeline || (!state.nationwide && !state.selected.length);
function areaKey(level, feature) {
  const p = feature.properties;
  return level === 'zcta' ? {store: state.receipts, key: p._state + '|' + p.zip, pop: p.zip} : {store: state.areas[level], key: p.geoid, pop: p.geoid};
}
const areaTitle = (level, feature) => level === 'zcta' ? `ZCTA ${feature.properties.zip} · ${feature.properties._state}` : feature.properties.name;
function stateItems() {
  return Object.keys(state.statesByCode).map(code => ({key: code, name: state.statesByCode[code], amounts: stateAmounts(code), pop: population('state', code), isState: true}));
}
function areaItems() {
  const level = state.layer.level, seen = new Set(), list = [];
  for (const polygon of state.layer.getLayers()) {
    const {store, key, pop} = areaKey(level, polygon.feature);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({key, name: areaTitle(level, polygon.feature), amounts: comparison(store, key), pop: population(level, pop)});
  }
  return list;
}
const coloredLevel = () => statesColored() || !state.layer ? 'state' : state.layer.level;
const coloredItems = () => coloredLevel() === 'state' ? stateItems() : areaItems();

/* Filter: ranges on any statistic; the one shown always applies, the others only with "apply all". */
const filterOn = () => !$('filter').hidden;
function passes(amounts, pop) {
  if (!filterOn()) return true;
  const f = state.filter, active = f.all ? Object.keys(f.ranges) : [f.stat];
  for (const name of active) {
    const range = f.ranges[name];
    if (!range) continue;
    const v = stats[name].value(...amounts, pop);
    if (v == null || (range[0] != null && v < range[0]) || (range[1] != null && v > range[1])) return false;
  }
  return true;
}

/* Shading. "Who led" is eight steps of the leader's share of the pair's dollars (see leadClasses); "Total raised"
   and "Per 100 residents" are five viridis classes cut at fifths of the places shown. Instead of a hard
   "too little to call" cutoff, colors fade smoothly toward pale as the weight behind them shrinks:
   dollars for "Who led", residents for "Per 100 residents". The fade runs on a log scale between the
   10th and 75th percentile of the places shown, so it adapts to every view. */
// Eight steps, four per side (leader's share 50-55, 55-65, 65-80, 80%+), from the second candidate's
// strongest to the first's. There is no neutral band: any lead, however narrow, tints toward the leader.
const LEAD_CUTS = [.55, .65, .8];
function leadClasses() {
  const side = (hue) => [.3, .5, .75, 1].map(t => hexBlend(NEUTRAL, hue, t));
  return [...side(hues[state.second]).reverse(), ...side(hues[state.first])];
}
function leadColor(share) {
  if (share === .5) return NEUTRAL;
  const classes = leadClasses();
  return share > .5 ? classes[4 + bin(share, LEAD_CUTS)] : classes[3 - bin(1 - share, LEAD_CUTS)];
}
function strength(weight) {
  const f = state.fade;
  if (!f || weight <= 0) return weight > 0 ? 1 : 0;
  if (f.hi <= f.lo) return 1;
  return Math.max(0, Math.min(1, (Math.log(weight) - Math.log(f.lo)) / (Math.log(f.hi) - Math.log(f.lo))));
}
const faded = (color, s) => hexBlend(PALE, color, .15 + .85 * s);
function classify(amounts, pop, included = true) {
  const a = amounts[0][0], b = amounts[1][0], total = a + b;
  if (!included) return {fill: EMPTY, kind: 'out'};
  if (total <= 0) return {fill: EMPTY, kind: 'empty'};
  if (state.measure === 'volume') return {fill: ramp[bin(total, state.breaks)], kind: 'value'};
  if (state.measure === 'capita') {
    if (!pop) return {fill: EMPTY, kind: 'nopop'};
    const s = strength(pop);
    return {fill: faded(ramp[bin(100 * total / pop, state.breaks)], s), kind: 'value', s};
  }
  const s = strength(total);
  return {fill: faded(leadColor(a / total), s), kind: 'value', s};
}
function paint(amounts, pop) {
  const {fill, kind} = classify(amounts, pop, passes(amounts, pop));
  return {fillColor: fill, fillOpacity: kind === 'out' ? .12 : kind === 'empty' || kind === 'nopop' ? .3 : .9};
}
function stateStyle(feature) {
  const code = feature.properties.code, chosen = !state.timeline && !state.nationwide && state.selected.includes(code);
  const base = {pane: 'statePane', color: chosen ? '#10212b' : '#7d8e95', weight: chosen ? 2.4 : .8, opacity: .9};
  if (!statesColored()) return {...base, fillColor: '#ffffff', fillOpacity: chosen || state.nationwide ? 0 : .6};
  return {...base, ...paint(stateAmounts(code), population('state', code))};
}
function areaStyle(level, feature) {
  const {store, key, pop} = areaKey(level, feature);
  return {pane: 'zctaPane', color: '#56696f', weight: level === 'zcta' || level === 'cousub' ? .35 : .6, opacity: .5,
    ...paint(comparison(store, key), population(level, pop))};
}
/* Class cutoffs (fifths, rounded to two significant digits) and fade range, from the places shown that
   pass the filter. On the timeline the cutoffs come from every month so they hold still while it plays. */
function nice(v) {
  if (v <= 0) return 0;
  const p = 10 ** (Math.floor(Math.log10(v)) - 1);
  return Math.round(v / p) * p;
}
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
function computeScales() {
  const capita = state.measure === 'capita', shown = coloredItems().filter(i => passes(i.amounts, i.pop));
  const weights = shown.map(i => capita ? i.pop || 0 : i.amounts[0][0] + i.amounts[1][0]).filter(w => w > 0).sort((a, b) => a - b);
  state.fade = weights.length > 4 ? {lo: quantile(weights, .1), hi: quantile(weights, .75)} : null;
  if (state.measure === 'lead') { state.breaks = []; return; }
  let list = [];
  const add = (i) => { const total = i.amounts[0][0] + i.amounts[1][0]; if (total > 0 && (!capita || i.pop)) list.push(capita ? 100 * total / i.pop : total); };
  if (state.timeline) {
    const saved = state.timeIndex, indexes = state.timeMode === 'month' ? state.months.map((m, i) => i) : [state.months.length - 1];
    for (const i of indexes) { state.timeIndex = i; stateItems().filter(x => passes(x.amounts, x.pop)).forEach(add); }
    state.timeIndex = saved;
  } else shown.forEach(add);
  list = list.sort((a, b) => a - b);
  const cuts = [.2, .4, .6, .8].map(q => nice(quantile(list, q) || 0));
  state.breaks = cuts.filter((v, i) => v > 0 && v > (cuts[i - 1] || 0));
}
function tooltip(level, title, amounts, pop, extra = '') {
  const [a, b] = amounts, total = a[0] + b[0], estimated = level !== 'zcta' && level !== 'state';
  const lines = [`<div class="tooltip-title">${title}</div>`];
  if (!total) lines.push('<div class="tooltip-sub">No itemized receipts from here for either candidate</div>');
  else {
    const pct = (n) => Math.round(100 * n / total) + '%';
    const avg = (v) => v[2] >= 1 ? ` · avg ${money(v[0] / v[2])}` : '';
    lines.push(`<div><span class="dot" style="background:${hues[state.first]}"></span>${names[state.first]} ${money(a[0])} (${pct(a[0])})<span class="tooltip-sub">${avg(a)}</span></div>`,
      `<div><span class="dot" style="background:${hues[state.second]}"></span>${names[state.second]} ${money(b[0])} (${pct(b[0])})<span class="tooltip-sub">${avg(b)}</span></div>`);
    const count = a[2] + b[2];
    lines.push(`<div class="tooltip-sub">${estimated ? '≈' + count.toLocaleString('en-US', {maximumFractionDigits: 1}) + ' contributions (estimated)' : count.toLocaleString() + ' itemized contributions'}</div>`);
    if (pop) lines.push(`<div class="tooltip-sub">${money(100 * total / pop)} per 100 residents · pop. ${pop.toLocaleString()}</div>`);
    const {s, kind} = classify(amounts, pop, passes(amounts, pop));
    if (kind === 'out') lines.push('<div class="tooltip-sub">Outside the filter range</div>');
    else if (s != null && s < .5 && state.measure !== 'volume') lines.push(`<div class="tooltip-sub">Shown paler: ${state.measure === 'capita' ? 'few residents' : 'few dollars'} compared with the places shown</div>`);
  }
  return lines.join('') + extra;
}
function stateTooltip(code) {
  let note = '', title = state.statesByCode[code];
  if (state.timeline) title += ` · ${state.timeMode === 'month' ? '' : 'through '}${monthLabel(timeMonth())}`;
  else if (state.level !== 'zcta' && state.selected.length) {
    const [x, y] = comparison(state.unallocated, state.level + '|' + code);
    if (x[0] + y[0] >= .5) note = `<div class="tooltip-sub">${money(x[0] + y[0])} from ZIPs with no mappable ${levels[state.level].noun}</div>`;
  }
  if (!state.timeline && !state.nationwide && !state.selected.includes(code)) note += `<div class="tooltip-hint">Click to open ${levels[state.level].label} · Shift-click to add</div>`;
  return tooltip('state', title, stateAmounts(code), population('state', code), note);
}
function showError(error) {
  $('error').textContent = error.message || String(error);
  $('error').hidden = false;
  console.error(error);
}

/* Data loading */
async function cached(key, load) {
  if (!state.geo.has(key)) state.geo.set(key, load().catch(error => { state.geo.delete(key); throw error; }));
  return state.geo.get(key);
}
const tag = (features, code) => features.map(f => ({...f, properties: {...f.properties, _state: code}}));
async function features(level) {
  if (!state.nationwide && !state.selected.length) return [];
  if (levels[level].national) {
    const all = (await cached(level, () => packed(`data/levels/geo/${level}.bin?v=1`))).features;
    return state.nationwide ? all : all.filter(f => f.properties.states.some(s => state.selected.includes(s)));
  }
  const dir = level === 'zcta' ? 'data/zctas' : 'data/levels/geo/cousub', v = level === 'zcta' ? 3 : 1;
  const files = await Promise.all(state.selected.map(code =>
    cached(level + '|' + code, () => packed(`${dir}/${encodeURIComponent(code)}.bin?v=${v}`)).then(geo => tag(geo.features, code))));
  return files.flat();
}
const loadPopulation = (name) => state.population[name] ? null :
  file(`data/population/${name}.csv`).then(text => { state.population[name] = new Map(csv(text).map(r => [r.geoid, Number(r.population)])); });
async function loadLevel(level) {
  const jobs = [];
  if (level !== 'zcta' && !state.areas[level]) jobs.push(file(`data/levels/${level}.csv`).then(text => {
    const areas = new Map();
    addRows(csv(text), areas, row => row.geoid + '|' + row.candidate);
    state.areas[level] = areas;
  }));
  if (level !== 'zcta' && !state.unallocated.size) jobs.push(file('data/levels/unallocated.csv').then(text =>
    addRows(csv(text), state.unallocated, row => row.level + '|' + row.state + '|' + row.candidate)));
  // Population feeds per-resident shading, the rankings and the filter.
  if (state.measure === 'capita' || !$('rank').hidden || filterOn()) jobs.push(loadPopulation(level), loadPopulation('state'));
  await Promise.all(jobs);
}

/* Rendering the area layer for the current selection */
async function render(fit = false) {
  const token = ++state.render, level = state.level;
  updateScope(true);
  try {
    await loadLevel(level);
    const list = await features(level);
    if (token !== state.render) return;
    if (state.layer) map.removeLayer(state.layer);
    state.index = new Map();
    state.layer = L.geoJSON({type: 'FeatureCollection', features: list}, {
      pane: 'zctaPane', smoothFactor: .5, style: feature => areaStyle(level, feature),
      onEachFeature: (feature, polygon) => {
        const p = feature.properties;
        state.index.set(areaKey(level, feature).key, polygon);
        polygon.bindTooltip(() => {
          const {store, key, pop} = areaKey(level, feature);
          return tooltip(level, areaTitle(level, feature), comparison(store, key), population(level, pop));
        }, {sticky: true, direction: 'top'});
        // A single click zooms in (or opens the state when nationwide); a quick double click resets to the U.S.
        let single;
        polygon.on('click', e => {
          L.DomEvent.stopPropagation(e);
          clearTimeout(single);
          const add = modifier(e);
          single = setTimeout(() => {
            if (state.nationwide || add) chooseState(p._state || p.states[0], add);
            else map.fitBounds(polygon.getBounds(), {padding: [55, 55], maxZoom: 10});
          }, 250);
        });
        polygon.on('dblclick', e => { L.DomEvent.stopPropagation(e); clearTimeout(single); resetView(); });
        polygon.on('mouseover', () => polygon.setStyle({weight: 1.8, color: '#10212b', opacity: 1}));
        polygon.on('mouseout', () => polygon.setStyle(areaStyle(level, feature)));
      }
    });
    if (!state.timeline) state.layer.addTo(map);
    state.layer.level = level;
    $('error').hidden = true;
    if (fit && list.length) map.fitBounds(state.layer.getBounds(), fitPadding(8));
  } catch (error) { showError(error); }
  if (token === state.render) { updateScope(); refresh(); }
}
// Keep fitted areas clear of the masthead and of the totals panel when it sits on the right.
function fitPadding(maxZoom) {
  const side = $('side'), box = side.getBoundingClientRect();
  const right = window.innerWidth > 850 && !side.hidden && box.left > window.innerWidth / 2 ? window.innerWidth - box.left + 20 : 30;
  return {paddingTopLeft: [40, 90], paddingBottomRight: [right, 50], maxZoom};
}
const modifier = (e) => { const o = e.originalEvent || e; return o.shiftKey || o.ctrlKey || o.metaKey; };
function chooseState(code, add) {
  if (!state.statesByCode[code]) return;
  state.nationwide = false;
  if (!add) state.selected = [code];
  else if (state.selected.includes(code)) state.selected = state.selected.filter(c => c !== code);
  else state.selected = [...state.selected, code];
  syncControls();
  if (!state.selected.length) { map.fitBounds(CONUS, fitPadding(4.5)); render(); } else render(true);
}
function resetView() {
  state.selected = []; state.nationwide = false;
  syncControls(); map.fitBounds(CONUS, fitPadding(4.5)); render();
}
function setNationwide(on) {
  state.nationwide = on;
  if (on && !levels[state.level].national) state.level = 'county';
  syncControls();
  map.fitBounds(CONUS, fitPadding(4.5));
  render(!on && state.selected.length > 0);
}
function setLevel(level) {
  state.level = level;
  if (state.nationwide && !levels[level].national) state.nationwide = false;
  syncControls();
  render();
}
// Each candidate list leaves out whoever is picked in the other one.
function syncCandidates() {
  for (const [id, other] of [['first', 'second'], ['second', 'first']])
    $(id).innerHTML = order.filter(c => c !== state[other]).map(c => `<option value="${c}"${c === state[id] ? ' selected' : ''}>${names[c]}</option>`).join('');
}
function syncControls() {
  $('view').value = state.nationwide ? 'nation' : 'states';
  $('level').value = state.level;
  $('nation').setAttribute('aria-pressed', String(state.nationwide));
  for (const option of $('level').options) option.disabled = state.nationwide && !levels[option.value].national;
}
function updateScope(loading) {
  const label = levels[state.level].label;
  if (loading) { $('scope').textContent = `Loading ${label}…`; return; }
  if (state.timeline) { $('scope').textContent = `States · ${state.timeMode === 'month' ? '' : 'through '}${monthLabel(timeMonth(), 'long')}`; return; }
  $('scope').textContent = state.nationwide ? `United States · ${label}` : state.selected.length
    ? `${state.selected.map(c => state.statesByCode[c]).join(' · ')} · ${label}` : `United States · click a state to open its ${label}`;
}

/* Legend */
function updateLegend() {
  const level = coloredLevel(), label = levels[level].label;
  const swatches = (colors) => colors.map(c => `<span style="background:${c}"></span>`).join('');
  const empty = `<span class="swatch" style="background:${EMPTY}"></span>`;
  const fadeRow = (color, what, format) => state.fade ? `<div class="fade-row"><span class="fade" style="background:linear-gradient(90deg,${faded(color, 0)},${color})"></span>` +
    `<div class="ticks ends"><span>${format(state.fade.lo)} or less</span><span>${format(state.fade.hi)}+ ${what}</span></div></div>` : '';
  let html;
  if (state.measure === 'lead') {
    html = `<div class="legend-title">Who led in itemized dollars</div><div class="steps">${swatches(leadClasses())}</div>` +
      `<div class="ticks8"><span>80%+</span><span>65</span><span>55</span><span>50</span><span>50</span><span>55</span><span>65</span><span>80%+</span></div>` +
      `<div class="ticks ends"><span>← ${names[state.second]} led</span><span>${names[state.first]} led →</span></div>` +
      fadeRow(hues[state.first], 'combined', short) + `<div class="legend-note">Paler = fewer dollars behind the lead</div><div class="legend-note">${empty}No receipts</div>`;
  } else {
    const capita = state.measure === 'capita', breaks = state.breaks, format = stats[capita ? 'capita' : 'total'].format;
    html = `<div class="legend-title">${capita ? 'Dollars per 100 residents' : 'Total raised'} · ${names[state.first]} + ${names[state.second]}</div>` +
      `<div class="steps">${swatches(ramp.slice(0, breaks.length + 1))}</div><div class="ticks">${breaks.map(b => `<span>${format(b)}</span>`).join('')}</div>` +
      `<div class="legend-note">Each color holds about a fifth of the ${label} shown</div>` +
      (capita ? fadeRow(ramp[3], 'residents', people) + '<div class="legend-note">Paler = fewer residents, a less stable rate</div>' : '') + `<div class="legend-note">${empty}No receipts</div>`;
  }
  if (filterOn()) html += `<div class="legend-note filter-note">Filter on: faint places are outside the range</div>`;
  if (level !== 'zcta' && level !== 'state') html += '<div class="legend-note">Area amounts are estimates apportioned from ZIPs</div>';
  $('legend').innerHTML = html;
}

/* Charts: hand-built SVG at the card's real pixel size, so text stays legible when a panel is resized. */
function series(codes) {
  const out = order.map(c => ({candidate: c, values: state.months.map(m =>
    codes.reduce((sum, code) => sum + (state.monthly.get(code + '|' + c + '|' + m)?.[0] || 0), 0))}));
  if (state.chartMode === 'cumulative') for (const s of out) { let run = 0; s.values = s.values.map(v => (run += v)); }
  return out;
}
function lineChart(lines, W, H, {marker = null, band = true} = {}) {
  const months = state.months, L0 = 38, R0 = 34, T0 = 12, B0 = 20, max = Math.max(1, ...lines.flatMap(s => s.values));
  const x = (i) => L0 + (W - L0 - R0) * (months.length > 1 ? i / (months.length - 1) : .5), y = (v) => T0 + (H - T0 - B0) * (1 - v / max);
  const index = (m) => months.findIndex(x => x >= m);
  let shade = '';
  if (band && state.span[1] - state.span[0] < phases.length && !state.timeline) {
    const start = phaseMonths[phases[state.span[0]]][0], end = phaseMonths[phases[state.span[1] - 1]][1], i0 = Math.max(0, index(start)), i1 = index(end) < 0 ? months.length - 1 : index(end);
    shade = `<rect x="${x(i0)}" y="${T0}" width="${Math.max(2, x(i1) - x(i0))}" height="${H - T0 - B0}" class="band"/>`;
  }
  // Primary label sits left of its line and Runoff right of its, so the adjacent months don't collide.
  const marks = [['2026-03', 'Primary', -3, 'end'], ['2026-05', 'Runoff', 3, 'start']].map(([m, label, dx, anchor]) => {
    const i = months.indexOf(m);
    return i < 0 ? '' : `<line x1="${x(i)}" x2="${x(i)}" y1="${T0}" y2="${H - B0}" class="event"/><text x="${x(i) + dx}" y="${T0 + 8}" text-anchor="${anchor}" class="event-label">${label}</text>`;
  }).join('');
  const paths = lines.map(s => `<polyline fill="none" stroke="${hues[s.candidate]}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" points="${s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>`).join('');
  const ticks = months.map((m, i) => m.endsWith('-01') ? `<text x="${x(i)}" y="${H - 5}" class="axis" text-anchor="middle">${m.slice(0, 4)}</text>` : '').join('');
  const step = (W - L0 - R0) / Math.max(1, months.length - 1);
  const hit = months.map((m, i) => `<rect x="${x(i) - step / 2}" y="${T0}" width="${step}" height="${H - T0 - B0}" class="hit" data-i="${i}"/>`).join('');
  const now = marker == null ? '' : `<line x1="${x(marker)}" x2="${x(marker)}" y1="${T0}" y2="${H - B0}" class="now"/>`;
  return `<svg class="chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Itemized receipts by month">
    <line x1="${L0}" x2="${W - R0}" y1="${H - B0}" y2="${H - B0}" class="base"/>
    <line x1="${L0}" x2="${W - R0}" y1="${T0}" y2="${T0}" class="grid"/><text x="${L0 - 4}" y="${T0 + 3}" class="axis" text-anchor="end">${short(max)}</text>
    <text x="${L0 - 4}" y="${H - B0 + 3}" class="axis" text-anchor="end">$0</text>${shade}${marks}${paths}${ticks}${now}
    <line class="cursor" y1="${T0}" y2="${H - B0}" visibility="hidden"/>${hit}</svg><div class="chart-tip" hidden></div>`;
}
function bindChart(node, lines, onPick) {
  const svg = node.querySelector('svg.chart');
  if (!svg) return;
  const tip = node.querySelector('.chart-tip'), cursor = svg.querySelector('.cursor');
  svg.addEventListener('pointermove', e => {
    const target = e.target.closest('.hit');
    if (!target) return;
    const i = Number(target.dataset.i), cx = Number(target.getAttribute('x')) + Number(target.getAttribute('width')) / 2;
    cursor.setAttribute('x1', cx); cursor.setAttribute('x2', cx); cursor.setAttribute('visibility', 'visible');
    tip.innerHTML = `<b>${monthLabel(state.months[i])}${state.chartMode === 'cumulative' && !onPick ? ' · to date' : ''}</b>` +
      lines.map(s => `<div><span class="dot" style="background:${hues[s.candidate]}"></span>${names[s.candidate]} ${money(s.values[i])}</div>`).join('');
    tip.hidden = false;
    const box = svg.getBoundingClientRect(), card = node.getBoundingClientRect();
    tip.style.top = (box.bottom - card.top + 2) + 'px';
    tip.style.left = Math.max(0, Math.min(card.width - tip.offsetWidth, box.left - card.left + cx - tip.offsetWidth / 2)) + 'px';
  });
  svg.addEventListener('pointerleave', () => { tip.hidden = true; cursor.setAttribute('visibility', 'hidden'); });
  if (onPick) svg.addEventListener('click', e => { const t = e.target.closest('.hit'); if (t) onPick(Number(t.dataset.i)); });
}

/* Totals panel: selected states (or the US), period totals, and monthly receipts */
function summary(codes, title, removable, code, W, H) {
  const rows = order.map(c => {
    const v = codes.reduce((sum, s) => sum.map((n, i) => n + values(state.totals, s + '|' + c)[i]), [0, 0, 0]);
    return `<tr><td><span class="dot" style="background:${hues[c]}"></span>${names[c]}</td><td>${money(v[0])}</td><td class="muted-cell">${v[2] ? 'avg ' + money(v[0] / v[2]) : ''}</td></tr>`;
  }).join('');
  const chart = state.monthly ? lineChart(series(codes), W, H) : '<p class="muted">Monthly totals appear after the next data refresh.</p>';
  return `<section class="card" data-code="${code}"><header><h2>${title}</h2>${removable ? `<button class="remove" data-remove="${code}" aria-label="Remove ${title}">×</button>` : ''}</header>
    <table class="totals"><tbody>${rows}</tbody></table>${chart}</section>`;
}
function updatePanel() {
  const side = $('side');
  if (side.hidden || !state.statesByCode) return;
  const all = Object.keys(state.statesByCode), period = periodLabel();
  $('side-title').textContent = `Itemized receipts · ${period}`;
  // Default width grows for 3+ states; once the user resizes the panel, its own size wins.
  side.classList.toggle('wide', !state.nationwide && state.selected.length >= 3 && window.innerWidth > 1100);
  const cards = state.nationwide || !state.selected.length ? [[all, 'United States', false, 'us']]
    : [...(state.selected.length > 1 ? [[state.selected, `All selected (${state.selected.length} states)`, false, 'all']] : []),
      ...state.selected.map(c => [[c], state.statesByCode[c], state.selected.length > 1, c])];
  const box = $('cards'), width = box.clientWidth || 300;
  const columns = Math.max(1, Math.floor((width + 16) / 266)), W = Math.floor((width - 16 * (columns - 1)) / columns);
  // A panel the user made taller shares the extra height among its charts.
  const rows = Math.ceil(cards.length / columns), tall = side.style.height ? (box.clientHeight - 30) / rows - 92 : 0;
  const H = Math.round(Math.max(110, Math.min(420, Math.max(W * .42, tall))));
  box.style.setProperty('--columns', columns);
  box.innerHTML = cards.map(([codes, title, removable, code]) => summary(codes, title, removable, code, W, H)).join('') +
    `<p class="hint">Click a state to open it. Shift-, Ctrl- or ⌘-click adds it. Double-click any area to return to the U.S. Drag panels by their title; resize from the corner.</p>`;
  box.querySelectorAll('.card').forEach((card, i) => bindChart(card, state.monthly ? series(cards[i][0]) : []));
  $('add-state').innerHTML = '<option value="">+ Add state…</option>' +
    (state.nationwide ? '' : '<option value="ALL">All states (nationwide)</option>') + Object.entries(state.statesByCode)
    .filter(([c]) => state.nationwide || !state.selected.includes(c)).sort((a, b) => a[1].localeCompare(b[1]))
    .map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
  document.querySelectorAll('#chart-mode button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === state.chartMode)));
}

/* Top places panel: choose the level and how to sort; hover highlights, click zooms. */
const rankMeasures = {
  total: {label: () => 'Total raised', value: stats.total.value, format: money},
  capita: {label: () => 'Per 100 residents', value: stats.capita.value, format: (v) => '$' + v.toFixed(2)},
  first: {label: () => `${names[state.first]}'s share`, value: stats.share.value, format: stats.share.format},
  second: {label: () => `${names[state.second]}'s share`, value: (a, b) => a[0] + b[0] > 0 ? b[0] / (a[0] + b[0]) : null, format: stats.share.format},
  avg: {label: () => 'Average contribution', value: stats.avg.value, format: money},
  count: {label: () => 'Contributions', value: stats.count.value, format: (v) => Math.round(v).toLocaleString()},
};
function updateRank() {
  if ($('rank').hidden || !state.statesByCode) return;
  for (const option of $('rank-by').options) option.textContent = rankMeasures[option.value].label();
  $('rank-by').value = state.rankBy;
  const rankLevel = state.rankStates ? 'state' : state.level;
  $('rank-level').value = rankLevel;
  document.querySelectorAll('#rank-order button').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.order === 'desc') === state.rankDesc)));
  const areasShown = rankLevel !== 'state' && state.layer && state.layer.getLayers().length && !state.timeline;
  if (rankLevel !== 'state' && !areasShown) {
    $('rank-title').textContent = `Top ${levels[rankLevel].label}`;
    $('rank-list').innerHTML = `<li class="muted">Open a state (or turn on Nationwide for counties, districts, or metro areas) to rank ${levels[rankLevel].label}.</li>`;
    $('rank-note').textContent = '';
    return;
  }
  const items = rankLevel === 'state' ? stateItems() : areaItems(), filtered = coloredLevel() === rankLevel;
  const measure = rankMeasures[state.rankBy], rows = [];
  for (const item of items) {
    if (item.amounts[0][0] + item.amounts[1][0] <= 0 || (filtered && !passes(item.amounts, item.pop))) continue;
    const value = measure.value(...item.amounts, item.pop);
    if (value != null) rows.push({...item, value, total: item.amounts[0][0] + item.amounts[1][0]});
  }
  // Ties (such as many places at 100% share) go to the place with more dollars.
  rows.sort((p, q) => (state.rankDesc ? q.value - p.value : p.value - q.value) || q.total - p.total);
  const top = rows.slice(0, 25), max = Math.max(...top.map(r => r.value), 1e-9);
  $('rank-title').textContent = `${state.rankDesc ? 'Top' : 'Bottom'} ${levels[rankLevel].label}`;
  $('rank-list').innerHTML = top.length ? top.map((r, i) => {
    const [a, b] = r.amounts;
    return `<li data-key="${r.key}" data-state="${r.isState ? 1 : ''}" tabindex="0"><span class="rank-n">${i + 1}</span><span class="rank-name">${r.name}</span><span class="rank-value">${measure.format(r.value)}</span>
      <span class="rank-bar" style="width:${Math.max(3, 100 * r.value / max)}%"><i style="flex:${a[0]};background:${hues[state.first]}"></i><i style="flex:${b[0]};background:${hues[state.second]}"></i></span></li>`;
  }).join('') : '<li class="muted">Nothing to rank here.</li>';
  $('rank-note').textContent = `${rows.length.toLocaleString()} ${levels[rankLevel].label} with receipts${filtered && filterOn() ? ' inside the filter' : ''} · bar length follows the ranking, split ${names[state.first]} / ${names[state.second]}. Use Filter to set minimums (for example, dollars behind a share).`;
}
function highlight(key, on) {
  const polygon = state.index.get(key);
  if (!polygon) return;
  if (on) { polygon.setStyle({weight: 2.4, color: '#10212b', opacity: 1}); polygon.bringToFront(); }
  else polygon.setStyle(areaStyle(state.layer.level, polygon.feature));
}

/* Filter panel: histogram and min/max range for a statistic of the places shown. */
const SLIDER = 1000;
function filterScope() { return coloredLevel() + '|' + (state.nationwide ? 'US' : state.selected.join(',')) + '|' + state.span.join('-') + '|' + state.first + '|' + state.second; }
function filterExtent(list, stat) {
  const vals = list.filter(v => v != null && (!stat.log || v > 0));
  if (!vals.length) return null;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (!stat.log) { lo = 0; hi = 1; }
  if (hi <= lo) hi = lo * 1.01 + 1e-9;
  const toPos = (v) => Math.round(SLIDER * (stat.log ? (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) : (v - lo) / (hi - lo)));
  const toVal = (p) => stat.log ? Math.exp(Math.log(lo) + p / SLIDER * (Math.log(hi) - Math.log(lo))) : lo + p / SLIDER * (hi - lo);
  return {vals, lo, hi, toPos, toVal};
}
function updateFilter() {
  if (!filterOn() || !state.statesByCode) return;
  const f = state.filter, scope = filterScope();
  if (f.scope !== scope) { f.scope = scope; f.ranges = {}; }
  document.querySelectorAll('#filter-stat button').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.stat === f.stat));
    b.textContent = stats[b.dataset.stat].label() + (f.ranges[b.dataset.stat] ? ' •' : '');
  });
  const stat = stats[f.stat], items = coloredItems().filter(i => i.amounts[0][0] + i.amounts[1][0] > 0);
  const extent = filterExtent(items.map(i => stat.value(...i.amounts, i.pop)), stat);
  const box = $('filter-hist'), W = Math.max(240, box.clientWidth || 300), H = 84;
  if (!extent) { box.innerHTML = '<p class="muted">No values to filter here.</p>'; return; }
  const range = f.ranges[f.stat] || [null, null];
  const p0 = range[0] == null ? 0 : Math.max(0, extent.toPos(range[0])), p1 = range[1] == null ? SLIDER : Math.min(SLIDER, extent.toPos(range[1]));
  const bins = new Array(36).fill(0);
  for (const v of extent.vals) bins[Math.min(bins.length - 1, Math.floor(extent.toPos(v) / SLIDER * bins.length))]++;
  const top = Math.max(...bins), bw = W / bins.length;
  box.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="hist" role="img" aria-label="Distribution of ${stat.label()}">` + bins.map((n, i) => {
    const mid = (i + .5) / bins.length * SLIDER, h = n ? Math.max(2, (H - 4) * Math.sqrt(n / top)) : 0;
    return `<rect x="${(i * bw + 1).toFixed(1)}" y="${H - h}" width="${(bw - 2).toFixed(1)}" height="${h}" rx="1.5" class="${mid >= p0 && mid <= p1 ? 'in' : 'out'}"><title>${n.toLocaleString()} ${coloredLevel() === 'state' ? 'states' : levels[coloredLevel()].label}</title></rect>`;
  }).join('') + '</svg>';
  $('filter-lo').value = p0; $('filter-hi').value = p1;
  $('filter-min').textContent = stat.format(range[0] ?? extent.lo);
  $('filter-max').textContent = stat.format(range[1] ?? extent.hi);
  const inside = items.filter(i => passes(i.amounts, i.pop)).length;
  $('filter-count').textContent = `${inside.toLocaleString()} of ${items.length.toLocaleString()} ${levels[coloredLevel()].label} included`;
  $('filter-all').checked = f.all;
}
let filterFrame = 0;
function filterInput(which) {
  const f = state.filter, stat = stats[f.stat];
  const items = coloredItems().filter(i => i.amounts[0][0] + i.amounts[1][0] > 0);
  const extent = filterExtent(items.map(i => stat.value(...i.amounts, i.pop)), stat);
  if (!extent) return;
  let p0 = Number($('filter-lo').value), p1 = Number($('filter-hi').value);
  if (p0 > p1) { if (which === 'lo') p0 = p1; else p1 = p0; $('filter-lo').value = p0; $('filter-hi').value = p1; }
  const range = [p0 <= 0 ? null : extent.toVal(p0), p1 >= SLIDER ? null : extent.toVal(p1)];
  f.ranges[f.stat] = range[0] == null && range[1] == null ? undefined : range;
  if (!f.ranges[f.stat]) delete f.ranges[f.stat];
  cancelAnimationFrame(filterFrame);
  filterFrame = requestAnimationFrame(refresh);
}

/* Donors panel: where each candidate's itemized money comes from. */
function updateDonors() {
  if ($('donors').hidden || !state.statesByCode) return;
  const codes = [...new Set([...state.totals.keys()].map(k => k.split('|')[0]))];
  $('donors-period').textContent = periodLabel();
  $('donors-body').innerHTML = order.map(c => {
    const byState = codes.map(code => [code, values(state.totals, code + '|' + c)]).filter(([, v]) => v[0] > 0);
    const total = byState.reduce((s, [, v]) => s + v[0], 0), count = byState.reduce((s, [, v]) => s + v[2], 0);
    if (!total) return `<section class="card"><h2><span class="dot" style="background:${hues[c]}"></span>${names[c]}</h2><p class="muted">No itemized receipts in this period.</p></section>`;
    const tx = byState.find(([code]) => code === 'TX')?.[1][0] || 0, top = byState.sort((p, q) => q[1][0] - p[1][0]).slice(0, 6);
    return `<section class="card"><header><h2><span class="dot" style="background:${hues[c]}"></span>${names[c]}</h2><span class="muted-cell">${money(total)}</span></header>
      <div class="stat-row"><div><b>${Math.round(100 * tx / total)}%</b><span>from Texas</span></div><div><b>${money(total / count)}</b><span>avg contribution</span></div><div><b>${byState.length}</b><span>states &amp; areas</span></div></div>
      <div class="split" title="Texas vs. out of state"><i style="flex:${tx};background:${hues[c]}"></i><i style="flex:${total - tx};background:${hexBlend(hues[c], '#ffffff', .6)}"></i></div>
      <ol class="bars">${top.map(([code, v]) => `<li data-code="${code}" class="${state.statesByCode[code] ? 'pick' : ''}"><span>${state.statesByCode[code] || code}</span>
        <span class="bar"><i style="width:${100 * v[0] / top[0][1][0]}%;background:${code === 'TX' ? hues[c] : hexBlend(hues[c], '#ffffff', .35)}"></i></span><span>${Math.round(100 * v[0] / total)}%</span></li>`).join('')}</ol></section>`;
  }).join('') + '<p class="hint">Share of each candidate\'s itemized individual dollars by contributor\'s reported state. Click a state to open it.</p>';
}

/* Timeline panel: scrub or play through months; the map switches to states colored for that month. */
function updateTimeline() {
  if ($('timeline').hidden || !state.monthly) return;
  const m = timeMonth(), all = Object.keys(state.statesByCode);
  $('time-slider').max = state.months.length - 1;
  $('time-slider').value = state.timeIndex;
  $('time-label').textContent = (state.timeMode === 'month' ? '' : 'Through ') + monthLabel(m, 'long');
  document.querySelectorAll('#time-mode button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === state.timeMode)));
  const saved = state.chartMode;
  state.chartMode = state.timeMode === 'month' ? 'monthly' : 'cumulative';
  const lines = series(all);
  state.chartMode = saved;
  const box = $('time-chart'), W = Math.max(240, box.clientWidth || 300);
  box.innerHTML = lineChart(lines, W, Math.round(Math.max(110, Math.min(260, W * .38))), {marker: state.timeIndex, band: false});
  bindChart(box, lines, (i) => { play(false); state.timeIndex = i; timelineChanged(); });
  const at = order.map(c => [c, all.reduce((s, code) => s + stateValues(code, c)[0], 0)]), max = Math.max(1, ...at.map(([, v]) => v));
  $('time-board').innerHTML = at.sort((p, q) => q[1] - p[1]).map(([c, v]) => `<li><span><span class="dot" style="background:${hues[c]}"></span>${names[c]}</span>
    <span class="bar"><i style="width:${100 * v / max}%;background:${hues[c]}"></i></span><span>${short(v)}</span></li>`).join('');
}
function timelineChanged() { refresh(); updateScope(); }
let playing = null;
function play(on) {
  clearInterval(playing); playing = null;
  $('time-play').textContent = on ? '❚❚' : '▶';
  $('time-play').setAttribute('aria-label', on ? 'Pause' : 'Play');
  if (!on) return;
  if (state.timeIndex >= state.months.length - 1) state.timeIndex = 0;
  timelineChanged();
  playing = setInterval(() => {
    if (state.timeIndex >= state.months.length - 1) return play(false);
    state.timeIndex += 1; timelineChanged();
  }, 850);
}
function setTimeline(on) {
  state.timeline = on && !!state.monthly;
  if (!on) play(false);
  if (state.layer) state.timeline ? map.removeLayer(state.layer) : state.layer.addTo(map);
  refresh(); updateScope();
}

/* Floating panels: drag by the title bar, resize from the corner. Positions reset on reload. */
function floating(panel) {
  const head = panel.querySelector('.float-head');
  head.addEventListener('pointerdown', e => {
    if (window.innerWidth <= 850 || e.target.closest('button, select, input')) return;
    const box = panel.getBoundingClientRect(), dx = e.clientX - box.left, dy = e.clientY - box.top;
    front(panel);
    Object.assign(panel.style, {left: box.left + 'px', top: box.top + 'px', right: 'auto', bottom: 'auto', transform: 'none'});
    panel.classList.add('dragging');
    head.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const w = panel.offsetWidth;
      panel.style.left = Math.max(-w + 80, Math.min(window.innerWidth - 80, ev.clientX - dx)) + 'px';
      panel.style.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy)) + 'px';
    };
    const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); panel.classList.remove('dragging'); };
    head.addEventListener('pointermove', move); head.addEventListener('pointerup', up);
  });
  panel.addEventListener('pointerdown', () => front(panel));
  let last = '';
  new ResizeObserver(() => {
    const size = panel.offsetWidth + 'x' + (panel.style.height || '');
    if (size === last) return;
    last = size;
    redraw(panel.id);
  }).observe(panel);
}
/* A newly opened panel never covers another box: keep its default spot if that is free, otherwise take
   the free spot nearest the top right, shrinking it (height first, then width) until one exists. */
function placeFree(panel) {
  if (window.innerWidth <= 850) return;
  const gap = 10, W = window.innerWidth, H = window.innerHeight;
  const others = [...document.querySelectorAll('.panel')].filter(el => el !== panel && !el.hidden && el.offsetParent)
    .map(el => el.getBoundingClientRect()).filter(r => r.width && r.height);
  const hits = (x, y, w, h) => others.some(r => x < r.right + gap && x + w > r.left - gap && y < r.bottom + gap && y + h > r.top - gap);
  const box = panel.getBoundingClientRect();
  if (!hits(box.left, box.top, box.width, box.height)) return;
  const sizes = [];
  for (let h = box.height; h >= 180; h -= 40) sizes.push([box.width, h]);
  for (let w = box.width - 40; w >= 250; w -= 40) sizes.push([w, 180]);
  for (const [w, h] of sizes) {
    for (let x = W - w - 17; x >= 12; x -= 12) {
      for (let y = 80; y + h <= H - 30; y += 12) {
        if (hits(x, y, w, h)) continue;
        Object.assign(panel.style, {left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px', right: 'auto', bottom: 'auto', transform: 'none'});
        return;
      }
    }
  }
}
let z = 1010;
const front = (panel) => { panel.style.zIndex = ++z; };
const PANELS = ['side', 'rank', 'donors', 'timeline', 'filter'];
const redraw = (id) => ({side: updatePanel, rank: updateRank, donors: updateDonors, timeline: updateTimeline, filter: updateFilter})[id]?.();
function openPanel(id, open) {
  const panel = $(id);
  if (open && window.innerWidth <= 850) for (const other of PANELS) if (other !== id && !$(other).hidden) openPanel(other, false);
  panel.hidden = !open;
  document.querySelector(`[data-panel="${id}"]`)?.setAttribute('aria-pressed', String(open));
  if (id === 'timeline') setTimeline(open);
  if (id === 'filter') loadLevel(state.level).then(refresh, showError);
  if (open) {
    front(panel);
    if (id === 'rank') loadLevel(state.level).then(updateRank, showError);
    redraw(id);
    placeFree(panel);
    redraw(id);
  }
}

function refresh() {
  if (!state.states) return;
  computeScales();
  state.states.setStyle(stateStyle);
  if (state.layer) state.layer.setStyle(feature => areaStyle(state.layer.level, feature));
  document.querySelectorAll('.candidate-dot').forEach(dot => { dot.style.background = hues[state[dot.dataset.slot]]; });
  updateLegend(); updatePanel(); updateRank(); updateDonors(); updateTimeline(); updateFilter();
}
async function start() {
  const [boundaries, receipts, totals, coverage] = await Promise.all([
    json('data/states.json?v=2'), file('data/receipts.csv'), file('data/state_totals.csv'), json('data/coverage.json')]);
  addRows(csv(receipts), state.receipts, row => row.state + '|' + row.zip + '|' + row.candidate);
  addRows(csv(totals), state.totals, row => row.state + '|' + row.candidate);
  state.coverage = coverage;
  state.statesByCode = Object.fromEntries(boundaries.features.map(f => [f.properties.code, f.properties.name]));
  file('data/state_monthly.csv').then(text => {
    const rows = csv(text);
    state.monthly = new Map(rows.map(r => [r.state + '|' + r.candidate + '|' + r.month, [Number(r.positive_cents) / 100, Number(r.net_cents) / 100, Number(r.count)]]));
    state.months = [...new Set(rows.map(r => r.month))].sort();
    state.timeIndex = state.months.length - 1;
    $('launch-timeline').disabled = false;
    updatePanel();
  }).catch(() => {});
  state.states = L.geoJSON(boundaries, {
    pane: 'statePane', style: stateStyle,
    onEachFeature: (feature, layer) => {
      const code = feature.properties.code;
      layer.bindTooltip(() => stateTooltip(code), {sticky: true, direction: 'top'});
      layer.on('click', e => { L.DomEvent.stopPropagation(e); if (state.timeline) openPanel('timeline', false); chooseState(code, modifier(e)); });
      layer.on('mouseover', () => layer.setStyle({weight: 2.4, color: '#10212b'}));
      layer.on('mouseout', () => layer.setStyle(stateStyle(feature)));
    }
  }).addTo(map);
  $('coverage').textContent = `FEC through ${coverage.coverage_end} · ${coverage.filing_count} filings`;
  if (window.innerWidth <= 850) { $('side').classList.add('collapsed'); $('side-toggle').setAttribute('aria-expanded', 'false'); }
  for (const id of PANELS) floating($(id));
  syncCandidates();
  syncControls();
  await render();
}

function periodInput(which) {
  let a = Number($('period-lo').value), b = Number($('period-hi').value);
  // Handles can't cross or meet: at least one phase stays selected.
  if (b <= a) { if (which === 'lo') a = b - 1; else b = a + 1; }
  $('period-lo').value = a; $('period-hi').value = b;
  state.span = [a, b];
  $('period-value').textContent = periodLabel();
  $('period-fill').style.left = (100 * a / phases.length) + '%';
  $('period-fill').style.right = (100 * (phases.length - b) / phases.length) + '%';
  refresh();
}
$('period-lo').addEventListener('input', () => periodInput('lo'));
$('period-hi').addEventListener('input', () => periodInput('hi'));
$('measure').addEventListener('change', async e => {
  state.measure = e.target.value;
  try { await loadLevel(state.level); } catch (error) { showError(error); }
  refresh();
});
$('level').addEventListener('change', e => setLevel(e.target.value));
$('view').addEventListener('change', e => setNationwide(e.target.value === 'nation'));
for (const id of ['first', 'second']) $(id).addEventListener('change', e => { state[id] = e.target.value; syncCandidates(); refresh(); });
$('add-state').addEventListener('change', e => {
  const value = e.target.value;
  if (value === 'ALL') setNationwide(true); else if (value) chooseState(value, !state.nationwide && state.selected.length > 0);
});
$('cards').addEventListener('click', e => { const code = e.target.dataset?.remove; if (code) chooseState(code, true); });
$('side-toggle').addEventListener('click', () => {
  const open = $('side').classList.toggle('collapsed') === false;
  $('side-toggle').setAttribute('aria-expanded', String(open));
  if (open) updatePanel();
});
$('chart-mode').addEventListener('click', e => { const mode = e.target.dataset?.mode; if (mode) { state.chartMode = mode; updatePanel(); } });
document.querySelectorAll('[data-panel]').forEach(button => button.addEventListener('click', () => openPanel(button.dataset.panel, $(button.dataset.panel).hidden)));
document.querySelectorAll('.float-close').forEach(button => button.addEventListener('click', () => openPanel(button.closest('.float').id, false)));
$('rank-by').addEventListener('change', async e => {
  state.rankBy = e.target.value;
  try { await loadLevel(state.level); } catch (error) { showError(error); }
  updateRank();
});
$('rank-level').addEventListener('change', e => {
  const level = e.target.value;
  state.rankStates = level === 'state';
  if (state.rankStates) return updateRank();
  // Ranking counties, districts or metro areas with nothing open shows them nationwide.
  if (!state.selected.length && !state.nationwide && levels[level].national) { state.level = level; setNationwide(true); }
  else setLevel(level);
});
$('rank-order').addEventListener('click', e => { const order = e.target.dataset?.order; if (order) { state.rankDesc = order === 'desc'; updateRank(); } });
const rankItem = (e) => e.target.closest('li[data-key]');
$('rank-list').addEventListener('pointerover', e => { const li = rankItem(e); if (li && !li.dataset.state) highlight(li.dataset.key, true); });
$('rank-list').addEventListener('pointerout', e => { const li = rankItem(e); if (li && !li.dataset.state) highlight(li.dataset.key, false); });
$('rank-list').addEventListener('click', e => {
  const li = rankItem(e);
  if (!li) return;
  if (li.dataset.state) return chooseState(li.dataset.key, modifier(e));
  const polygon = state.index.get(li.dataset.key);
  if (polygon) { map.fitBounds(polygon.getBounds(), fitPadding(10)); polygon.openTooltip(polygon.getBounds().getCenter()); }
});
$('filter-stat').addEventListener('click', e => { const stat = e.target.dataset?.stat; if (stat) { state.filter.stat = stat; refresh(); } });
$('filter-lo').addEventListener('input', () => filterInput('lo'));
$('filter-hi').addEventListener('input', () => filterInput('hi'));
$('filter-all').addEventListener('change', e => { state.filter.all = e.target.checked; refresh(); });
$('filter-reset').addEventListener('click', () => { state.filter.ranges = {}; refresh(); });
$('donors-body').addEventListener('click', e => { const li = e.target.closest('li.pick'); if (li) chooseState(li.dataset.code, modifier(e)); });
$('time-slider').addEventListener('input', e => { play(false); state.timeIndex = Number(e.target.value); timelineChanged(); });
$('time-play').addEventListener('click', () => play(!playing));
$('time-mode').addEventListener('click', e => { const mode = e.target.dataset?.mode; if (mode) { state.timeMode = mode; timelineChanged(); } });
$('home').addEventListener('click', resetView);
$('nation').addEventListener('click', () => setNationwide(!state.nationwide));
$('zoom-in').addEventListener('click', () => map.zoomIn());
$('zoom-out').addEventListener('click', () => map.zoomOut());
$('tiles').addEventListener('click', () => {
  const active = map.hasLayer(tiles);
  active ? map.removeLayer(tiles) : tiles.addTo(map);
  $('tiles').setAttribute('aria-pressed', String(!active));
});
function about(open) { $('about').hidden = !open; $('about-toggle').setAttribute('aria-expanded', String(open)); }
$('about-toggle').addEventListener('click', () => about($('about').hidden));
$('about-close').addEventListener('click', () => about(false));
document.addEventListener('keydown', e => {if (e.key === 'Escape') about(false);});
start().catch(showError);
