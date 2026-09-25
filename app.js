/* Static FEC map. Geometry is fetched only as the user selects states or turns on the nationwide view. */
const $ = (id) => document.getElementById(id);
const names = {C00919084: 'Talarico', C00369033: 'Cornyn', C00901918: 'Paxton'};
// Each candidate keeps one color everywhere (map, legend, chart); checked for color-vision separation.
const hues = {C00919084: '#246a93', C00369033: '#b07d12', C00901918: '#ac3546'};
const order = ['C00919084', 'C00369033', 'C00901918'];
const phases = ['pre_primary', 'between_primary_runoff', 'post_runoff'];
const phaseMonths = {pre_primary: ['2025-01', '2026-03'], between_primary_runoff: ['2026-03', '2026-05'], post_runoff: ['2026-05', '9999-12']};
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
const short = (n) => n >= 1e6 ? '$' + +(n / 1e6).toFixed(1) + 'm' : n >= 1e3 ? '$' + +(n / 1e3).toFixed(1) + 'k' : '$' + Math.round(n);
const NEUTRAL = '#d4cfca', EMPTY = '#e4e8e8';
// floor: combined dollars below which "who led" is not called; breaks: "total raised" class edges.
const levels = {
  zcta: {label: 'ZCTAs', noun: 'ZCTA', floor: 250, breaks: [500, 2500, 1e4, 5e4], minPop: 1000},
  county: {label: 'counties', noun: 'county', floor: 1000, breaks: [1e3, 1e4, 1e5, 1e6], national: true, minPop: 1000},
  cd: {label: 'congressional districts', noun: 'district', floor: 5000, breaks: [2.5e4, 1e5, 2.5e5, 1e6], national: true, minPop: 1000},
  cbsa: {label: 'metro/micro areas', noun: 'metro area', floor: 1000, breaks: [1e3, 1e4, 1e5, 1e6], national: true, minPop: 1000},
  cousub: {label: 'county subdivisions', noun: 'county subdivision', floor: 250, breaks: [500, 2500, 1e4, 5e4], minPop: 1000},
  state: {label: 'states', noun: 'state', floor: 1e4, breaks: [5e4, 2.5e5, 1e6, 5e6], minPop: 0},
};
const perCapitaBreaks = [1, 5, 20, 100]; // dollars per 100 residents
const ramp = ['#ede6dc', '#c9c1a8', '#8fa39a', '#4f7b8a', '#1d4c68'];
const state = {period: 'all', first: 'C00919084', second: 'C00901918', measure: 'lead', level: 'zcta',
  selected: ['TX'], nationwide: false, receipts: new Map(), totals: new Map(), areas: {}, unallocated: new Map(),
  population: {}, monthly: null, geo: new Map(), layer: null, render: 0, states: null, coverage: null};
const map = L.map('map', {zoomControl: false, doubleClickZoom: false, minZoom: 3, maxZoom: 12, preferCanvas: false,
  worldCopyJump: false, zoomSnap: .25, maxBounds: [[-10, -185], [73, -40]], maxBoundsViscosity: .6});
map.createPane('statePane'); map.getPane('statePane').style.zIndex = 410;
map.createPane('zctaPane'); map.getPane('zctaPane').style.zIndex = 420;
map.setView([31, -99], 5);
const tiles = L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 12, opacity: .5, attribution: 'Basemap: <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map" target="_blank" rel="noopener">USGS The National Map</a>'
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
  return state.period === 'all' ? phases.reduce((sum, phase) => sum.map((n, i) => n + item[phase][i]), [0, 0, 0]) : item[state.period];
}
const comparison = (store, key) => [values(store, key + '|' + state.first), values(store, key + '|' + state.second)];
function hexBlend(a, b, ratio) {
  const toRGB = x => [1, 3, 5].map(i => parseInt(x.slice(i, i + 2), 16));
  const x = toRGB(a), y = toRGB(b), t = Math.max(0, Math.min(1, ratio));
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
const bin = (value, breaks) => breaks.filter(b => value >= b).length;

/* Shading. "Who led" is five steps of the first candidate's share of the pair's dollars;
   areas under the level's dollar floor keep their color but are hatched as too little to call. "Total raised" and
   "Per 100 residents" are five-step single-hue classes. */
function leadClasses() {
  const a = hues[state.first], b = hues[state.second];
  return [b, hexBlend(b, NEUTRAL, .55), NEUTRAL, hexBlend(a, NEUTRAL, .55), a];
}
function classify(amounts, level, population) {
  const a = amounts[0][0], b = amounts[1][0], total = a + b, spec = levels[level];
  if (total <= 0) return {fill: EMPTY, kind: 'empty'};
  if (state.measure === 'volume') return {fill: ramp[bin(total, spec.breaks)], kind: 'value'};
  if (state.measure === 'capita') {
    if (!population) return {fill: hatched('#d9d5cf'), kind: 'thin'};
    const color = ramp[bin(100 * total / population, perCapitaBreaks)];
    return population < spec.minPop ? {fill: hatched(color), kind: 'thin'} : {fill: color, kind: 'value'};
  }
  const color = leadClasses()[bin(a / total, [.2, .4, .6, .8])];
  return total < spec.floor ? {fill: hatched(color), kind: 'thin'} : {fill: color, kind: 'value'};
}
// One SVG pattern per base color: the class color with pale diagonal stripes over it.
function hatched(color) {
  const id = 'hatch-' + color.slice(1);
  if (!document.getElementById(id)) {
    const pattern = document.createElementNS('http://www.w3.org/2000/svg', 'pattern');
    pattern.id = id;
    for (const [k, v] of Object.entries({width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)'})) pattern.setAttribute(k, v);
    pattern.innerHTML = `<rect width="6" height="6" fill="${color}"/><line x1="1.5" y1="0" x2="1.5" y2="6" stroke="#fbfaf8" stroke-width="2.2" stroke-opacity=".85"/>`;
    $('patterns').appendChild(pattern);
  }
  return `url(#${id})`;
}
function paint(amounts, level, population) {
  const {fill, kind} = classify(amounts, level, population);
  return {fillColor: fill, fillOpacity: kind === 'empty' ? .35 : .86};
}
const population = (level, id) => state.population[level]?.get(id);
function stateStyle(feature) {
  const code = feature.properties.code, chosen = !state.nationwide && state.selected.includes(code);
  const base = {pane: 'statePane', color: chosen ? '#1d3440' : '#647783', weight: chosen ? 2.2 : .8, opacity: .85};
  if (state.nationwide || chosen) return {...base, fillOpacity: 0};
  return {...base, ...paint(comparison(state.totals, code), 'state', population('state', code)), fillOpacity: .6};
}
function areaKey(level, feature) {
  const p = feature.properties;
  return level === 'zcta' ? {store: state.receipts, key: p._state + '|' + p.zip, pop: p.zip} : {store: state.areas[level], key: p.geoid, pop: p.geoid};
}
function areaStyle(level, feature) {
  const {store, key, pop} = areaKey(level, feature);
  return {pane: 'zctaPane', color: '#5f747c', weight: level === 'zcta' || level === 'cousub' ? .4 : .7, opacity: .45,
    ...paint(comparison(store, key), level, population(level, pop))};
}
function tooltip(level, id, title, amounts, pop, extra = '') {
  const [a, b] = amounts, total = a[0] + b[0], estimated = level !== 'zcta' && level !== 'state';
  const {kind} = classify(amounts, level, pop);
  const lines = [`<div class="tooltip-title">${title}</div>`];
  if (!total) lines.push('<div class="tooltip-sub">No itemized receipts from here for either candidate</div>');
  else {
    const pct = (n) => Math.round(100 * n / total) + '%';
    lines.push(`<div><span class="dot" style="background:${hues[state.first]}"></span>${names[state.first]} ${money(a[0])} (${pct(a[0])})</div>`,
      `<div><span class="dot" style="background:${hues[state.second]}"></span>${names[state.second]} ${money(b[0])} (${pct(b[0])})</div>`);
    const count = a[2] + b[2];
    lines.push(`<div class="tooltip-sub">${estimated ? '≈' + count.toLocaleString('en-US', {maximumFractionDigits: 1}) + ' contributions (estimated)' : count.toLocaleString() + ' itemized contributions'}</div>`);
    if (pop) lines.push(`<div class="tooltip-sub">${money(100 * total / pop)} per 100 residents · pop. ${pop.toLocaleString()}</div>`);
    if (kind === 'thin') lines.push(`<div class="tooltip-sub">${state.measure === 'capita' ? 'Too few residents for a stable rate' : `Under ${money(levels[level].floor)} combined: too little to call`}</div>`);
  }
  return lines.join('') + extra;
}
function stateTooltip(code) {
  let note = '';
  if (state.level !== 'zcta') {
    const [x, y] = comparison(state.unallocated, state.level + '|' + code);
    if (x[0] + y[0] >= .5) note = `<div class="tooltip-sub">${money(x[0] + y[0])} from ZIPs with no mappable ${levels[state.level].noun}</div>`;
  }
  return tooltip('state', code, state.statesByCode[code], comparison(state.totals, code), population('state', code), note);
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
  if (levels[level].national) {
    const all = (await cached(level, () => packed(`data/levels/geo/${level}.bin?v=1`))).features;
    return state.nationwide ? all : all.filter(f => f.properties.states.some(s => state.selected.includes(s)));
  }
  const dir = level === 'zcta' ? 'data/zctas' : 'data/levels/geo/cousub', v = level === 'zcta' ? 3 : 1;
  const files = await Promise.all(state.selected.map(code =>
    cached(level + '|' + code, () => packed(`${dir}/${encodeURIComponent(code)}.bin?v=${v}`)).then(geo => tag(geo.features, code))));
  return files.flat();
}
async function loadLevel(level) {
  const jobs = [];
  if (level !== 'zcta' && !state.areas[level]) jobs.push(file(`data/levels/${level}.csv`).then(text => {
    const areas = new Map();
    addRows(csv(text), areas, row => row.geoid + '|' + row.candidate);
    state.areas[level] = areas;
  }));
  if (level !== 'zcta' && !state.unallocated.size) jobs.push(file('data/levels/unallocated.csv').then(text =>
    addRows(csv(text), state.unallocated, row => row.level + '|' + row.state + '|' + row.candidate)));
  if (state.measure === 'capita') for (const name of [level, 'state']) if (!state.population[name]) jobs.push(
    file(`data/population/${name}.csv`).then(text => { state.population[name] = new Map(csv(text).map(r => [r.geoid, Number(r.population)])); }));
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
    state.layer = L.geoJSON({type: 'FeatureCollection', features: list}, {
      pane: 'zctaPane', smoothFactor: .5, style: feature => areaStyle(level, feature),
      onEachFeature: (feature, polygon) => {
        const p = feature.properties;
        polygon.bindTooltip(() => {
          const {store, key, pop} = areaKey(level, feature);
          const title = level === 'zcta' ? `ZCTA ${p.zip} · ${p._state}` : p.name;
          return tooltip(level, key, title, comparison(store, key), population(level, pop));
        }, {sticky: true, direction: 'top'});
        polygon.on('click', e => {
          L.DomEvent.stopPropagation(e);
          const home = p._state || p.states[0], add = modifier(e);
          if (state.nationwide || add) chooseState(home, add);
          else map.fitBounds(polygon.getBounds(), {padding: [55, 55], maxZoom: 10});
        });
        polygon.on('mouseover', () => polygon.setStyle({weight: 1.6, color: '#1d3440', opacity: .95}));
        polygon.on('mouseout', () => polygon.setStyle(areaStyle(level, feature)));
      }
    }).addTo(map);
    state.layer.level = level;
    $('error').hidden = true;
    if (fit && list.length) map.fitBounds(state.layer.getBounds(), {paddingTopLeft: [40, 90], paddingBottomRight: [panelWidth() + 30, 50], maxZoom: 8});
  } catch (error) { showError(error); }
  if (token === state.render) { updateScope(); refresh(); }
}
const panelWidth = () => window.innerWidth > 850 ? $('side').offsetWidth : 0;
const modifier = (e) => { const o = e.originalEvent || e; return o.shiftKey || o.ctrlKey || o.metaKey; };
function chooseState(code, add) {
  if (!state.statesByCode[code]) return;
  state.nationwide = false;
  if (!add) state.selected = [code];
  else if (state.selected.includes(code)) { if (state.selected.length > 1) state.selected = state.selected.filter(c => c !== code); }
  else state.selected = [...state.selected, code];
  syncControls();
  render(true);
}
function setNationwide(on) {
  state.nationwide = on;
  if (on && !levels[state.level].national) state.level = 'county';
  syncControls();
  if (on) map.fitBounds([[24, -125], [50, -66]], {paddingTopLeft: [20, 60], paddingBottomRight: [panelWidth(), 20], maxZoom: 4.5});
  render(!on);
}
function syncControls() {
  $('view').value = state.nationwide ? 'nation' : 'states';
  $('level').value = state.level;
  $('nation').setAttribute('aria-pressed', String(state.nationwide));
  for (const option of $('level').options) option.disabled = state.nationwide && !levels[option.value].national;
}
function updateScope(loading) {
  const label = levels[state.level].label;
  const where = state.nationwide ? 'United States' : state.selected.map(c => state.statesByCode[c]).join(' · ');
  $('scope').textContent = loading ? `Loading ${label}…` : `${where} · ${label}`;
}

/* Legend */
function updateLegend() {
  const spec = levels[state.level], swatches = (colors) => colors.map(c => `<span style="background:${c}"></span>`).join('');
  const stripe = (color) => `<span class="swatch hatch" style="background-color:${color}"></span>`;
  const hatch = state.measure === 'lead' ? stripe(hues[state.first]) + stripe(hues[state.second]) : stripe(ramp[2]), empty = `<span class="swatch" style="background:${EMPTY}"></span>`;
  let html;
  if (state.measure === 'lead') {
    html = `<div class="legend-title">Who led in itemized dollars</div><div class="steps">${swatches(leadClasses())}</div>` +
      `<div class="ticks"><span>${names[state.second]} 80%+</span><span>Even</span><span>${names[state.first]} 80%+</span></div>` +
      `<div class="legend-note">${hatch}Under ${short(spec.floor)} combined · too little to call ${empty}None</div>`;
  } else {
    const capita = state.measure === 'capita', breaks = capita ? perCapitaBreaks : spec.breaks;
    html = `<div class="legend-title">${capita ? 'Dollars per 100 residents' : 'Total raised'} · ${names[state.first]} + ${names[state.second]}</div>` +
      `<div class="steps">${swatches(ramp)}</div><div class="ticks">${breaks.map(b => `<span>${short(b)}</span>`).join('')}</div>` +
      `<div class="legend-note">${capita ? `${hatch}Under ${spec.minPop.toLocaleString()} residents · unstable rate ` : ''}${empty}None</div>`;
  }
  if (state.level !== 'zcta') html += '<div class="legend-note">Area amounts are estimates apportioned from ZIPs</div>';
  $('legend').innerHTML = html;
}

/* Side panel: selected states, period totals, and monthly receipts */
function monthlySeries(codes) {
  const months = [...new Set([...state.monthly.keys()].map(k => k.split('|')[2]))].sort();
  return {months, series: order.map(c => ({candidate: c, values: months.map(m =>
    codes.reduce((sum, code) => sum + (state.monthly.get(code + '|' + c + '|' + m) || 0), 0))}))};
}
function chart(codes) {
  if (!state.monthly) return '<p class="muted">Monthly totals appear after the next data refresh.</p>';
  const {months, series} = monthlySeries(codes);
  const W = 300, H = 128, L0 = 34, R0 = 30, T0 = 10, B0 = 20, max = Math.max(1, ...series.flatMap(s => s.values));
  const x = (i) => L0 + (W - L0 - R0) * (months.length > 1 ? i / (months.length - 1) : .5), y = (v) => T0 + (H - T0 - B0) * (1 - v / max);
  const [start, end] = state.period === 'all' ? [null, null] : phaseMonths[state.period];
  const index = (m) => months.findIndex(x => x >= m);
  let band = '';
  if (start) {
    const i0 = Math.max(0, index(start)), i1 = index(end) < 0 ? months.length - 1 : index(end);
    band = `<rect x="${x(i0)}" y="${T0}" width="${Math.max(2, x(i1) - x(i0))}" height="${H - T0 - B0}" class="band"/>`;
  }
  // Primary label sits left of its line and Runoff right of its, so the adjacent months don't collide.
  const marks = [['2026-03', 'Primary', -3, 'end'], ['2026-05', 'Runoff', 3, 'start']].map(([m, label, dx, anchor]) => {
    const i = months.indexOf(m);
    return i < 0 ? '' : `<line x1="${x(i)}" x2="${x(i)}" y1="${T0}" y2="${H - B0}" class="event"/><text x="${x(i) + dx}" y="${T0 + 8}" text-anchor="${anchor}" class="event-label">${label}</text>`;
  }).join('');
  const lines = series.map(s => `<polyline fill="none" stroke="${hues[s.candidate]}" stroke-width="2" stroke-linejoin="round" points="${s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>`).join('');
  const ticks = months.map((m, i) => m.endsWith('-01') || i === 0 ? `<text x="${x(i)}" y="${H - 5}" class="axis" text-anchor="middle">${m.endsWith('-01') ? m.slice(0, 4) : ''}</text>` : '').join('');
  const hit = months.map((m, i) => `<rect x="${x(i) - (W - L0) / months.length / 2}" y="${T0}" width="${(W - L0) / months.length}" height="${H - T0 - B0}" class="hit" data-i="${i}"/>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly itemized receipts">
    <line x1="${L0}" x2="${W - R0}" y1="${H - B0}" y2="${H - B0}" class="base"/>
    <line x1="${L0}" x2="${W - R0}" y1="${T0}" y2="${T0}" class="grid"/><text x="${L0 - 4}" y="${T0 + 3}" class="axis" text-anchor="end">${short(max)}</text>
    <text x="${L0 - 4}" y="${H - B0 + 3}" class="axis" text-anchor="end">$0</text>${band}${marks}${lines}${ticks}
    <line class="cursor" y1="${T0}" y2="${H - B0}" visibility="hidden"/>${hit}</svg><div class="chart-tip" hidden></div>`;
}
function bindChart(node, codes) {
  const svg = node.querySelector('svg.chart');
  if (!svg) return;
  const {months, series} = monthlySeries(codes), tip = node.querySelector('.chart-tip'), cursor = svg.querySelector('.cursor');
  svg.addEventListener('pointermove', e => {
    const target = e.target.closest('.hit');
    if (!target) return;
    const i = Number(target.dataset.i), cx = Number(target.getAttribute('x')) + Number(target.getAttribute('width')) / 2;
    cursor.setAttribute('x1', cx); cursor.setAttribute('x2', cx); cursor.setAttribute('visibility', 'visible');
    const label = new Date(months[i] + '-15').toLocaleDateString('en-US', {month: 'short', year: 'numeric'});
    tip.innerHTML = `<b>${label}</b>` + series.map(s => `<div><span class="dot" style="background:${hues[s.candidate]}"></span>${names[s.candidate]} ${money(s.values[i])}</div>`).join('');
    tip.hidden = false;
    const box = svg.getBoundingClientRect(), card = node.getBoundingClientRect(), px = box.left - card.left + cx / svg.viewBox.baseVal.width * box.width;
    tip.style.top = (box.bottom - card.top + 2) + 'px';
    tip.style.left = Math.max(0, Math.min(card.width - tip.offsetWidth, px - tip.offsetWidth / 2)) + 'px';
  });
  svg.addEventListener('pointerleave', () => { tip.hidden = true; cursor.setAttribute('visibility', 'hidden'); });
}
function summary(codes, title, removable, code) {
  const rows = order.map(c => {
    const v = codes.reduce((sum, s) => sum + values(state.totals, s + '|' + c)[0], 0);
    return `<tr><td><span class="dot" style="background:${hues[c]}"></span>${names[c]}</td><td>${money(v)}</td></tr>`;
  }).join('');
  return `<section class="card" data-code="${code || ''}"><header><h2>${title}</h2>${removable ? `<button class="remove" data-remove="${code}" aria-label="Remove ${title}">×</button>` : ''}</header>
    <table class="totals"><tbody>${rows}</tbody></table>${chart(codes)}</section>`;
}
function updatePanel() {
  const period = $('period').selectedOptions[0].textContent;
  const codes = state.nationwide ? Object.keys(state.statesByCode) : state.selected;
  $('side-toggle').textContent = `Itemized receipts · ${period}`;
  // Fit the panel to what it shows: two columns once three or more states are compared on a wide screen.
  $('side').classList.toggle('wide', !state.nationwide && state.selected.length >= 3 && window.innerWidth > 1100);
  let html = '';
  if (state.nationwide) html += summary(codes, 'United States', false);
  else {
    // With several states, an "All selected" card sums them above the per-state cards.
    if (state.selected.length > 1) html += summary(state.selected, `All selected (${state.selected.length} states)`, false, 'all');
    html += state.selected.map(c => summary([c], state.statesByCode[c], state.selected.length > 1, c)).join('');
  }
  html += `<p class="hint">Click a state to show it alone. Shift-, Ctrl- or ⌘-click adds it. Monthly lines include all ${Object.keys(names).length} candidates.</p>`;
  $('cards').innerHTML = html;
  const cards = $('cards').querySelectorAll('.card');
  cards.forEach(card => bindChart(card, state.nationwide || card.dataset.code === 'all' ? codes : [card.dataset.code]));
  $('add-state').innerHTML = '<option value="">+ Add state…</option>' +
    (state.nationwide ? '' : '<option value="ALL">All states (nationwide)</option>') + Object.entries(state.statesByCode)
    .filter(([c]) => state.nationwide || !state.selected.includes(c)).sort((a, b) => a[1].localeCompare(b[1]))
    .map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
}
function refresh() {
  if (!state.states) return;
  state.states.setStyle(stateStyle);
  if (state.layer) state.layer.setStyle(feature => areaStyle(state.layer.level, feature));
  document.querySelectorAll('.candidate-dot').forEach(dot => { dot.style.background = hues[state[dot.dataset.slot]]; });
  updateLegend();
  updatePanel();
}
async function start() {
  const [boundaries, receipts, totals, coverage] = await Promise.all([
    json('data/states.json?v=2'), file('data/receipts.csv'), file('data/state_totals.csv'), json('data/coverage.json')]);
  addRows(csv(receipts), state.receipts, row => row.state + '|' + row.zip + '|' + row.candidate);
  addRows(csv(totals), state.totals, row => row.state + '|' + row.candidate);
  file('data/state_monthly.csv').then(text => {
    state.monthly = new Map(csv(text).map(r => [r.state + '|' + r.candidate + '|' + r.month, Number(r.positive_cents) / 100]));
    updatePanel();
  }).catch(() => {});
  state.coverage = coverage;
  state.statesByCode = Object.fromEntries(boundaries.features.map(f => [f.properties.code, f.properties.name]));
  state.states = L.geoJSON(boundaries, {
    pane: 'statePane', style: stateStyle,
    onEachFeature: (feature, layer) => {
      const code = feature.properties.code;
      layer.bindTooltip(() => stateTooltip(code), {sticky: true, direction: 'top'});
      layer.on('click', e => { L.DomEvent.stopPropagation(e); chooseState(code, modifier(e)); });
      layer.on('mouseover', () => layer.setStyle({weight: 2.2, color: '#1d3440'}));
      layer.on('mouseout', () => layer.setStyle(stateStyle(feature)));
    }
  }).addTo(map);
  $('coverage').textContent = `FEC through ${coverage.coverage_end} · ${coverage.filing_count} filings`;
  if (window.innerWidth <= 850) { $('side').classList.add('collapsed'); $('side-toggle').setAttribute('aria-expanded', 'false'); }
  window.addEventListener('resize', () => $('side').classList.toggle('wide', !state.nationwide && state.selected.length >= 3 && window.innerWidth > 1100));
  syncControls();
  await render(true);
}

$('period').addEventListener('change', e => {state.period = e.target.value; refresh();});
$('measure').addEventListener('change', async e => {
  state.measure = e.target.value;
  try { await loadLevel(state.level); } catch (error) { showError(error); }
  refresh();
});
$('level').addEventListener('change', e => {state.level = e.target.value; render();});
$('view').addEventListener('change', e => setNationwide(e.target.value === 'nation'));
for (const id of ['first', 'second']) $(id).addEventListener('change', e => {
  const other = id === 'first' ? 'second' : 'first';
  if (e.target.value === $(other).value) $(other).value = id === 'first' ? state.first : state.second;
  state.first = $('first').value; state.second = $('second').value; refresh();
});
$('add-state').addEventListener('change', e => {
  const value = e.target.value;
  if (value === 'ALL') setNationwide(true); else if (value) chooseState(value, !state.nationwide);
});
$('cards').addEventListener('click', e => { const code = e.target.dataset?.remove; if (code) chooseState(code, true); });
$('side-toggle').addEventListener('click', () => {
  const open = $('side').classList.toggle('collapsed') === false;
  $('side-toggle').setAttribute('aria-expanded', String(open));
});
$('home').addEventListener('click', () => chooseState('TX', false));
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
