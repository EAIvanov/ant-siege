// Точка входа: интерфейс, настройки, полный экран, игровой цикл
import { T, ANTS } from './config.js?v=f511fb61';
import { sfx } from './audio.js?v=f511fb61';
import { G, head, view, input, flags, resetGame, score } from './state.js?v=f511fb61';
import { loadVision, initCamera, visionReady, fitView, track, light } from './tracking.js?v=f511fb61';
import { step, stepParticles, stepFeel, hooks, chargeLevel, waveCountdown, comboMult } from './game.js?v=f511fb61';
import { initCalib, openCalib, updateCalib, loadCalib, isCalibrated } from './calib.js?v=f511fb61';
import { initRenderer, resizeRenderer, render, atlasReady } from './render.js?v=f511fb61';
import { mic, initMic, sampleMic } from './mic.js?v=f511fb61';
import { resetShots, requestShot, captureDue, shots, downloadShot, downloadAll } from './shots.js?v=f511fb61';

const $ = s => document.querySelector(s);
const video = $('#cam'), canvas = $('#game');
const ui = {
  life: $('#life'), fill: $('#lifeFill'), hud: $('#hud'), time: $('#sTime'), score: $('#sScore'), kills: $('#sKills'),
  att: $('#sAtt'), wave: $('#sWave'), fx: $('#fx'), toast: $('#toast'), warn: $('#warn'),
  start: $('#start'), over: $('#over'), err: $('#err'), btnStart: $('#btnStart'), btnAgain: $('#btnAgain'),
  optRad: $('#optRad'), optRadV: $('#optRadV'), optSnd: $('#optSnd'), optMic: $('#optMic'),
  power: $('#power'), powerFill: $('#powerFill'), dbg: $('#debugLine'),
  cd: $('#countdown'), cdLabel: $('#cdLabel'), cdNum: $('#cdNum'),
  shots: $('#shots'), shotsBox: $('#shotsBox'), btnDlAll: $('#btnDlAll'),
  lightbox: $('#lightbox'), lbImg: $('#lbImg'), lbCap: $('#lbCap'), lbClose: $('#lbClose'), lbDl: $('#lbDl'),
  calib: $('#calib'), btnCalib: $('#btnCalib'), load: $('#loadState'), btnCalib2: $('#btnCalib2'), calState: $('#calState'),
  combo: $('#combo'), comboN: $('#comboN'), comboX: $('#comboX'), comboFill: $('#comboFill'),
};
let debug = false;

function resize() {
  fitView(innerWidth, innerHeight);
  resizeRenderer(innerWidth, innerHeight, Math.min(devicePixelRatio || 1, 1.25)); // GPU делим с MediaPipe
}

// полный экран разрешён только из жеста пользователя: вызывать первой строкой обработчика клика
function goFullscreen() {
  const el = document.documentElement;
  if (document.fullscreenElement || document.webkitFullscreenElement) return;
  try {
    const p = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen?.();
    p?.catch?.(() => {});
  } catch {}
}

// одна надпись на экране; более важная (p выше) не перебивается менее важной, пока видна
let toastT, toastP = 0, toastUntil = 0;
function toast(s, p = 1) {
  const now = performance.now();
  if (p < toastP && now < toastUntil) return;
  toastP = p; toastUntil = now + 1100;
  ui.toast.textContent = s; ui.toast.style.opacity = 1; clearTimeout(toastT); toastT = setTimeout(() => ui.toast.style.opacity = 0, 1100);
}
hooks.toast = toast;
hooks.shot = (label, delay, kind) => requestShot(label, delay, kind);
const mmss = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
let nextPeriodicShot = 20;

// ---------- настройки ----------
function setRadius(r) {
  T.crushRadius = Math.max(20, Math.min(80, Math.round(r)));
  ui.optRad.value = T.crushRadius; ui.optRadV.textContent = T.crushRadius;
  try { localStorage.setItem('antsiege_radius', T.crushRadius); } catch {}
}
function setMuted(m) {
  sfx.muted = m; ui.optSnd.checked = !m;
  try { localStorage.setItem('antsiege_mute', m ? '1' : '0'); } catch {}
}
function loadSettings() {
  let r = T.crushRadius, m = false, useMic = true;
  try {
    r = +localStorage.getItem('antsiege_radius') || r; m = localStorage.getItem('antsiege_mute') === '1';
    useMic = localStorage.getItem('antsiege_mic') !== '0';
  } catch {}
  setRadius(r); setMuted(m); ui.optMic.checked = useMic;
}
ui.optRad.oninput = () => setRadius(+ui.optRad.value);
ui.optSnd.onchange = () => setMuted(!ui.optSnd.checked);
ui.optMic.onchange = () => { try { localStorage.setItem('antsiege_mic', ui.optMic.checked ? '1' : '0'); } catch {} };
addEventListener('keydown', e => {
  if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
    setRadius(T.crushRadius + (e.code === 'BracketRight' ? 4 : -4));
    if (flags.running) toast(`ПАЛЕЦ ${T.crushRadius} PX`);
  } else if (e.code === 'KeyM') {
    setMuted(!sfx.muted);
    if (flags.running) toast(sfx.muted ? 'ЗВУК ВЫКЛ' : 'ЗВУК ВКЛ');
  } else if (e.code === 'KeyF') goFullscreen();
  else if (e.code === 'KeyD') { debug = !debug; ui.dbg.hidden = !debug; }
});

// ---------- загрузка всего нужного до старта: процент на кнопке, кнопки доступны, когда всё готово ----------
// Код игры и three.js к этому моменту уже загружены (иначе main.js не запустился бы). Дальше ждём распознавание
// (основной вес, ~12 МБ), шрифты и иконки бонусов
function preload() {
  const btns = [ui.btnStart, ui.btnCalib], label = ui.btnStart.dataset.label; // в разметке сейчас «Загрузка…»
  let rec = 0, fonts = 0, icons = 0;
  const show = () => {
    const p = rec * 0.94 + fonts * 0.03 + icons * 0.03; // распознавание — почти весь вес
    ui.btnStart.style.setProperty('--p', p);
    ui.btnStart.textContent = `Загрузка ${Math.round(p * 100)}%`;
  };
  ui.btnStart.classList.add('loading'); show();
  Promise.all([
    loadVision(p => { rec = p; show(); }),
    document.fonts.ready.then(() => { fonts = 1; show(); }),
    atlasReady.then(() => { icons = 1; show(); }), // иконки бонусов в атласе; иконки интерфейса встроены в css/icons.css
  ]).then(() => { ui.load.textContent = ''; },
    e => { ui.load.textContent = `Не всё загрузилось (${e.message || e}). Нажмите «Начать», чтобы попробовать снова.`; })
    .finally(() => {
      ui.btnStart.classList.remove('loading'); ui.btnStart.textContent = label;
      for (const b of btns) b.disabled = false;
    });
}

// ---------- старт ----------
// модели, камера и микрофон — один раз, для игры и для калибровки; btn показывает, что идёт
async function ensureMedia(btn) {
  const label = [...btn.childNodes]; // сами узлы, а не innerHTML: на них держат ссылки (#calState)
  btn.disabled = true;
  try {
    if (!visionReady()) {
      btn.textContent = 'Загружаю распознавание…';
      await loadVision(p => { if (btn.disabled) btn.textContent = `Загружаю распознавание… ${Math.round(p * 100)}%`; });
    }
    if (!view.vw) { btn.textContent = 'Запрашиваю камеру…'; await initCamera(video); }
    // микрофон отдельным запросом: отказ не должен лишать игры камеры
    if (ui.optMic.checked && !mic.ok && sfx.context()) {
      btn.textContent = 'Запрашиваю микрофон…';
      try { await initMic(sfx.context()); } catch { toast('НЕТ МИКРОФОНА'); }
    }
    resize();
  } finally { btn.disabled = false; btn.replaceChildren(...label); }
}
function showError(e) {
  ui.err.style.display = 'block';
  ui.err.textContent = 'Не удалось запустить: ' + (e.message || e) +
    '\nНужен Chrome/Edge/Safari с доступом к камере. Страница должна открываться с localhost или https.';
}

ui.btnStart.onclick = async () => {
  goFullscreen(); sfx.unlock();
  ui.err.style.display = 'none';
  try { await ensureMedia(ui.btnStart); }
  catch (e) { showError(e); ui.btnStart.textContent = 'Попробовать снова'; return; }
  ui.start.hidden = true; ui.hud.hidden = false; ui.life.hidden = false; ui.power.hidden = false;
  startRound();
};
ui.btnAgain.onclick = () => { goFullscreen(); sfx.unlock(); ui.over.hidden = true; ui.lightbox.hidden = true; startRound(); };

// ---------- калибровка: со стартового экрана или после игры, возвращает туда же ----------
let calibFrom = null;
async function startCalib(from, btn) {
  sfx.unlock();
  ui.err.style.display = 'none';
  try { await ensureMedia(btn); } catch (e) { showError(e); return; }
  calibFrom = from; from.hidden = true; ui.calib.hidden = false;
  resetGame(); // после игры: убрать муравьёв с экрана (итоги уже выписаны на экран результата)
  flags.calib = true; openCalib();
}
ui.btnCalib.onclick = () => startCalib(ui.start, ui.btnCalib);
ui.btnCalib2.onclick = () => startCalib(ui.over, ui.btnCalib2);
initCalib(() => {
  flags.calib = false; ui.calib.hidden = true; calibFrom.hidden = false; ui.warn.style.display = 'none';
  showCalState();
});
const showCalState = () => { ui.calState.textContent = isCalibrated() ? '· своя' : ''; };

function startRound() {
  resetGame(); resetShots(); nextPeriodicShot = 20;
  flags.over = false; flags.running = true;
}

// ---------- цикл: запускается один раз при загрузке ----------
let lastFrame = performance.now();
// ошибка в одном кадре не должна останавливать игру: следующий кадр запрашиваем в любом случае
function loop(now) {
  requestAnimationFrame(loop);
  try { frame(now); } catch (e) { console.error(e); }
}
function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000); lastFrame = now;
  if (flags.running || flags.calib) {
    track(video, now);
    sampleMic();
    // лица нет — пауза: иначе можно спрятать лицо, и муравьям не во что вцепиться
    flags.paused = flags.running && !flags.over && !flags.calib && head.lostFor > T.pauseAfter;
    warnings();
  }
  if (flags.calib) { updateCalib(dt); stepParticles(dt); }
  else if (flags.running) {
    stepFeel(dt);
    if (flags.paused) hud(G.att);                 // пауза: стоит всё — время, волны, муравьи, бонусы
    else if (!flags.over && G.freeze > 0) hud(G.att); // стоп-кадр: мир замер, камера, руки и тряска живут
    else if (!flags.over) {
      const attached = step(dt);
      // снимок для хронологии раз в 20 с
      if (G.t >= nextPeriodicShot) { requestShot('по ходу игры', 0, 'periodic'); nextPeriodicShot += 20; }
      if (G.life <= 0) { G.life = 0; endGame(); }
      hud(attached);
    }
    sfx.charge(flags.over || flags.paused ? -1 : chargeLevel()); // гул набора силы огненного шара
    if (!(G.freeze > 0) && !flags.paused) stepParticles(dt);
  }
  render();
  if (flags.running && !flags.calib) captureDue(canvas, G.t); // сразу после отрисовки, пока кадр в буфере
}

function endGame() {
  flags.over = true; sfx.over(); ui.cd.hidden = true;
  requestShot('съели', 0);
  const t = Math.round(G.t), sc = score();
  let best = 0;
  try { best = +localStorage.getItem('antsiege_best_score') || 0; if (sc > best) { best = sc; localStorage.setItem('antsiege_best_score', sc); } } catch {}
  $('#rScore').textContent = sc; $('#rTime').textContent = t + ' с'; $('#rKills').textContent = G.kills;
  $('#rWave').textContent = G.wave; $('#rBest').textContent = best; $('#rCombo').textContent = G.comboBest;
  $('#rCause').textContent = deathCause();
  ui.combo.hidden = true;
  setTimeout(() => { buildGallery(); ui.over.hidden = false; ui.btnAgain.focus({ preventScroll: true }); }, 900); // Enter — сразу ещё раз
}

// кто доел: вцепившиеся в момент гибели по видам, сначала самые прочные (их труднее снять)
function deathCause() {
  const by = {};
  for (const a of G.ants) if (a.st === 'attached') by[a.type] = (by[a.type] || 0) + 1;
  const n = Object.values(by).reduce((s, x) => s + x, 0);
  if (!n) return '';
  const parts = Object.entries(by).sort(([a], [b]) => ANTS[b].hp - ANTS[a].hp).map(([k, c]) => `${ANTS[k].title} ${c}`);
  return `На голове ${n}: ${parts.join(', ')}.`;
}

// ---------- галерея снимков на экране результата ----------
// снимки — кнопки: открываются крупно по клику
let lbIndex = 0; // какой снимок открыт крупно
function buildGallery() {
  ui.shots.replaceChildren(...shots().map((s, i) => {
    const b = document.createElement('button'), img = document.createElement('img'), cap = document.createElement('span');
    b.className = 'shot'; img.src = s.src; img.alt = s.label;
    cap.textContent = `${mmss(s.t)} · ${s.label}`;
    b.append(img, cap);
    b.onclick = () => { lbIndex = i; ui.lbImg.src = s.src; ui.lbCap.textContent = cap.textContent; ui.lightbox.hidden = false; };
    return b;
  }));
  const has = shots().length > 0;
  ui.shotsBox.hidden = !has;
  ui.over.querySelector('.card').classList.toggle('wide', has); // с галереей карточка шире
}
ui.lbClose.onclick = () => { ui.lightbox.hidden = true; };
ui.lbDl.onclick = () => downloadShot(shots()[lbIndex], lbIndex);
ui.btnDlAll.onclick = async () => {
  const label = ui.btnDlAll.innerHTML;
  ui.btnDlAll.disabled = true; ui.btnDlAll.textContent = 'Собираю архив…';
  try { await downloadAll(); } finally { ui.btnDlAll.disabled = false; ui.btnDlAll.innerHTML = label; }
};
ui.lightbox.onclick = e => { if (e.target === ui.lightbox) ui.lightbox.hidden = true; };

// предупреждения внизу (в игре и при калибровке): лицо важнее света
function warnings() {
  const msg = !(flags.calib || !flags.over) ? ''
    : flags.paused ? 'Пауза: не вижу лицо. Вернитесь в кадр'
    : head.lostFor > 0.8 ? 'Не вижу лицо. Вернитесь в кадр'
    : light.dark ? 'Мало света: руки и лицо распознаются хуже' : '';
  if (ui.warn.textContent !== msg) ui.warn.textContent = msg;
  ui.warn.style.display = msg ? 'block' : 'none';
  ui.warn.classList.toggle('pause', !!flags.paused); // пауза — крупно по центру
}

function hud(att) {
  ui.fill.style.transform = `scaleX(${G.life / 100})`;
  ui.life.className = G.fx.shield > 0 ? 'shield' : G.life <= 30 ? 'low' : G.life <= 60 ? 'mid' : '';
  ui.time.textContent = Math.floor(G.t); ui.score.textContent = score(); ui.kills.textContent = G.kills;
  ui.att.textContent = att; ui.wave.textContent = G.wave;
  const chips = ['lull', 'slow', 'shield', 'fear'].filter(k => G.fx[k] > 0)
    .map(k => `<span class="chip ${k}">${{ lull: 'передышка', slow: 'медленно', shield: 'бессмертие', fear: 'паника' }[k]} ${G.fx[k].toFixed(1)}</span>`);
  ui.fx.innerHTML = chips.join(' ');
  // серия: видна с 3 подряд; полоска — сколько осталось до обрыва
  ui.combo.hidden = G.combo < 3;
  if (G.combo >= 3) {
    ui.comboN.textContent = G.combo; ui.comboX.textContent = G.comboTier ? `×${comboMult()}` : '';
    ui.combo.className = G.comboTier ? 't' + G.comboTier : '';
    ui.comboFill.style.transform = `scaleX(${G.comboT / T.comboWindow})`;
  }
  // суперсила: шкала вверху; полная — светится
  ui.powerFill.style.transform = `scaleX(${G.power})`;
  ui.power.classList.toggle('ready', G.power >= 1);
  // отсчёт 3-2-1 (подсказка вверху, игра идёт): цифра заново «выпрыгивает» при каждой смене
  // 3-2-1 до события, затем «0» в момент начала
  const left = waveCountdown(), zero = !(left > 0) && G.cdZero > 0;
  ui.cd.hidden = !(left > 0 || zero);
  if (left > 0 || zero) {
    const n = zero ? '0' : String(Math.ceil(left));
    if (ui.cdNum.textContent !== n) {
      ui.cdNum.textContent = n; ui.cdNum.classList.remove('pop'); void ui.cdNum.offsetWidth; ui.cdNum.classList.add('pop');
    }
    ui.cdLabel.textContent = zero ? G.cdZeroLabel : G.t < T.countdown ? 'старт через' : `волна ${G.wave + 1} через`;
  } else ui.cdNum.textContent = '';
  if (debug) ui.dbg.textContent =
    `тряска ${head.shake.toFixed(1)} (сдвиг ${head.pPos.toFixed(1)}, поворот ${head.pRot.toFixed(1)}; хватка ${T.grip.join('–')})` +
    ` · рот ${head.jaw.toFixed(2)} (открыт от ${T.jawOpen})` +
    ` · микрофон ${mic.ok || mic.fake != null ? `${mic.level.toFixed(3)} (фон ${mic.floor.toFixed(3)}, порог ${Math.max(T.screamLevel, mic.floor * T.screamFloorMul).toFixed(3)})` : 'выкл'}` +
    ` · сила ${Math.round(G.power * 100)}% · свет ${light.level.toFixed(2)}` +
    input.hands.map((h, i) => (h.bend != null
      ? ` · рука${i + 1}: сгиб самого прямого ${h.bendMax.toFixed(2)} (кулак < ${T.fist3[0]}), средний ${h.bend.toFixed(2)} (раскрыта > ${T.fist3[1]}), щепоть ${h.pinch.toFixed(2)} (< ${T.pinch3[0]})`
      : ` · рука${i + 1}: кулак ${h.curl.toFixed(2)}/${T.fistCurl[0]}, щепоть ${h.bunch.toFixed(2)}/${T.fistBunch[0]}`) +
      (` раскрыта ${h.sinceOpen < 99 ? h.sinceOpen.toFixed(1) + ' с назад' : 'давно'} (огонь, если < ${T.armTime})` +
      (h.closed ? ` СЖАТА, заряд ${Math.round((h.fist?.charge || 0) * 100)}% (выстрел от ${T.chargeMin * 100}), движение ${Math.round(h.fist?.vPeak || 0)} px/с` : ''))).join('');
}

// ---------- запуск: только после всех объявлений ----------
initRenderer(canvas, video);
addEventListener('resize', resize);
resize();
loadSettings();
loadCalib(); showCalState();
preload();
resetGame();
requestAnimationFrame(loop);
