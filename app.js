/* Static FEC map. State shapes and ZCTAs are fetched only as the user opens them. */
const $ = (id) => document.getElementById(id);
const names = {C00919084: 'Talarico', C00369033: 'Cornyn', C00901918: 'Paxton'};
const phases = ['pre_primary', 'between_primary_runoff', 'post_runoff'];
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
const state = {period: 'between_primary_runoff', first: 'C00919084', second: 'C00901918', measure: 'lead',
  receipts: new Map(), totals: new Map(), zctas: new Map(), open: new Map(), pending: new Map(), states: null, coverage: null};
const map = L.map('map', {zoomControl: false, doubleClickZoom: false, minZoom: 3, maxZoom: 12, preferCanvas: true,
  worldCopyJump: false, zoomSnap: .25, maxBounds: [[-10, -185], [73, -40]], maxBoundsViscosity: .6});
map.createPane('statePane'); map.getPane('statePane').style.zIndex = 410;
map.createPane('zctaPane'); map.getPane('zctaPane').style.zIndex = 420;
map.setView([31, -99], 5);
const tiles = L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 12, opacity: .5, attribution: 'Basemap: <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map" target="_blank" rel="noopener">USGS The National Map</a>'
}).addTo(map);
map.attributionControl.setPrefix('<a href="https://leafletjs.com/" target="_blank" rel="noopener">Leaflet</a> · <a href="https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html" target="_blank" rel="noopener">Census ZCTAs</a>');

function csv(text) {
  const lines = text.trim().split(/\r?\n/), head = lines.shift().split(',');
  return lines.filter(Boolean).map(line => Object.fromEntries(line.split(',').map((value, index) => [head[index], value])));
}
async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
  return response.json();
}
async function packed(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
  if (!globalThis.DecompressionStream) throw new Error('This browser needs gzip stream support to display ZCTAs.');
  return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
}
async function file(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
  return response.text();
}
function addRows(rows, destination, key) {
  for (const row of rows) {
    const id = key(row), phase = row.phase;
    let item = destination.get(id);
    if (!item) { item = Object.fromEntries(phases.map(p => [p, [0, 0, 0]])); destination.set(id, item); }
    item[phase] = [Number(row.positive_cents) / 100, Number(row.net_cents) / 100, Number(row.count)];
  }
}
function values(store, id) {
  const item = store.get(id);
  if (!item) return [0, 0, 0];
  return state.period === 'all' ? phases.reduce((sum, phase) => sum.map((n, i) => n + item[phase][i]), [0, 0, 0]) : item[state.period];
}
function comparison(store, key) {
  return [values(store, key + '|' + state.first), values(store, key + '|' + state.second)];
}
function hexBlend(a, b, ratio) {
  const toRGB = x => [1, 3, 5].map(i => parseInt(x.slice(i, i + 2), 16));
  const x = toRGB(a), y = toRGB(b), t = Math.max(0, Math.min(1, ratio));
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
function color(amounts) {
  const a = amounts[0][0], b = amounts[1][0], total = a + b;
  if (total <= 0) return {fillColor: '#d7dddc', fillOpacity: .6};
  if (state.measure === 'volume') {
    const t = Math.min(1, Math.log10(total + 1) / 5);
    return {fillColor: hexBlend('#e9e1d8', '#174b6a', t), fillOpacity: .88};
  }
  const share = a / total;
  const base = share < .5 ? hexBlend('#ac3546', '#e7e2df', share * 2) : hexBlend('#e7e2df', '#246a93', (share - .5) * 2);
  return {fillColor: base, fillOpacity: Math.min(.94, .48 + Math.log10(total + 1) / 10)};
}
function stateStyle(feature) {
  const code = feature.properties.code;
  return {pane: 'statePane', color: '#647783', weight: state.open.has(code) ? 1.8 : .8,
    opacity: .85, ...color(comparison(state.totals, code)), fillOpacity: state.open.has(code) ? .08 : .8};
}
function zctaStyle(code, feature) {
  return {pane: 'zctaPane', color: '#667b83', weight: .45, opacity: .35,
    ...color(comparison(state.receipts, code + '|' + feature.properties.zip))};
}
function tooltip(code, zip) {
  const [a, b] = comparison(zip ? state.receipts : state.totals, code + (zip ? '|' + zip : ''));
  const total = a[0] + b[0];
  const share = total ? `${Math.round(100 * a[0] / total)}% ${names[state.first]}` : 'No mapped receipts';
  return `<div class="tooltip-title">${zip ? `ZCTA ${zip} · ${code}` : state.statesByCode[code]}</div>` +
    `<div>${names[state.first]} ${money(a[0])} · ${names[state.second]} ${money(b[0])}</div>` +
    `<div class="tooltip-sub">${share} · ${(a[2] + b[2]).toLocaleString()} entries</div>`;
}
function showError(error) {
  $('error').textContent = error.message || String(error);
  $('error').hidden = false;
  console.error(error);
}
async function openState(code, fit = true) {
  if (state.open.has(code)) { if (fit) map.fitBounds(state.open.get(code).getBounds(), {padding: [30, 30], maxZoom: 8}); return; }
  if (state.pending.has(code)) return;
  const request = Symbol(code);
  state.pending.set(code, request);
  $('scope').textContent = `Loading ${state.statesByCode[code]}…`;
  try {
    let geo = state.zctas.get(code);
    if (!geo) { geo = await packed(`data/zctas/${encodeURIComponent(code)}.bin`); state.zctas.set(code, geo); }
    if (state.pending.get(code) !== request) return;
    const layer = L.geoJSON(geo, {
      pane: 'zctaPane', style: feature => zctaStyle(code, feature),
      onEachFeature: (feature, polygon) => {
        const zip = feature.properties.zip;
        polygon.bindTooltip(() => tooltip(code, zip), {sticky: true, direction: 'top'});
        let singleClick;
        polygon.on('click', e => { L.DomEvent.stopPropagation(e); clearTimeout(singleClick);
          singleClick = setTimeout(() => map.fitBounds(polygon.getBounds(), {padding: [55, 55], maxZoom: 10}), 230); });
        polygon.on('dblclick', e => { L.DomEvent.stopPropagation(e); clearTimeout(singleClick); closeState(code); });
        polygon.on('mouseover', () => polygon.setStyle({weight: 1.4, color: '#253d49', opacity: .9}));
        polygon.on('mouseout', () => polygon.setStyle(zctaStyle(code, feature)));
      }
    }).addTo(map);
    state.open.set(code, layer);
    state.states.setStyle(stateStyle);
    updateScope();
    if (fit) map.fitBounds(layer.getBounds(), {padding: [35, 35], maxZoom: 8});
  } catch (error) { showError(error); updateScope(); }
  finally { if (state.pending.get(code) === request) state.pending.delete(code); }
}
function closeState(code) {
  state.pending.delete(code);
  const layer = state.open.get(code);
  if (!layer) return;
  map.removeLayer(layer); state.open.delete(code); state.states.setStyle(stateStyle); updateScope();
}
function updateScope() {
  const codes = [...state.open.keys()];
  $('scope').textContent = codes.length ? `${codes.map(c => state.statesByCode[c]).join(' · ')} · ZCTAs` : 'U.S. · click a state to open ZCTAs';
}
function updateLegend() {
  if (state.measure === 'volume') {
    $('legend').innerHTML = `<div class="legend-title">Combined positive receipts</div><div class="scale volume"></div><div class="ticks"><span>$0</span><span>$100</span><span>$10k</span><span>$100k+</span></div><div class="legend-note">Same scale for states and ZCTAs · gray has no receipts</div>`;
  } else {
    $('legend').innerHTML = `<div class="legend-title">Share of positive receipts</div><div class="scale"></div><div class="ticks"><span>${names[state.second]} 100%</span><span>50 / 50</span><span>${names[state.first]} 100%</span></div><div class="legend-note">Fainter areas have fewer dollars · gray has no receipts</div>`;
  }
}
function refresh() {
  if (!state.states) return;
  state.states.setStyle(stateStyle);
  for (const [code, layer] of state.open) layer.setStyle(feature => zctaStyle(code, feature));
  updateLegend();
}
async function start() {
  const [boundaries, receipts, totals, coverage] = await Promise.all([
    json('data/states.json'), file('data/receipts.csv'), file('data/state_totals.csv'), json('data/coverage.json')]);
  addRows(csv(receipts), state.receipts, row => row.state + '|' + row.zip + '|' + row.candidate);
  addRows(csv(totals), state.totals, row => row.state + '|' + row.candidate);
  state.coverage = coverage;
  state.statesByCode = Object.fromEntries(boundaries.features.map(f => [f.properties.code, f.properties.name]));
  state.states = L.geoJSON(boundaries, {
    pane: 'statePane', style: stateStyle,
    onEachFeature: (feature, layer) => {
      const code = feature.properties.code;
      layer.bindTooltip(() => tooltip(code), {sticky: true, direction: 'top'});
      let singleClick;
      layer.on('click', e => { L.DomEvent.stopPropagation(e); clearTimeout(singleClick);
        singleClick = setTimeout(() => openState(code), 230); });
      layer.on('dblclick', e => { L.DomEvent.stopPropagation(e); clearTimeout(singleClick); closeState(code); });
      layer.on('mouseover', () => layer.setStyle({weight: 2, color: '#293f49'}));
      layer.on('mouseout', () => layer.setStyle(stateStyle(feature)));
    }
  }).addTo(map);
  $('coverage').textContent = `FEC through ${coverage.coverage_end} · ${coverage.filing_count} filings`;
  updateLegend();
  await openState('TX', false);
  const tx = state.open.get('TX');
  if (tx) map.fitBounds(tx.getBounds(), {paddingTopLeft: [40, 90], paddingBottomRight: [35, 60], maxZoom: 7});
}

$('period').addEventListener('change', e => {state.period = e.target.value; refresh();});
$('measure').addEventListener('change', e => {state.measure = e.target.value; refresh();});
for (const id of ['first', 'second']) $(id).addEventListener('change', e => {
  const other = id === 'first' ? 'second' : 'first';
  if (e.target.value === $(other).value) $(other).value = id === 'first' ? state.first : state.second;
  state.first = $('first').value; state.second = $('second').value; refresh();
});
$('home').addEventListener('click', () => openState('TX'));
$('nation').addEventListener('click', () => map.fitBounds([[24, -125], [50, -66]], {padding: [35, 35], maxZoom: 4.5}));
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
