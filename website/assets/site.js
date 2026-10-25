/* Site menu and scroll motion. Each page handles its own docs and purchase flow. */
(function () {
  'use strict';
  var root = document.documentElement;
  var toggle = document.querySelector('[data-menu-toggle]');
  var menu = toggle && document.getElementById(toggle.getAttribute('aria-controls'));
  if (toggle && menu) {
    function setMenu(open) {
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? '메뉴 닫기' : '메뉴 열기');
      menu.hidden = !open;
      root.classList.toggle('menu-open', open);
    }
    toggle.addEventListener('click', function () { setMenu(toggle.getAttribute('aria-expanded') !== 'true'); });
    menu.addEventListener('click', function (e) { if (e.target.closest('a')) setMenu(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') { setMenu(false); toggle.focus(); }
    });
    window.addEventListener('resize', function () { if (window.innerWidth > 760) setMenu(false); }, { passive: true });
  }

  featureReel();
  hero();
  motion();
  friction();

  function featureReel() {
    var reel = document.querySelector('.feature-reel');
    if (!reel) return;
    var video = reel.querySelector('video');
    var buttons = Array.prototype.slice.call(reel.querySelectorAll('[data-feature-time]'));
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    var visible = false, userPaused = false, automaticPause = false;
    function play() { video.play().catch(function () {}); }
    buttons.forEach(function (button) {
      button.addEventListener('click', function () {
        userPaused = false;
        buttons.forEach(function (item) { item.setAttribute('aria-pressed', String(item === button)); });
        function seek() {
          video.currentTime = Number(button.dataset.featureTime);
          play();
        }
        if (video.readyState) seek();
        else { video.addEventListener('loadedmetadata', seek, { once: true }); video.load(); }
      });
    });
    video.addEventListener('timeupdate', function () {
      var chapter = Math.min(2, Math.floor(video.currentTime / 6));
      buttons.forEach(function (button, index) { button.setAttribute('aria-pressed', String(index === chapter)); });
    });
    video.addEventListener('pause', function () {
      if (!automaticPause && visible && !document.hidden) userPaused = true;
      automaticPause = false;
    });
    video.addEventListener('play', function () { userPaused = false; });
    function sync() {
      if (visible && !document.hidden && !reduce.matches && !userPaused) play();
      else if (!video.paused) { automaticPause = true; video.pause(); }
    }
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        sync();
      }, { threshold: 0.25 }).observe(video);
    }
    document.addEventListener('visibilitychange', sync);
    reduce.addEventListener('change', sync);
  }

  /* Hero launch: the neurons grow from their cell bodies, the title types itself in, then the rest follows.
     After the intro a steady blue light follows the cursor across the neurons. */
  function hero() {
    var section = document.querySelector('.sketch-hero');
    var title = section && section.querySelector('h1');
    var pre = section && section.querySelector('.ascii-art--neurons');
    if (!title || !pre || !root.classList.contains('intro')) return;
    var fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    var marks = '<>/-vo', chars = [], caret = document.createElement('span'), done = false;
    var glow = pre.cloneNode(false), canvas = document.createElement('canvas');
    var pointer = null, light = null, turn = { cos: 1, sin: 0 }, visible = true, raf = 0;
    var glowWidth = 0, glowHeight = 0, glowRadius = 72, cellWidth = 6, cellHeight = 10;
    canvas.width = canvas.height = glowRadius * 2;
    canvas.style.position = 'absolute';
    glow.appendChild(canvas);
    var ink = canvas.getContext('2d');
    // One entry per column. A jamo is two columns wide, so it leaves an empty column behind it.
    var neuronLines = pre.textContent.split('\n').map(function (line) {
      var columns = [];
      Array.prototype.forEach.call(line, function (ch) { columns.push(ch); if (/[ㄱ-ㅎ]/.test(ch)) columns.push(''); });
      return columns;
    });
    var neuronColumns = Math.max.apply(null, neuronLines.map(function (line) { return line.length; }));

    // Only rasterize the 144px hover patch: a steady light that fades out from the pointer.
    function shimmer() {
      ink.clearRect(0, 0, canvas.width, canvas.height);
      var left = Math.round(light.x - glowRadius), top = Math.round(light.y - glowRadius);
      canvas.style.left = left + 'px';
      canvas.style.top = top + 'px';
      var x0 = Math.max(1, Math.floor(left / cellWidth));
      var x1 = Math.min(neuronColumns - 2, Math.ceil((left + canvas.width) / cellWidth));
      var y0 = Math.max(1, Math.floor(top / cellHeight));
      var y1 = Math.min(neuronLines.length - 2, Math.ceil((top + canvas.height) / cellHeight));
      for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) {
        var glyph = neuronLines[y][x];
        if (!glyph || glyph === ' ') continue;
        var px = x * cellWidth - left, py = y * cellHeight - top;
        var dx = px - glowRadius, dy = py - glowRadius;
        var distance = (dx * dx + dy * dy) / (glowRadius * glowRadius);
        if (distance >= 1) continue;
        ink.globalAlpha = (1 - distance) * .85;
        ink.fillText(glyph, px, py);
      }
    }

    function glyph(c) {
      if (/[가-힣]/.test(c)) return String.fromCharCode(0xac00 + Math.floor(Math.random() * 11172));
      return marks.charAt(Math.floor(Math.random() * marks.length));
    }
    function scramble(ch, flips, then, pick) {
      var final = ch.getAttribute('data-ch'), n = 0;
      (function flip() {
        if (n++ < flips) { ch.textContent = pick ? pick() : glyph(final); setTimeout(flip, 45); return; }
        ch.textContent = final;
        if (then) then();
      })();
    }
    // Wrap each syllable in a span; words stay unbreakable so Korean line breaks don't change.
    function split(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (child) {
        if (child.nodeType === 1) { if (child.tagName === 'SPAN') split(child); return; }
        if (child.nodeType !== 3) return;
        var frag = document.createDocumentFragment();
        child.textContent.split(/(\s+)/).forEach(function (part) {
          if (!part) return;
          if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); return; }
          var word = document.createElement('span');
          word.className = 'hero-word';
          part.split('').forEach(function (c) {
            var ch = document.createElement('span');
            ch.className = 'hero-ch';
            ch.setAttribute('data-ch', c);
            ch.textContent = c;
            word.appendChild(ch);
            chars.push(ch);
          });
          frag.appendChild(word);
        });
        node.replaceChild(frag, child);
      });
    }
    function place(ch, before) {
      var h = title.getBoundingClientRect(), r = ch.getBoundingClientRect();
      caret.style.left = (r.left - h.left + (before ? 0 : r.width)).toFixed(1) + 'px';
      caret.style.top = (r.top - h.top + r.height * .14).toFixed(1) + 'px';
      caret.style.height = (r.height * .74).toFixed(1) + 'px';
    }
    function play() {
      if (section.classList.contains('is-playing')) return;
      chars.forEach(function (ch) { ch.style.width = ch.getBoundingClientRect().width.toFixed(2) + 'px'; });
      section.classList.add('is-playing');
      place(chars[0], true);
      caret.classList.add('is-on');
      chars.forEach(function (ch, i) {
        setTimeout(function () { ch.classList.add('is-on'); place(ch); scramble(ch, 3); }, 120 + i * 56);
      });
      var end = 120 + chars.length * 56;
      setTimeout(function () { caret.classList.add('is-blink'); }, end + 120);
      setTimeout(function () { section.classList.add('is-lit'); measure(); wake(); }, 1100);
      setTimeout(function () {
        caret.classList.remove('is-on', 'is-blink');
        chars.forEach(function (ch) { ch.style.width = ''; });
        done = true;
        setTimeout(rotate, 400);
      }, end + 1000);
    }
    // After the intro, the last word erases and retypes through the documents people write in HWP.
    var rotor = title.querySelector('.hero-rotate');
    var kinds = ['문서', '수행평가', '과제', '보고서', '계약서', '시험지', '소설', '민원서', '공문', '이력서', '회의록', '기획서', '논문', '안내문', '견적서', '통신문', '일기', '원고'], kind = 0;
    // Retyped syllables flicker through plain geometric shapes before they land.
    var shapes = '○△□◇▽◎';
    function shape() { return shapes.charAt(Math.floor(Math.random() * shapes.length)); }
    function rotate() {
      if (!rotor || !root.classList.contains('motion')) return;
      if (!visible || document.hidden) { setTimeout(rotate, 600); return; }
      var word = kinds[kind = (kind + 1) % kinds.length];
      caret.classList.add('is-on');
      caret.classList.remove('is-blink');
      (function erase() {
        var last = rotor.lastElementChild;
        if (last) { place(last, true); rotor.removeChild(last); setTimeout(erase, 70); return; }
        place(rotor, true);
        setTimeout(function () { type(0); }, 260);
      })();
      function type(i) {
        if (i === word.length) { caret.classList.add('is-blink'); setTimeout(rotate, 2200); return; }
        var ch = document.createElement('span');
        ch.className = 'hero-ch is-on';
        ch.setAttribute('data-ch', word.charAt(i));
        ch.textContent = word.charAt(i);
        rotor.appendChild(ch);
        place(ch);
        scramble(ch, 3, null, shape);
        setTimeout(function () { type(i + 1); }, 110);
      }
    }
    function measure() {
      var style = getComputedStyle(pre);
      glowWidth = pre.offsetWidth;
      glowHeight = pre.offsetHeight;
      glow.style.width = glowWidth + 'px';
      glow.style.height = glowHeight + 'px';
      ink.font = style.fontSize + ' ' + style.fontFamily;
      ink.textBaseline = 'top';
      ink.fillStyle = getComputedStyle(section).getPropertyValue('--accent-hover').trim() || '#a0bdf6';
      cellWidth = ink.measureText('M').width;
      cellHeight = parseFloat(style.lineHeight);
      var m = /matrix\(([^,]+),\s*([^,]+)/.exec(style.transform);
      turn = m ? { cos: parseFloat(m[1]), sin: parseFloat(m[2]) } : { cos: 1, sin: 0 };
    }
    function lit() { return visible && !document.hidden && root.classList.contains('motion') && section.classList.contains('is-lit'); }
    function wake() { if (!raf && pointer && lit()) raf = requestAnimationFrame(tick); }
    function tick(now) {
      raf = 0;
      if (!pointer || !lit()) return;
      var r = glow.getBoundingClientRect();
      var dx = pointer.x - r.left - r.width / 2, dy = pointer.y - r.top - r.height / 2;
      light = {
        x: glowWidth / 2 + turn.cos * dx + turn.sin * dy,
        y: glowHeight / 2 - turn.sin * dx + turn.cos * dy
      };
      shimmer();
    }

    glow.classList.add('ascii-art--glow');
    pre.parentNode.insertBefore(glow, pre.nextSibling);
    title.setAttribute('aria-label', (title.innerText || title.textContent).replace(/\s+/g, ' ').trim());
    split(title);
    // The rotating word keeps its syllables as direct children so they erase one at a time.
    var wrap = title.querySelector('.hero-rotate > .hero-word');
    if (wrap) { while (wrap.firstChild) wrap.parentNode.insertBefore(wrap.firstChild, wrap); wrap.remove(); }
    caret.className = 'hero-caret';
    caret.setAttribute('aria-hidden', 'true');
    title.appendChild(caret);
    root.classList.add('intro-run');

    var fonts = document.fonts && document.fonts.load ? document.fonts.load('700 1em Gaegu') : null;
    if (fonts) fonts.then(play, play);
    setTimeout(play, fonts ? 400 : 0);
    window.addEventListener('resize', measure, { passive: true });
    section.addEventListener('pointermove', function (e) {
      if (fine.matches) { pointer = { x: e.clientX, y: e.clientY }; section.classList.add('is-neuron-hover'); wake(); }
    });
    section.addEventListener('pointerleave', function () { pointer = null; light = null; section.classList.remove('is-neuron-hover'); });
    // Hovering a syllable once the intro is over re-decodes it. On "나의 한글 문서." the flicker reads
    // the Hunminjeongeum preface in order, so sweeping across the line walks through the text.
    var preface = '나랏말싸미듕귁에달아문짜와로서르사맛디아니할쎄', read = 0;
    function next() { var c = preface.charAt(read); read = (read + 1) % preface.length; return c; }
    title.addEventListener('pointerover', function (e) {
      var ch = e.target.closest && e.target.closest('.hero-ch');
      if (!done || !ch || ch.closest('.hero-rotate') || !fine.matches || ch.hasAttribute('data-busy') || !root.classList.contains('motion')) return;
      ch.setAttribute('data-busy', '');
      ch.style.width = ch.getBoundingClientRect().width.toFixed(2) + 'px';
      scramble(ch, 4, function () { ch.style.width = ''; ch.removeAttribute('data-busy'); }, ch.closest('.hero-marked-title') ? next : null);
    });
    document.addEventListener('visibilitychange', wake);
    if (reduce.addEventListener) reduce.addEventListener('change', function () { setTimeout(wake); });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) { visible = entries[0].isIntersecting; wake(); }).observe(section);
    }
  }

  /* Sticky nav, reveals, splash words and ASCII art motion. */
  function motion() {
    var nav = document.querySelector('[data-nav]');
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    var fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    var links = nav ? Array.prototype.slice.call(nav.querySelectorAll('.nav__links a[href^="#"]')) : [];
    var sections = links.map(function (link) { return document.querySelector(link.getAttribute('href')); });
    var splash = document.querySelector('.editor-splash');
    var words = splash ? Array.prototype.slice.call(splash.querySelectorAll('.keyword-splash li')) : [];
    var art = Array.prototype.slice.call(document.querySelectorAll('.ascii-art:not(.ascii-art--neurons)'));
    var depth = [-24, 26, -20, 34, -28, 18, -32, 24, 20, 36, -22, 30];
    var centers = [], pointer = null, queued = false;
    var phone = window.matchMedia('(max-width: 760px)');

    function enabled() { return !reduce.matches && 'IntersectionObserver' in window; }
    function apply() { root.classList.toggle('motion', enabled()); queue(); }

    // Measure how far each word bursts out from the center of the screenshot.
    function measure() {
      if (!splash) return;
      var cx = splash.offsetWidth / 2, cy = splash.offsetHeight / 2;
      centers = words.map(function (word, i) {
        var x = word.offsetLeft + word.offsetWidth / 2, y = word.offsetTop + word.offsetHeight / 2;
        word.style.setProperty('--sx', ((cx - x) * .62).toFixed(1) + 'px');
        word.style.setProperty('--sy', ((cy - y) * .62).toFixed(1) + 'px');
        word.style.setProperty('--delay', (i * 45) + 'ms');
        word.style.setProperty('--drift', (7 + (i * 7 % 6)) + 's');
        word.style.setProperty('--drift-delay', (-i * 1.3).toFixed(1) + 's');
        return { x: x, y: y, rx: 0, ry: 0 };
      });
    }

    function progress(element) {
      var r = element.getBoundingClientRect();
      var p = (r.top + r.height / 2 - window.innerHeight / 2) / window.innerHeight;
      return Math.max(-1.2, Math.min(1.2, p));
    }

    function frame() {
      queued = false;
      var y = window.scrollY;
      if (nav) {
        nav.classList.toggle('is-stuck', y > 8);
        // Past the first screen the nav stays put: a slim bar on larger screens, the bare menu button on phones.
        nav.classList.toggle('is-compact', y > 240 && !phone.matches);
        var line = window.innerHeight * .4, current = null;
        sections.forEach(function (section, i) { if (section && section.getBoundingClientRect().top <= line) current = links[i]; });
        links.forEach(function (link) {
          if (link === current) link.setAttribute('aria-current', 'location');
          else link.removeAttribute('aria-current');
        });
      }
      if (!enabled()) return;
      art.forEach(function (pre) {
        var section = pre.closest('.notebook-section') || pre.parentElement;
        pre.style.translate = '0 ' + (progress(section) * -48).toFixed(1) + 'px';
      });
      if (!splash) return;
      var box = splash.getBoundingClientRect();
      var shift = progress(splash), moving = false;
      centers.forEach(function (c, i) {
        var tx = 0, ty = 0;
        if (pointer) {
          var dx = box.left + c.x - pointer.x, dy = box.top + c.y - pointer.y;
          var d = Math.sqrt(dx * dx + dy * dy) || 1;
          // Words near the cursor get nudged away.
          if (d < 190) { var push = Math.pow(1 - d / 190, 2) * 22; tx = dx / d * push; ty = dy / d * push; }
        }
        c.rx += (tx - c.rx) * .12;
        c.ry += (ty - c.ry) * .12;
        if (Math.abs(tx - c.rx) > .1 || Math.abs(ty - c.ry) > .1) moving = true;
        words[i].style.setProperty('--rx', c.rx.toFixed(2) + 'px');
        words[i].style.setProperty('--ry', (c.ry + depth[i] * shift).toFixed(2) + 'px');
      });
      if (moving) queue();
    }
    function queue() { if (!queued) { queued = true; requestAnimationFrame(frame); } }

    apply();
    measure();
    if (reduce.addEventListener) reduce.addEventListener('change', apply);
    window.addEventListener('scroll', queue, { passive: true });
    window.addEventListener('resize', function () { measure(); queue(); }, { passive: true });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
    if (splash) {
      splash.addEventListener('pointermove', function (e) { if (fine.matches) { pointer = { x: e.clientX, y: e.clientY }; queue(); } });
      splash.addEventListener('pointerleave', function () { pointer = null; queue(); });
    }
    if (!('IntersectionObserver' in window)) return;

    var reveal = ['.editor-photograph', '.provider-list article', '.provider-billing', '.connect-intro > p', '.final-hippo', '.price-note'];
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -12% 0px' });
    document.querySelectorAll(reveal.join(',')).forEach(function (element) {
      var index = Array.prototype.indexOf.call(element.parentElement.children, element);
      element.setAttribute('data-reveal', '');
      element.style.setProperty('--reveal-delay', Math.min(index, 3) * 90 + 'ms');
      observer.observe(element);
    });
    if (splash) observer.observe(splash);
  }
  /* Full-screen sections ([data-slide]) behave like slides. One critically damped spring drives every move:
     a stroke toward the next slide stretches the page a little with growing resistance, a firm stroke
     retargets the same spring at the next slide, and a stroke that stops short lets it settle back.
     Because the spring keeps its velocity across those changes, the motion never restarts or jerks.
     Trackpad momentum after a slide change is absorbed, so one swipe moves one slide. A slide taller
     than the screen scrolls natively until its edge comes into view. */
  function friction() {
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    var slides = Array.prototype.slice.call(document.querySelectorAll('[data-slide]'));
    if (!slides.length) return;
    // A gentle trackpad swipe sums past COMMIT; a single event of NOTCH or more (a wheel notch) commits at once.
    var STRETCH = 48, SOFTNESS = 60, COMMIT = 60, NOTCH = 50, IDLE = 180, QUIET = 180, GAP = 120, SETTLE_MAX = 700;
    var GLIDE = 12, BAND = 20;                        // spring frequencies (rad/s): slide change, stretch
    var raf = 0, pos = 0, vel = 0, goal = 0, last = 0, committed = false;
    var pull = null, idle = 0, settling = false, settleTimer = 0, settleStart = 0, lastDelta = 0, lastWheel = 0;

    function tick(now) {
      var dt = Math.min(.034, (now - last) / 1000), w = committed ? GLIDE : BAND;
      last = now;
      vel += (w * w * (goal - pos) - 2 * w * vel) * dt;
      pos += vel * dt;
      // Land once the last couple of pixels remain instead of creeping through the spring's long tail.
      if (Math.abs(goal - pos) < 2 && Math.abs(vel) < 40) {
        window.scrollTo({ top: goal, behavior: 'instant' });
        raf = 0; vel = 0;
        if (committed) { committed = false; settled(); }
        return;
      }
      window.scrollTo({ top: pos, behavior: 'instant' });
      raf = requestAnimationFrame(tick);
    }
    function drive(to, commit, speed) {
      goal = to;
      committed = !!commit;
      if (raf) return;
      pos = window.scrollY; vel = speed || 0; last = performance.now();
      raf = requestAnimationFrame(tick);
    }
    function halt() { cancelAnimationFrame(raf); raf = 0; vel = 0; committed = false; }
    function stop() { halt(); pull = null; clearTimeout(idle); }
    // Absorb the momentum tail of the swipe that changed slides; disarm after a short quiet spell.
    function settled() {
      settling = true; settleStart = performance.now(); lastDelta = Infinity;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(function () { settling = false; }, QUIET);
    }
    // Where each slide starts (the first one from the very top) and the last scroll position that still shows it.
    // What follows the last slide (the footer) is one more stop, so a single-slide page still glides to it.
    function stops() {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      var list = slides.map(function (slide, i) {
        var r = slide.getBoundingClientRect(), top = i ? r.top + window.scrollY : 0;
        var start = Math.min(top, max);
        return { start: start, end: Math.min(max, Math.max(start, r.bottom + window.scrollY - window.innerHeight)) };
      });
      var tail = Math.min(max, slides[slides.length - 1].getBoundingClientRect().bottom + window.scrollY);
      if (tail > list[list.length - 1].end + 1) list.push({ start: tail, end: max });
      return list;
    }
    // Where a stroke leaves from and heads to, a clamp at a slide edge, or null to let the browser scroll.
    function plan(y, delta, list) {
      if (delta > 0) {
        var i = -1;
        list.forEach(function (s, k) { if (s.start <= y + 1) i = k; });
        var cur = list[i], next = list[i + 1];
        if (!cur || !next) return null;
        if (y < cur.end - 1) return y + delta <= cur.end ? null : { clampTo: cur.end };
        // Stretch from where the page actually is, which can be past the slide after a jump or scrollbar drag.
        return { home: Math.max(y, cur.end), to: next.start };
      }
      var j = -1;
      list.forEach(function (s, k) { if (s.start < y - 1) j = k; });
      if (j < 0) return null;
      var s = list[j];
      if (y > s.end + 1) {
        // Below the last slide (the footer) scrolls freely, then stops at its edge.
        if (j === list.length - 1) return y + delta > s.end ? null : { clampTo: s.end };
        return { home: y, to: s.end };
      }
      if (s.end > s.start + 1 && y + delta > s.start) return null;
      return { home: s.start, to: s.start };
    }
    function step(dir) {
      var p = plan(raf ? goal : window.scrollY, dir, stops());
      if (!p) return false;
      pull = null; clearTimeout(idle);
      drive(p.clampTo !== undefined ? p.clampTo : p.to, true);
      return true;
    }
    window.addEventListener('wheel', function (e) {
      if (reduce.matches || e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      if (root.classList.contains('menu-open')) return;
      var delta = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? window.innerHeight : 1);
      var now = performance.now(), size = Math.abs(delta), gap = now - lastWheel;
      lastWheel = now;
      if (committed) {
        // A deliberate stroke against the glide turns it around; anything else rides along.
        if (Math.sign(delta) !== Math.sign(goal - pos) && size > 30 && gap > GAP) {
          committed = false;
          if (step(delta > 0 ? 1 : -1)) { e.preventDefault(); return; }
        }
        e.preventDefault();
        return;
      }
      if (settling) {
        // After a pause, or when strokes grow again, it is a new swipe; anything else is momentum.
        var fresh = gap > GAP || (size > lastDelta * 1.6 && size > 24);
        if (!fresh && now - settleStart < SETTLE_MAX) {
          e.preventDefault();
          lastDelta = size;
          clearTimeout(settleTimer);
          settleTimer = setTimeout(function () { settling = false; }, QUIET);
          return;
        }
        clearTimeout(settleTimer); settling = false;
      }
      // Plan from where the spring is heading, so a stroke mid-stretch keeps its slide.
      var y = raf ? goal : window.scrollY, p = plan(y, delta, stops());
      if (!p) { if (raf) stop(); pull = null; return; }
      e.preventDefault();
      if (p.clampTo !== undefined) { stop(); window.scrollTo({ top: p.clampTo, behavior: 'instant' }); settled(); return; }
      var dir = delta > 0 ? 1 : -1;
      clearTimeout(idle);
      if (Math.abs(p.to - p.home) < 2) { pull = null; drive(p.to, true); return; }
      if (!pull || pull.dir !== dir || pull.to !== p.to) pull = { dir: dir, home: p.home, to: p.to, amount: 0 };
      pull.amount += size;
      if (pull.amount > COMMIT || size >= NOTCH) { var to = pull.to; pull = null; drive(to, true); return; }
      // Stretch: the page gives way less the harder it is pulled, and settles back when the stroke stops.
      drive(pull.home + dir * STRETCH * (1 - Math.exp(-pull.amount / SOFTNESS)));
      idle = setTimeout(function () {
        if (!pull) return;
        var home = pull.home;
        pull = null;
        drive(home);
      }, IDLE);
    }, { passive: false });
    // Arrow, Page and Space keys step between slides with the same spring; Home and End jump to the ends.
    // Inside a tall slide or the footer they scroll natively. Other keys leave the spring alone.
    window.addEventListener('keydown', function (e) {
      var el = e.target, key = e.key;
      var typing = el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
      if (typing || e.altKey || e.ctrlKey || e.metaKey || reduce.matches || root.classList.contains('menu-open')) return;
      var dir = { ArrowDown: 1, PageDown: 1, ArrowUp: -1, PageUp: -1 }[key];
      // Space on a focused button or link presses it.
      if (key === ' ') { if (el && el.closest && el.closest('button, a, summary')) return; dir = e.shiftKey ? -1 : 1; }
      else if (e.shiftKey) return;
      if (key === 'Home' || key === 'End') {
        e.preventDefault(); pull = null; clearTimeout(idle);
        drive(key === 'Home' ? 0 : document.documentElement.scrollHeight - window.innerHeight, true);
        return;
      }
      if (!dir) return;
      if (step(dir)) e.preventDefault();
      else stop();
    });
    // In-page links to a slide (or anything inside one) glide to the slide's start instead of the browser's jump.
    document.addEventListener('click', function (e) {
      var link = e.target.closest && e.target.closest('a[href^="#"]');
      if (!link || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || reduce.matches) return;
      var target = document.getElementById(decodeURIComponent(link.getAttribute('href').slice(1)));
      var slide = target && target.closest('[data-slide]');
      if (!slide) return;
      e.preventDefault();
      pull = null; clearTimeout(idle);
      drive(stops()[slides.indexOf(slide)].start, true);
      history.replaceState(null, '', link.getAttribute('href'));
    });
    // A resize moves the slides; keep a glide aimed at the slide it was heading for.
    window.addEventListener('resize', function () {
      if (!raf || !committed) return;
      var list = stops(), best = list[0];
      list.forEach(function (s) { if (Math.abs(s.start - goal) < Math.abs(best.start - goal)) best = s; });
      goal = best.start;
    }, { passive: true });
    // Touch: past the slide edge the page follows the finger with resistance; a swipe of 40px, or a
    // quick flick, changes slides and the spring carries the finger's speed into the glide.
    var touch = null, nativeUntil = 0, nativeY = 0, wall = null;
    // A native touch scroll (and its momentum) inside a tall slide or the footer stops at the slide edge it
    // crosses, and stays there until the gesture and its momentum are over.
    window.addEventListener('scroll', function () {
      if (performance.now() > nativeUntil) { wall = null; return; }
      var y = window.scrollY;
      if (wall === null) {
        stops().forEach(function (s) {
          [s.start, s.end].forEach(function (b) { if ((nativeY < b && y > b) || (nativeY > b && y < b)) wall = { at: b, side: Math.sign(nativeY - b) }; });
        });
        nativeY = y;
      }
      if (wall && (y - wall.at) * wall.side < 0) window.scrollTo({ top: wall.at, behavior: 'instant' });
    }, { passive: true });
    window.addEventListener('touchstart', function (e) {
      if (reduce.matches || e.touches.length > 1 || root.classList.contains('menu-open')) { touch = null; return; }
      var y = e.touches[0].clientY;
      touch = { y0: y, last: y, t: performance.now(), v: 0, mode: committed ? 'block' : null };
      if (!committed && raf) halt();
    }, { passive: true });
    window.addEventListener('touchmove', function (e) {
      if (!touch || e.touches.length > 1) return;
      var y = e.touches[0].clientY, now = performance.now(), dy = touch.y0 - y;
      touch.v = (touch.last - y) / Math.max(1, now - touch.t);
      touch.last = y; touch.t = now;
      // Decide on the very first move: once the browser starts a native scroll it ignores preventDefault
      // (iOS) or makes the event uncancelable (Android), and the two would fight over the page.
      if (touch.mode === null) {
        if (!dy) return;
        var dir = dy > 0 ? 1 : -1, p = e.cancelable ? plan(window.scrollY, dir, stops()) : null;
        if (!p || p.clampTo !== undefined) { touch.mode = 'native'; nativeUntil = Infinity; nativeY = window.scrollY; wall = null; return; }
        touch.mode = 'band'; touch.dir = dir; touch.home = p.home; touch.to = p.to;
      }
      if (touch.mode === 'native') return;
      e.preventDefault();
      if (touch.mode !== 'band') return;
      var reach = Math.max(0, dy * touch.dir);
      window.scrollTo({ top: touch.home + touch.dir * STRETCH * 1.6 * (1 - Math.exp(-reach / 180)), behavior: 'instant' });
    }, { passive: false });
    window.addEventListener('touchend', function () {
      if (touch && touch.mode === 'native' && nativeUntil) nativeUntil = performance.now() + 1500;
      if (!touch || touch.mode !== 'band') { touch = null; return; }
      var dy = (touch.y0 - touch.last) * touch.dir, flick = touch.v * touch.dir > .35;
      var go = Math.abs(touch.to - touch.home) > 1 && (dy > 40 || flick);
      drive(go ? touch.to : touch.home, go, go ? touch.v * 1000 : 0);
      touch = null;
    });
    window.addEventListener('pointerdown', function (e) { if (e.pointerType !== 'touch') stop(); });
  }
})();
