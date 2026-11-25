import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// Popisky obcí a ulic + značky zajímavostí (HTML prvky ukotvené ve 3D).
// Vše vypínatelné v panelu „Zajímavosti“; volby se pamatují v prohlížeči.

const ICON = {
  cirkev: '✝', smirci: '✠', pamatnik: '★', stavba: '⌂', priroda: '♣',
  historie: '⌛', obec: '◉', turistika: '⚑', sluzby: 'i',
};
const DIST = { poi: 1800, service: 900, poiName: 380, street: 650, place: 12000 };

function load(key, def) {
  try { const v = localStorage.getItem(`stod3d.v2.${key}`); return v === null ? def : JSON.parse(v); } catch { return def; }
}
function save(key, v) {
  try { localStorage.setItem(`stod3d.v2.${key}`, JSON.stringify(v)); } catch { /* ignorovat */ }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function createLabels({ data, world, scene, camera, container, onChange, flyTo }) {
  const renderer = new CSS2DRenderer();
  renderer.setSize(innerWidth, innerHeight);
  Object.assign(renderer.domElement.style, { position: 'fixed', inset: '0', pointerEvents: 'none' });
  renderer.domElement.id = 'labels';
  container.appendChild(renderer.domElement);

  const state = {
    places: load('places', false),
    streets: load('streets', false),
    pois: load('pois', false),
    cats: load('cats', Object.fromEntries(Object.keys(data.categories).map((k) => [k, true]))),
  };
  const groups = { places: new THREE.Group(), streets: new THREE.Group(), pois: new THREE.Group() };
  Object.values(groups).forEach((g) => scene.add(g));
  const items = [];               // { obj, x, z, lift, kind, poi?, el }

  // ---------------------------------------------------------------- obce
  for (const p of data.places) {
    const e = el('div', `lbl-place rank${p.rank}`, p.name);
    if (p.pop) e.title = `${p.pop} obyvatel`;
    const obj = new CSS2DObject(e);
    groups.places.add(obj);
    items.push({ obj, x: p.x, z: p.z, lift: p.rank >= 3 ? 90 : 55, kind: 'place' });
  }

  // ---------------------------------------------------------------- ulice: popisek uprostřed nejdelšího úseku
  for (const s of data.streets) {
    let best = null, bestL = 0;
    for (const path of s.paths) {
      let L = 0;
      for (let i = 1; i < path.length; i++) L += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
      if (L > bestL) { bestL = L; best = path; }
    }
    if (!best) continue;
    let half = bestL / 2, x = best[0][0], z = best[0][1];
    for (let i = 1; i < best.length; i++) {
      const L = Math.hypot(best[i][0] - best[i - 1][0], best[i][1] - best[i - 1][1]);
      if (half <= L) {
        const t = half / L;
        x = best[i - 1][0] + (best[i][0] - best[i - 1][0]) * t;
        z = best[i - 1][1] + (best[i][1] - best[i - 1][1]) * t;
        break;
      }
      half -= L;
    }
    const obj = new CSS2DObject(el('div', 'lbl-street', s.name));
    groups.streets.add(obj);
    items.push({ obj, x, z, lift: 4, kind: 'street' });
  }

  // ---------------------------------------------------------------- zajímavosti
  const info = document.getElementById('poi-info');
  let selected = null;

  function showInfo(p) {
    selected = p;
    info.replaceChildren();
    const head = el('div', 'poi-head');
    head.append(el('span', `poi-ico cat-${p.cat}`, ICON[p.cat] || '•'), el('h3', '', p.name));
    const close = el('button', 'poi-close', '×');
    close.title = 'Zavřít';
    close.onclick = () => { info.hidden = true; selected = null; };
    head.append(close);
    info.append(head);
    const meta = [data.categories[p.cat], p.year ? `rok ${p.year}` : null].filter(Boolean).join(' · ');
    info.append(el('div', 'poi-meta', meta));
    if (p.text) info.append(el('p', 'poi-text', p.text));
    if (p.links?.length) {
      const ul = el('ul', 'poi-links');
      for (const l of p.links) {
        const a = el('a', '', l.replace(/^https?:\/\/(www\.)?/, '').slice(0, 48) + (l.length > 56 ? '…' : ''));
        a.href = l; a.target = '_blank'; a.rel = 'noopener';
        const li = el('li'); li.append(a); ul.append(li);
      }
      info.append(ul);
    }
    info.append(el('div', 'poi-src', `Zdroj: ${p.src}`));
    const go = el('button', 'poi-go', 'Přiblížit');
    go.onclick = () => flyTo(p.x, p.z, 260);
    info.append(go);
    info.hidden = false;
  }

  const poiItems = [];
  for (const p of data.pois) {
    const e = el('div', `poi cat-${p.cat}`);
    e.append(el('span', 'poi-ico', ICON[p.cat] || '•'), el('span', 'poi-name', p.name));
    e.title = p.name;
    e.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    e.addEventListener('click', (ev) => { ev.stopPropagation(); showInfo(p); });
    const obj = new CSS2DObject(e);
    groups.pois.add(obj);
    const it = { obj, x: p.x, z: p.z, lift: 3, kind: 'poi', poi: p, el: e };
    items.push(it);
    poiItems.push(it);
  }

  // ---------------------------------------------------------------- panel
  const panel = document.getElementById('poi-panel');
  const toggles = panel.querySelector('.toggles');
  const mk = (label, checked, onToggle, cls = '') => {
    const l = el('label', `tg ${cls}`);
    const c = el('input');
    c.type = 'checkbox'; c.checked = checked;
    c.onchange = () => { onToggle(c.checked); refresh(); };
    l.append(c, document.createTextNode(` ${label}`));
    toggles.append(l);
    return c;
  };
  mk('Názvy obcí', state.places, (v) => { state.places = v; save('places', v); });
  mk('Názvy ulic', state.streets, (v) => { state.streets = v; save('streets', v); });
  mk('Zajímavosti', state.pois, (v) => { state.pois = v; save('pois', v); }, 'strong');
  for (const [k, name] of Object.entries(data.categories)) {
    const n = data.pois.filter((p) => p.cat === k).length;
    if (!n) continue;
    const c = mk(`${ICON[k]}  ${name} (${n})`, state.cats[k] !== false, (v) => { state.cats[k] = v; save('cats', state.cats); }, `sub cat-${k}`);
    c.dataset.cat = k;
  }

  const list = panel.querySelector('.poi-list');
  function renderList() {
    list.replaceChildren();
    const shown = data.pois.filter((p) => state.cats[p.cat] !== false);
    shown.sort((a, b) => a.name.localeCompare(b.name, 'cs'));
    for (const p of shown.slice(0, 300)) {
      const li = el('li');
      const b = el('button');
      b.append(el('span', `poi-ico cat-${p.cat}`, ICON[p.cat] || '•'), document.createTextNode(` ${p.name}`));
      b.onclick = () => { showInfo(p); highlight(p.name, p.x, p.z); flyTo(p.x, p.z, 320); };
      li.append(b);
      list.append(li);
    }
    panel.querySelector('.count').textContent = `${shown.length} položek`;
  }

  // ---------------------------------------------------------------- zvýraznění nalezeného místa
  const hlEl = el('div', 'hl');
  const hlName = el('span', 'hl-name');
  hlEl.append(hlName, el('span', 'hl-pin', '▼'));
  const hl = new CSS2DObject(hlEl);
  hl.visible = false;
  scene.add(hl);
  const hlPos = { x: 0, z: 0 };
  function highlight(name, x, z) {
    hlName.textContent = name;
    hlPos.x = x; hlPos.z = z;
    hl.visible = true;
    onChange();
  }

  // ---------------------------------------------------------------- vyhledávání
  const norm = (t) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const TYPE = { place: 'Obec', street: 'Ulice', addr: 'Adresa' };
  const index = [];
  for (const p of data.places) index.push({ kind: 'place', name: p.name, x: p.x, z: p.z, order: 0 });
  for (const it of items.filter((i) => i.kind === 'street')) {
    index.push({ kind: 'street', name: it.obj.element.textContent, x: it.x, z: it.z, order: 1 });
  }
  for (const p of data.pois) index.push({ kind: 'poi', name: p.name, x: p.x, z: p.z, poi: p, order: 2 });
  for (const [name, x, z] of data.addresses || []) index.push({ kind: 'addr', name, x, z, order: 3 });
  for (const e of index) e.key = norm(e.name);

  const box = document.getElementById('search');
  const input = box.querySelector('input');
  const results = box.querySelector('.results');
  let found = [], active = -1;

  function choose(e) {
    if (!e) return;
    results.hidden = true;
    input.value = e.name;
    highlight(e.name, e.x, e.z);
    if (e.poi) showInfo(e.poi);
    flyTo(e.x, e.z, e.kind === 'place' ? 750 : e.kind === 'street' ? 380 : 320);
    input.blur();
  }
  function renderResults() {
    results.replaceChildren();
    found.forEach((e, i) => {
      const li = el('li', i === active ? 'active' : '');
      const ico = e.poi ? el('span', `poi-ico cat-${e.poi.cat}`, ICON[e.poi.cat] || '•') : el('span', `res-ico ${e.kind}`);
      const label = el('span', 'res-name', e.name);
      const type = el('span', 'res-type', e.poi ? data.categories[e.poi.cat] : TYPE[e.kind]);
      li.append(ico, label, type);
      li.onmousedown = (ev) => { ev.preventDefault(); choose(e); };
      results.append(li);
    });
    results.hidden = !found.length;
  }
  input.addEventListener('input', () => {
    const q = norm(input.value.trim());
    active = -1;
    if (q.length < 2) { found = []; renderResults(); return; }
    const toks = q.split(/\s+/);
    found = index.filter((e) => toks.every((t) => e.key.includes(t)))
      .map((e) => ({ e, score: e.order * 10 + (e.key.startsWith(toks[0]) ? 0 : 5) + e.key.length / 100 }))
      .sort((a, b) => a.score - b.score).slice(0, 12).map((r) => r.e);
    renderResults();
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') { active = Math.min(found.length - 1, active + 1); renderResults(); ev.preventDefault(); }
    else if (ev.key === 'ArrowUp') { active = Math.max(0, active - 1); renderResults(); ev.preventDefault(); }
    else if (ev.key === 'Enter') choose(found[active >= 0 ? active : 0]);
    else if (ev.key === 'Escape') { input.value = ''; found = []; renderResults(); hl.visible = false; onChange(); input.blur(); }
    ev.stopPropagation();          // psaní nesmí ovládat kameru (W, A, S, D…)
  });
  input.addEventListener('keyup', (ev) => ev.stopPropagation());
  input.addEventListener('focus', () => { if (found.length) results.hidden = false; });
  input.addEventListener('blur', () => { results.hidden = true; });
  input.addEventListener('search', () => { if (!input.value) { hl.visible = false; onChange(); } });

  function refresh() {
    groups.places.visible = state.places;
    groups.streets.visible = state.streets;
    groups.pois.visible = state.pois;
    // kategorie, hledání a seznam jen když jsou zajímavosti zapnuté
    panel.querySelector('.poi-browse').hidden = !state.pois;
    toggles.querySelectorAll('.tg.sub').forEach((l) => { l.hidden = !state.pois; });
    if (!state.pois) { info.hidden = true; selected = null; }
    renderList();
    onChange();
  }
  refresh();

  // ---------------------------------------------------------------- aktualizace před vykreslením
  const cam = new THREE.Vector3();
  function update() {
    cam.copy(camera.position);
    if (hl.visible) hl.position.set(hlPos.x, world.heightAt(hlPos.x, hlPos.z) + 3, hlPos.z);
    for (const it of items) {
      const g = it.kind === 'street' ? groups.streets : it.kind === 'place' ? groups.places : groups.pois;
      if (!g.visible) continue;
      const d = Math.hypot(it.x - cam.x, it.z - cam.z);
      const max = it.kind === 'place' ? DIST.place : it.kind === 'street' ? DIST.street
        : it.poi.cat === 'sluzby' ? DIST.service : DIST.poi;
      const catOk = it.kind !== 'poi' || state.cats[it.poi.cat] !== false;
      const vis = catOk && (d < max || (it.poi && it.poi === selected));
      it.obj.visible = vis;
      if (!vis) continue;
      it.obj.position.set(it.x, world.heightAt(it.x, it.z) + it.lift, it.z);
      if (it.el) it.el.classList.toggle('named', d < DIST.poiName || it.poi === selected);
    }
  }

  return {
    render(scene_, camera_) { update(); renderer.render(scene_, camera_); },
    resize() { renderer.setSize(innerWidth, innerHeight); },
    highlight,
  };
}
