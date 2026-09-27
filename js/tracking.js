// Камера и MediaPipe: лицо (позиция, тряска, глаза) и руки (точки, скорость ладони)
// MediaPipe 1.0.1 — локальная копия (tools/vendor.py): с чужих серверов ничего не грузится, статистика в Google отключена
import { FilesetResolver, FaceLandmarker, HandLandmarker } from "../vendor/mediapipe/vision_bundle.mjs";
import { T } from './config.js?v=7ea3fdf3';
import { clamp, dist, avg } from './util.js?v=7ea3fdf3';
import { view, head, input } from './state.js?v=7ea3fdf3';

// полные адреса от этого модуля (относительный путь MediaPipe понял бы от страницы)
const WASM = new URL("../vendor/mediapipe/wasm", import.meta.url).href;
const FACE_MODEL = new URL("../vendor/models/face_landmarker.task.gz", import.meta.url).href;
const HAND_MODEL = new URL("../vendor/models/hand_landmarker.task.gz", import.meta.url).href;
const WASM_BYTES = 11.8e6; // размер wasm после распаковки — для процента, когда сервер отдаёт его сжатым

let faceLM = null, handLM = null, lastVideoTime = -1, prevNow = 0;
export const visionReady = () => !!faceLM;

// Загрузка распознавания: одна на всех (игра начинает её сразу при открытии страницы, кнопки ждут её же).
// wasm и модели качаем сами, по частям — так виден процент; MediaPipe получает их готовыми и сам ничего не качает.
// onProgress(0..1) — подписка на процент загрузки
let visionP = null;
const listeners = new Set();
export function loadVision(onProgress) {
  if (onProgress) listeners.add(onProgress);
  return visionP ??= initVision().catch(e => { visionP = null; throw e; }); // ошибка — при следующем вызове заново
}

async function initVision() {
  // ожидаемые размеры сразу, иначе процент прыгал бы назад, пока не пришли заголовки всех файлов
  const files = { wasm: { got: 0, total: WASM_BYTES }, face: { got: 0, total: 3.3e6 }, hand: { got: 0, total: 5.8e6 } };
  const report = () => {
    let got = 0, total = 0;
    for (const f of Object.values(files)) { got += f.got; total += f.total; }
    for (const fn of listeners) fn(Math.min(1, got / total));
  };
  // по частям, с учётом полученного; total — из заголовка, если сервер не сжимал ответ (иначе там сжатый размер)
  const fetchBytes = async (key, url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url.split('/').pop()}: ${r.status}`);
    const f = files[key], len = !r.headers.get('content-encoding') && +r.headers.get('content-length');
    if (len) f.total = len;
    const reader = r.body.getReader(), parts = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); f.got += value.length; report();
    }
    return new Blob(parts);
  };
  // модели лежат в .gz: так по сети на 2.4 МБ меньше. Некоторые хостинги отдают .gz уже распакованным
  // (Content-Encoding: gzip) — тогда браузер распаковал сам; сжатое узнаём по первым байтам 1f 8b
  const gunzip = async blob => {
    const [a, b] = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    const data = a === 0x1f && b === 0x8b ? blob.stream().pipeThrough(new DecompressionStream('gzip')) : blob;
    return new Uint8Array(await new Response(data).arrayBuffer());
  };

  const vision = await FilesetResolver.forVisionTasks(WASM); // только выбирает сборку wasm (с SIMD или без), не качает
  // сборки без SIMD в проекте нет: её выбирают лишь очень старые браузеры
  if (String(vision.wasmBinaryPath).includes('nosimd')) throw new Error('браузер устарел. Обновите Chrome, Edge, Firefox или Safari');
  const [wasm, face, hand] = await Promise.all([
    vision.wasmBinaryPath ? fetchBytes('wasm', vision.wasmBinaryPath) : (delete files.wasm, null),
    fetchBytes('face', FACE_MODEL).then(gunzip),
    fetchBytes('hand', HAND_MODEL).then(gunzip),
  ]);
  if (wasm) vision.wasmBinaryPath = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }));
  try {
    [faceLM, handLM] = await Promise.all([
      FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetBuffer: face, delegate: 'GPU' },
        runningMode: 'VIDEO', numFaces: 1,
        outputFaceBlendshapes: true,            // открытый рот для крика
        outputFacialTransformationMatrixes: true, // поворот головы для стряхивания
      }),
      HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetBuffer: hand, delegate: 'GPU' },
        runningMode: 'VIDEO', numHands: 2,
      }),
    ]);
  } finally { if (wasm) URL.revokeObjectURL(vision.wasmBinaryPath); }
  for (const fn of listeners) fn(1);
}

export async function initCamera(video) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
  });
  video.srcObject = stream;
  await new Promise(r => video.onloadedmetadata = r);
  await video.play();
  view.vw = video.videoWidth; view.vh = video.videoHeight;
}

// видео растянуто по object-fit: cover и отзеркалено
export function fitView(W, H) {
  view.W = W; view.H = H;
  if (view.vw) {
    view.scale = Math.max(W / view.vw, H / view.vh);
    view.offX = (W - view.vw * view.scale) / 2; view.offY = (H - view.vh * view.scale) / 2;
  }
}
const mapPt = lm => ({ x: view.offX + (1 - lm.x) * view.vw * view.scale, y: view.offY + lm.y * view.vh * view.scale });

// освещённость: раз в секунду кадр ужимается до 32×18 и берётся средняя яркость 0..1.
// В темноте MediaPipe теряет пальцы и путает кулак с ладонью — об этом стоит предупредить
export const light = { level: 1, dark: false };
let lightCv = null, lightAt = 0;
function sampleLight(video, now) {
  if (now - lightAt < 1000) return;
  lightAt = now;
  lightCv ??= Object.assign(document.createElement('canvas'), { width: 32, height: 18 }).getContext('2d', { willReadFrequently: true });
  lightCv.drawImage(video, 0, 0, 32, 18);
  const d = lightCv.getImageData(0, 0, 32, 18).data;
  let s = 0; for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  light.level = s / (d.length / 4) / 255;
  light.dark = light.dark ? light.level < T.dark[1] : light.level < T.dark[0]; // гистерезис
}

export function track(video, now) {
  if (video.currentTime === lastVideoTime) return; // детектим только новые кадры камеры
  lastVideoTime = video.currentTime;
  sampleLight(video, now);
  const dt = Math.max(1 / 120, (now - (prevNow || now)) / 1000); prevNow = now;
  trackFace(faceLM.detectForVideo(video, now), dt);
  trackHands(handLM.detectForVideo(video, now), dt);
}

function trackFace(fr, dt) {
  const f = fr.faceLandmarks?.[0];
  if (!f) { head.seen = false; head.lostFor += dt; head.shake = 0; return; }

  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of f) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  const c = mapPt({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 });
  const r = Math.max((x1 - x0) * view.vw, (y1 - y0) * view.vh) * view.scale * 0.56;
  const wasSeen = head.seen, k = wasSeen ? 0.55 : 1;
  head.x += (c.x - head.x) * k; head.y += (c.y - head.y) * k; head.r += (r - head.r) * k;

  // сила тряски = скорость × размах × резкость. Считаем и для сдвига (в радиусах лица), и для поворота
  // (в радианах) и берём большее: при повороте головы центр лица почти не смещается
  const M = fr.facialTransformationMatrixes?.[0]?.data, R = M ? rot3(M) : null;
  const kr = Math.min(1, dt / 0.4);
  head.pPos = head.pRot = 0;
  if (wasSeen) {
    const vx = (head.x - head.px) / dt, vy = (head.y - head.py) / dt;
    const acc = Math.hypot(vx - head.vx, vy - head.vy) / dt;
    head.vx = vx; head.vy = vy;
    head.rx += (head.x - head.rx) * kr; head.ry += (head.y - head.ry) * kr;
    const vN = Math.hypot(vx, vy) / head.r, ampN = Math.hypot(head.x - head.rx, head.y - head.ry) / head.r;
    head.pPos = shakePower(vN, ampN / 0.25, acc / head.r);
    if (R && head.R) {
      const w = rotAngle(head.R, R) / dt, accW = Math.abs(w - head.w) / dt;
      head.w = w;
      for (let i = 0; i < 9; i++) head.Rrest[i] += (R[i] - head.Rrest[i]) * kr;
      head.pRot = shakePower(w, rotAngle(head.Rrest, R) / 0.3, accW);
    }
    head.shake = head.shake * 0.4 + Math.max(head.pPos, head.pRot) * 0.6;
  } else { head.vx = head.vy = head.shake = head.w = 0; head.rx = head.x; head.ry = head.y; }
  if (R) { head.R = R; if (!wasSeen || !head.Rrest) head.Rrest = R.slice(); }
  head.px = head.x; head.py = head.y;
  head.seen = true; head.lostFor = 0;

  // рот: насколько открыт (для крика)
  const cats = fr.faceBlendshapes?.[0]?.categories;
  if (cats) head.jaw = cats.find(q => q.categoryName === 'jawOpen')?.score ?? 0;
  head.mouth = mapPt({ x: (f[13].x + f[14].x) / 2, y: (f[13].y + f[14].y) / 2 }); // середина губ
}

// v — скорость (радиусы лица/с или рад/с), amp — размах в долях «полного», acc — резкость
const shakePower = (v, amp, acc) => v * clamp(amp, 0, 1.5) * (0.6 + 0.4 * clamp(acc / 60, 0, 2));

// 3×3 поворот из матрицы 4×4 лица, нормированный от возможного масштаба
function rot3(M) {
  const s = Math.hypot(M[0], M[1], M[2]) || 1;
  return [0, 1, 2, 4, 5, 6, 8, 9, 10].map(i => M[i] / s);
}
// угол между двумя ориентациями: acos((Σ Aij·Bij − 1) / 2). Сумма не меняется при транспонировании
// обеих матриц, поэтому неважно, по строкам или по столбцам хранится матрица
function rotAngle(A, B) {
  let d = 0; for (let i = 0; i < 9; i++) d += A[i] * B[i];
  return Math.acos(clamp((d - 1) / 2, -1, 1));
}

// ---------- жест «огненный шар» ----------
// size — видимый размер ладони (запястье → основание среднего пальца): рука дальше от камеры — меньше.
// Сжатие считаем двумя признаками, оба в размерах ладони (не зависят от расстояния до камеры):
// curl — кончики у центра ладони (кулак), bunch — все пять кончиков сошлись (щепоть)
function handPose(h, prev, W3) {
  const p = h.pts;
  h.size = dist(p[0], p[9]) || 1;
  if (W3) return handPose3(h, prev, W3);
  h.curl = [8, 12, 16, 20].reduce((s, i) => s + dist(p[i], h.palm), 0) / 4 / h.size;
  const c = avg(h.tips);
  h.bunch = Math.max(...h.tips.map(t => dist(t, c))) / h.size;
  // щепоть засчитываем, только если пальцы не выпрямлены: у выпрямленной ладони со сведёнными
  // пальцами кончики тоже рядом, и без этого раскрытие не замечалось бы
  const straight = h.curl > T.fingersStraight;
  h.open = h.curl > T.fistCurl[1] && (h.bunch > T.fistBunch[1] || straight);
  if (prev?.closed) {
    // раскрыта: пальцы заметно распрямились по абсолютному порогу (гистерезис) или относительно
    // самого сжатого момента — так раскрытие ловится и у рук, которые до порога не дотягивают
    h.curlMin = Math.min(prev.curlMin, h.curl);
    const opened = (h.curl > T.fistCurl[1] && (h.bunch > T.fistBunch[1] || straight)) || h.curl > h.curlMin + T.openJump;
    h.closed = !opened;
  } else {
    h.closed = h.curl < T.fistCurl[0] || (h.bunch < T.fistBunch[0] && !straight);
    h.curlMin = h.curl;
  }
}

// По 3D-точкам руки (метры, не зависят от поворота к камере):
// сгиб пальца — |кончик − основание| / длина пальца (прямой ≈ 1, в кулаке ≈ 0.35);
// bend — средний сгиб 4 пальцев, bendMax — самый прямой из них;
// pinch — разброс 5 кончиков вокруг их центра / ширина ладони (основание указательного − мизинца).
// Кулак — когда поджаты ВСЕ четыре пальца (bendMax), а не в среднем: иначе поза «указка»
// (указательный вытянут, остальные поджаты — так давят муравьёв) считалась кулаком и копила огонь
const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const FINGERS = [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
function handPose3(h, prev, W) {
  const bends = FINGERS.map(([m, p, d, t]) => d3(W[t], W[m]) / (d3(W[m], W[p]) + d3(W[p], W[d]) + d3(W[d], W[t])));
  h.bend = bends.reduce((s, b) => s + b, 0) / 4;
  h.bendMax = Math.max(...bends);
  const tips = [4, 8, 12, 16, 20].map(i => W[i]);
  const c = { x: 0, y: 0, z: 0 }; for (const t of tips) { c.x += t.x / 5; c.y += t.y / 5; c.z += t.z / 5; }
  h.pinch = Math.max(...tips.map(t => d3(t, c))) / (d3(W[5], W[17]) || 1);
  h.curl = h.bend; h.bunch = h.pinch; // для отладочной строки
  h.open = h.bend > T.fist3[1] && h.pinch > T.pinch3[1]; // явно раскрыта: пальцы прямые, кончики врозь
  if (prev?.closed) h.closed = !h.open; // гистерезис: разжата — только ладонью
  // щепоть — кончики сошлись, но ни один палец не вытянут прямо (у «указки» кончики не сходятся, но на всякий случай)
  else h.closed = h.bendMax < T.fist3[0] || (h.pinch < T.pinch3[0] && h.bendMax < T.pinchStraight);
}

// Пока пальцы сжаты, игра копит заряд (charge 0..1, сразу списывая суперсилу — см. game.js).
// Выстрел — когда пальцы распрямились. Движение руки задаёт только направление: берём самый
// резкий момент за последние ~0.3 с (к раскрытию ладони рука уже тормозит).
function updateFist(prev, h, dt) {
  if (!h.closed) {
    if (prev) release(prev, h.palm);
    return null;
  }
  // огонь — только жест «раскрыл ладонь → сжал»: рука должна была быть явно раскрыта не раньше armTime назад.
  // Расслабленная рука (пальцы чуть согнуты, кончики рядом) похожа на неплотный кулак или щепоть — порогами
  // их не развести, а без раскрытия перед сжатием она огонь не зажжёт. Так же и рука, вошедшая в кадр согнутой
  if (!prev && !(h.sinceOpen <= T.armTime)) return null;
  // born — когда сжатие началось (калибровка засчитывает только жест, сделанный на её шаге)
  const f = prev ? { ...prev } : { vPeak: 0, aim: { vx: 0, vy: 0 }, charge: 0, pos: h.palm, age: 0, born: performance.now() };
  // сколько рука сжата непрерывно и спокойно: на резком взмахе кадр смазан, и MediaPipe может на миг
  // «сжать» пальцы — такое сжатие огонь не начинает (начатый заряд взмах не сбрасывает)
  if (Math.hypot(h.vx, h.vy) < T.closeCalm || f.charge > 0) f.age += dt;
  const sp = Math.hypot(h.vx, h.vy), decayed = f.vPeak * Math.exp(-dt / 0.3);
  if (sp >= decayed) { f.vPeak = sp; f.aim = { vx: h.vx, vy: h.vy }; } else f.vPeak = decayed;
  f.pos = h.palm;
  return f;
}

// заряд отпущен: игра решит — выстрел или (если сжимали слишком коротко) возврат суперсилы
function release(f, at, refund = false) {
  if (!f.charge || input.fires.length >= 4) return;
  const aim = f.vPeak > T.aimSpeed ? f.aim : { vx: 0, vy: 0 };
  input.fires.push({ x: at.x, y: at.y, vx: aim.vx, vy: aim.vy, k: f.charge, refund });
}

function trackHands(hr, dt) {
  const next = [];
  (hr.landmarks || []).forEach((lm, li) => {
    const pts = lm.map(mapPt);
    const palm = avg([pts[0], pts[5], pts[9], pts[13], pts[17]]);
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    const h = { palm, pts, tips: [4, 8, 12, 16, 20].map(i => pts[i]), tv: [0, 0, 0, 0, 0], r: Math.max(x1 - x0, y1 - y0) * 0.6, vx: 0, vy: 0 };
    // сопоставляем с рукой из прошлого кадра для скорости
    let best = null, bd = 220;
    for (const p of input.prevHands) { const d = dist(p.palm, palm); if (d < bd) { bd = d; best = p; } }
    if (best) best.matched = true;
    if (best) {
      const vx = (palm.x - best.palm.x) / dt, vy = (palm.y - best.palm.y) / dt;
      h.vx = best.vx * 0.35 + vx * 0.65; h.vy = best.vy * 0.35 + vy * 0.65;
      // скорость каждого кончика пальца: трение по муравью давит быстрее
      h.tv = h.tips.map((t, i) => best.tv[i] * 0.35 + dist(t, best.tips[i]) / dt * 0.65);
    }
    handPose(h, best, hr.worldLandmarks?.[li]);
    h.sinceOpen = h.open ? 0 : best ? best.sinceOpen + dt : Infinity; // сколько с последнего явного раскрытия
    h.fist = updateFist(best?.fist, h, dt);
    next.push(h);
  });
  // при резком броске ладонь смазывается и MediaPipe на кадр-другой теряет руку:
  // заряженный кулак, пропавший на скорости, считаем раскрытым в броске; пропавший без движения —
  // просто потерян, заряд вернётся в суперсилу
  for (const p of input.prevHands)
    if (!p.matched && p.fist) release(p.fist, p.fist.pos, p.fist.vPeak <= T.lostThrow);
  input.prevHands = input.hands = next;
}
