// 밤하늘 장면. 한 칸이 화면의 --u 픽셀인 작은 캔버스를 정수배로 키워서 그려요.
// 하마 그림은 website/assets/hama.svg(앉은 하마)와 website/404.html(엎드린 하마)을 그대로 옮겼어요.
(() => {
  const PAL = {
    a: '#b2e2fb', b: '#62b3e2', c: '#2f73a0', d: '#1d4766', e: '#0c2536', k: '#000000', w: '#e6f5ff',
    n: '#15304a', m: '#122a40',
  };
  const SKY = ['#0b0f14', '#101820', '#15212c'];
  const GROUND = '#0c2536';
  const DEEP_GROUND = '#0a1e2c';

  const LYING = [
    '...........................',
    '.....aaaa..................',
    '..aaabbbbaaa.....aac.......',
    'aabbbbbbbbbbbaa.abbca......',
    'bbbbbbbbbbbbbbbabbbbbbaaa..',
    'bbbbbbbbbbbbbbbbbbebbbbbc..',
    'cbbbbbbbbbbbbbbbbkbbbbbbb..',
    '.bbbbbbbbbbbbbbbbbbbbbbbbbc',
    '.bbbccbbbbbcbbbbbbbbbbbbbbc',
    '.bbbddccbbbddbbbcccccccccd.',
    '.cccdd..cccdd.dddddddddd...',
  ];
  const SITTING = [
    '.............aaa......',
    '.............bbbaa....',
    '.............bbbbc....',
    '.............bbbb.....',
    '............abbbb.....',
    '.........a..bbbbc.....',
    '........acaabbbb......',
    '..........bbbbbc...w..',
    '.........akbbbbe.wabaa',
    '........abbbbbeeabbbcc',
    '.....aaabbbbbbbbbbcc..',
    '..aaabbbbbbbbbbccc....',
    'aabbbbbbbbbbbbc.......',
    'bbbbbbbbbbbbbb........',
    'bbbbbbbbbbbbbb........',
    'cbbbbbbbbbbbbc........',
    '.bbbbbbbbbbbc.........',
    '.bbbccbbbbbcd.........',
    '.bbbddccbbbdd.........',
    '.cccdd..cccdd.........',
  ];
  const MOON = [
    '..aa.......',
    '.aa........',
    '.aw........',
    'aww........',
    'awww.......',
    'awww.......',
    'awwww......',
    '.awwwww...a',
    '.aawwwwwwaa',
    '..aawwwwaa.',
    '....aaaa...',
  ];
  const CLOUD = [
    '....nnnn........',
    '...nnnnnn.nnn...',
    '.nnnnnnnnnnnnn..',
    'nnnnnnnnnnnnnnn.',
    'nnnnnnnnnnnnnnnn',
    '.mmmmmmmmmmmmmm.',
  ];

  const grid = (rows) => rows.map((row) => row.split(''));
  const patch = (rows, changes) => {
    const out = grid(rows);
    for (const [x, y, c] of changes) out[y][x] = c;
    return out;
  };
  /** 숨을 들이쉬면 등이 한 칸 솟아요: 0~14열의 맨 윗칸을 한 줄 위로 올려요. */
  const inhale = (rows) => {
    const out = grid(rows);
    for (let x = 0; x <= 14; x += 1) {
      const top = out.findIndex((row) => row[x] !== '.');
      if (top > 0) { out[top - 1][x] = out[top][x]; out[top][x] = 'b'; }
    }
    return out;
  };
  const blink = (rows) => rows.map((row) => row.slice()).map((row, y) => {
    if (y === 5) row[18] = 'b';
    if (y === 6) row[17] = 'c';
    return row;
  });
  /** 귀가 한 칸 쫑긋 서요. */
  const twitch = (rows) => {
    const out = rows.map((row) => row.slice());
    out[1][17] = 'a'; out[1][18] = 'c';
    out[2][17] = 'b'; out[2][18] = 'b'; out[2][19] = 'a';
    return out;
  };
  const LIE = grid(LYING);
  const LIE_IN = inhale(LYING);
  const LIE_BLINK = blink(LIE);
  const LIE_TWITCH = twitch(LIE);
  const SIT = grid(SITTING);
  const SIT_BLINK = patch(SITTING, [[10, 8, 'b']]);
  const CLOUD_PX = grid(CLOUD);

  /** 손으로 흩뿌린 별: [가로 비율, 하늘 높이 비율, 종류, 주기(초), 시작] */
  const STARS = [
    [0.035, 0.07, 'dot', 9, 1], [0.12, 0.83, 'dim'], [0.18, 0.05, 'far'], [0.25, 0.9, 'dot', 11, 4],
    [0.31, 0.08, 'plus', 7, 0.6], [0.37, 0.76, 'far'], [0.43, 0.14, 'dim'], [0.475, 0.88, 'plusDim', 8, 3.1],
    [0.53, 0.33, 'dot', 13, 6], [0.565, 0.06, 'far'], [0.6, 0.64, 'dim'], [0.645, 0.22, 'plus', 6.4, 2.2],
    [0.69, 0.47, 'far'], [0.715, 0.09, 'dot', 10, 7.5], [0.755, 0.72, 'dot', 12, 2], [0.785, 0.36, 'dim'],
    [0.83, 0.58, 'plusDim', 9.4, 5], [0.86, 0.12, 'far'], [0.9, 0.8, 'dim'], [0.94, 0.42, 'dot', 8.6, 0.3],
    [0.97, 0.18, 'plus', 7.8, 4.4], [0.02, 0.94, 'far'], [0.34, 0.96, 'far'], [0.505, 0.55, 'far'], [0.665, 0.9, 'dim'],
  ];

  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const PAD = 2;
  let stage, canvas, ctx, bg;
  let u = 4, cols = 0, rows = 0, horizon = 0, hamaX = 0, moon = [0, 0], wall = false;
  let lastKey = '', timer = 0;
  let celebration = null;
  const pose = { blinkAt: 0, twitchAt: 0 };

  function sprite(c, rows, x, y) {
    for (let j = 0; j < rows.length; j += 1) {
      const row = rows[j];
      for (let i = 0; i < row.length; i += 1) {
        const k = row[i];
        if (k === '.') continue;
        c.fillStyle = PAL[k];
        c.fillRect(x + i, y + j, 1, 1);
      }
    }
  }

  /** y 아래를 color 로 칠하고, 경계 두 줄은 바둑판으로 섞어요. */
  function stepDown(c, y, end, color) {
    c.fillStyle = color;
    c.fillRect(0, y + 2, cols, Math.max(0, end - y - 2));
    for (let x = 0; x < cols; x += 1) c.fillRect(x, y + (x % 2), 1, 1);
  }

  /** 바뀌지 않는 하늘, 지평선, 땅, 달을 한 번만 그려 둬요. */
  function paintBackground() {
    bg = document.createElement('canvas');
    bg.width = cols;
    bg.height = rows;
    const c = bg.getContext('2d');
    const b1 = Math.round(horizon * 0.46);
    const b2 = Math.round(horizon * 0.8);
    c.fillStyle = SKY[0]; c.fillRect(0, 0, cols, horizon);
    stepDown(c, b1, horizon, SKY[1]);
    stepDown(c, b2, horizon, SKY[2]);
    c.fillStyle = PAL.c; c.fillRect(0, horizon, cols, 1);
    c.fillStyle = GROUND; c.fillRect(0, horizon + 1, cols, rows - horizon - 1);
    // 땅은 벽 화면에서 한 단 어두워지고, 관리 화면에서는 페이지 바탕으로 이어져요.
    if (wall) stepDown(c, horizon + Math.round((rows - horizon) * 0.55), rows, DEEP_GROUND);
    else stepDown(c, rows - PAD - 2, rows, SKY[0]);
    c.fillStyle = PAL.d;
    for (let x = 0; x < cols; x += 1) if (x % 8 === 0 || x % 8 === 3) c.fillRect(x, horizon + 3, 1, 1);
    sprite(c, grid(MOON), moon[0] - 5, moon[1] - 5);
    for (const star of STARS) if (star[2] === 'far' || star[2] === 'dim') drawStar(c, star, false);
  }

  function starPos([fx, fy]) {
    const visible = cols - PAD * 2;
    return [PAD + Math.round(fx * (visible - 1)), PAD + 1 + Math.round(fy * (horizon - PAD - 4))];
  }

  function twinkling(star, t) {
    const [, , , period, offset = 0] = star;
    if (!period) return false;
    const phase = ((t + offset) % period) / period;
    return phase >= 0.88 && phase < 0.94;
  }

  function drawStar(c, star, off) {
    const [x, y] = starPos(star);
    const kind = star[2];
    if (Math.abs(x - moon[0]) < 9 && Math.abs(y - moon[1]) < 9) return;
    if (kind === 'far') { c.fillStyle = PAL.d; c.fillRect(x, y, 1, 1); return; }
    if (kind === 'dim') { c.fillStyle = PAL.c; c.fillRect(x, y, 1, 1); return; }
    if (kind === 'dot') { c.fillStyle = off ? PAL.c : PAL.a; c.fillRect(x, y, 1, 1); return; }
    const arm = kind === 'plus' ? PAL.b : PAL.c;
    c.fillStyle = kind === 'plus' ? PAL.w : PAL.a;
    c.fillRect(x, y, 1, 1);
    if (off) return;
    c.fillStyle = arm;
    c.fillRect(x - 1, y, 1, 1); c.fillRect(x + 1, y, 1, 1);
    c.fillRect(x, y - 1, 1, 1); c.fillRect(x, y + 1, 1, 1);
  }

  /** 지금 시각의 장면 상태. 같은 상태면 다시 그리지 않아요. */
  function frame(now) {
    const t = reduced.matches ? 0 : now / 1000;
    const stars = STARS.map((s) => (s[2] === 'far' || s[2] === 'dim' ? 0 : twinkling(s, t) ? 1 : 0)).join('');
    const clouds = reduced.matches ? 0 : Math.floor(t / 7);
    let hama = 'lie';
    let shot = -1;
    if (celebration) {
      const since = now - celebration.start;
      if (since > 2800) celebration = null;
      else {
        hama = since < 90 ? 'hop' : 'sit';
        if (since > 1100 && since < 1250) hama = 'sitBlink';
        shot = Math.floor(since / 70);
      }
    }
    if (hama === 'lie' && !reduced.matches) {
      if (now >= pose.blinkAt && now < pose.blinkAt + 160) hama = 'blink';
      else if (now >= pose.blinkAt + 160) pose.blinkAt = now + 3800 + Math.random() * 3600;
      const tw = now - pose.twitchAt;
      if (tw >= 0 && tw < 500 && hama === 'lie') hama = Math.floor(tw / 125) % 2 === 0 ? 'twitch' : 'lie';
      else if (tw >= 500) pose.twitchAt = now + 9000 + Math.random() * 9000;
      if (hama === 'lie' && Math.floor(t / 2.2) % 2 === 1) hama = 'in';
    }
    return { key: `${stars}|${clouds}|${hama}|${shot}`, t, stars, clouds, hama, shot };
  }

  function draw(f) {
    ctx.drawImage(bg, 0, 0);
    STARS.forEach((star, i) => {
      if (star[2] === 'far' || star[2] === 'dim') return;
      drawStar(ctx, star, f.stars[i] === '1');
    });
    // 구름 한 장이 7초에 한 칸씩 오른쪽으로 흘러가요.
    const span = cols + 20;
    sprite(ctx, CLOUD_PX, ((Math.round(0.18 * span) + f.clouds) % span) - 18, Math.round(0.7 * horizon));
    if (f.hama === 'sit' || f.hama === 'hop' || f.hama === 'sitBlink') {
      const lift = f.hama === 'hop' ? 2 : 0;
      sprite(ctx, f.hama === 'sitBlink' ? SIT_BLINK : SIT, hamaX + 3, horizon - SIT.length + 1 - lift);
    } else {
      const rows = { in: LIE_IN, blink: LIE_BLINK, twitch: LIE_TWITCH }[f.hama] ?? LIE;
      sprite(ctx, rows, hamaX, horizon - LIE.length + 1);
    }
    if (f.shot >= 0 && celebration) drawShootingStar(f.shot);
  }

  /** 오른쪽 위에서 왼쪽 아래로 긋는 별똥별. 꼬리는 네 가지 색으로 짧아져요. */
  function drawShootingStar(step) {
    const { sx, sy } = celebration;
    const tail = [PAL.w, PAL.a, PAL.a, PAL.b, PAL.b, PAL.c, PAL.c, PAL.d, PAL.d];
    const head = step * 3;
    const fade = Math.max(0, step - 9);
    for (let i = tail.length - 1; i >= 0; i -= 1) {
      const d = head - i * 2;
      if (d < 0 || i < fade - 3) continue;
      const x = sx - d;
      const y = sy + Math.floor(d / 2);
      if (y >= horizon - 1 || x < 0) continue;
      ctx.fillStyle = tail[Math.min(tail.length - 1, i + Math.max(0, fade))] ?? PAL.d;
      ctx.fillRect(x, y, 2, 1);
    }
  }

  function tick() {
    clearTimeout(timer);
    if (!ctx || document.hidden) return;
    const f = frame(performance.now());
    if (f.key !== lastKey) { lastKey = f.key; draw(f); }
    if (reduced.matches && !celebration) return;
    timer = setTimeout(tick, celebration ? 70 : 125);
  }

  function layout() {
    if (!stage) return;
    wall = root.classList.contains('wall');
    const w = innerWidth;
    const h = innerHeight;
    u = wall ? Math.max(3, Math.floor(Math.min(w / 160, h / 90))) : Math.min(6, Math.max(3, Math.floor(w / 288)));
    root.style.setProperty('--u', `${u}px`);
    root.style.setProperty('--fp', `${Math.max(1, Math.round(u / 6))}px`);
    const box = stage.getBoundingClientRect();
    const visibleCols = Math.ceil(box.width / u);
    const visibleRows = Math.ceil(box.height / u);
    cols = visibleCols + PAD * 2;
    rows = visibleRows + PAD * 2;
    horizon = PAD + (wall ? Math.round(visibleRows * 0.64) : visibleRows - 7);
    hamaX = PAD + Math.round(visibleCols * (wall ? 0.6 : 0.7));
    moon = [PAD + Math.round(visibleCols * (wall ? 0.84 : 0.8)), PAD + Math.round((horizon - PAD) * (wall ? 0.36 : 0.42))];
    root.style.setProperty('--horizon', `${(horizon - PAD) * u}px`);
    canvas.width = cols;
    canvas.height = rows;
    canvas.style.width = `${cols * u}px`;
    canvas.style.height = `${rows * u}px`;
    canvas.style.left = canvas.style.top = `${-PAD * u}px`;
    ctx = canvas.getContext('2d');
    paintBackground();
    lastKey = '';
    tick();
  }

  function celebrate() {
    if (!ctx || reduced.matches) return;
    const visible = cols - PAD * 2;
    celebration = {
      start: performance.now(),
      sx: PAD + Math.round(visible * (0.66 + Math.random() * 0.2)),
      sy: PAD + Math.round((horizon - PAD) * (0.18 + Math.random() * 0.1)),
    };
    tick();
  }

  function mount(node) {
    stage = node;
    canvas = node.querySelector('canvas');
    pose.blinkAt = performance.now() + 2500;
    pose.twitchAt = performance.now() + 7000;
    let pending = 0;
    addEventListener('resize', () => { cancelAnimationFrame(pending); pending = requestAnimationFrame(layout); });
    document.addEventListener('visibilitychange', tick);
    reduced.addEventListener('change', () => { lastKey = ''; tick(); });
    layout();
  }

  window.hamaScene = { mount, layout, celebrate };
})();
