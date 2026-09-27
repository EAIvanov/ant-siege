// Игровая логика: муравьи, суперсила, бонусы, жизнь. Ничего не рисует.
import { T, PTS, BONUS, PAL, ANTS } from './config.js?v=f511fb61';
import { rand, pick, dist, clamp } from './util.js?v=f511fb61';
import { G, head, input, view } from './state.js?v=f511fb61';
import { sfx } from './audio.js?v=f511fb61';
import { mic } from './mic.js?v=f511fb61';

// UI подставляет свои функции: надпись (текст, важность 1..3: важная не перебивается менее важной)
// и снимок яркого момента (подпись, через сколько секунд снять)
export const hooks = { toast: () => {}, shot: () => {} };

// ---------- отклик: тряска и стоп-кадр ----------
// тряска копит «травму» 0..1: события её добавляют, она затухает; видимая сила — травма², так мелкие
// события лишь вздрагивают экран, а крупные бьют. Стоп-кадр замораживает мир (не видео и не руки)
export const addTrauma = k => { G.trauma = Math.min(1, G.trauma + k); };
export const hitStop = s => { G.freeze = Math.max(G.freeze, s); };
// видео на мгновение уходит в негатив (одна плавная волна за dur с)
export const negative = dur => { G.invT = G.invDur = dur; };
// каждый кадр, и в стоп-кадре тоже
export function stepFeel(dt) {
  G.trauma = Math.max(0, G.trauma - T.traumaDecay * dt);
  G.freeze = Math.max(0, G.freeze - dt);
  G.invT = Math.max(0, G.invT - dt);
}

// разгон мягче прежнего: виды сами добавляют разнообразие (бегунки ×1.6), потолок ниже
const baseSpeed = () => Math.min(50 + G.t * 1.6 + (G.wave - 1) * 6, 240);
// интервал «на одного рабочего»: быстро сокращается в первые волны, потом пол опускается с каждой волной —
// сложность растёт всю игру, а не упирается в потолок
const spawnEvery = () => Math.max(Math.max(0.28, 0.75 - 0.04 * (G.wave - 1)), 2.4 * Math.pow(0.98, G.t));

// один шаг игры; возвращает число прицепившихся
export function step(dt) {
  // пока суперсилу тратят (тряска, крик), она не копится — иначе капля зарядки за кадр
  // тут же уходила бы в тряску, и стряхивание работало бы с «пустой» шкалой
  const used = G.using; G.using = false;
  updatePower(dt, used);
  updateScream(dt);
  G.t += dt;
  for (const k in G.fx) G.fx[k] = Math.max(0, G.fx[k] - dt);
  updateWave(dt);

  // бюджет появления: каждый муравей «стоит» свою прочность (солдат — как 2.2 рабочих, стайка бегунков — 1.8),
  // так общий напор растёт плавно, а не удваивается с новыми видами
  if (G.fx.lull <= 0) G.spawnAcc += dt; // в передышку новые не приходят
  while (G.spawnAcc >= spawnEvery()) G.spawnAcc -= spawnEvery() * spawnGroup();
  updateBosses(dt);
  G.bonusIn -= dt; if (G.bonusIn <= 0) { spawnBonus(); G.bonusIn = rand(...T.bonusEvery); }

  updateFire(dt);
  updateCombo(dt);
  const { attached, drain } = updateAnts(dt);
  G.att = attached;
  // облепили сильнее прежнего — кадр на память
  if (attached >= 4 && attached >= (G.attShot || 0) + 3) { G.attShot = attached; hooks.shot(`облепили: ${attached}`, 0, 'attach'); }
  updateShakeCost(dt);
  updateBonuses(dt);
  if (drain > 0 && G.fx.shield <= 0) G.life -= drain * T.drainPerAnt * dt; // урон — сумма по видам вцепившихся
  if (G.life <= 30 && !G.lowWarned) { G.lowWarned = true; sfx.low(); } else if (G.life > 35) G.lowWarned = false;
  return attached;
}

export function stepParticles(dt) {
  for (const p of G.parts) { p.l -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= .9; p.vy *= .9; }
  G.parts = G.parts.filter(p => p.l > 0);
  G.blastT = Math.max(0, G.blastT - dt);
  for (const b of G.blasts) b.t += dt;
  G.blasts = G.blasts.filter(b => b.t < 0.6);
  for (const w of G.sWaves) w.t += dt;
  G.sWaves = G.sWaves.filter(w => w.t < 0.8);
  for (const p of G.pops) p.t += dt;
  G.pops = G.pops.filter(p => p.t < 0.3);
  for (const h of G.hits) h.t += dt;
  G.hits = G.hits.filter(h => h.t < 0.6);
}

// ---------- серия: убийства подряд без паузы дольше comboWindow поднимают множитель очков ----------
export const comboMult = () => G.comboTier ? T.comboTiers[G.comboTier - 1][1] : 1;

function updateCombo(dt) {
  if (G.combo && (G.comboT -= dt) <= 0) { G.combo = 0; G.comboTier = 0; }
}

function addCombo() {
  G.combo++; G.comboT = T.comboWindow; G.comboBest = Math.max(G.comboBest, G.combo);
  const tier = T.comboTiers.filter(([n]) => G.combo >= n).length;
  if (tier > G.comboTier) {
    G.comboTier = tier; sfx.combo(tier); hooks.toast(`СЕРИЯ ×${comboMult()}`, 1);
    if (tier === T.comboTiers.length) hooks.shot(`серия ${G.combo}`, 0);
  }
}

// ---------- волны и отсчёт 3-2-1: только подсказка со звуком, игра не останавливается ----------
// секунд до ближайшего события отсчёта (старт игры или следующая волна), 0 — отсчёта сейчас нет
export function waveCountdown() {
  if (G.t < T.countdown) return T.countdown - G.t;
  const left = G.wave * T.waveTime - G.t;
  return left <= T.countdown ? left : 0;
}

function updateWave(dt) {
  G.cdZero = Math.max(0, G.cdZero - dt);
  // «0» отсчёта: момент начала — держится 0.7 с вместе с сигналом старта
  if (G.t >= G.wave * T.waveTime) {
    G.wave++; sfx.go(); hooks.toast(`ВОЛНА ${G.wave}`, 3); G.cdZero = 0.7; G.cdZeroLabel = `волна ${G.wave}`;
    G.fx.lull = T.waveLull;
    hooks.shot(`волна ${G.wave}`, 0);
    G.bossQueue = 0; G.bossCalled = false; // гиганты следующей волны ещё не вызваны
    const fresh = Object.values(ANTS).find(t => t.from === G.wave); // новый вид в этой волне
    if (fresh) hooks.toast(`ВОЛНА ${G.wave}: ${fresh.title.toUpperCase()}`, 3);
  }
  else if (!G.started && G.t >= T.countdown) { G.started = true; sfx.go(); hooks.toast('ВПЕРЁД!', 3); G.cdZero = 0.7; G.cdZeroLabel = 'старт'; }
  const left = waveCountdown(), n = left > 0 ? Math.ceil(left) : 0;
  if (n && n !== G.cdBeep) sfx.tick(n);
  G.cdBeep = n;
}

// заряд самой заряженной сжатой руки (для звука набора силы); −1 — никто не заряжает
export function chargeLevel() {
  let k = -1;
  for (const h of input.hands) if (h.closed && h.fist) k = Math.max(k, h.fist.charge);
  return k < 0.03 ? -1 : k; // кулак сжат, но замаха нет — тихо
}

// ---------- суперсила: копится, пока её не тратят (тряска, крик, огонь) ----------
function updatePower(dt, used) {
  if (!used) G.power = Math.min(1, G.power + dt / T.powerCharge);
  const ready = G.power >= 1;
  if (ready && !G.powerWas) { hooks.toast('СУПЕРСИЛА ГОТОВА', 2); sfx.ready(); }
  G.powerWas = ready;
}

// кричит ли человек сейчас: громко — само по себе крик; с открытым ртом хватает и умеренной громкости;
// без микрофона — по широко открытому рту
function screaming() {
  const jaw = head.seen ? head.jaw : 0;
  if (!mic.ok && mic.fake == null) return jaw > T.jawScream;
  return mic.level > Math.max(T.screamLevel, mic.floor * T.screamFloorMul)
    || (jaw > T.jawOpen && mic.level > Math.max(T.screamLevelMouth, mic.floor * 2.5));
}

// крик — как огненный шар: пока звучит, копится заряд (виден у подбородка, изо рта расходятся волны);
// когда стих дольше screamGap — один импульс, тем сильнее, чем дольше кричали
function updateScream(dt) {
  if (!screaming()) {
    G.quietT += dt;
    if (G.quietT >= T.screamGap) {
      if (G.screamT >= T.screamHold) releaseScream(); else G.screamT = 0;
      G.screamLock = false;
    }
    return;
  }
  G.quietT = 0;
  if (G.screamLock) return; // после импульса ждём тишины
  G.using = true;
  if (G.power <= 0.01) { sfx.deny(); return; }
  G.screamT += dt;
  G.sWaveAcc += dt;
  if (G.sWaveAcc >= 0.12) { G.sWaveAcc = 0; G.sWaves.push({ x: head.mouth.x, y: head.mouth.y, r: head.r, t: 0 }); }
  // крик длиннее, чем хватает суперсилы (или максимума), — импульс сразу
  if (G.screamT >= Math.min(T.screamMax, G.power * T.screamMax)) { releaseScream(); G.screamLock = true; }
}

function releaseScream() {
  const d = Math.min(G.screamT, G.power * T.screamMax, T.screamMax), k = d / T.screamMax;
  G.screamT = 0;
  if (k <= 0) return;
  G.power = Math.max(0, G.power - k); G.powerWas = false;
  G.fx.fear = Math.max(G.fx.fear, 0.5 + (T.fearTime - 0.5) * k);
  G.blastT = 0.6; G.blastK = k;
  for (const a of G.ants) {
    if (a.st === 'dead' || !ANTS[a.type].fling) continue; // броненосцы и гиганты крика не боятся
    // вцепившихся срывает, только если импульс сильнее их хватки
    if (a.st === 'attached' && k * T.screamGrip <= a.grip) continue;
    a.st = 'run'; a.loose = 0;
    const an = Math.atan2(a.y - head.y, a.x - head.x), v = (250 + 650 * k) * rand(0.85, 1.15);
    a.vx = Math.cos(an) * v; a.vy = Math.sin(an) * v; a.flung = 0.6;
  }
  addTrauma(T.trauma.scream[0] + (T.trauma.scream[1] - T.trauma.scream[0]) * k); puff(head.x, head.y, Math.round(10 + 35 * k), [PAL.pink, PAL.violet, PAL.cyan]);
  sfx.scream(k); hooks.toast('КРИК!', 2); hooks.shot('крик', 0.15);
}

// ---------- огненный шар: жест распознан трекингом, здесь — заряд за суперсилу, полёт и взрыв ----------
// заряд копится, пока пальцы сжаты, и сразу списывается с суперсилы; кончилась сила — заряд не растёт
function updateCharge(dt) {
  for (const h of input.hands) {
    const f = h.fist;
    if (!h.closed || !f || f.age < T.closeHold) continue; // мигнувшее «сжатие» не собирает огонь
    // начать заряд — только при достаточной суперсиле; начатый можно добирать и ниже порога
    if (!f.charge && G.power < T.fireMinPower) { if (!f.denied) { f.denied = true; sfx.deny(); } continue; }
    const add = Math.min(dt / T.chargeTime, 1 - f.charge, G.power / T.fireCost);
    if (add > 0) { f.charge += add; G.power -= add * T.fireCost; G.powerWas = false; }
    else if (f.charge < 1 && !f.denied) { f.denied = true; sfx.deny(); } // сжал, а силы нет
    if (f.charge > 0) G.using = true; // пока держат заряд, суперсила не копится
  }
}

function updateFire(dt) {
  updateCharge(dt);
  for (const f of input.fires.splice(0)) launchFire(f);
  for (const b of G.fireballs) {
    b.t += dt; b.x += b.vx * dt; b.y += b.vy * dt;
    if (Math.random() < dt * 40) puff(b.x, b.y, 1, [PAL.fire, PAL.ember, PAL.flame]); // искры следом
    if (b.t >= T.fireFlight) explode(b);
  }
  G.fireballs = G.fireballs.filter(b => b.t < T.fireFlight);
}

function launchFire(f) {
  const k = f.k; // заряд уже оплачен суперсилой
  // не выстрел (сжимали слишком коротко или рука потерялась без движения) — заряд возвращается
  if (f.refund || k < T.chargeMin) { G.power = Math.min(1, G.power + k * T.fireCost); return; }
  G.power = Math.max(0, G.power - Math.max(0, T.fireMinShot - k * T.fireCost)); // слабый выстрел — не дешевле минимума
  const R = (T.fireRadius[0] + (T.fireRadius[1] - T.fireRadius[0]) * k) * rand(0.75, 1.25);
  // летит туда, куда направлен бросок: по боковому движению руки, тем дальше, чем оно резче;
  // чистый толчок вперёд взрывается почти у руки
  const sp = Math.hypot(f.vx, f.vy), d = Math.min(T.fireRange, sp * T.fireAim);
  const tx = clamp(f.x + (sp ? f.vx / sp : 0) * d, 0, view.W), ty = clamp(f.y + (sp ? f.vy / sp : 0) * d, 0, view.H);
  G.fireballs.push({ x: f.x, y: f.y, vx: (tx - f.x) / T.fireFlight, vy: (ty - f.y) / T.fireFlight, t: 0, k, R });
  sfx.fireLaunch(k);
}

function explode(b) {
  const { W, H } = view;
  b.x = clamp(b.x, 0, W); b.y = clamp(b.y, 0, H);
  G.blasts.push({ x: b.x, y: b.y, R: b.R, k: b.k, t: 0 });
  const dmg = T.fireDamage[0] + (T.fireDamage[1] - T.fireDamage[0]) * b.k;
  for (const a of G.ants) {
    if (a.st === 'dead') continue;
    const d = dist(a, b);
    if (d < b.R) { hurt(a, dmg); continue; } // в радиусе ранит всех, и вцепившихся; обычным хватает
    if (d < b.R * 1.6 && a.st !== 'attached' && ANTS[a.type].fling) { // чуть дальше — отбрасывает волной
      const an = Math.atan2(a.y - b.y, a.x - b.x), v = 500 * (1 - (d - b.R) / (b.R * 0.6)) + 150;
      a.vx = Math.cos(an) * v; a.vy = Math.sin(an) * v; a.flung = 0.8;
    }
  }
  addTrauma(T.trauma.fire[0] + (T.trauma.fire[1] - T.trauma.fire[0]) * b.k);
  hitStop(T.hitStop.fire[0] + (T.hitStop.fire[1] - T.hitStop.fire[0]) * b.k);
  puff(b.x, b.y, Math.round(25 + 45 * b.k), [PAL.fire, PAL.flame, PAL.ember]);
  sfx.fireBoom(b.k); if (b.k > 0.7) hooks.toast('ОГНЕННЫЙ УДАР!', 1); // слабый выстрел — без надписи, взрыва хватает
  hooks.shot(b.k > 0.7 ? 'огненный удар' : 'огонь', 0.12); // вспышка в самом разгаре
}

// стряхивание головой — тоже действие суперсилы: тратит её по силе тряски, пока есть кого стряхивать
function updateShakeCost(dt) {
  if (G.att === 0 || head.shake <= T.grip[0]) return;
  G.using = true;
  if (G.power > 0) { G.power = Math.max(0, G.power - (head.shake - T.grip[0]) * T.shakeCost * dt); G.powerWas = false; }
  else if (head.shake > T.grip[0] * 2) sfx.deny(); // явно трясём, а силы нет (обычные повороты не пищат)
}

// ---------- муравьи ----------
// вид по весам текущей волны: новые виды появляются с волны from и со временем чаще
function pickType() {
  const opts = Object.entries(ANTS).filter(([, t]) => !t.boss && t.from <= G.wave).map(([k, t]) => [k, Math.max(0, t.weight(G.wave))]);
  let r = Math.random() * opts.reduce((s, [, w]) => s + w, 0);
  for (const [k, w] of opts) { r -= w; if (r <= 0) return k; }
  return 'worker';
}

// возвращает «стоимость» появившихся в долях рабочего
function spawnGroup() {
  const type = pickType(), t = ANTS[type], n = t.pack || 1;
  const first = spawnAnt(type);
  // стайка появляется рядом
  for (let i = 1; i < n && first; i++) spawnAnt(type, { x: first.x + rand(-50, 50), y: first.y + rand(-50, 50) });
  return Math.max(1, t.hp * n);
}

export function spawnAnt(type = 'worker', at = null) {
  if (!ANTS[type].boss && G.ants.reduce((n, a) => n + (a.st !== 'dead'), 0) >= T.maxAnts) return null;
  const t = ANTS[type], { W, H } = view, m = 70 * (t.boss ? 2 : 1), side = Math.floor(Math.random() * 4);
  const x = at ? at.x : side === 0 ? -m : side === 1 ? W + m : rand(-m, W + m);
  const y = at ? at.y : side === 2 ? -m : side === 3 ? H + m : rand(-m, H + m);
  const a = {
    type, x, y, a: 0, hp: t.hp, maxHp: t.hp, size: rand(...t.size), st: 'run', vx: 0, vy: 0, flung: 0,
    ph: Math.random() * 10, wf: rand(1.5, 3.5) * (t.fly ? 1.6 : 1), wa: rand(0.15, 0.45) * (t.fly ? 2 : 1),
    jit: rand(0.85, 1.15), deadT: 0, ox: 0, oy: 0, grip: rand(...T.grip) + t.grip, loose: 0, hit: 0,
  };
  G.ants.push(a);
  return a;
}

// гиганты: за bossLead с до конца волны — предупреждение и 1..bossMax гигантов с интервалом
function updateBosses(dt) {
  if (!G.bossCalled && G.t >= G.wave * T.waveTime - T.bossLead) {
    G.bossCalled = true; G.bossQueue = Math.min(T.bossMax, 1 + Math.floor((G.wave - 1) / T.bossEvery)); G.bossIn = 0;
    hooks.toast('ГИГАНТЫ!', 3); sfx.horn(); negative(1); // негатив, а не красное и не тряска: красное и тряска — это урон
  }
  if (G.bossQueue > 0 && (G.bossIn -= dt) <= 0) { spawnAnt('giant'); G.bossQueue--; G.bossIn = T.bossGap; }
}

// урон муравью (огонь, взрыв): гибнет, если прочность кончилась
function hurt(a, dmg) {
  a.hp -= dmg; a.hit = 1;
  if (a.hp <= 0) kill(a);
}

function updateAnts(dt) {
  const { W, H } = view;
  const spd = baseSpeed() * (G.fx.slow > 0 ? T.slowMul : 1);
  let attached = 0, drain = 0;
  for (const h of input.hands) h.touch = [0, 0, 0, 0, 0]; // какие кончики сейчас давят муравья (подсветка)

  for (const a of G.ants) {
    if (a.st === 'dead') { a.deadT += dt; continue; }
    const t = ANTS[a.type], hpk = Math.max(0, a.hp / a.maxHp); // раненый замедляется
    if (a.st === 'attached') {
      a.x = head.x + a.ox * head.r; a.y = head.y + a.oy * head.r;
      a.a = Math.atan2(head.y - a.y, head.x - a.x) + Math.sin(G.t * 6 + a.ph) * 0.25;
      // стряхивание головой (только пока есть суперсила): сила тряски против хватки именно этого муравья
      if (G.power > 0 && head.shake > a.grip) a.loose += (head.shake - a.grip) * T.shakeRate * dt;
      else a.loose = Math.max(0, a.loose - T.regrip * dt);
      if (a.loose >= 1) shakeOff(a);
    }
    const stuck = a.st === 'attached';

    // давим пальцами (и свободных, и вцепившихся); чем быстрее палец трёт муравья, тем сильнее
    let press = 0; // 0 — не давят, 1 — неподвижный палец, до 1 + rubMax — быстрое трение
    for (const h of input.hands) h.tips.forEach((tip, i) => {
      if (dist(tip, a) < T.crushRadius + 5 * a.size * T.antScale) {
        press = Math.max(press, 1 + clamp(h.tv[i] / T.rubSpeed, 0, T.rubMax)); h.touch[i] = 1;
      }
    });
    a.hit = press ? 1 : Math.max(0, a.hit - dt * 2); // для яркости полоски здоровья
    if (press) {
      a.hp -= T.crushRate * press * dt;
      if (press > 1.5) { sfx.rub(); if (Math.random() < dt * 12) puff(a.x, a.y, 1, PAL.goo, false); }
      else sfx.press(); // и неподвижный палец слышно: тихое похрустывание, пока давит
      if (a.hp <= 0) { kill(a); continue; }
    }
    if (stuck) { attached++; drain += t.drain; continue; } // вцепившегося взмахом не сбросить

    // отшвыриваем взмахом (тяжёлых — нет; лёгких — от более слабого взмаха)
    if (a.flung <= 0 && t.fling) for (const h of input.hands) {
      const sp = Math.hypot(h.vx, h.vy);
      if (sp > T.flingSpeed / t.fling && dist(h.palm, a) < h.r * 1.15) {
        const k = Math.min(1, sp / 2200) * T.flingPower * Math.min(1.3, t.fling);
        a.vx = h.vx * k; a.vy = h.vy * k; a.flung = 1.1;
        puff(a.x, a.y, 5, [PAL.violet, PAL.pink]); sfx.fling();
        break;
      }
    }

    if (a.flung > 0) {
      a.flung -= dt;
      a.x += a.vx * dt; a.y += a.vy * dt;
      a.vx *= 0.955; a.vy *= 0.955;
      a.a = Math.atan2(a.vy, a.vx) + G.t * 40; // кувыркается
      // не даём улететь совсем
      a.x = clamp(a.x, -60, W + 60); a.y = clamp(a.y, -60, H + 60);
    } else if (G.fx.fear > 0 && t.fling) {
      // паника после крика: бегут прочь от головы, в пределах чуть за краем экрана
      const v = spd * t.speed * T.fearSpeed * a.jit;
      const ang = Math.atan2(a.y - head.y, a.x - head.x) + Math.sin(G.t * a.wf + a.ph) * a.wa;
      a.a = ang;
      a.x = clamp(a.x + Math.cos(ang) * v * dt, -60, W + 60); a.y = clamp(a.y + Math.sin(ang) * v * dt, -60, H + 60);
    } else {
      // к голове с вихлянием (у крылатых — широкий зигзаг)
      const v = spd * t.speed * (0.15 + 0.85 * hpk) * a.jit;
      const ang = Math.atan2(head.y - a.y, head.x - a.x) + Math.sin(G.t * a.wf + a.ph) * a.wa;
      a.a = ang;
      a.x += Math.cos(ang) * v * dt; a.y += Math.sin(ang) * v * dt;
    }

    // добежал; в полёте не цепляется, иначе стряхнутый тут же прицепится обратно
    if ((G.fx.fear <= 0 || !t.fling) && head.seen && a.flung <= 0 && dist(a, head) < head.r * 0.92) {
      a.st = 'attached'; a.loose = 0;
      // садится на контур головы, а не на лицо: там его видно и можно достать пальцем
      const ang = Math.atan2(a.y - head.y, a.x - head.x), rr = rand(0.85, 1.0);
      a.ox = Math.cos(ang) * rr; a.oy = Math.sin(ang) * rr;
      attached++; drain += t.drain; sfx.attach();
      G.hits.push({ ang, t: 0 }); if (G.hits.length > 8) G.hits.shift(); // вспышка на краю экрана с его стороны
    }
  }
  G.ants = G.ants.filter(a => !(a.st === 'dead' && a.deadT > 1.6));
  return { attached, drain };
}

function shakeOff(a) {
  a.st = 'run'; a.loose = 0; G.pts += PTS.shakeOff;
  // летит наружу от центра головы и отстаёт от её движения по инерции
  const an = Math.atan2(a.y - head.y, a.x - head.x), v = 260 + 40 * head.shake;
  a.vx = Math.cos(an) * v - head.vx * 0.35; a.vy = Math.sin(an) * v - head.vy * 0.35; a.flung = 0.9;
  puff(a.x, a.y, 5, [PAL.violet, PAL.cyan]); sfx.shakeOff();
}

// очки — по виду, за вцепившегося ×1.5, и множитель серии; гигант даёт ещё и суперсилу.
// chain = false — убит бонусом-взрывом: серию не продолжает
function kill(a, chain = true) {
  if (a.st === 'dead') return;
  const t = ANTS[a.type];
  if (chain) addCombo();
  G.pts += Math.round(t.pts * (a.st === 'attached' ? 1.5 : 1) * (chain ? comboMult() : 1));
  a.st = 'dead'; a.deadT = 0; G.kills++;
  puff(a.x, a.y, t.boss ? 30 : 7, PAL.goo, false);
  G.pops.push({ x: a.x, y: a.y, size: a.size, t: 0, tier: G.comboTier });
  if (t.hp >= 2 && !t.boss) addTrauma(T.trauma.heavy); // крепкий хрустнул — экран вздрагивает
  sfx.crush(1 + Math.min(G.combo, 20) * 0.025); // в серии хруст всё выше
  if (t.boss) {
    G.power = Math.min(1, G.power + T.bossReward);
    addTrauma(T.trauma.giant); hitStop(T.hitStop.giant); puff(a.x, a.y, 40, [PAL.gold, PAL.violet]);
    hooks.toast('ГИГАНТ ПОВЕРЖЕН', 3); hooks.shot('гигант повержен', 0.1); sfx.boom();
  }
}

// ---------- бонусы ----------
export function spawnBonus() {
  let s = BONUS.reduce((a, b) => a + b.w, 0), r = Math.random() * s, b = BONUS[0];
  for (const x of BONUS) { r -= x.w; if (r <= 0) { b = x; break; } }
  const p = bonusSpot();
  const pow = b.k === 'boom' ? pick(T.boomPowers) : 0;
  G.bonuses.push({ ...b, pow, x: p.x, y: p.y, age: 0, ph: Math.random() * 6 });
}

// точка подальше от всех точек рук (и от лица, где пальцы давят муравьёв), чтобы бонус не подбирался сам
function bonusSpot() {
  const { W, H } = view, pts = input.hands.flatMap(h => h.pts);
  let best = null, bestD = -Infinity;
  for (let i = 0; i < 40; i++) {
    const p = { x: rand(80, W - 80), y: rand(90, H - 90) };
    let d = (dist(p, head) - head.r) * 2;
    for (const q of pts) d = Math.min(d, dist(p, q));
    if (d > bestD) { bestD = d; best = p; }
    if (d >= T.bonusAvoid) break;
  }
  return best;
}

function updateBonuses(dt) {
  for (const b of G.bonuses) {
    b.age += dt; b.y += Math.sin(G.t * 1.6 + b.ph) * 18 * dt; b.x += Math.cos(G.t * 1.1 + b.ph) * 12 * dt;
    if (b.age > T.bonusLife) { b.dead = true; continue; }
    for (const h of input.hands) for (const p of h.pts) if (dist(p, b) < 46) { applyBonus(b); b.dead = true; break; }
  }
  G.bonuses = G.bonuses.filter(b => !b.dead);
}

export function applyBonus(b) {
  puff(b.x, b.y, 22, [PAL.violet, PAL.pink, PAL.cyan, PAL.gold]);
  switch (b.k) {
    case 'boom': {
      hooks.toast(`ВЗРЫВ ${Math.round(b.pow * 100)}%`, 2); hooks.shot('взрыв', 0.1);
      // гиганты не гибнут, а ранятся; из остальных — часть, но не все: хотя бы один остаётся
      for (const a of G.ants) if (a.st !== 'dead' && ANTS[a.type].boss) hurt(a, T.boomBossDamage);
      const alive = G.ants.filter(a => a.st !== 'dead' && !ANTS[a.type].boss);
      for (let i = alive.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [alive[i], alive[j]] = [alive[j], alive[i]]; }
      const n = Math.min(alive.length - 1, Math.round(alive.length * b.pow));
      alive.slice(0, Math.max(0, n)).forEach(a => kill(a, false));
      addTrauma(T.trauma.boom); negative(0.45); puff(head.x, head.y, 50, [PAL.gold, PAL.pink, PAL.violet]); sfx.boom(); return;
    }
    case 'slow': G.fx.slow = T.slowTime; break;
    case 'life': G.life = Math.min(100, G.life + T.lifeBonus); break;
    case 'med': G.life = Math.min(100, G.life + T.medBonus); break;
    case 'shield': G.fx.shield = T.shieldTime; break;
  }
  hooks.toast(b.t, 2); sfx.bonus();
}

// частицы: glow — светящиеся искры (аддитивно), иначе обычные капли
export function puff(x, y, n, cols, glow = true) {
  const many = Array.isArray(cols[0]);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * 6.28, s = rand(60, 260);
    G.parts.push({
      x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, l: rand(.3, .7),
      col: many ? pick(cols) : cols, glow, sz: glow ? rand(10, 18) : rand(6, 10), rot: Math.random() * 6.28,
    });
  }
}
