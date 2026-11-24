import * as THREE from 'three';

// Formulář „Nahlásit chybu nebo změnu“ – odesílá na api/reports (tools/server.py nebo api/reports.php).
// Poloha: střed aktuálního pohledu, nebo místo vybrané kliknutím do mapy.

const API = 'api/reports';

export function createReport({ camera, canvas, world, orbit, addresses, mark, onChange }) {
  const dlg = document.getElementById('report');
  const form = dlg.querySelector('form');
  const where = dlg.querySelector('.where');
  const msg = dlg.querySelector('.msg');
  const pickBtn = dlg.querySelector('.pick');
  let pos = null, picking = false;

  // nejbližší adresa – lidsky čitelný popis místa
  function describe(x, z) {
    let best = null, bd = 150;
    for (const [name, ax, az] of addresses || []) {
      const d = Math.hypot(ax - x, az - z);
      if (d < bd) { bd = d; best = name; }
    }
    return best ? (bd < 25 ? best : `u adresy ${best}`) : 'mimo zástavbu';
  }

  function setPos(x, z) {
    pos = { x, z, place: describe(x, z) };
    where.textContent = `${pos.place} (x ${x.toFixed(0)}, z ${z.toFixed(0)})`;
    mark('Nahlášené místo', x, z);
  }

  // bod na terénu pod kurzorem: paprsek z kamery, krokování po výškách terénu
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), p = new THREE.Vector3();
  function pickGround(ev) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    let prev = 0;
    for (let t = 1; t < 9000; t += Math.max(1, t * 0.01)) {
      p.copy(o).addScaledVector(d, t);
      if (p.y < world.heightAt(p.x, p.z)) {
        let a = prev, b = t;                   // zpřesnění půlením
        for (let i = 0; i < 20; i++) {
          const m = (a + b) / 2;
          p.copy(o).addScaledVector(d, m);
          if (p.y < world.heightAt(p.x, p.z)) b = m; else a = m;
        }
        return p.clone();
      }
      prev = t;
    }
    return null;
  }

  function open() {
    msg.textContent = '';
    msg.className = 'msg';
    if (!pos) setPos(orbit.target.x, orbit.target.z);
    dlg.hidden = false;
    form.querySelector('textarea').focus();
  }
  function close() {
    dlg.hidden = true;
    picking = false;
    document.body.classList.remove('picking');
  }

  document.getElementById('report-open').onclick = open;
  dlg.querySelector('.close').onclick = close;
  dlg.querySelector('.here').onclick = () => setPos(orbit.target.x, orbit.target.z);
  pickBtn.onclick = () => {
    picking = true;
    dlg.hidden = true;
    document.body.classList.add('picking');
  };
  // výběr místa: klik bez tažení (tažení dál otáčí mapou)
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', (e) => {
    if (!picking || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const g = pickGround(e);
    if (g) setPos(g.x, g.z);
    picking = false;
    document.body.classList.remove('picking');
    dlg.hidden = false;
    onChange();
  });

  // klávesy ve formuláři nesmí hýbat mapou
  dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); e.stopPropagation(); });
  dlg.addEventListener('keyup', (e) => e.stopPropagation());

  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = Object.fromEntries(fd.entries());
    Object.assign(body, { x: pos?.x, z: pos?.z, place: pos?.place, view: location.hash.slice(1) });
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    msg.className = 'msg';
    msg.textContent = 'Odesílám…';
    try {
      const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Server odpověděl ${r.status}.`);
      msg.className = 'msg ok';
      msg.textContent = `Děkujeme, hlášení č. ${j.id ?? ''} bylo uloženo.`;
      form.reset();
      setTimeout(close, 1800);
    } catch (err) {
      msg.className = 'msg err';
      msg.textContent = err.message.includes('Failed to fetch') || err.message.includes('404') || err.message.includes('501')
        ? 'Hlášení teď nejde odeslat – server nepřijímá hlášení (spusťte tools/server.py).'
        : err.message;
    } finally {
      btn.disabled = false;
    }
  };
}
