// Отрисовка на three.js: видео как текстура сцены (с эффектами в шейдере), спрайты из одного атласа
// тремя InstancedMesh (обычный, аддитивное свечение, верхний слой), свечение — UnrealBloomPass с порогом 1.0
// (светится только то, что ярче 1).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { T, PAL, ANTS } from './config.js';
import { rand } from './util.js';
import { G, head, input, view, flags } from './state.js';

let renderer, composer, camera, videoMesh, normal, glow, top, atlasTex;
export let atlasReady = Promise.resolve(); // иконки бонусов дорисованы в атлас (SVG грузятся асинхронно)
const stars = [];

// ---------- атлас: все картинки рисуются один раз в Canvas 2D ----------
const S = 2048, A = {}; // имя → [u0, v0, du, dv]
// ячейка муравья 256 px ↔ 40 «единиц муравья»; кольцо радиуса 120 px в ячейке 256; иконка бонуса — круг r=56 в ячейке 128
const ANT = 40, ANT_PX = 256 / ANT, RING = 256 / 120, ICON = 128 / 56 * 30;

// Внешний вид видов. body — [блик, основной, тень] для объёма; head/gaster/mand/legLen/slim — пропорции
const LOOKS = {
  worker:  { body: ['#e8553a', '#a52512', '#3e0703'], leg: '#3b0a05', head: 1,    gaster: 1,    mand: 1,   legLen: 1,    slim: 1 },
  soldier: { body: ['#c43c26', '#6e140a', '#220302'], leg: '#260503', head: 1.45, gaster: 1.05, mand: 2.1, legLen: 1,    slim: 1.12 },
  runner:  { body: ['#ffc15a', '#e07a1c', '#6e2a04'], leg: '#5e2405', head: 0.9,  gaster: 0.78, mand: 0.8, legLen: 1.35, slim: 0.82 },
  flyer:   { body: ['#c88450', '#734019', '#261204'], leg: '#2a1406', head: 0.95, gaster: 0.95, mand: 0.9, legLen: 1.05, slim: 0.95, wings: true },
  armored: { body: ['#7c82a3', '#262a40', '#06060c'], leg: '#0a0a12', head: 1.1,  gaster: 1.15, mand: 1.2, legLen: 0.9,  slim: 1.28, spines: true, sheen: '#b39bff' },
  // гигант — тяжёлый муравей-воин: тёмный глянцевый хитин с багровым отливом, массивная голова с шипами,
  // толстые лапы; глаза — небольшие красные точки
  giant:   { body: ['#7a3a30', '#2e0c08', '#060101'], leg: '#1a0604', head: 1.5,  gaster: 1.15, mand: 1.9, legLen: 1.05, slim: 1.35, legW: 1.7, eyes: '#ff3b1f', spines: true, crest: true, sheen: '#ff6a4a' },
};
const LOOK_KEYS = Object.keys(LOOKS);

// Муравей по анатомии: брюшко с сегментами, стебелёк, грудь из двух частей, голова с глазами и жвалами,
// коленчатые усики, 6 лап из бедра, голени и лапки. Походка «треногой»: (Л1, П2, Л3) и (П1, Л2, П3)
// шагают в противофазе. f = 0..3 — фазы шага, 4 — неподвижный. Смотрит вдоль +x, единицы ≈ мм.
function drawAntLook(c, L, f) {
  const still = f === 4, hs = L.head, gs = L.gaster, sl = L.slim, ll = L.legLen, lw = L.legW || 1;
  const [hi, mid, dk] = L.body;
  const gx = -3.4 - 5.2 * gs, grx = 5.4 * gs, gry = 4.1 * gs; // брюшко
  const hx = 5.0 + 2.8 * hs, hrx = 3.0 * hs, hry = 2.75 * hs;  // голова
  c.lineCap = 'round'; c.lineJoin = 'round';

  const blob = (x, y, rx, ry) => {
    const g = c.createRadialGradient(x - rx * 0.35, y - ry * 0.45, 0, x, y, Math.max(rx, ry) * 1.05);
    g.addColorStop(0, hi); g.addColorStop(0.55, mid); g.addColorStop(1, dk);
    c.fillStyle = g; c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, 6.283); c.fill();
    c.strokeStyle = 'rgba(0,0,0,.4)'; c.lineWidth = 0.3; c.stroke();
  };
  const shine = (x, y, rx, ry, a) => { c.fillStyle = `rgba(255,255,255,${a})`; c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, 6.283); c.fill(); };

  // лапы (под телом)
  for (const [ax, lean, grp] of [[3.4, 1, 0], [1.4, 0.15, 1], [-0.6, -1, 0]]) for (const side of [-1, 1]) {
    const tri = side < 0 ? grp : 1 - grp, sw = still ? 0 : Math.sin(f * Math.PI / 2 + tri * Math.PI);
    const kx = ax + lean * 2.2 + sw * 1.0, ky = side * (4.6 + Math.abs(lean) * 0.4) * ll; // колено
    const fx = ax + lean * 6.0 + sw * 2.4, fy = side * 9.8 * ll;                            // конец голени
    const tx = fx + lean * 1.8 + 0.4, ty = fy + side * 1.6 * ll;                            // лапка
    c.strokeStyle = L.leg;
    c.lineWidth = 1.15 * sl * lw; c.beginPath(); c.moveTo(ax, side * 1.1 * sl); c.lineTo(kx, ky); c.stroke();
    c.lineWidth = 0.75 * sl * lw; c.beginPath(); c.moveTo(kx, ky); c.lineTo(fx, fy); c.stroke();
    c.lineWidth = 0.45 * lw; c.beginPath(); c.moveTo(fx, fy); c.lineTo(tx, ty); c.stroke();
    c.fillStyle = L.leg; c.beginPath(); c.arc(kx, ky, 0.55 * sl * lw, 0, 6.283); c.fill();
  }

  // брюшко: объём, края сегментов, у гиганта — золотые полосы, сзади — редкие волоски
  blob(gx, 0, grx, gry);
  c.save(); c.beginPath(); c.ellipse(gx, 0, grx, gry, 0, 0, 6.283); c.clip();
  if (L.bands) {
    c.fillStyle = L.bands; c.globalAlpha = 0.75;
    for (let i = 0; i < 3; i++) { c.beginPath(); c.ellipse(gx + grx * (0.4 - i * 0.42), 0, 0.8 * gs, gry * 1.1, 0, 0, 6.283); c.fill(); }
    c.globalAlpha = 1;
  }
  c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 0.3;
  for (let i = 0; i < 4; i++) { const sx = gx + grx * (0.55 - i * 0.38); c.beginPath(); c.moveTo(sx, -gry); c.quadraticCurveTo(sx - 1.3 * gs, 0, sx, gry); c.stroke(); }
  c.restore();
  c.strokeStyle = 'rgba(255,225,200,.3)'; c.lineWidth = 0.16;
  for (let i = -3; i <= 3; i++) { const an = Math.PI + i * 0.28, px = gx + Math.cos(an) * grx, py = Math.sin(an) * gry; c.beginPath(); c.moveTo(px, py); c.lineTo(px - 0.9, py + i * 0.12); c.stroke(); }

  // стебелёк и грудь
  blob(-2.9, 0, 0.9, 1.15 * sl);
  blob(-0.6, 0, 1.9, 1.35 * sl);
  blob(2.3, 0, 2.5, 1.75 * sl);
  if (L.spines) {
    c.fillStyle = dk;
    for (const s of [-1, 1]) { c.beginPath(); c.moveTo(-0.9, s * 1.0 * sl); c.lineTo(-2.6, s * 2.3 * sl); c.lineTo(-0.3, s * 1.3 * sl); c.closePath(); c.fill(); }
  }

  // голова, глаза, жвалы, усики
  blob(hx, 0, hrx, hry);
  if (L.crest) { // шипы на затылке гиганта
    c.fillStyle = dk;
    for (const s of [-1, 1]) for (const [dx, dy] of [[-0.6, 0.55], [0.5, 0.8]]) {
      const bx = hx + dx * hrx, by = s * dy * hry;
      c.beginPath(); c.moveTo(bx - 0.6, by); c.lineTo(bx - 1.6, by + s * 1.4); c.lineTo(bx + 0.5, by + s * 0.2); c.closePath(); c.fill();
    }
  }
  for (const s of [-1, 1]) {
    c.fillStyle = L.eyes || '#120806';
    const er = L.eyes ? 0.55 : 0.85; // горящие глаза гиганта — мелкие точки, свечение добавляет рендер
    c.beginPath(); c.ellipse(hx + 0.2 * hs, s * hry * 0.78, er * hs, er * 0.7 * hs, 0, 0, 6.283); c.fill();
    shine(hx, s * hry * 0.78 - 0.2, 0.25 * hs, 0.18 * hs, 0.7);
  }
  const m = L.mand, mx = hx + hrx * 0.85;
  c.fillStyle = dk;
  for (const s of [-1, 1]) {
    c.beginPath(); c.moveTo(mx, s * 1.0 * hs);
    c.quadraticCurveTo(mx + 1.9 * m, s * 1.5 * hs, mx + 2.3 * m, s * 0.15);
    c.quadraticCurveTo(mx + 1.2 * m, s * 0.6, mx - 0.2, s * 0.35 * hs); c.closePath(); c.fill();
  }
  const sway = still ? 0 : Math.sin(f * Math.PI / 2) * 0.35;
  c.strokeStyle = L.leg;
  for (const s of [-1, 1]) {
    const x0 = hx + hrx * 0.55, y0 = s * hry * 0.45, x1 = x0 + 2.6, y1 = s * (hry + 2.2), x2 = x1 + 3.8, y2 = s * (hry + 0.6 + sway);
    c.lineWidth = 0.6; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();               // стебелёк усика
    c.lineWidth = 0.48; c.beginPath(); c.moveTo(x1, y1); c.quadraticCurveTo(x1 + 2, y1 + s * 0.3, x2, y2); c.stroke(); // жгутик
    c.fillStyle = L.leg; c.beginPath(); c.ellipse(x2, y2, 0.7, 0.4, 0, 0, 6.283); c.fill();          // булава
  }

  // блики: хитин глянцевый
  shine(gx - grx * 0.3, -gry * 0.45, grx * 0.38, gry * 0.16, 0.38);
  shine(2.1, -0.75 * sl, 1.1, 0.35, 0.32);
  shine(hx - hrx * 0.15, -hry * 0.45, hrx * 0.4, hry * 0.15, 0.32);
  if (L.sheen) { c.strokeStyle = L.sheen; c.globalAlpha = 0.55; c.lineWidth = 0.35; c.beginPath(); c.ellipse(gx, 0, grx * 0.75, gry * 0.7, 0, Math.PI * 1.1, Math.PI * 1.6); c.stroke(); c.globalAlpha = 1; }

  // крылья (сверху, полупрозрачные, с жилками); f меняет взмах
  if (L.wings) {
    const flap = still ? 0 : [0, 0.35, 0.1, 0.45][f];
    for (const s of [-1, 1]) for (const [px, rot, len, wid] of [[1.2, 0.28, 7.5, 2.3], [0.2, 0.55, 5, 1.6]]) {
      c.save(); c.translate(px, s * 0.8); c.rotate(s * (rot + flap));
      c.fillStyle = 'rgba(225,235,255,.32)'; c.strokeStyle = 'rgba(60,40,30,.45)'; c.lineWidth = 0.22;
      c.beginPath(); c.ellipse(-len * 0.87, 0, len, wid, 0, 0, 6.283); c.fill(); c.stroke();
      c.beginPath(); c.moveTo(0, 0); c.lineTo(-len * 1.6, wid * 0.1); c.moveTo(-len * 0.4, wid * 0.2); c.lineTo(-len * 1.2, wid * 0.65); c.stroke();
      c.restore();
    }
  }
}

function buildAtlas() {
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const c = cv.getContext('2d');
  const cell = (name, x, y, w, h, fn) => {
    c.save(); c.translate(x + w / 2, y + h / 2); fn(); c.restore();
    A[name] = [x / S, 1 - (y + h) / S, w / S, h / S];
  };
  const ell = (x, y, rx, ry) => { c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, 6.283); c.fill(); };
  const radial = (r, stops) => {
    const g = c.createRadialGradient(0, 0, 0, 0, 0, r);
    for (const [o, a] of stops) g.addColorStop(o, `rgba(255,255,255,${a})`);
    c.fillStyle = g; c.beginPath(); c.arc(0, 0, r, 0, 6.283); c.fill();
  };

  // муравьи: 6 видов × 5 кадров, ячейки 256 — строки 0..3
  LOOK_KEYS.forEach((k, li) => { for (let f = 0; f < 5; f++) {
    const n = li * 5 + f;
    cell(k + f, (n % 8) * 256, Math.floor(n / 8) * 256, 256, 256, () => { c.scale(ANT_PX, ANT_PX); drawAntLook(c, LOOKS[k], f); });
  } });
  const Y = 1024;
  cell('shadow', 0, Y, 128, 128, () => { c.scale(1, 0.62); radial(62, [[0, .9], [.6, .5], [1, 0]]); });
  cell('glow', 128, Y, 128, 128, () => radial(63, [[0, 1], [.25, .45], [1, 0]]));
  cell('spark', 256, Y, 128, 128, () => {
    radial(40, [[0, 1], [.2, .7], [1, 0]]);
    c.fillStyle = 'rgba(255,255,255,.55)'; ell(0, 0, 60, 2.5); ell(0, 0, 2.5, 60);
  });
  cell('splat', 384, Y, 128, 128, () => {
    c.scale(4, 4); c.fillStyle = '#6a120a';
    ell(0, 0, 9, 6);
    for (let i = 0; i < 4; i++) { const an = i * 1.7; ell(Math.cos(an) * 9, Math.sin(an) * 7, 2.5, 2); }
  });
  cell('dot', 512, Y, 128, 128, () => radial(30, [[0, 1], [.7, 1], [1, 0]]));
  cell('bar', 640, Y, 128, 32, () => { c.fillStyle = '#fff'; c.beginPath(); c.roundRect(-62, -14, 124, 28, 14); c.fill(); });
  cell('ringDash', 0, Y + 256, 256, 256, () => {
    c.strokeStyle = '#fff'; c.lineWidth = 4; c.setLineDash([16, 20]);
    c.beginPath(); c.arc(0, 0, 120, 0, 6.283); c.stroke();
  });
  cell('ring', 256, Y + 256, 256, 256, () => {
    c.strokeStyle = '#fff'; c.lineWidth = 4;
    c.beginPath(); c.arc(0, 0, 120, 0, 6.283); c.stroke();
  });

  atlasTex = new THREE.CanvasTexture(cv);
  atlasTex.colorSpace = THREE.SRGBColorSpace;
  atlasReady = drawBonusIcons(c);
  return atlasTex;
}

// иконки бонусов (Lucide, лежат в icons/): тёмный круг с фиолетовой каймой, иконка; у взрыва подпись силы.
// SVG грузятся асинхронно — дорисовываем в атлас и обновляем текстуру
// у аптечки иконки-файла нет: сплошной зелёный крест рисуем сами — контурный на ходу не читается
const BONUS_ICONS = [['slow', 'snail'], ['life', 'heart'], ['shield', 'shield'], ['boom35', 'bomb', '35%'], ['boom60', 'bomb', '60%'], ['boom85', 'bomb', '85%'], ['med', null]];
async function drawBonusIcons(c) {
  const load = async (name, color) => {
    const svg = (await (await fetch(`icons/${name}.svg`)).text()).replaceAll('currentColor', color);
    const img = new Image(); img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    await img.decode(); return img;
  };
  const colors = { slow: '#8fe9ff', life: '#ff6b8a', shield: '#8fe9ff', bomb: '#ffb45a' };
  const imgs = {};
  for (const [, icon] of BONUS_ICONS) if (icon && !imgs[icon]) imgs[icon] = await load(icon, colors[icon] || colors[BONUS_ICONS.find(b => b[1] === icon)[0]]);
  const Y = 1024 + 512;
  BONUS_ICONS.forEach(([name, icon, label], i) => {
    const x = i * 128, y = Y;
    c.save(); c.translate(x + 64, y + 64);
    c.clearRect(-64, -64, 128, 128);
    c.fillStyle = 'rgba(16,9,40,.9)'; c.beginPath(); c.arc(0, 0, 56, 0, 6.283); c.fill();
    c.strokeStyle = '#c7a4ff'; c.lineWidth = 5; c.stroke();
    const sz = label ? 50 : 64;
    if (icon) c.drawImage(imgs[icon], -sz / 2, label ? -sz / 2 - 10 : -sz / 2, sz, sz);
    else { // аптечка: белая подложка креста и зелёный крест поверх
      const cross = (a, b) => { c.beginPath(); c.roundRect(-a, -b, 2 * a, 2 * b, 4); c.roundRect(-b, -a, 2 * b, 2 * a, 4); c.fill(); };
      c.fillStyle = '#f4fff8'; cross(33, 14); c.fillStyle = '#1fbf5f'; cross(29, 10);
    }
    if (label) { c.font = '700 22px Rubik,system-ui,sans-serif'; c.fillStyle = '#f0e2ff'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(label, 0, 32); }
    c.restore();
    A[name] = [x / S, 1 - (y + 128) / S, 128 / S, 128 / S];
  });
  atlasTex.needsUpdate = true;
}

// ---------- пачка спрайтов одним вызовом отрисовки ----------
class Batch {
  constructor(tex, max, blending) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.uv = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aUv', this.uv); geo.setAttribute('aCol', this.col);
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: tex } },
      vertexShader: `attribute vec4 aUv; attribute vec4 aCol; varying vec2 vUv; varying vec4 vCol;
        void main() { vUv = aUv.xy + uv * aUv.zw; vCol = aCol;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform sampler2D map; varying vec2 vUv; varying vec4 vCol;
        void main() { vec4 t = texture2D(map, vUv); gl_FragColor = vec4(t.rgb * vCol.rgb, t.a * vCol.a); }`,
      transparent: true, depthTest: false, depthWrite: false, blending,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; this.mesh.count = 0;
    this.max = max; this.n = 0;
  }
  begin() { this.n = 0; }
  // x, y — экранные координаты (y вниз), rot — экранный угол; col — [r,g,b] (может быть > 1)
  add(name, x, y, sx, sy, rot, col, a) {
    const r = A[name];
    if (this.n >= this.max || !r) return; // иконки бонусов появляются в атласе чуть позже
    const i = this.n++, m = this.mesh.instanceMatrix.array, o = i * 16;
    const cs = Math.cos(-rot), sn = Math.sin(-rot);
    m[o] = cs * sx; m[o + 1] = sn * sx; m[o + 2] = 0; m[o + 3] = 0;
    m[o + 4] = -sn * sy; m[o + 5] = cs * sy; m[o + 6] = 0; m[o + 7] = 0;
    m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = 1; m[o + 11] = 0;
    m[o + 12] = x; m[o + 13] = view.H - y; m[o + 14] = 0; m[o + 15] = 1;
    const u = this.uv.array, q = this.col.array, k = i * 4;
    u[k] = r[0]; u[k + 1] = r[1]; u[k + 2] = r[2]; u[k + 3] = r[3];
    q[k] = col[0]; q[k + 1] = col[1]; q[k + 2] = col[2]; q[k + 3] = a;
  }
  end() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true; this.uv.needsUpdate = true; this.col.needsUpdate = true;
  }
}

// ---------- видео с эффектами ----------
// Всё в одном шейдере: рябь (крик, взрыв огня) смещает картинку кольцевыми волнами, расслоение цветов
// по краям, насыщенность, затемнение, оттенок, виньетка, вспышка. Итог ≤ 0.97 — видео никогда не светится.
const RIPPLES = 6;
const VIDEO_FRAG = `
  uniform sampler2D map; uniform vec2 uRes, uPlane; uniform float uDpr, uSat, uDark, uVig, uChroma, uFlash;
  uniform float uInvert, uPoster, uWave, uTime;
  uniform vec3 uTint, uVigCol, uFlashCol; uniform vec4 uRip[${RIPPLES}];
  varying vec2 vUv;
  // видеотекстуры three.js не декодирует аппаратно, sRGB → линейный переводим сами; x — зеркало
  vec3 tex(vec2 uv) { return pow(texture2D(map, vec2(1.0 - uv.x, uv.y)).rgb, vec3(2.2)); }
  void main() {
    vec2 scr = uRes / uDpr, p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr; // css px, y вниз
    vec2 uv = vUv; float ring = 0.0;
    // волна: картинка колышется, как отражение в воде
    uv += vec2(sin(p.y / 38.0 + uTime * 9.0), sin(p.x / 45.0 + uTime * 7.0)) * uWave * 7.0 / uPlane;
    for (int i = 0; i < ${RIPPLES}; i++) {
      vec4 r = uRip[i];
      if (r.w <= 0.0) continue;
      vec2 d = p - r.xy; float dist = length(d), R = r.z * 700.0, e = (dist - R) / 45.0; // pow() с отрицательным основанием в GLSL не определён
      float band = exp(-e * e) * r.w * (1.0 - clamp(r.z / 0.8, 0.0, 1.0));
      vec2 dir = dist > 0.001 ? d / dist : vec2(0.0);
      uv -= vec2(dir.x, -dir.y) * band * 16.0 / uPlane;
      ring += band;
    }
    vec2 cd = (p - scr * 0.5) / scr, co = vec2(cd.x, -cd.y) * uChroma * 2.0 / uPlane;
    vec3 c = vec3(tex(uv + co).r, tex(uv).g, tex(uv - co).b);
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, uSat);
    // постеризация («комикс»): 5 уровней на канал, считается в гамма-пространстве, как видит глаз
    vec3 g = pow(c, vec3(1.0 / 2.2));
    g = mix(g, floor(g * 5.0 + 0.5) / 5.0, uPoster);
    // негатив: инверсия там же, в гамме, иначе тёмное станет слепяще-белым
    g = mix(g, 1.0 - g, uInvert);
    c = pow(g, vec3(2.2));
    c = c * (1.0 - uDark) + uTint;
    vec2 q = p / scr - 0.5;
    c = mix(c, uVigCol, smoothstep(0.28, 0.78, length(q * vec2(1.0, 0.85))) * uVig);
    c += uFlashCol * uFlash + vec3(0.25) * ring * 0.1;
    gl_FragColor = vec4(min(c, vec3(0.97)), 1.0);
  }`;

const fx = { sat: 0.7, dark: 0, vig: 0.15, chroma: 0, poster: 0, wave: 0, tint: [0, 0, 0], vigCol: [0, 0, 0] };
let lastFx = performance.now();

// какие эффекты сейчас на видео — по состоянию игры; плавно подводим к цели
function updateVideoFX(now) {
  const u = videoMesh.material.uniforms, dt = Math.min(0.1, (now - lastFx) / 1000); lastFx = now;
  const tgt = { sat: 0.7, dark: 0, vig: 0.15, chroma: 0, poster: 0, wave: 0, tint: [0, 0, 0], vigCol: [0, 0, 0] };
  const t = now / 1000, life = G.life ?? 100, att = G.att || 0;
  if (flags.running && !flags.over) {
    if (life < 60) tgt.sat -= (60 - life) / 60 * 0.5;                          // жизнь уходит — мир блекнет
    if (att) { tgt.tint = [Math.min(0.12, att * 0.012), 0, 0]; tgt.chroma = Math.min(3.5, att * 0.3); } // облепили — «зуд»
    if (life <= 30) { tgt.vig = 0.5 + 0.22 * Math.max(0, Math.sin(t * 7.5)); tgt.vigCol = [0.35, 0, 0.02]; } // сердцебиение
    if (G.ants?.some(a => a.st !== 'dead' && ANTS[a.type].boss)) { tgt.dark += 0.1; tgt.vig = Math.max(tgt.vig, 0.4); } // гиганты — чуть темнее, без красного: красный только урон
    if (G.fx?.slow > 0) { tgt.sat *= 0.65; tgt.tint = [tgt.tint[0], 0.01, 0.06]; }        // замедление — холодный оттенок
    if (G.fx?.fear > 0) tgt.wave = Math.min(1, G.fx.fear / 1.5);                 // паника после крика — картинка колышется
    if (G.comboTier >= 3) { tgt.poster = 0.85; tgt.sat = Math.max(tgt.sat, 1.15); } // серия ×3 — «комикс»
    if (G.fx?.shield > 0) { tgt.vig = Math.max(tgt.vig, 0.42); tgt.vigCol = [0.05, 0.35, 0.45]; } // бессмертие
  }
  if (flags.over && !flags.calib) { tgt.sat = 0; tgt.dark = 0.35; }            // съели — всё серое
  if (flags.paused) { tgt.sat = 0.15; tgt.dark = Math.max(tgt.dark, 0.5); }   // пауза — тёмное и почти серое
  const k = Math.min(1, dt * 6);
  for (const key of ['sat', 'dark', 'vig', 'chroma', 'poster', 'wave']) fx[key] += (tgt[key] - fx[key]) * k;
  for (const key of ['tint', 'vigCol']) for (let i = 0; i < 3; i++) fx[key][i] += (tgt[key][i] - fx[key][i]) * k;
  u.uSat.value = fx.sat; u.uDark.value = fx.dark; u.uVig.value = fx.vig; u.uChroma.value = fx.chroma;
  u.uTint.value.fromArray(fx.tint); u.uVigCol.value.fromArray(fx.vigCol);
  u.uPoster.value = fx.poster; u.uWave.value = fx.wave; u.uTime.value = t;
  // негатив: одна плавная волна инверсии — выход гигантов (1 с), бонус-взрыв (0.45 с)
  u.uInvert.value = G.invT > 0 ? Math.sin(Math.PI * (1 - G.invT / G.invDur)) : 0;

  // вспышка: только огненный удар, оранжевая
  const blast = (G.blasts || []).find(b => b.t < 0.2);
  if (blast) { u.uFlash.value = (0.2 - blast.t) / 0.2 * (0.18 + 0.2 * blast.k); u.uFlashCol.value.set(1, 0.45, 0.12); }
  else u.uFlash.value = 0;

  // рябь: взрывы огня и волны крика (новые — первыми)
  const rips = [
    ...(G.blasts || []).map(b => [b.x, b.y, b.t, 0.6 + 0.4 * b.k]),
    ...(G.sWaves || []).map(w => [w.x, w.y, w.t, 0.35]),
  ].sort((a, b) => a[2] - b[2]);
  for (let i = 0; i < RIPPLES; i++) u.uRip.value[i].set(...(rips[i] || [0, 0, 0, 0]));
}

// ---------- сцена ----------
export function initRenderer(canvas, video) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setClearColor(0x08051a, 1);
  const scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(0, 1, 1, 0, -10, 10);

  const vt = new THREE.VideoTexture(video); vt.colorSpace = THREE.SRGBColorSpace;
  videoMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
    uniforms: {
      map: { value: vt }, uRes: { value: new THREE.Vector2(1, 1) }, uPlane: { value: new THREE.Vector2(1, 1) }, uDpr: { value: 1 },
      uSat: { value: 0.7 }, uDark: { value: 0 }, uVig: { value: 0.15 }, uChroma: { value: 0 }, uFlash: { value: 0 },
      uInvert: { value: 0 }, uPoster: { value: 0 }, uWave: { value: 0 }, uTime: { value: 0 },
      uTint: { value: new THREE.Vector3() }, uVigCol: { value: new THREE.Vector3() }, uFlashCol: { value: new THREE.Vector3() },
      uRip: { value: Array.from({ length: RIPPLES }, () => new THREE.Vector4()) },
    },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: VIDEO_FRAG,
    depthTest: false, depthWrite: false,
  }));
  videoMesh.visible = false; videoMesh.renderOrder = 0;

  const tex = buildAtlas();
  normal = new Batch(tex, 3000, THREE.NormalBlending); normal.mesh.renderOrder = 1;
  glow = new Batch(tex, 3000, THREE.AdditiveBlending); glow.mesh.renderOrder = 2;
  top = new Batch(tex, 512, THREE.NormalBlending); top.mesh.renderOrder = 3; // иконки и полоски hp поверх свечения
  scene.add(videoMesh, normal.mesh, glow.mesh, top.mesh);

  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.9, 0.55, 1.0));
  composer.addPass(new OutputPass());

  // звёздная пыль поверх видео
  for (let i = 0; i < 70; i++) stars.push({ x: Math.random(), y: Math.random(), s: rand(6, 16), ph: rand(0, 6.28), f: rand(0.6, 2) });
}

export function resizeRenderer(W, H, dpr) {
  renderer.setPixelRatio(dpr); renderer.setSize(W, H, false);
  composer.setPixelRatio(dpr); composer.setSize(W, H);
  camera.left = 0; camera.right = W; camera.top = H; camera.bottom = 0; camera.updateProjectionMatrix();
  const u = videoMesh.material.uniforms;
  u.uRes.value.set(W * dpr, H * dpr); u.uDpr.value = dpr;
  if (view.vw) {
    const w = view.vw * view.scale, h = view.vh * view.scale;
    videoMesh.scale.set(w, h, 1);
    videoMesh.position.set(view.offX + w / 2, H - (view.offY + h / 2), 0);
    videoMesh.visible = true;
    u.uPlane.value.set(w, h);
  }
}

const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
// вспышка убитого по ступени серии: без серии, ×1.5, ×2, ×3
const POP_COL = [mul(PAL.lav, 1.3), PAL.violet, PAL.pink, PAL.gold];

// полоска здоровья над раненым муравьём (у гигантов — всегда): горизонтальная, под пальцем ярче;
// цвет по тем же порогам, что у полосы жизни игрока (60% и 30%)
const HP_COL = { hi: [0.85, 0.5, 1.0], mid: [1.0, 0.55, 0.12], low: [1.0, 0.22, 0.28] };
// шкала заряда (огонь, крик): яркая часть — набрано (уже оплачено суперсилой), тусклая — сколько ещё
// можно добрать на оставшуюся суперсилу; засечка — порог, с которого сработает
function drawChargeBar(x, y, k, extra, pin, col, dim) {
  const w = 120, h = 11, room = Math.min(1, k + extra);
  top.add('bar', x, y, w + 4, h + 4, 0, [0.06, 0.02, 0.06], 0.8);
  if (room > k) top.add('bar', x + (room - 1) * w / 2, y, Math.max(h, w * room), h, 0, dim, 0.45);
  if (k > 0) top.add('bar', x + (k - 1) * w / 2, y, Math.max(h, w * k), h, 0, col, 1);
  top.add('bar', x + (pin - 0.5) * w, y, 3, h + 6, 0, PAL.white, 0.7);
}
const drawFireBar = (x, y, k, armed) =>
  drawChargeBar(x, y, k, G.power / T.fireCost, T.chargeMin, armed ? [1, 0.72, 0.18] : [0.8, 0.4, 0.1], [0.55, 0.25, 0.08]);

function drawHpBar(a, boss) {
  const s = ANT * a.size * T.antScale, w = s * (boss ? 0.7 : 0.6), h = boss ? 10 : 8, y = a.y - s * 0.42;
  const hp = Math.max(0, a.hp / a.maxHp), al = boss ? 1 : 0.6 + 0.4 * a.hit;
  top.add('bar', a.x, y, w + 4, h + 4, 0, [0.04, 0.02, 0.1], 0.75 * al);
  top.add('bar', a.x + (hp - 1) * w / 2, y, Math.max(h, w * hp), h, 0,
    hp > 0.6 ? HP_COL.hi : hp > 0.3 ? HP_COL.mid : HP_COL.low, al);
}

export function render() {
  const now = performance.now(), sec = now / 1000, { W, H } = view;
  updateVideoFX(now);
  normal.begin(); glow.begin(); top.begin();
  // тряска: сила = травма², смещение — плавная сумма синусов (случайное число каждый кадр дребезжит)
  const sh = (G.trauma || 0) ** 2 * T.shakeMax, st = sec * 30;
  camera.position.set(sh * (0.6 * Math.sin(st * 1.7) + 0.4 * Math.sin(st * 3.1 + 1)),
                      sh * (0.6 * Math.sin(st * 2.3 + 2) + 0.4 * Math.sin(st * 3.7)), 0);

  for (const s of stars) glow.add('spark', s.x * W, s.y * H, s.s, s.s, 0, PAL.lav, 0.12 + 0.12 * Math.sin(sec * s.f + s.ph));

  // голова: пунктирное кольцо медленно вращается
  if (head.seen || head.lostFor < 1) {
    const att = G.att || 0;
    const col = G.fx?.fear > 0 ? PAL.pink : G.fx?.shield > 0 ? PAL.cyan : att ? PAL.red : PAL.violet;
    const a = G.fx?.shield > 0 || G.fx?.fear > 0 ? 0.9 : att ? Math.min(1, 0.45 + att * 0.06) : 0.35;
    glow.add('ringDash', head.x, head.y, head.r * RING, head.r * RING, sec * 0.15, col, a);
    if (G.fx?.shield > 0) {
      const rr = (head.r + 8 + Math.sin(sec * 8) * 3) * RING;
      glow.add('ring', head.x, head.y, rr, rr, 0, PAL.cyan, 0.45);
    }
  }
  // крик: изо рта во все стороны расходятся волны, у подбородка — шкала заряда
  for (const w of G.sWaves || []) {
    const q = w.t / 0.8, rr = w.r * (0.25 + 2.6 * q) * RING;
    glow.add('ring', w.x, w.y, rr, rr, 0, q < 0.5 ? PAL.pink : PAL.violet, 0.75 * (1 - q));
  }
  if (G.screamT > 0) {
    const k = Math.min(1, G.screamT / T.screamMax);
    drawChargeBar(head.x, head.y + head.r + 26, k, Math.max(0, G.power - k), T.screamHold / T.screamMax, [1, 0.45, 0.85], [0.5, 0.2, 0.45]);
  }
  // ударная волна крика
  if (G.blastT > 0) {
    const k = 1 - G.blastT / 0.6, rr = head.r * (1 + k * (1.5 + 5 * G.blastK)) * RING; // длинный крик — шире волна
    glow.add('ring', head.x, head.y, rr, rr, 0, PAL.pink, (G.blastT / 0.6) * (0.4 + 0.6 * G.blastK));
  }

  // бонусы
  for (const b of G.bonuses || []) {
    if (b.age > T.bonusLife - 2 && Math.floor(b.age * 8) % 2 === 0) continue; // мигает перед исчезновением
    const s = 1 + Math.sin(sec * 5 + b.ph) * 0.08;
    glow.add('glow', b.x, b.y, 150 * s, 150 * s, 0, PAL.violet, 0.5);
    top.add(b.k === 'boom' ? 'boom' + Math.round(b.pow * 100) : b.k, b.x, b.y, ICON * s, ICON * s, 0, PAL.white, 1);
  }

  // муравьи: пятна, тени, тела; вцепившиеся с золотым ореолом, у гигантов — горящие глаза
  const alive = (G.ants || []).filter(a => a.st !== 'dead');
  for (const a of G.ants || []) if (a.st === 'dead') {
    const s = ANT * a.size * T.antScale * 0.8;
    normal.add('splat', a.x, a.y, s, s, a.ph, PAL.white, 1 - a.deadT / 1.6);
  }
  for (const a of alive) {
    const s = ANT * a.size * T.antScale, sq = 0.45 + 0.55 * Math.max(0, a.hp / a.maxHp);
    const flying = ANTS[a.type].fly && a.st === 'run'; // у летящего тень ниже и бледнее — видно высоту
    normal.add('shadow', a.x + (flying ? 12 : 0), a.y + (flying ? 16 : 0), s * 0.75 * (flying ? 0.7 : 1), s * 0.55 * sq, a.a, PAL.black, flying ? 0.22 : 0.4);
  }
  for (const a of alive) {
    const t = ANTS[a.type], s = ANT * a.size * T.antScale, hpk = Math.max(0, a.hp / a.maxHp);
    const sq = 0.45 + 0.55 * hpk, k = 0.4 + 0.6 * hpk; // раненый сплющен и темнее
    const steps = t.fly ? 36 : 18 * t.speed;           // у крылатых кадры машут крыльями чаще
    const f = a.st === 'run' ? Math.floor((sec * steps + a.ph) / 6.283 * 4) % 4 : 4;
    // вцепившийся дрожит тем сильнее, чем ближе к отрыву: видно, что тряска действует
    const j = a.st === 'attached' ? a.loose * 7 : 0;
    const x = a.x + Math.sin(sec * 47 + a.ph) * j, y = a.y + Math.cos(sec * 53 + a.ph) * j;
    normal.add(a.type + f, x, y, s, s * sq, a.a, [k, k, k], 1);
    if (a.st === 'attached') glow.add('glow', x, y, s * 1.1, s * 0.8, a.a, mul(PAL.gold, 0.45), 0.25 + Math.sin(sec * 9 + a.ph) * 0.1);
    if (t.boss) { // глаза гиганта: координаты из рисунка (head = 1.5: центр головы 9.2, глаза ±3.2)
      const px = s / ANT, cs = Math.cos(a.a), sn = Math.sin(a.a), ex = 9.5 * px;
      for (const side of [-1, 1]) {
        const ey = side * 3.2 * px;
        glow.add('glow', x + ex * cs - ey * sn, y + ex * sn + ey * cs, 3.2 * px, 3.2 * px, 0, PAL.red, 0.6 + 0.3 * Math.sin(sec * 6 + side));
      }
    }
  }
  for (const a of alive) { const boss = ANTS[a.type].boss; if (boss || a.hp < a.maxHp) drawHpBar(a, boss); }

  // огненные шары: растут, будто летят в экран; взрывы — огненный диск и кольцо до радиуса поражения
  for (const b of G.fireballs || []) {
    const q = b.t / T.fireFlight, s = (40 + (60 + 90 * b.k) * q) * (1 + Math.sin(sec * 40) * 0.06);
    glow.add('glow', b.x, b.y, s * 2.4, s * 2.4, 0, PAL.ember, 0.5);
    glow.add('glow', b.x, b.y, s, s, 0, PAL.flame, 0.95);
    glow.add('spark', b.x, b.y, s * 1.3, s * 1.3, sec * 6, PAL.fire, 0.7);
  }
  for (const b of G.blasts || []) {
    const q = b.t / 0.6, e = 1 - (1 - q) * (1 - q); // быстро раскрывается и гаснет
    glow.add('glow', b.x, b.y, b.R * 2.6 * e, b.R * 2.6 * e, 0, PAL.fire, 0.6 * (1 - q));
    glow.add('ring', b.x, b.y, b.R * e * RING, b.R * e * RING, 0, PAL.flame, 0.9 * (1 - q));
  }

  // убитый: короткое расходящееся кольцо; в серии — ярче и цветом ступени
  for (const p of G.pops || []) {
    const q = p.t / 0.3, s = ANT * p.size * T.antScale * (0.35 + 0.65 * (1 - (1 - q) * (1 - q)));
    const col = POP_COL[p.tier] || POP_COL[0];
    glow.add('ring', p.x, p.y, s * RING * 0.5, s * RING * 0.5, 0, col, (1 - q) * (p.tier ? 0.9 : 0.6));
    if (q < 0.4) glow.add('glow', p.x, p.y, s * 0.9, s * 0.9, 0, col, (0.4 - q) * 1.2);
  }
  // вцепился муравей: край экрана вспыхивает красным с его стороны (луч от центра головы до края)
  for (const h of G.hits || []) {
    const cs = Math.cos(h.ang), sn = Math.sin(h.ang);
    const d = Math.min(cs > 0 ? (W - head.x) / cs : cs < 0 ? -head.x / cs : Infinity,
                       sn > 0 ? (H - head.y) / sn : sn < 0 ? -head.y / sn : Infinity);
    const s = Math.min(W, H) * 0.45;
    glow.add('glow', head.x + cs * d, head.y + sn * d, s, s, 0, mul(PAL.red, 0.5), 0.8 * (1 - h.t / 0.6));
  }

  // частицы
  for (const p of G.parts || []) {
    const al = Math.min(1, p.l * 2);
    if (p.glow) glow.add('spark', p.x, p.y, p.sz, p.sz, p.rot, p.col, al);
    else normal.add('dot', p.x, p.y, p.sz, p.sz, 0, p.col, al);
  }

  // руки: кольцо ладони (розовое на взмахе), зоны пальцев
  for (const h of input.hands) {
    const fast = Math.hypot(h.vx, h.vy) > T.flingSpeed, pr = h.r * 1.15 * RING;
    glow.add('ring', h.palm.x, h.palm.y, pr, pr, 0, fast ? PAL.pink : PAL.lav, fast ? 0.9 : 0.12);
    if (fast) {
      const tx = h.palm.x - h.vx * 0.08, ty = h.palm.y - h.vy * 0.08, len = Math.hypot(h.vx, h.vy) * 0.08;
      glow.add('glow', (h.palm.x + tx) / 2, (h.palm.y + ty) / 2, len + 30, 30, Math.atan2(h.vy, h.vx), PAL.pink, 0.55);
    }
    // огонь в кулаке — только когда заряд реально идёт (есть суперсила); под ним шкала силы
    if (h.closed && h.fist?.charge > 0) {
      const k = h.fist.charge, armed = k >= T.chargeMin;
      const s = 26 + 70 * k + Math.sin(sec * 30) * 3;
      glow.add('glow', h.palm.x, h.palm.y, s * 2, s * 2, 0, PAL.ember, armed ? 0.55 : 0.25);
      glow.add('glow', h.palm.x, h.palm.y, s, s, 0, armed ? PAL.flame : PAL.fire, armed ? 0.9 : 0.45);
      drawFireBar(h.palm.x, h.palm.y + h.r * 0.9 + 18, k, armed);
    }
    h.tips.forEach((t, i) => {
      const R = T.crushRadius, on = h.touch?.[i]; // кончик давит муравья — кольцо розовое и ярче
      glow.add('glow', t.x, t.y, R * 2.2, R * 2.2, 0, mul(on ? PAL.pink : PAL.violet, 0.3), on ? 0.3 : 0.18);
      glow.add('ring', t.x, t.y, R * RING, R * RING, 0, on ? mul(PAL.pink, 0.8) : mul(PAL.violet, 0.6), on ? 0.7 : 0.22);
      glow.add('glow', t.x, t.y, 20, 20, 0, PAL.violet, 0.9);
    });
  }

  normal.end(); glow.end(); top.end();
  composer.render();
}
