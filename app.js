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
// Max-out donors are counted per election (FEC limits apply separately to the primary, runoff and general).
const elections = ['primary', 'runoff', 'general'];
const electionLabel = () => ({all: 'all elections', primary: 'primary', runoff: 'runoff', general: 'general'})[state.election];
const maxMode = () => state.measure === 'maxouts' || state.measure === 'maxcapita';
const kindNow = () => maxMode() ? 'max' : 'dollars';
const perResidents = () => state.measure === 'capita' || state.measure === 'maxcapita';
// Dollars are shown per 100 residents; max-out donors, far fewer, per 10,000.
const PER = () => maxMode() ? 10000 : 100;
const perLabel = () => maxMode() ? 'per 10,000 residents' : 'per 100 residents';
const phaseMonths = {pre_primary: ['2025-01', '2026-03'], between_primary_runoff: ['2026-03', '2026-05'], post_runoff: ['2026-05', '9999-12']};
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
const short = (n) => n >= 1e6 ? '$' + +(n / 1e6).toFixed(1) + 'm' : n >= 1e3 ? '$' + +(n / 1e3).toFixed(1) + 'k' : '$' + Math.round(n);
const people = (n) => n >= 1e6 ? +(n / 1e6).toFixed(1) + 'm' : n >= 1e3 ? +(n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
const monthLabel = (m, style = 'short') => new Date(m + '-15').toLocaleDateString('en-US', {month: style, year: 'numeric'});
// Dark theme: weak values fade toward the map background; no-receipt places are grey.
const themes = {
  dark: {NEUTRAL: '#5d656c', PALE: '#1b2329', EMPTY: '#3a4248', INK: '#f2f6f8', LINE: '#0c1115', EDGE: '#56656e', CONTEXT: '#10171c'},
  light: {NEUTRAL: '#d9d3cb', PALE: '#f4f2ef', EMPTY: '#cfd5d8', INK: '#10212b', LINE: '#56696f', EDGE: '#7d8e95', CONTEXT: '#ffffff'},
};
let NEUTRAL, PALE, EMPTY, INK, LINE, EDGE, CONTEXT;
const CONUS = [[24, -125], [50, -66]];
const levels = {
  zcta: {label: 'ZCTAs', noun: 'ZCTA', title: 'ZIP (ZCTA)', national: true, detail: true},
  county: {label: 'counties', noun: 'county', title: 'County', national: true},
  cd: {label: 'congressional districts', noun: 'district', title: 'Congressional district', national: true},
  cbsa: {label: 'metro/micro areas', noun: 'metro area', title: 'Metro/micro area', national: true},
  cousub: {label: 'county subdivisions', noun: 'county subdivision', title: 'County subdivision', national: true, detail: true},
  state: {label: 'states', noun: 'state', title: 'States'},
};
const ramp = ['#fde725', '#5ec962', '#21918c', '#3b528b', '#440154']; // viridis, light to dark
// Statistics shared by the filter and the rankings. value(first, second, population) -> number or null.
// With a max-out measure the amounts are donor counts [donors, in one gift, accumulated, over-limit gifts].
const donors = (v) => Math.abs(v - Math.round(v)) < .005 ? Math.round(v).toLocaleString() : '≈' + v.toFixed(1);
const stats = {
  total: {label: () => maxMode() ? 'Max-out donors' : 'Total raised', value: (a, b) => a[0] + b[0], log: true, format: (v) => maxMode() ? donors(v) : short(v)},
  capita: {label: () => maxMode() ? 'Per 10,000 residents' : 'Per 100 residents', value: (a, b, pop) => pop ? PER() * (a[0] + b[0]) / pop : null, log: true,
    format: (v) => maxMode() ? +v.toPrecision(2) + '' : v < 10 ? '$' + +v.toFixed(2) : short(v)},
  share: {label: () => `${names[state.first]}'s share`, value: (a, b) => a[0] + b[0] > 0 ? a[0] / (a[0] + b[0]) : null, log: false, format: (v) => Math.round(100 * v) + '%'},
  avg: {label: () => maxMode() ? 'Share in one gift' : 'Average contribution',
    value: (a, b) => maxMode() ? (a[0] + b[0] > 0 ? (a[1] + b[1]) / (a[0] + b[0]) : null) : a[2] + b[2] > 0 ? (a[0] + b[0]) / (a[2] + b[2]) : null,
    get log() { return !maxMode(); }, format: (v) => maxMode() ? Math.round(100 * v) + '%' : short(v)},
  count: {label: () => maxMode() ? 'Accumulated' : 'Contributions', value: (a, b) => a[2] + b[2], log: true, format: (v) => maxMode() ? donors(v) : people(v)},
};
// Data shading can be hidden or faded (outlines and tooltips stay); remembered per browser.
const stored = (key, fallback) => { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } };
const state = {dataOn: stored('dataOn', true), dataOpacity: stored('dataOpacity', 1), span: [0, 3], first: 'C00919084', second: 'C00901918', measure: 'lead', election: 'all', level: 'zcta',
  selected: [], lastSelected: [], lastLocalLevel: 'zcta', localPending: false, focused: null, nationwide: false,
  receipts: new Map(), receiptsLoaded: null, totals: new Map(), areas: {}, unallocated: new Map(),
  levelLoads: {}, maxLoaded: null, population: {}, monthly: null, months: [], geo: new Map(), layer: null, index: new Map(), render: 0, visibleKey: null, states: null,
  coverage: null, breaks: [], fade: null, chartMode: 'monthly', timeline: false, timeIndex: 0, timeMode: 'cumulative',
  rankBy: 'total', rankDesc: true, rankStates: false, showEmpty: true,
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
/* Boundary files: data/manifest.json maps each path to a content hash. A file is requested
   as path?h=hash and kept in Cache Storage under that URL, so it is downloaded again only when
   it changes (Pages gives every file a new ETag on each deploy). Without Cache Storage
   (private windows, some embedded browsers) files come straight from the network. */
const GEO_CACHE = 'senatedonors-geo';
const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;
let manifest = {};
let geoCache = null;
function openGeoCache() {
  if (!geoCache) geoCache = (async () => { try { return globalThis.caches ? await caches.open(GEO_CACHE) : null; } catch { return null; } })();
  return geoCache;
}
async function loadManifest() {
  try {
    const response = await fetch('data/manifest.json', {cache: 'no-cache'});
    if (response.ok) manifest = (await response.json()).files || {};
  } catch { manifest = {}; }
}
const geoUrl = (path) => manifest[path] ? `${path}?h=${manifest[path]}` : path;
async function geoResponse(path) {
  const url = geoUrl(path), cache = manifest[path] ? await openGeoCache() : null;
  if (cache) {
    try { const hit = await cache.match(url); if (hit) return hit; } catch { /* fall through to the network */ }
  }
  const response = await fetchOk(url);
  if (cache) cache.put(url, response.clone()).catch(() => {});
  return response;
}
// Drop cached files whose hash is no longer in the manifest.
async function evictGeo() {
  const cache = await openGeoCache();
  if (!cache || !Object.keys(manifest).length) return;
  try {
    for (const request of await cache.keys()) {
      const url = new URL(request.url), path = url.pathname.slice(url.pathname.indexOf('/data/') + 1);
      if (manifest[path] !== url.searchParams.get('h')) await cache.delete(request);
    }
  } catch { /* eviction is best effort */ }
}
// Warm the cache for a file without parsing it (hover prefetch).
function prefetchGeo(path) {
  if (!manifest[path] || navigator.connection?.saveData) return;
  openGeoCache().then(cache => cache && cache.match(geoUrl(path)).then(hit => hit || geoResponse(path).then(r => r.arrayBuffer()))).catch(() => {});
}
// Gzipped TopoJSON (or GeoJSON) -> GeoJSON FeatureCollection.
async function packed(path) {
  const response = await geoResponse(path);
  if (!globalThis.DecompressionStream) throw new Error('This browser needs gzip stream support to display boundaries.');
  const data = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
  return data.type === 'Topology' ? topojson.feature(data, data.objects[Object.keys(data.objects)[0]]) : data;
}
// Each item holds, per phase, [dollars, net dollars, count, dollars placed by address, count placed by
// address] (area levels only), and in .max the max-out donors per election [in one gift, accumulated, over-limit gifts].
function itemFor(store, id) {
  let item = store.get(id);
  if (!item) { item = Object.fromEntries(phases.map(p => [p, [0, 0, 0, 0, 0]])); store.set(id, item); }
  return item;
}
function addRows(rows, destination, key) {
  for (const row of rows) {
    itemFor(destination, key(row))[row.phase] = [Number(row.positive_cents) / 100, Number(row.net_cents) / 100, Number(row.count),
      Number(row.address_cents || 0) / 100, Number(row.address_count || 0)];
  }
}
function addMaxouts(rows, destination, key) {
  for (const row of rows) {
    const item = itemFor(destination, key(row)), sums = (item.max ||= {})[row.election] ||= [0, 0, 0];
    sums[0] += Number(row.single_gift); sums[1] += Number(row.accumulated); sums[2] += Number(row.over_limit_contributions);
  }
}
function values(store, id, kind = kindNow()) {
  const item = store.get(id);
  if (kind === 'max') {
    const out = [0, 0, 0, 0];
    for (const e of state.election === 'all' ? elections : [state.election]) {
      const m = item?.max?.[e];
      if (m) { out[1] += m[0]; out[2] += m[1]; out[3] += m[2]; }
    }
    out[0] = out[1] + out[2];
    return out;
  }
  if (!item) return [0, 0, 0, 0, 0];
  return phases.slice(...state.span).reduce((sum, phase) => sum.map((n, i) => n + item[phase][i]), [0, 0, 0, 0, 0]);
}
const comparison = (store, key, kind) => [values(store, key + '|' + state.first, kind), values(store, key + '|' + state.second, kind)];
const timeMonth = () => state.months[state.timeIndex];
// State amounts for one candidate: the selected period, or the timeline month (cumulative or single).
function stateValues(code, candidate, kind = kindNow()) {
  if (!state.timeline || kind === 'max') return values(state.totals, code + '|' + candidate, kind);
  const end = timeMonth(), sum = [0, 0, 0];
  for (const m of state.months) {
    if (m > end || (state.timeMode === 'month' && m !== end)) continue;
    const v = state.monthly.get(code + '|' + candidate + '|' + m);
    if (v) v.forEach((n, i) => { sum[i] += n; });
  }
  return sum;
}
const stateAmounts = (code, kind) => [stateValues(code, state.first, kind), stateValues(code, state.second, kind)];
function hexBlend(a, b, ratio) {
  const toRGB = x => [1, 3, 5].map(i => parseInt(x.slice(i, i + 2), 16));
  const x = toRGB(a), y = toRGB(b), t = Math.max(0, Math.min(1, ratio));
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
const bin = (value, breaks) => breaks.filter(b => value >= b).length;
const population = (level, id) => state.population[level]?.get(id);

/* The colored set: exactly one level is colored at a time. States when nothing is open (or on the
   timeline); otherwise the open areas, with every other state as plain context. */
// Nationwide ZCTAs and county subdivisions draw at every zoom: visible states' files stream in nearest-first.
const detailNation = () => state.nationwide && levels[state.level].detail;
const statesColored = () => state.timeline || (!state.nationwide && !state.selected.length);
function areaKey(level, feature) {
  const p = feature.properties;
  return level === 'zcta' ? {store: state.receipts, key: p._state + '|' + p.zip, pop: p.zip} : {store: state.areas[level], key: p.geoid, pop: p.geoid};
}
const areaTitle = (level, feature) => level === 'zcta' ? `ZCTA ${feature.properties.zip} · ${feature.properties._state}` : feature.properties.name;
function stateItems(kind) {
  return Object.keys(state.statesByCode).map(code => ({key: code, name: state.statesByCode[code], amounts: stateAmounts(code, kind), pop: population('state', code), isState: true}));
}
function areaItems(kind) {
  const level = state.layer.level, seen = new Set(), list = [];
  for (const polygon of state.layer.getLayers()) {
    const {store, key, pop} = areaKey(level, polygon.feature);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({key, name: areaTitle(level, polygon.feature), amounts: comparison(store, key, kind), pop: population(level, pop)});
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
  if (state.measure === 'volume' || state.measure === 'maxouts') return {fill: ramp[bin(total, state.breaks)], kind: 'value'};
  if (perResidents()) {
    if (!pop) return {fill: EMPTY, kind: 'nopop'};
    const s = strength(pop);
    return {fill: faded(ramp[bin(PER() * total / pop, state.breaks)], s), kind: 'value', s};
  }
  const s = strength(total);
  return {fill: faded(leadColor(a / total), s), kind: 'value', s};
}
const dataAlpha = () => state.dataOn ? state.dataOpacity : 0;
function paint(amounts, pop) {
  const {fill, kind} = classify(amounts, pop, passes(amounts, pop));
  return {fillColor: fill, fillOpacity: dataAlpha() * (kind === 'out' ? .12 : kind === 'empty' || kind === 'nopop' ? .3 : .9)};
}
function stateStyle(feature) {
  const code = feature.properties.code, chosen = !state.timeline && !state.nationwide && state.selected.includes(code);
  const base = {pane: 'statePane', color: chosen ? INK : EDGE, weight: chosen ? 2.4 : .7, opacity: .9};
  if (!statesColored()) return {...base, fillColor: CONTEXT, fillOpacity: chosen || state.nationwide ? 0 : .55};
  const amounts = stateAmounts(code);
  if (!hasReceipts(amounts) && !state.showEmpty) return {...base, fillOpacity: 0};
  return {...base, ...paint(amounts, population('state', code))};
}
// Places where neither compared candidate has receipts in the span are grey, or not drawn when the
// legend's No receipts switch is off; either way they ignore hover and clicks.
const hasReceipts = (amounts) => amounts[0][0] + amounts[1][0] > 0;
function areaAmounts(level, feature) {
  const {store, key} = areaKey(level, feature);
  return comparison(store, key);
}
function areaStyle(level, feature) {
  const {pop} = areaKey(level, feature), amounts = areaAmounts(level, feature);
  if (!hasReceipts(amounts)) return state.showEmpty ? {pane: 'zctaPane', stroke: true, fill: true, color: LINE, weight: .3, opacity: .6, fillColor: EMPTY, fillOpacity: .5 * dataAlpha()} : {pane: 'zctaPane', stroke: false, fill: false};
  const focused = state.focused?.level === level && state.focused.key === areaKey(level, feature).key;
  return {pane: 'zctaPane', stroke: true, fill: true, color: focused ? INK : LINE,
    weight: focused ? 2.2 : level === 'zcta' || level === 'cousub' ? .35 : .6, opacity: focused ? 1 : .5,
    ...paint(amounts, population(level, pop))};
}
function syncInteractivity() {
  if (!state.layer) return;
  const level = state.layer.level;
  state.layer.eachLayer(polygon => { if (polygon._path) polygon._path.style.pointerEvents = hasReceipts(areaAmounts(level, polygon.feature)) ? '' : 'none'; });
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
  const capita = perResidents(), shown = coloredItems().filter(i => passes(i.amounts, i.pop));
  const weights = shown.map(i => capita ? i.pop || 0 : i.amounts[0][0] + i.amounts[1][0]).filter(w => w > 0).sort((a, b) => a - b);
  state.fade = weights.length > 4 ? {lo: quantile(weights, .1), hi: quantile(weights, .75)} : null;
  if (state.measure === 'lead') { state.breaks = []; return; }
  let list = [];
  const add = (i) => { const total = i.amounts[0][0] + i.amounts[1][0]; if (total > 0 && (!capita || i.pop)) list.push(capita ? PER() * total / i.pop : total); };
  if (state.timeline && !maxMode()) {
    const saved = state.timeIndex, indexes = state.timeMode === 'month' ? state.months.map((m, i) => i) : [state.months.length - 1];
    for (const i of indexes) { state.timeIndex = i; stateItems().filter(x => passes(x.amounts, x.pop)).forEach(add); }
    state.timeIndex = saved;
  } else shown.forEach(add);
  list = list.sort((a, b) => a - b);
  const cuts = [.2, .4, .6, .8].map(q => nice(quantile(list, q) || 0));
  state.breaks = cuts.filter((v, i) => v > 0 && v > (cuts[i - 1] || 0));
}
// lookup(kind) -> [first, second] amounts, so the tooltip can show dollars and max-out donors in any mode.
function tooltip(level, title, lookup, pop, extra = '') {
  const [a, b] = lookup('dollars'), total = a[0] + b[0], area = level !== 'zcta' && level !== 'state';
  const lines = [`<div class="tooltip-title">${title}</div>`];
  if (!total) lines.push('<div class="tooltip-sub">No itemized receipts from here for either candidate</div>');
  else {
    const pct = (n) => Math.round(100 * n / total) + '%';
    const avg = (v) => v[2] >= 1 ? ` · avg ${money(v[0] / v[2])}` : '';
    lines.push(`<div><span class="dot" style="background:${hues[state.first]}"></span>${names[state.first]} ${money(a[0])} (${pct(a[0])})<span class="tooltip-sub">${avg(a)}</span></div>`,
      `<div><span class="dot" style="background:${hues[state.second]}"></span>${names[state.second]} ${money(b[0])} (${pct(b[0])})<span class="tooltip-sub">${avg(b)}</span></div>`);
    const count = a[2] + b[2];
    if (!area) lines.push(`<div class="tooltip-sub">${count.toLocaleString()} itemized contributions</div>`);
    else {
      // Contributions placed by street address are exact; only the rest of each ZIP's total is an estimate.
      const placed = a[4] + b[4], rest = Math.max(0, count - placed), share = (a[3] + b[3]) / total;
      lines.push(`<div class="tooltip-sub">${placed.toLocaleString()} contributions placed by street address` +
        (rest >= .05 ? ` + ≈${rest.toFixed(1)} estimated from ZIP` : '') + '</div>');
      if (share < .995) lines.push(`<div class="tooltip-sub">${Math.round(100 * share)}% of dollars placed by address · ${Math.round(100 * (1 - share))}% estimated</div>`);
    }
    if (pop && !maxMode()) lines.push(`<div class="tooltip-sub">${money(100 * total / pop)} per 100 residents · pop. ${pop.toLocaleString()}</div>`);
  }
  const [x, y] = lookup('max');
  if (state.maxLoaded && x[0] + y[0] + x[3] + y[3] > 0) {
    const line = (c, v) => v[0] + v[3] > 0 ? `<div class="tooltip-sub"><span class="dot" style="background:${hues[c]}"></span>${names[c]}: ${donors(v[0])} ` +
      `(${donors(v[1])} in one gift, ${donors(v[2])} accumulated)${v[3] >= .005 ? ` · ${donors(v[3])} gift${v[3] === 1 ? '' : 's'} over the limit` : ''}</div>` : '';
    lines.push(`<div class="tooltip-sub tooltip-head">Max-out donors · ${electionLabel()}</div>`, line(state.first, x), line(state.second, y));
    if (pop && maxMode()) lines.push(`<div class="tooltip-sub">${+(PER() * (x[0] + y[0]) / pop).toPrecision(2)} per 10,000 residents · pop. ${pop.toLocaleString()}</div>`);
  } else if (maxMode()) lines.push(`<div class="tooltip-sub">No max-out donors here for either candidate (${electionLabel()})</div>`);
  const shade = lookup(kindNow());
  if (shade[0][0] + shade[1][0] > 0) {
    const {s, kind} = classify(shade, pop, passes(shade, pop));
    if (kind === 'out') lines.push('<div class="tooltip-sub">Outside the filter range</div>');
    else if (s != null && s < .5 && state.measure !== 'volume' && state.measure !== 'maxouts') lines.push(`<div class="tooltip-sub">Shown paler: ${perResidents() ? 'few residents' : 'few dollars'} compared with the places shown</div>`);
  }
  return lines.join('') + extra;
}
function stateTooltip(code) {
  let note = '', title = state.statesByCode[code];
  if (state.timeline) title += ` · ${state.timeMode === 'month' ? '' : 'through '}${monthLabel(timeMonth())}`;
  else if (state.level !== 'zcta' && state.selected.length) {
    const [x, y] = comparison(state.unallocated, state.level + '|' + code, 'dollars');
    if (x[0] + y[0] >= .5) note = `<div class="tooltip-sub">${money(x[0] + y[0])} from ZIPs with no mappable ${levels[state.level].noun}</div>`;
  }
  if (!state.timeline && !state.nationwide && !state.selected.includes(code)) note += `<div class="tooltip-hint">Click to open ${levels[state.level].label} · Shift-click to add</div>`;
  return tooltip('state', title, (kind) => stateAmounts(code, kind), population('state', code), note);
}
function showError(error) {
  $('error').textContent = error.message || String(error);
  $('error').hidden = false;
  console.error(error);
}

/* Data loading */
// Parsed boundary files, most recently used last. Only a few are kept beyond the ones on
// screen: the compressed bytes stay in Cache Storage, and parsed files are large.
const GEO_KEEP = 6;
async function cached(key, load) {
  let entry = state.geo.get(key);
  if (entry) state.geo.delete(key);
  else entry = load().catch(error => { state.geo.delete(key); throw error; });
  state.geo.set(key, entry);
  return entry;
}
function trimGeo(inUse) {
  let spare = [...state.geo.keys()].filter(key => !inUse.has(key));
  while (spare.length > GEO_KEEP) state.geo.delete(spare.shift());
}
const tag = (features, code) => features.map(f => ({...f, properties: {...f.properties, _state: code}}));
function visibleDetailCodes() {
  if (!detailNation() || !state.states) return [];
  const bounds = map.getBounds(), center = map.getCenter(), codes = [];
  state.states.eachLayer(layer => {
    const box = layer.getBounds();
    if (box.intersects(bounds)) codes.push([layer.feature.properties.code, center.distanceTo(box.getCenter())]);
  });
  return codes.sort((a, b) => a[1] - b[1]).map(c => c[0]);
}
const detailKey = () => state.nationwide && levels[state.level].detail ?
  `${state.level}|${visibleDetailCodes().sort().join(',')}` : null;
async function features(level, token) {
  if (!state.nationwide && !state.selected.length) return [];
  if (levels[level].national && !levels[level].detail) {
    const all = (await cached(level, () => packed(`data/levels/geo/${level}.bin`))).features;
    progressTick(token);
    return state.nationwide ? all : all.filter(f => f.properties.states.some(s => state.selected.includes(s)));
  }
  const files = await Promise.all(state.selected.map(code => stateFile(level, code).then(f => { progressTick(token); return f; })));
  return files.flat();
}
const statePath = (level, code) => `${level === 'zcta' ? 'data/zctas' : 'data/levels/geo/cousub'}/${code}.bin`;
function stateFile(level, code) {
  return cached(level + '|' + code, () => packed(statePath(level, code))).then(geo => tag(geo.features, code));
}
// Tens of thousands of shapes: canvas keeps nationwide ZCTAs and subdivisions responsive.
const detailCanvas = L.canvas({pane: 'zctaPane', padding: .4});
const loadPopulation = (name) => state.population[name] ? null :
  file(`data/population/${name}.csv`).then(text => { state.population[name] = new Map(csv(text).map(r => [r.geoid, Number(r.population)])); });
async function loadLevel(level) {
  const jobs = [];
  // ZIP receipts are only needed once a ZIP layer is drawn or ranked.
  if (level === 'zcta') {
    state.receiptsLoaded ||= file('data/receipts.csv').then(text => addRows(csv(text), state.receipts, row => row.state + '|' + row.zip + '|' + row.candidate))
      .catch(error => { state.receiptsLoaded = null; throw error; });
    jobs.push(state.receiptsLoaded);
  }
  // Area dollars, then their max-out donor counts (optional: older deploys have no max-out files).
  const once = (name, load) => (state.levelLoads[name] ||= load().catch(error => { delete state.levelLoads[name]; throw error; }));
  const optional = (url, apply) => file(url).then(text => apply(csv(text)), () => {});
  if (level !== 'zcta') jobs.push(once(level, async () => {
    const areas = new Map(), key = row => row.geoid + '|' + row.candidate;
    addRows(csv(await file(`data/levels/${level}.csv`)), areas, key);
    await optional(`data/levels/maxouts_${level}.csv`, rows => addMaxouts(rows, areas, key));
    state.areas[level] = areas;
  }));
  if (level !== 'zcta') jobs.push(once('unallocated', async () => {
    const key = row => row.level + '|' + row.state + '|' + row.candidate;
    addRows(csv(await file('data/levels/unallocated.csv')), state.unallocated, key);
    await optional('data/levels/maxouts_unallocated.csv', rows => addMaxouts(rows, state.unallocated, key));
  }));
  // Population feeds per-resident shading, the rankings and the filter.
  if (perResidents() || !$('rank').hidden || filterOn()) jobs.push(loadPopulation(level), loadPopulation('state'));
  await Promise.all(jobs);
}

/* Loading bar: one step per boundary file (a state's file, or one national file). */
const progress = {token: 0, done: 0, total: 0, timer: 0};
function progressStart(token, total) {
  Object.assign(progress, {token, done: 0, total: Math.max(1, total)});
  clearTimeout(progress.timer);
  progress.timer = setTimeout(() => { if (progress.token === token && progress.done < progress.total) $('progress').hidden = false; }, 150);
  progressDraw();
}
function progressTick(token) {
  if (token !== progress.token) return;
  progress.done += 1;
  progressDraw();
  if (progress.done >= progress.total) { clearTimeout(progress.timer); setTimeout(() => { if (progress.token === token) $('progress').hidden = true; }, 250); }
}
function progressDraw() {
  $('progress-fill').style.width = (100 * progress.done / progress.total) + '%';
  $('progress-count').textContent = `${progress.done}/${progress.total}`;
}

/* Rendering the area layer for the current selection */
async function render(fit = false) {
  const token = ++state.render, level = state.level;
  state.visibleKey = detailKey();
  updateScope(true);
  try {
    const streaming = detailNation();
    const files = !streaming && !state.selected.length && !state.nationwide ? 0 : streaming ? visibleDetailCodes().length
      : levels[level].national && !levels[level].detail ? 1 : state.selected.length;
    progressStart(token, files + 1);
    // The U.S. overview needs only state totals; area data loads when areas are drawn.
    if (files) await loadLevel(level);
    progressTick(token);
    const list = streaming ? [] : await features(level, token);
    if (token !== state.render) return;
    if (state.layer) map.removeLayer(state.layer);
    state.index = new Map();
    state.layer = L.geoJSON({type: 'FeatureCollection', features: list}, {
      pane: 'zctaPane', smoothFactor: .5, style: feature => areaStyle(level, feature), ...(streaming ? {renderer: detailCanvas} : {}),
      onEachFeature: (feature, polygon) => {
        const p = feature.properties;
        state.index.set(areaKey(level, feature).key, polygon);
        polygon.bindTooltip(() => {
          const {store, key, pop} = areaKey(level, feature);
          return tooltip(level, areaTitle(level, feature), (kind) => comparison(store, key, kind), population(level, pop));
        }, {sticky: true, direction: 'top'});
        // A single click focuses an area (or opens its state in nationwide view).
        let single;
        // Canvas shapes stay hit-testable when hidden, so empty areas ignore hover and clicks here.
        polygon.on('tooltipopen', () => { if (!hasReceipts(areaAmounts(level, feature))) polygon.closeTooltip(); });
        polygon.on('click', e => {
          L.DomEvent.stopPropagation(e);
          if (!hasReceipts(areaAmounts(level, feature))) return;
          clearTimeout(single);
          const add = modifier(e);
          single = setTimeout(() => {
            if (state.nationwide || add) chooseState(p._state || p.states[0], add);
            else focusArea(level, feature, polygon);
          }, 250);
        });
        polygon.on('dblclick', e => { L.DomEvent.stopPropagation(e); clearTimeout(single); resetView(); });
        polygon.on('mouseover', () => { if (hasReceipts(areaAmounts(level, feature))) polygon.setStyle({weight: 1.8, color: INK, opacity: 1}); });
        polygon.on('mouseout', () => polygon.setStyle(areaStyle(level, feature)));
      }
    });
    if (!state.timeline) state.layer.addTo(map);
    state.layer.level = level;
    $('error').hidden = true;
    if (fit && list.length) map.fitBounds(state.layer.getBounds(), fitPadding(8));
    if (streaming) {
      const layer = state.layer;
      await Promise.all(visibleDetailCodes().map(code => stateFile(level, code).then(found => {
        progressTick(token);
        if (token !== state.render || layer !== state.layer) return;
        layer.addData(found);
        scheduleRefresh();
      })));
    }
  } catch (error) { showError(error); if (progress.token === token) $('progress').hidden = true; }
  if (token === state.render) {
    const codes = detailNation() ? visibleDetailCodes() : state.selected;
    trimGeo(new Set(levels[level].detail ? codes.map(code => level + '|' + code) : [level]));
    updateScope(); refresh();
  }
}
let refreshFrame = 0;
function scheduleRefresh() { cancelAnimationFrame(refreshFrame); refreshFrame = requestAnimationFrame(() => { updateScope(); refresh(); }); }
// Keep fitted areas clear of the masthead and of the totals panel when it sits on the right.
function fitPadding(maxZoom) {
  const side = $('side'), box = side.getBoundingClientRect();
  const right = window.innerWidth > 850 && !side.hidden && box.left > window.innerWidth / 2 ? window.innerWidth - box.left + 20 : 30;
  return {paddingTopLeft: [40, 90], paddingBottomRight: [right, 50], maxZoom};
}
const modifier = (e) => { const o = e.originalEvent || e; return o.shiftKey || o.ctrlKey || o.metaKey; };
function clearFocus() {
  const old = state.focused;
  state.focused = null;
  if (old) {
    const polygon = state.index.get(old.key);
    if (polygon && state.layer?.level === old.level) polygon.setStyle(areaStyle(old.level, polygon.feature));
  }
}
function focusArea(level, feature, polygon) {
  clearFocus();
  state.focused = {level, key: areaKey(level, feature).key, title: areaTitle(level, feature)};
  polygon.setStyle(areaStyle(level, feature));
  polygon.bringToFront();
  map.fitBounds(polygon.getBounds(), fitPadding(10));
  updateScope();
}
function returnToSelection() {
  clearFocus();
  if (state.layer?.getLayers().length) map.fitBounds(state.layer.getBounds(), fitPadding(8));
  updateScope();
}
function chooseState(code, add) {
  if (!state.statesByCode[code]) return;
  clearFocus();
  state.nationwide = false;
  state.localPending = false;
  if (!add) state.selected = [code];
  else if (state.selected.includes(code)) state.selected = state.selected.filter(c => c !== code);
  else state.selected = [...state.selected, code];
  if (state.selected.length) { state.lastSelected = [...state.selected]; state.lastLocalLevel = state.level; }
  syncControls();
  if (!state.selected.length) { map.fitBounds(CONUS, fitPadding(4.5)); render(); } else render(true);
}
function resetView() {
  if (state.selected.length) state.lastSelected = [...state.selected];
  clearFocus();
  state.selected = []; state.nationwide = false; state.localPending = false;
  syncControls(); map.fitBounds(CONUS, fitPadding(4.5)); render();
}
function setNationwide(on) {
  if (!on && !state.lastSelected.length) return resetView();
  setGeography(on ? `nation:${levels[state.level].national ? state.level : 'county'}` : `states:${state.lastLocalLevel}`);
}
function setLevel(level) {
  if (!state.selected.length && !state.nationwide && levels[level].national) return setGeography(`nation:${level}`);
  return setGeography(`${state.nationwide && levels[level].national ? 'nation' : 'states'}:${level}`);
}
function setGeography(choice) {
  if (choice === 'overview') return resetView();
  const [scope, level] = choice.split(':');
  if (!levels[level] || (scope === 'nation' && !levels[level].national)) return;
  const wasNationwide = state.nationwide, wasLocal = !state.nationwide && state.selected.length > 0;
  clearFocus();
  state.level = level;
  state.nationwide = scope === 'nation';
  state.localPending = !state.nationwide && !state.selected.length && !state.lastSelected.length;
  if (!state.nationwide) {
    if (!state.selected.length) state.selected = [...state.lastSelected];
    state.lastLocalLevel = level;
  }
  syncControls();
  if (state.nationwide && !wasNationwide) map.fitBounds(CONUS, fitPadding(4.5));
  render(!state.nationwide && !wasLocal);
}
// Each candidate list leaves out whoever is picked in the other one.
function syncCandidates() {
  for (const [id, other] of [['first', 'second'], ['second', 'first']])
    $(id).innerHTML = order.filter(c => c !== state[other]).map(c => `<option value="${c}"${c === state[id] ? ' selected' : ''}>${names[c]}</option>`).join('');
}
function syncControls() {
  $('geography').value = state.nationwide || state.selected.length || state.localPending ? state.level : 'overview';
  $('nation').setAttribute('aria-pressed', String(state.nationwide));
  const code = !state.nationwide && state.selected.length === 1 ? state.selected[0] : '';
  $('state-code').textContent = code || (!state.nationwide && state.selected.length > 1 ? String(state.selected.length) : 'ST');
}
function openStateMenu() {
  $('state-menu').hidden = false;
  $('state-picker').setAttribute('aria-expanded', 'true');
  $('state-search').value = '';
  $('state-options').querySelectorAll('label').forEach(label => {
    label.hidden = false;
    label.querySelector('input').checked = state.selected.includes(label.querySelector('input').value);
  });
  $('state-search').focus();
}
function closeStateMenu() {
  $('state-menu').hidden = true;
  $('state-picker').setAttribute('aria-expanded', 'false');
}
function applyStateSelection() {
  const codes = [...$('state-options').querySelectorAll('input:checked')].map(input => input.value);
  closeStateMenu();
  if (!codes.length) { state.selected = []; state.lastSelected = []; return resetView(); }
  clearFocus();
  state.selected = codes;
  state.lastSelected = [...codes];
  state.lastLocalLevel = state.level;
  state.nationwide = false;
  state.localPending = false;
  syncControls();
  render(true);
}
function updateScope(loading) {
  const node = $('scope'), label = levels[state.level].label;
  node.replaceChildren();
  if (loading) { node.textContent = `Loading ${label}…`; return; }
  if (state.timeline) { node.textContent = `States · ${state.timeMode === 'month' ? '' : 'through '}${monthLabel(timeMonth(), 'long')}`; return; }
  if (!state.nationwide && !state.selected.length) {
    node.textContent = state.localPending ? `Select a state to see ${label}` : 'U.S. states · click a state to open areas'; return;
  }
  const step = (name, action) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'crumb'; b.textContent = name; b.addEventListener('click', action);
    node.append(b);
  };
  const separator = () => { const s = document.createElement('span'); s.className = 'crumb-separator'; s.textContent = '›'; node.append(s); };
  step('U.S. states', resetView); separator();
  if (state.nationwide) {
    node.append(`Nationwide ${label}${levels[state.level].detail ? ' · visible states' : ''}`);
    return;
  }
  const selected = state.selected.length > 2 ? `${state.selected.length} states` : state.selected.map(c => state.statesByCode[c]).join(' + ');
  if (state.focused) { step(selected, returnToSelection); separator(); node.append(`${label} › ${state.focused.title}`); }
  else node.append(`${selected} · ${label}`);
}

/* Legend */
function updateLegend() {
  const level = coloredLevel(), label = levels[level].label;
  const swatches = (colors) => colors.map(c => `<span style="background:${c}"></span>`).join('');
  const empty = `<span class="swatch" style="background:${EMPTY}"></span>`;
  const noneNote = `<button class="empty-toggle" id="empty-toggle" role="switch" aria-checked="${state.showEmpty}">${empty}${maxMode() ? 'No max-out donors' : 'No receipts'}<i></i></button>`;
  const fadeRow = (color, what, format) => state.fade ? `<div class="fade-row"><span class="fade" style="background:linear-gradient(90deg,${faded(color, 0)},${color})"></span>` +
    `<div class="ticks ends"><span>${format(state.fade.lo)} or less</span><span>${format(state.fade.hi)}+ ${what}</span></div></div>` : '';
  let html;
  if (state.measure === 'lead') {
    html = `<div class="legend-title">Who led in itemized dollars</div><div class="steps">${swatches(leadClasses())}</div>` +
      `<div class="ticks8"><span>80%+</span><span>65</span><span>55</span><span>50</span><span>50</span><span>55</span><span>65</span><span>80%+</span></div>` +
      `<div class="ticks ends"><span>← ${names[state.second]} led</span><span>${names[state.first]} led →</span></div>` +
      fadeRow(hues[state.first], 'combined', short) + '<div class="legend-note">Paler = fewer dollars behind the lead</div>' + noneNote;
  } else {
    const capita = perResidents(), breaks = state.breaks, format = stats[capita ? 'capita' : 'total'].format;
    const what = maxMode() ? `Max-out donors${capita ? ' per 10,000 residents' : ''} · ${electionLabel()}` : capita ? 'Dollars per 100 residents' : 'Total raised';
    html = `<div class="legend-title">${what} · ${names[state.first]} + ${names[state.second]}</div>` +
      `<div class="steps">${swatches(ramp.slice(0, breaks.length + 1))}</div><div class="ticks">${breaks.map(b => `<span>${format(b)}</span>`).join('')}</div>` +
      `<div class="legend-note">Each color holds about a fifth of the ${label} shown</div>` +
      (capita ? fadeRow(ramp[3], 'residents', people) + '<div class="legend-note">Paler = fewer residents, a less stable rate</div>' : '') + noneNote;
  }
  if (filterOn()) html += `<div class="legend-note filter-note">Filter on: faint places are outside the range</div>`;
  html = `<div class="layer-row"><button class="empty-toggle" id="data-switch" role="switch" aria-checked="${state.dataOn}" title="Show or hide the data shading">Data layer<i></i></button>` +
    `<input type="range" id="data-opacity" min="10" max="100" step="5" value="${Math.round(100 * state.dataOpacity)}" aria-label="Data layer opacity" title="Opacity" ${state.dataOn ? '' : 'disabled'}></div>` + html;
  if (maxMode()) html += `<div class="legend-note">Donors who gave a candidate ${money((state.coverage?.maxouts?.limit_cents ?? 350000) / 100)} or more for one election, placed at their latest contribution</div>`;
  const placed = state.coverage?.placement?.[level];
  if (placed) html += `<div class="legend-note">${Math.round(100 * placed.address_cents / placed.matched_cents)}% of ${levels[level].noun} dollars placed by street address; the rest estimated from ZIP</div>`;
  $('legend').innerHTML = html;
  $('legend').classList.toggle('data-off', !state.dataOn);
  fitLegend();
}
// The legend sits between the panel buttons and the footer; it shrinks (then collapses to its essentials)
// rather than ever covering them. On short screens the legend and footer move beside the buttons instead.
// Clicking the legend title collapses or expands it.
function fitLegend() {
  const legend = $('legend'), foot = $('foot');
  legend.style.left = foot.style.left = '';
  if (window.innerWidth <= 850) { legend.style.maxHeight = $('tools').style.top = ''; return; }
  $('tools').style.top = (document.querySelector('.map-actions').getBoundingClientRect().bottom + 12) + 'px';
  const tools = $('tools').getBoundingClientRect();
  let room = foot.getBoundingClientRect().top - tools.bottom - 20;
  if (room < 110) {
    legend.style.left = foot.style.left = (tools.right + 12) + 'px';
    room = foot.getBoundingClientRect().top - 90 - 12;
  }
  legend.style.maxHeight = Math.max(0, room) + 'px';
  legend.classList.toggle('squeezed', room < 110);
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
    const v = codes.reduce((sum, s) => sum.map((n, i) => n + values(state.totals, s + '|' + c, 'dollars')[i]), [0, 0, 0]);
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
    `<p class="hint">Click a state to open it. Shift-, Ctrl- or ⌘-click adds it. Use Map view to switch geography and the location path to step back. Drag panels by their title; resize from the corner.</p>`;
  box.querySelectorAll('.card').forEach((card, i) => bindChart(card, state.monthly ? series(cards[i][0]) : []));
  $('add-state').innerHTML = '<option value="">+ Add state…</option>' +
    (state.nationwide ? '' : '<option value="ALL">All states (nationwide)</option>') + Object.entries(state.statesByCode)
    .filter(([c]) => state.nationwide || !state.selected.includes(c)).sort((a, b) => a[1].localeCompare(b[1]))
    .map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
  document.querySelectorAll('#chart-mode button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === state.chartMode)));
}

/* Top places panel: choose the level and how to sort; hover highlights, click zooms. */
// kind: which amounts a ranking reads (dollars, or max-out donors for the selected election).
const rankMeasures = {
  total: {kind: 'dollars', label: () => 'Total raised', value: (a, b) => a[0] + b[0], format: money},
  capita: {kind: 'dollars', label: () => 'Per 100 residents', value: (a, b, pop) => pop ? 100 * (a[0] + b[0]) / pop : null, format: (v) => '$' + v.toFixed(2)},
  first: {kind: 'dollars', label: () => `${names[state.first]}'s share`, value: stats.share.value, format: stats.share.format},
  second: {kind: 'dollars', label: () => `${names[state.second]}'s share`, value: (a, b) => a[0] + b[0] > 0 ? b[0] / (a[0] + b[0]) : null, format: stats.share.format},
  avg: {kind: 'dollars', label: () => 'Average contribution', value: (a, b) => a[2] + b[2] > 0 ? (a[0] + b[0]) / (a[2] + b[2]) : null, format: money},
  count: {kind: 'dollars', label: () => 'Contributions', value: (a, b) => a[2] + b[2], format: (v) => Math.round(v).toLocaleString()},
  maxouts: {kind: 'max', label: () => `Max-out donors (${electionLabel()})`, value: (a, b) => a[0] + b[0] || null, format: donors},
  maxcapita: {kind: 'max', label: () => 'Max-out donors per 10,000 residents', value: (a, b, pop) => pop && a[0] + b[0] ? 10000 * (a[0] + b[0]) / pop : null, format: (v) => +v.toPrecision(2) + ''},
  maxsingle: {kind: 'max', label: () => 'Maxed out in one gift', value: (a, b) => a[1] + b[1] || null, format: donors},
  maxaccum: {kind: 'max', label: () => 'Maxed out over several gifts', value: (a, b) => a[2] + b[2] || null, format: donors},
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
    $('rank-list').innerHTML = `<li class="muted">${state.nationwide && levels[rankLevel].detail ? 'Loading areas for the visible states…' : `Open a state or choose a nationwide view to rank ${levels[rankLevel].label}.`}</li>`;
    $('rank-note').textContent = '';
    return;
  }
  const measure = rankMeasures[state.rankBy], rows = [];
  // The filter applies when ranking the colored level with the amounts it is colored by.
  const items = rankLevel === 'state' ? stateItems(measure.kind) : areaItems(measure.kind), filtered = coloredLevel() === rankLevel && measure.kind === kindNow();
  for (const item of items) {
    if (item.amounts[0][0] + item.amounts[1][0] <= 0 || (filtered && !passes(item.amounts, item.pop))) continue;
    const value = measure.value(...item.amounts, item.pop);
    // Ties go to more dollars (or more max-out donors).
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
  $('rank-note').textContent = `${rows.length.toLocaleString()} ${levels[rankLevel].label} with ${measure.kind === 'max' ? 'max-out donors' : 'receipts'}${state.nationwide && levels[rankLevel].detail ? ' in the visible states' : ''}${filtered && filterOn() ? ' inside the filter' : ''} · bar length follows the ranking, split ${names[state.first]} / ${names[state.second]}. Use Filter to set minimums (for example, dollars behind a share).`;
}
function highlight(key, on) {
  const polygon = state.index.get(key);
  if (!polygon) return;
  if (on) { polygon.setStyle({weight: 2.4, color: INK, opacity: 1}); polygon.bringToFront(); }
  else polygon.setStyle(areaStyle(state.layer.level, polygon.feature));
}

/* Filter panel: histogram and min/max range for a statistic of the places shown. */
const SLIDER = 1000;
function filterScope() { return coloredLevel() + '|' + (state.nationwide ? 'US' : state.selected.join(',')) + '|' + state.span.join('-') + '|' + state.first + '|' + state.second + '|' + kindNow() + '|' + state.election; }
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

/* Filter view: a scatter-plot matrix of the filter statistics for the colored places. Kept places are
   drawn in their map color, filtered-out ones faint; bands show the ranges. Drag a box to set the two
   ranges of a plot, double-click to clear them; hover finds the place on the map, click opens it. */
const SPLOM = ['total', 'capita', 'share', 'avg', 'count'];
let splom = null;  // layout and points of the last drawing, for hover and brushing
// Docked: same left and width as the filter panel, just above it (inside the window).
function dockSplom() {
  const panel = $('splom'), filter = $('filter');
  if (filter.hidden || window.innerWidth <= 850) return;
  const box = filter.getBoundingClientRect(), gap = 10, top = 84;
  const height = Math.max(220, Math.min(460, box.top - gap - top));
  Object.assign(panel.style, {left: box.left + 'px', width: box.width + 'px', height: height + 'px',
    top: Math.max(top, box.top - gap - height) + 'px', right: 'auto', bottom: 'auto', transform: 'none'});
}
function splomAxis(name, items) {
  const stat = stats[name], vals = items.map(i => stat.value(...i.amounts, i.pop));
  const ext = filterExtent(vals, stat);
  return ext && {name, stat, vals, pos: (v) => v == null || (stat.log && v <= 0) ? null : Math.max(0, Math.min(1, ext.toPos(v) / SLIDER)), ext};
}
function updateSplom() {
  const panel = $('splom');
  if (panel.hidden || !state.statesByCode) return;
  const canvas = $('splom-canvas'), box = $('splom-plot'), W = box.clientWidth, H = box.clientHeight;
  if (!W || !H) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(W * ratio); canvas.height = Math.round(H * ratio);
  const g = canvas.getContext('2d');
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  g.clearRect(0, 0, W, H);
  const dark = document.documentElement.classList.contains('dark');
  const ink = dark ? '#93a3ab' : '#53656d', grid = dark ? 'rgba(147,163,171,.18)' : 'rgba(83,101,109,.16)', cellBg = dark ? 'rgba(255,255,255,.03)' : 'rgba(16,33,43,.03)';
  const items = coloredItems().filter(i => i.amounts[0][0] + i.amounts[1][0] > 0);
  const axes = SPLOM.map(name => splomAxis(name, items)).filter(Boolean);
  const f = state.filter, applied = new Set(filterOn() ? (f.all ? Object.keys(f.ranges) : [f.stat]) : []);
  const kept = items.map(i => passes(i.amounts, i.pop));
  const nKept = kept.filter(Boolean).length;
  $('splom-count').textContent = `${nKept.toLocaleString()} of ${items.length.toLocaleString()} ${coloredLevel() === 'state' ? 'states' : levels[coloredLevel()].label} kept`;
  if (axes.length < 2) { splom = null; g.fillStyle = ink; g.font = '12px system-ui'; g.fillText('Not enough values to plot here.', 8, 20); return; }
  // Lower triangle: columns are axes[0..n-2], rows axes[1..n-1].
  const n = axes.length - 1, left = 16, bottom = 16, gap = 5;
  // Cells stretch to fill the panel, so resizing it reshapes the plots.
  const cw = Math.max(20, (W - left - gap * (n - 1)) / n), ch = Math.max(20, (H - bottom - gap * (n - 1)) / n);
  const cells = [];
  for (let r = 0; r < n; r++) for (let c = 0; c <= r; c++) {
    cells.push({x: axes[c], y: axes[r + 1], x0: left + c * (cw + gap), y0: r * (ch + gap), w: cw, h: ch});
  }
  const color = items.map((i, k) => kept[k] ? classify(i.amounts, i.pop, true).fill : null);
  const dot = Math.max(1.4, Math.min(3.2, 260 / Math.sqrt(items.length + 1) / 4));
  const points = [];
  for (const cell of cells) {
    const {x, y, x0, y0, w, h} = cell;
    g.fillStyle = cellBg; g.fillRect(x0, y0, w, h);
    // Ranges: a vertical band for the x statistic, a horizontal one for y; solid when the filter applies them.
    for (const [axis, vertical] of [[x, true], [y, false]]) {
      const range = f.ranges[axis.name];
      if (!range) continue;
      const a = range[0] == null ? 0 : axis.pos(range[0]) ?? 0, b = range[1] == null ? 1 : axis.pos(range[1]) ?? 1;
      g.fillStyle = applied.has(axis.name) ? 'rgba(59,143,208,.16)' : 'rgba(147,163,171,.10)';
      if (vertical) g.fillRect(x0 + a * w, y0, (b - a) * w, h);
      else g.fillRect(x0, y0 + (1 - b) * h, w, (b - a) * h);
    }
    g.strokeStyle = grid; g.lineWidth = 1; g.strokeRect(x0 + .5, y0 + .5, w - 1, h - 1);
    const px = [];
    // Filtered-out places first so kept ones sit on top.
    for (const pass of [false, true]) {
      g.fillStyle = dark ? 'rgba(147,163,171,.28)' : 'rgba(83,101,109,.22)';
      for (let k = 0; k < items.length; k++) {
        if (kept[k] !== pass) continue;
        const u = x.pos(x.vals[k]), v = y.pos(y.vals[k]);
        if (u == null || v == null) continue;
        const cx = x0 + 2 + u * (w - 4), cy = y0 + 2 + (1 - v) * (h - 4);
        if (pass) g.fillStyle = color[k];
        g.beginPath(); g.arc(cx, cy, pass ? dot : dot * .8, 0, 2 * Math.PI); g.fill();
        px.push([cx, cy, k]);
      }
    }
    points.push(px);
  }
  // Axis names: under the bottom row and beside the first column.
  g.fillStyle = ink; g.font = '600 9.5px system-ui'; g.textBaseline = 'middle';
  for (let c = 0; c < n; c++) { g.textAlign = 'center'; g.fillText(axes[c].stat.label(), left + c * (cw + gap) + cw / 2, n * (ch + gap) - gap + bottom / 2, cw); }
  for (let r = 0; r < n; r++) {
    g.save(); g.translate(left / 2, r * (ch + gap) + ch / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center';
    g.fillText(axes[r + 1].stat.label(), 0, 0, ch); g.restore();
  }
  // Key in the empty upper-right corner.
  if (n > 1) {
    const kx = left + cw + gap + 8, ky = 8;
    g.textAlign = 'left'; g.font = '11px system-ui';
    g.fillStyle = ramp[2]; g.beginPath(); g.arc(kx + 4, ky + 6, 3.5, 0, 7); g.fill(); g.fillStyle = ink; g.fillText(`Kept · ${nKept.toLocaleString()}`, kx + 12, ky + 6);
    g.fillStyle = dark ? 'rgba(147,163,171,.45)' : 'rgba(83,101,109,.4)'; g.beginPath(); g.arc(kx + 4, ky + 22, 3, 0, 7); g.fill();
    g.fillStyle = ink; g.fillText(`Filtered out · ${(items.length - nKept).toLocaleString()}`, kx + 12, ky + 22);
    g.fillText(filterOn() ? (f.all ? 'All ranges applied' : `Applied: ${stats[f.stat].label()}`) : 'Filter closed: nothing excluded', kx, ky + 40);
  }
  splom = {cells, points, items, W, H};
}
function splomCell(e) {
  if (!splom) return null;
  const box = $('splom-canvas').getBoundingClientRect(), x = e.clientX - box.left, y = e.clientY - box.top;
  const index = splom.cells.findIndex(c => x >= c.x0 && x <= c.x0 + c.w && y >= c.y0 && y <= c.y0 + c.h);
  return index < 0 ? {x, y} : {x, y, index, cell: splom.cells[index]};
}
function splomNearest(hit) {
  let best = null, d2 = 64;
  for (const [px, py, k] of splom.points[hit.index]) {
    const d = (px - hit.x) ** 2 + (py - hit.y) ** 2;
    if (d < d2) { d2 = d; best = k; }
  }
  return best;
}
let splomHover = null, splomDrag = null;
function splomLight(item, on) {
  if (!item) return;
  if (!item.isState) return highlight(item.key, on);
  state.states.eachLayer(layer => { if (layer.feature.properties.code === item.key) layer.setStyle(on ? {weight: 2.4, color: INK} : stateStyle(layer.feature)); });
}
$('splom-canvas').addEventListener('pointermove', e => {
  const hit = splomCell(e), tip = $('splom-tip');
  if (splomDrag) {
    splomDrag.x1 = Math.max(splomDrag.cell.x0, Math.min(splomDrag.cell.x0 + splomDrag.cell.w, hit.x));
    splomDrag.y1 = Math.max(splomDrag.cell.y0, Math.min(splomDrag.cell.y0 + splomDrag.cell.h, hit.y));
    updateSplom();
    const g = $('splom-canvas').getContext('2d'), d = splomDrag;
    g.strokeStyle = '#3b8fd0'; g.lineWidth = 1.2; g.setLineDash([4, 3]);
    g.strokeRect(Math.min(d.x, d.x1), Math.min(d.y, d.y1), Math.abs(d.x1 - d.x), Math.abs(d.y1 - d.y)); g.setLineDash([]);
    return;
  }
  const k = hit?.cell ? splomNearest(hit) : null, item = k == null ? null : splom.items[k];
  if (item !== splomHover) { splomLight(splomHover, false); splomLight(item, true); splomHover = item; }
  if (!item) { tip.hidden = true; return; }
  const {x, y} = hit.cell;
  tip.innerHTML = `<b>${item.name}</b><div>${x.stat.label()}: ${x.stat.format(x.vals[k])}</div><div>${y.stat.label()}: ${y.stat.format(y.vals[k])}</div>` +
    (passes(item.amounts, item.pop) ? '' : '<div class="muted">Filtered out</div>');
  tip.hidden = false;
  tip.style.left = Math.min(splom.W - tip.offsetWidth, hit.x + 12) + 'px';
  tip.style.top = Math.max(0, hit.y - tip.offsetHeight - 8) + 'px';
});
$('splom-canvas').addEventListener('pointerleave', () => { if (!splomDrag) { splomLight(splomHover, false); splomHover = null; $('splom-tip').hidden = true; } });
$('splom-canvas').addEventListener('pointerdown', e => {
  const hit = splomCell(e);
  if (!hit?.cell) return;
  e.currentTarget.setPointerCapture(e.pointerId);
  splomDrag = {...hit, x1: hit.x, y1: hit.y};
});
$('splom-canvas').addEventListener('pointerup', e => {
  const d = splomDrag;
  splomDrag = null;
  if (!d) return;
  const {cell} = d;
  if (Math.abs(d.x1 - d.x) < 4 && Math.abs(d.y1 - d.y) < 4) {
    // A click, not a box: open the place under the pointer.
    const k = splomNearest(d);
    if (k == null) return updateSplom();
    const item = splom.items[k];
    if (item.isState) return chooseState(item.key, modifier(e));
    const polygon = state.index.get(item.key);
    if (polygon) { focusArea(state.layer.level, polygon.feature, polygon); polygon.openTooltip(polygon.getBounds().getCenter()); }
    return;
  }
  // Pixel box -> value ranges on both statistics; both then apply.
  const toVal = (axis, t) => axis.ext.toVal(Math.max(0, Math.min(1, t)) * SLIDER);
  const u0 = (Math.min(d.x, d.x1) - cell.x0 - 2) / (cell.w - 4), u1 = (Math.max(d.x, d.x1) - cell.x0 - 2) / (cell.w - 4);
  const v0 = 1 - (Math.max(d.y, d.y1) - cell.y0 - 2) / (cell.h - 4), v1 = 1 - (Math.min(d.y, d.y1) - cell.y0 - 2) / (cell.h - 4);
  const f = state.filter;
  f.ranges[cell.x.name] = [u0 <= 0 ? null : toVal(cell.x, u0), u1 >= 1 ? null : toVal(cell.x, u1)];
  f.ranges[cell.y.name] = [v0 <= 0 ? null : toVal(cell.y, v0), v1 >= 1 ? null : toVal(cell.y, v1)];
  f.all = true;
  refresh();
});
$('splom-canvas').addEventListener('dblclick', e => {
  const hit = splomCell(e);
  if (!hit?.cell) return;
  delete state.filter.ranges[hit.cell.x.name]; delete state.filter.ranges[hit.cell.y.name];
  refresh();
});
$('filter-splom').addEventListener('click', () => openPanel('splom', $('splom').hidden));

/* Donors panel: where each candidate's itemized money comes from. */
function updateDonors() {
  if ($('donors').hidden || !state.statesByCode) return;
  const codes = [...new Set([...state.totals.keys()].map(k => k.split('|')[0]))];
  $('donors-period').textContent = periodLabel();
  $('donors-body').innerHTML = order.map(c => {
    const byState = codes.map(code => [code, values(state.totals, code + '|' + c, 'dollars')]).filter(([, v]) => v[0] > 0);
    const total = byState.reduce((s, [, v]) => s + v[0], 0), count = byState.reduce((s, [, v]) => s + v[2], 0);
    if (!total) return `<section class="card"><h2><span class="dot" style="background:${hues[c]}"></span>${names[c]}</h2><p class="muted">No itemized receipts in this period.</p></section>`;
    const tx = byState.find(([code]) => code === 'TX')?.[1][0] || 0, top = byState.sort((p, q) => q[1][0] - p[1][0]).slice(0, 6);
    return `<section class="card"><header><h2><span class="dot" style="background:${hues[c]}"></span>${names[c]}</h2><span class="muted-cell">${money(total)}</span></header>
      <div class="stat-row"><div><b>${Math.round(100 * tx / total)}%</b><span>from Texas</span></div><div><b>${money(total / count)}</b><span>avg contribution</span></div><div><b>${byState.length}</b><span>states &amp; areas</span></div></div>
      <div class="split" title="Texas vs. out of state"><i style="flex:${tx};background:${hues[c]}"></i><i style="flex:${total - tx};background:${hexBlend(hues[c], PALE, .6)}"></i></div>
      <ol class="bars">${top.map(([code, v]) => `<li data-code="${code}" class="${state.statesByCode[code] ? 'pick' : ''}"><span>${state.statesByCode[code] || code}</span>
        <span class="bar"><i style="width:${100 * v[0] / top[0][1][0]}%;background:${code === 'TX' ? hues[c] : hexBlend(hues[c], PALE, .35)}"></i></span><span>${Math.round(100 * v[0] / total)}%</span></li>`).join('')}</ol></section>`;
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
  const at = order.map(c => [c, all.reduce((s, code) => s + stateValues(code, c, 'dollars')[0], 0)]), max = Math.max(1, ...at.map(([, v]) => v));
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
  if (state.layer) state.timeline ? map.removeLayer(state.layer) : (state.layer.addTo(map), syncInteractivity());
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
const PANELS = ['side', 'rank', 'donors', 'timeline', 'filter', 'splom'];
const redraw = (id) => ({side: updatePanel, rank: updateRank, donors: updateDonors, timeline: updateTimeline, filter: updateFilter, splom: updateSplom})[id]?.();
function openPanel(id, open) {
  const panel = $(id);
  if (open && window.innerWidth <= 850) for (const other of PANELS) if (other !== id && !$(other).hidden) openPanel(other, false);
  panel.hidden = !open;
  document.querySelector(`[data-panel="${id}"]`)?.setAttribute('aria-pressed', String(open));
  if (id === 'timeline') setTimeline(open);
  if (id === 'filter') loadLevel(state.level).then(refresh, showError);
  // The scatter plots travel with the filter: they open docked just above it and close with it.
  if (id === 'filter' && !open && !$('splom').hidden) openPanel('splom', false);
  if (id === 'splom' && open && window.innerWidth > 850) { panel.hidden = false; front(panel); dockSplom(); redraw(id); return; }
  if (open) {
    front(panel);
    if (id === 'filter' && window.innerWidth > 850) setTimeout(() => openPanel('splom', true));
    if (id === 'rank') loadLevel(state.level).then(updateRank, showError);
    redraw(id);
    placeFree(panel);
    redraw(id);
  }
}

function restyle() {
  state.states.setStyle(stateStyle);
  if (state.layer) { state.layer.setStyle(feature => areaStyle(state.layer.level, feature)); syncInteractivity(); }
}
function refresh() {
  if (!state.states) return;
  computeScales();
  restyle();
  document.querySelectorAll('.candidate-dot').forEach(dot => { dot.style.background = hues[state[dot.dataset.slot]]; });
  updateLegend(); updatePanel(); updateRank(); updateDonors(); updateTimeline(); updateFilter(); updateSplom();
}
function setData(on, opacity = state.dataOpacity) {
  state.dataOn = on; state.dataOpacity = opacity;
  try { localStorage.setItem('dataOn', JSON.stringify(on)); localStorage.setItem('dataOpacity', JSON.stringify(opacity)); } catch {}
  $('data-toggle').setAttribute('aria-pressed', String(on));
  restyle();
}
async function start() {
  const [boundaries, totals, coverage] = await Promise.all([
    loadManifest().then(() => geoResponse('data/states.json')).then(r => r.json()), file('data/state_totals.csv'), json('data/coverage.json')]);
  addRows(csv(totals), state.totals, row => row.state + '|' + row.candidate);
  state.coverage = coverage;
  state.statesByCode = Object.fromEntries(boundaries.features.map(f => [f.properties.code, f.properties.name]));
  for (const [code, name] of Object.entries(state.statesByCode).sort((a, b) => a[1].localeCompare(b[1]))) {
    const label = document.createElement('label'), input = document.createElement('input');
    input.type = 'checkbox'; input.value = code;
    label.append(input, `${name} (${code})`);
    $('state-options').append(label);
  }
  // Max-out donors by reported state and ZIP (small); states are sums of their ZIP rows.
  state.maxLoaded = file('data/maxouts.csv').then(text => {
    const rows = csv(text);
    addMaxouts(rows, state.totals, row => row.state + '|' + row.candidate);
    addMaxouts(rows.filter(row => row.zip), state.receipts, row => row.state + '|' + row.zip + '|' + row.candidate);
    refresh();
    return true;
  }).catch(() => { state.maxLoaded = null; $('measure').querySelectorAll('[value^=max]').forEach(o => { o.disabled = true; }); });
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
      let prefetch;
      layer.on('mouseover', () => {
        layer.setStyle({weight: 2.4, color: INK});
        // Hovering a state for a moment fetches its boundary file into the cache, ready for the click.
        if (levels[state.level].detail && finePointer) prefetch = setTimeout(() => prefetchGeo(statePath(state.level, code)), 200);
      });
      layer.on('mouseout', () => { clearTimeout(prefetch); layer.setStyle(stateStyle(feature)); });
    }
  }).addTo(map);
  $('coverage').textContent = `FEC through ${coverage.coverage_end} · ${coverage.filing_count} filings`;
  if (coverage.placement) $('about-placement').textContent = 'Placed by address: ' + Object.entries(coverage.placement)
    .map(([level, p]) => `${levels[level].label} ${Math.round(100 * p.address_cents / p.matched_cents)}%`).join(', ') + ' of dollars.';
  const near = Object.values(coverage.maxouts?.near_limit || {}).reduce((a, b) => a + b, 0);
  if (near) $('about-near').textContent = `; ${near.toLocaleString()} donor-elections have itemized totals between $3,300 and $3,499.99`;
  syncMeasure();
  if (window.innerWidth <= 850) { $('side').classList.add('collapsed'); $('side-toggle').setAttribute('aria-expanded', 'false'); }
  for (const id of PANELS) floating($(id));
  syncCandidates();
  syncControls();
  await render();
  (window.requestIdleCallback || setTimeout)(() => evictGeo());
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
// Max-out measures count donors per election, so the Period slider gives way to an Election choice.
function syncMeasure() {
  $('election-control').hidden = !maxMode();
  $('period-control').classList.toggle('inactive', maxMode());
  $('period-control').title = maxMode() ? 'Max-out donors are counted per election; choose the election instead' : '';
}
$('measure').addEventListener('change', async e => {
  state.measure = e.target.value;
  syncMeasure();
  try { await loadLevel(state.level); } catch (error) { showError(error); }
  refresh();
});
$('election').addEventListener('change', e => { state.election = e.target.value; refresh(); });
$('geography').addEventListener('change', e => {
  if (e.target.value === 'choose') { syncControls(); openStateMenu(); }
  else if (e.target.value === 'overview') resetView();
  else setLevel(e.target.value);
});
$('state-picker').addEventListener('click', () => $('state-menu').hidden ? openStateMenu() : closeStateMenu());
$('state-close').addEventListener('click', closeStateMenu);
$('state-apply').addEventListener('click', applyStateSelection);
$('state-clear').addEventListener('click', () => $('state-options').querySelectorAll('input').forEach(input => { input.checked = false; }));
$('state-search').addEventListener('input', e => {
  const query = e.target.value.trim().toLowerCase();
  $('state-options').querySelectorAll('label').forEach(label => { label.hidden = !label.textContent.toLowerCase().includes(query); });
});
document.addEventListener('pointerdown', e => {
  if (!$('state-menu').hidden && !e.target.closest('#state-menu, #state-picker, #geography')) closeStateMenu();
});
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
  // Ranking an area level with nothing open shows it nationwide.
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
  if (polygon) { focusArea(state.layer.level, polygon.feature, polygon); polygon.openTooltip(polygon.getBounds().getCenter()); }
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
$('legend').addEventListener('click', e => {
  if (e.target.closest('#empty-toggle')) { state.showEmpty = !state.showEmpty; refresh(); }
  else if (e.target.closest('.legend-title')) $('legend').classList.toggle('collapsed');
});
window.addEventListener('resize', fitLegend);
function setTheme(name) {
  ({NEUTRAL, PALE, EMPTY, INK, LINE, EDGE, CONTEXT} = themes[name]);
  document.documentElement.classList.toggle('dark', name === 'dark');
  $('theme').setAttribute('aria-pressed', String(name === 'dark'));
  try { localStorage.setItem('theme', name); } catch {}
  refresh();
}
$('theme').addEventListener('click', () => setTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark'));
$('home').addEventListener('click', resetView);
$('nation').addEventListener('click', () => setNationwide(!state.nationwide));
$('zoom-in').addEventListener('click', () => map.zoomIn());
$('zoom-out').addEventListener('click', () => map.zoomOut());
map.on('moveend', () => { if (detailKey() !== state.visibleKey) render(); });
$('data-toggle').addEventListener('click', () => { setData(!state.dataOn); updateLegend(); });
$('legend').addEventListener('click', e => { if (e.target.closest('#data-switch')) { setData(!state.dataOn); updateLegend(); } });
// Opacity restyles only, so the slider is not rebuilt mid-drag.
$('legend').addEventListener('input', e => { if (e.target.id === 'data-opacity') setData(true, Number(e.target.value) / 100); });
$('tiles').addEventListener('click', () => {
  const active = map.hasLayer(tiles);
  active ? map.removeLayer(tiles) : tiles.addTo(map);
  $('tiles').setAttribute('aria-pressed', String(!active));
});
function about(open) { $('about').hidden = !open; if (open) front($('about')); $('about-toggle').setAttribute('aria-expanded', String(open)); }
$('about-toggle').addEventListener('click', () => about($('about').hidden));
$('about-close').addEventListener('click', () => about(false));
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('state-menu').hidden) return closeStateMenu();
  if (e.target.closest('select, input')) return;
  if (!$('about').hidden) return about(false);
  if (state.focused) return returnToSelection();
  if (state.selected.length || state.nationwide) resetView();
});
{ let saved = null; try { saved = localStorage.getItem('theme'); } catch {} setTheme(themes[saved] ? saved : 'dark'); }
start().catch(showError);
