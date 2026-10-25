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
     After the intro a blue signal light wanders the neurons (or follows the cursor) and the hero tilts with it. */
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
    var neuronLines = pre.textContent.split('\n');
    var neuronColumns = Math.max.apply(null, neuronLines.map(function (line) { return line.length; }));
    var states = new Uint8Array(neuronColumns * neuronLines.length), nextStates = new Uint8Array(states.length);

    // Only rasterize the 144px hover patch. The original text never changes.
    function shimmer() {
      ink.clearRect(0, 0, canvas.width, canvas.height);
      var left = Math.round(light.x - glowRadius), top = Math.round(light.y - glowRadius);
      canvas.style.left = left + 'px';
      canvas.style.top = top + 'px';
      nextStates.fill(0);
      var x0 = Math.max(1, Math.floor(left / cellWidth));
      var x1 = Math.min(neuronColumns - 2, Math.ceil((left + canvas.width) / cellWidth));
      var y0 = Math.max(1, Math.floor(top / cellHeight));
      var y1 = Math.min(neuronLines.length - 2, Math.ceil((top + canvas.height) / cellHeight));
      for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) {
        var glyph = neuronLines[y].charAt(x);
        if (!glyph || glyph === ' ') continue;
        var px = x * cellWidth - left, py = y * cellHeight - top;
        var dx = px - glowRadius, dy = py - glowRadius;
        var distance = (dx * dx + dy * dy) / (glowRadius * glowRadius);
        if (distance >= 1) continue;
        var index = y * neuronColumns + x, state = states[index], excited = 0;
        for (var oy = -1; oy <= 1; oy++) for (var ox = -1; ox <= 1; ox++) {
          if ((ox || oy) && states[index + oy * neuronColumns + ox] === 1) excited++;
        }
        nextStates[index] = state ? (state < 4 ? state + 1 : 0) : (excited === 1 || Math.random() < .035 ? 1 : 0);
        ink.globalAlpha = (1 - distance) * (nextStates[index] === 1 ? 1 : nextStates[index] === 2 ? .65 : .25);
        ink.fillText(glyph, px, py);
      }
      var previous = states; states = nextStates; nextStates = previous;
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
        setTimeout(function () { ch.classList.add('is-on'); place(ch); scramble(ch, 3); }, 260 + i * 56);
      });
      var end = 260 + chars.length * 56;
      setTimeout(function () { caret.classList.add('is-blink'); }, end + 120);
      setTimeout(function () { section.classList.add('is-lit'); measure(); wake(); }, 1500);
      setTimeout(function () {
        caret.classList.remove('is-on', 'is-blink');
        chars.forEach(function (ch) { ch.style.width = ''; });
        done = true;
        setTimeout(rotate, 1400);
      }, end + 1800);
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
      // Eight small canvas updates per second; no DOM glyph updates or idle loop.
      raf = setTimeout(function () { raf = 0; wake(); }, 125);
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
    setTimeout(play, fonts ? 700 : 0);
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
    var centers = [], pointer = null, queued = false, lastY = window.scrollY, hidden = false;

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
        // Hide the nav while scrolling down; show it again on scroll up.
        if (Math.abs(y - lastY) > 6) {
          hidden = y > lastY && y > 240 && !root.classList.contains('menu-open');
          lastY = y;
        }
        nav.classList.toggle('is-hidden', hidden && enabled());
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
  /* The hero resists the first wheel strokes, then glides to the next section in one move. */
  function friction() {
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    var hero = document.querySelector('.sketch-hero');
    var next = hero && hero.nextElementSibling;
    if (!next) return;
    var pull = 0, idle = 0, frame = 0;

    function gate() { return next.getBoundingClientRect().top + window.scrollY; }
    function stop() { cancelAnimationFrame(frame); frame = 0; pull = 0; }
    function glide(to, duration) {
      var from = window.scrollY, start = 0;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(function step(now) {
        if (!start) start = now;
        var t = Math.min(1, (now - start) / duration);
        var ease = t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        window.scrollTo({ top: from + (to - from) * ease, behavior: 'instant' });
        frame = t < 1 ? requestAnimationFrame(step) : 0;
      });
    }
    window.addEventListener('wheel', function (e) {
      if (reduce.matches || e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      if (root.classList.contains('menu-open')) return;
      var y = window.scrollY, line = gate(), down = e.deltaY > 0;
      var delta = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? window.innerHeight : 1);
      if (frame) { e.preventDefault(); return; }
      // Going up, any stroke that would reach the hero glides straight to the top.
      if (!down) {
        if (y <= 0 || y + delta > line) return;
        e.preventDefault();
        pull = 0;
        glide(0, Math.min(850, 300 + y * .6));
        return;
      }
      // Going down, only the stretch above the next section is gated.
      if (y >= line - 1) return;
      e.preventDefault();
      pull += delta;
      clearTimeout(idle);
      idle = setTimeout(function () { pull = 0; }, 260);
      // A short stroke only nudges the page; a firm one carries it across.
      if (pull > 120) { pull = 0; glide(line, 850); }
      else window.scrollTo({ top: Math.min(line, y + delta * .18), behavior: 'instant' });
    }, { passive: false });
    window.addEventListener('keydown', stop);
    window.addEventListener('pointerdown', stop);
  }
})();
