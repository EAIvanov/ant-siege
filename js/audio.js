// Звуки синтезируются WebAudio на лету, без файлов
export const sfx = (() => {
  let ac = null, out = null, nbuf = null, muted = false;
  const last = {};
  // не чаще раза в gap мс для каждого звука, чтобы массовые события не превращались в шум
  const ok = (k, gap) => {
    const n = performance.now();
    if (!ac || muted || n - (last[k] || 0) < gap) return false;
    last[k] = n; return true;
  };
  // частые звуки каждый раз чуть выше или ниже (±k), чтобы не приедались
  const vary = (k = 0.07) => 1 + (Math.random() * 2 - 1) * k;
  function tone(f0, f1, dur, type = 'sine', vol = 0.2, at = 0) {
    const t = ac.currentTime + at, o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(out); o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(dur, vol, f0, f1, at = 0) {
    if (!nbuf) {
      nbuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = nbuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const t = ac.currentTime + at, s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = nbuf; f.type = 'bandpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f).connect(g).connect(out); s.start(t); s.stop(t + dur + 0.02);
  }
  // набор силы огненного шара: лёгкий чистый тон и тихий звонкий призвук выше, мягко мерцают;
  // генераторы постоянные, высоту и громкость плавно двигаем каждый кадр
  let chg = null;
  function charge(k) {
    if (!ac) return;
    if (!chg) {
      const o = ac.createOscillator(), o2 = ac.createOscillator(), g = ac.createGain(), g2 = ac.createGain();
      const lfo = ac.createOscillator(), lg = ac.createGain(); // мерцание громкости
      o.type = 'sine'; o2.type = 'sine'; g.gain.value = 0; g2.gain.value = 0.35;
      lfo.frequency.value = 5; lg.gain.value = 0; lfo.connect(lg).connect(g.gain);
      o.connect(g); o2.connect(g2).connect(g); g.connect(out);
      o.start(); o2.start(); lfo.start();
      chg = { o, o2, g, lfo, lg };
    }
    const t = ac.currentTime, on = k >= 0 && !muted;
    const v = on ? 0.012 + 0.03 * k : 0;
    chg.g.gain.setTargetAtTime(v, t, 0.08); chg.lg.gain.setTargetAtTime(v * 0.35, t, 0.08);
    if (on) {
      const f = 520 + 520 * k; // от «до» второй октавы вверх на октаву
      chg.o.frequency.setTargetAtTime(f, t, 0.08);
      chg.o2.frequency.setTargetAtTime(f * 3, t, 0.08); // дуодецима — звонкость без резкости
      chg.lfo.frequency.setTargetAtTime(5 + 7 * k, t, 0.15);
    }
  }

  return {
    charge, // k 0..1 — сила замаха, k < 0 — тишина
    // AudioContext можно создать только из жеста пользователя
    unlock() {
      try {
        if (!ac) { ac = new AudioContext(); out = ac.createGain(); out.gain.value = 0.6; out.connect(ac.destination); }
        if (ac.state === 'suspended') ac.resume();
      } catch {}
    },
    get muted() { return muted; }, set muted(v) { muted = v; },
    context() { return ac; }, // тот же контекст нужен микрофону
    // p — высота: в серии хруст поднимается
    crush(p = 1) { if (ok('crush', 40)) { const v = vary() * p; noise(0.14, 0.5, 2200 * v, 250 * v); tone(260 * v, 70 * v, 0.12, 'square', 0.06); } },
    fling()    { if (ok('fling', 90)) { const v = vary(0.12); noise(0.22, 0.25, 500 * v, 3500 * v); } },
    attach()   { if (ok('attach', 120)) { const v = vary(); tone(180 * v, 110 * v, 0.14, 'sawtooth', 0.07); } },
    shakeOff() { if (ok('shake', 50)) { const v = vary(0.1); tone(420 * v, 950 * v, 0.09, 'triangle', 0.14); } },
    // новая ступень серии: короткое восходящее арпеджио, тем длиннее, чем выше ступень
    combo(tier) { if (ok('combo', 200)) [659, 880, 1175, 1568].slice(0, tier + 1).forEach((f, i) => tone(f, f, 0.12, 'triangle', 0.16, i * 0.05)); },
    bonus()    { if (ok('bonus', 100)) [660, 880, 1320, 1760].forEach((f, i) => tone(f, f, 0.14, 'sine', 0.14, i * 0.06)); },
    boom()     { if (ok('boom', 200)) { noise(0.7, 0.8, 1500, 60); tone(110, 35, 0.6, 'sine', 0.5); } },
    // отсчёт перед волной: 3, 2, 1 — каждый выше, последний длиннее
    tick(n)    { if (ok('tick', 300)) tone(660 + (3 - n) * 220, 660 + (3 - n) * 220, n === 1 ? 0.35 : 0.14, 'sine', 0.22); },
    // гиганты идут: низкий гудящий рог
    horn()     { if (ok('horn', 1500)) { tone(70, 65, 1.1, 'sawtooth', 0.16); tone(105, 98, 1.1, 'sawtooth', 0.08); noise(1.0, 0.2, 200, 90); } },
    go()       { if (ok('go', 500)) [784, 1175].forEach((f, i) => tone(f, f, 0.2, 'triangle', 0.2, i * 0.08)); },
    ready()    { if (ok('ready', 500)) [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, f, 0.18, 'sine', 0.12, i * 0.07)); },
    deny()     { if (ok('deny', 600)) tone(150, 120, 0.18, 'square', 0.07); },
    // палец давит, но не трёт: тихий короткий хруст, частота как у шагов
    press()    { if (ok('press', 170)) { const v = vary(0.2); noise(0.045, 0.1, 1800 * v, 900 * v); tone(140 * v, 90 * v, 0.04, 'square', 0.025); } },
    rub()      { if (ok('rub', 110)) { const v = vary(0.15); noise(0.06, 0.18, 2600 * v, 1200 * v); } },
    scream(k = 1) { if (ok('scream', 300)) { noise(0.25 + 0.4 * k, 0.3 + 0.4 * k, 300, 4000); tone(90, 120 + 200 * k, 0.45, 'sawtooth', 0.18 * k + 0.04); } },
    fireLaunch(k = 1) { if (ok('fireL', 150)) { noise(0.35, 0.35 + 0.3 * k, 200, 2500); tone(120, 260, 0.3, 'sawtooth', 0.08); } },
    fireBoom(k = 1)   { if (ok('fireB', 150)) { noise(0.5 + 0.5 * k, 0.5 + 0.35 * k, 2000, 80); tone(95, 30, 0.5 + 0.3 * k, 'sine', 0.35 + 0.2 * k); } },
    low()      { if (ok('low', 1500)) [440, 440].forEach((f, i) => tone(f, f, 0.1, 'square', 0.08, i * 0.16)); },
    over()     { if (ok('over', 1000)) [392, 311, 233, 175].forEach((f, i) => tone(f, f * 0.97, 0.22, 'triangle', 0.18, i * 0.2)); },
  };
})();
