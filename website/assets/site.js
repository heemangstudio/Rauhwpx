/* HamaEditor 사이트 공통 움직임. 프레임워크 없이 가볍게 돌아가요.
   - [data-nav]        : 스크롤하면 data-scrolled="true" 가 붙어 아래 선이 보여요.
   - [data-menu-toggle]: 좁은 화면 메뉴를 열고 닫아요 (aria-controls 로 메뉴를 찾아요).
   - [data-reveal]     : 화면에 들어오면 .is-in 이 붙어요. 한 번만 일어나요.
                         data-reveal="words" 는 먼저 낱말마다 <span class="w"> 로 감싸서 한 낱말씩 올라오게 해요. 글자는 그대로예요.
   - [data-scene]      : 화면에 붙는 장면 트랙이에요. 창이 자리를 잡으면 [data-scene-copy] 안의 [data-reveal] 을 켜고
                         안의 [data-demo] 를 시작해요. 움직임은 CSS 스크롤 타임라인이 하고, 지원하지 않으면 --in, --out, --p 를 줘요.
   - [data-demo]       : 화면에 들어올 때마다 안의 [data-at] 조각을 시간 순서대로 켜요.
                         video[data-demo-video] 가 있으면 영상과 같이 가고, data-at="end" 는 영상이 끝날 때 켜져요.
                         data-loop="ms" 를 주면 끝나고 그만큼 쉬었다가 다시 해요.
   - video[data-autoplay]: 보일 때만 재생하고, 안 보이면 멈춰요. data-calm-controls 를 주면 움직임 줄이기 설정에서 재생 버튼이 보여요.
   - [data-steps-for]  : 영상 시간에 맞춰 단계에 aria-current 와 --p(진행률)를 줘요. 누르면 그 장면으로 가요.
   - [data-footer]     : 넓은 화면에서 본문 아래로 바닥글이 드러나게 높이를 맞춰요.
   움직임 줄이기 설정이면 모든 장면을 마지막 상태로 바로 보여 주고 영상은 포스터로 둬요. */
(function () {
  'use strict';

  var root = document.documentElement;
  root.classList.add('js');

  var reduceQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function calm() { return !!(reduceQuery && reduceQuery.matches); }
  var hasIO = 'IntersectionObserver' in window;
  function all(sel, scope) { return Array.prototype.slice.call((scope || document).querySelectorAll(sel)); }
  // 장면 트랙 안의 나타나기와 데모는 아래 장면 코드가 맡아요.
  var scenes = hasIO && !calm() ? all('[data-scene]') : [];
  function inScene(el) { return scenes.length > 0 && !!el.closest('[data-scene]'); }

  /* ── 내비게이션: 스크롤 상태 ── */
  var nav = document.querySelector('[data-nav]');
  if (nav) {
    var navQueued = false;
    var paintNav = function () {
      navQueued = false;
      nav.setAttribute('data-scrolled', window.scrollY > 4 ? 'true' : 'false');
    };
    window.addEventListener('scroll', function () {
      if (!navQueued) { navQueued = true; requestAnimationFrame(paintNav); }
    }, { passive: true });
    paintNav();
  }

  /* ── 좁은 화면 메뉴 ── */
  var toggle = document.querySelector('[data-menu-toggle]');
  var menu = toggle ? document.getElementById(toggle.getAttribute('aria-controls')) : null;
  if (toggle && menu) {
    var setMenu = function (open) {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? '메뉴 닫기' : '메뉴 열기');
      root.classList.toggle('menu-open', open);
      if (open) {
        menu.hidden = false;
        requestAnimationFrame(function () { menu.classList.add('is-open'); });
      } else {
        menu.classList.remove('is-open');
        menu.hidden = true;
      }
    };
    toggle.addEventListener('click', function () {
      setMenu(toggle.getAttribute('aria-expanded') !== 'true');
    });
    menu.addEventListener('click', function (e) {
      if (e.target.closest('a')) setMenu(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
        setMenu(false);
        toggle.focus();
      }
    });
    if (window.matchMedia) {
      var wide = window.matchMedia('(min-width: 761px)');
      var onWide = function () { if (wide.matches) setMenu(false); };
      if (wide.addEventListener) wide.addEventListener('change', onWide);
      else if (wide.addListener) wide.addListener(onWide);
    }
  }

  /* ── 제목 낱말 나누기: 글자는 그대로 두고 낱말마다 상자를 씌워요 ── */
  function splitWords(el) {
    var n = 0;
    (function walk(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (child) {
        if (child.nodeType === 3) {
          if (!/\S/.test(child.nodeValue)) return;
          var frag = document.createDocumentFragment();
          child.nodeValue.split(/(\s+)/).forEach(function (part) {
            if (!part) return;
            if (!/\S/.test(part)) { frag.appendChild(document.createTextNode(part)); return; }
            var box = document.createElement('span');
            var inner = document.createElement('span');
            box.className = 'w';
            inner.className = 'w__i';
            inner.style.setProperty('--wi', String(n++));
            inner.textContent = part;
            box.appendChild(inner);
            frag.appendChild(box);
          });
          node.replaceChild(frag, child);
        } else if (child.nodeType === 1 && child.tagName !== 'BR') {
          walk(child);
        }
      });
    })(el);
    el.classList.add('is-split');
  }
  if (hasIO && !calm()) all('[data-reveal="words"]').forEach(splitWords);

  /* ── 나타나기 ── */
  var reveals = all('[data-reveal]');
  if (!hasIO || calm()) {
    reveals.forEach(function (el) { el.classList.add('is-in'); });
  } else {
    var revealIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          revealIO.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
    reveals.forEach(function (el) { if (!inScene(el)) revealIO.observe(el); });
  }

  /* ── 장면 (paper 처럼 보일 때마다 다시 재생해요) ── */
  function makeDemo(el) {
    var parts = all('[data-at]', el);
    var video = el.querySelector('video[data-demo-video]');
    var counters = all('[data-count]', el);
    var loopMs = parseInt(el.getAttribute('data-loop'), 10) || 0;
    var timers = [];
    var running = false;

    var lastAt = parts.reduce(function (max, p) {
      var at = parseInt(p.getAttribute('data-at'), 10);
      return isNaN(at) ? max : Math.max(max, at);
    }, 0);

    function count() {
      counters.forEach(function (c) {
        c.textContent = String(el.querySelectorAll(c.getAttribute('data-count') + '.is-on').length);
      });
    }
    function turnOn(p) { p.classList.add('is-on'); if (counters.length) count(); }
    function clearTimers() { timers.forEach(clearTimeout); timers = []; }
    function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
    function reset() {
      clearTimers();
      parts.forEach(function (p) { p.classList.remove('is-on'); });
      count();
    }
    function finish() {
      clearTimers();
      parts.forEach(function (p) { p.classList.add('is-on'); });
      count();
    }
    function endParts() {
      parts.forEach(function (p) { if (p.getAttribute('data-at') === 'end') turnOn(p); });
    }

    function start() {
      reset();
      running = true;
      parts.forEach(function (p) {
        var at = parseInt(p.getAttribute('data-at'), 10);
        if (!isNaN(at)) later(function () { turnOn(p); }, at);
      });
      if (video) {
        try { video.currentTime = 0; } catch (_) { /* 메타데이터 전이면 처음부터 재생돼요 */ }
        var playing = video.play();
        // 저전력 모드처럼 자동 재생이 막히면 마지막 장면을 보여 줘요.
        if (playing && playing.catch) playing.catch(function () { if (running) finish(); });
      } else {
        later(endParts, lastAt + 700);
        if (loopMs) later(start, lastAt + 700 + loopMs);
      }
    }
    function stop() {
      running = false;
      clearTimers();
      if (video && !video.paused) video.pause();
    }
    if (video) {
      video.addEventListener('ended', function () {
        if (!running) return;
        endParts();
        if (loopMs) later(start, loopMs);
      });
    }
    return { start: start, stop: stop, finish: finish, isRunning: function () { return running; } };
  }

  var demos = all('[data-demo]');
  if (demos.length) {
    if (!hasIO || calm()) {
      demos.forEach(function (el) { makeDemo(el).finish(); });
    } else {
      var demoIO = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          var d = entry.target.__demo;
          if (entry.intersectionRatio >= 0.3 && !d.isRunning()) d.start();
          else if (!entry.isIntersecting && d.isRunning()) d.stop();
        });
      }, { threshold: [0, 0.3] });
      demos.forEach(function (el) {
        el.__demo = makeDemo(el);
        if (!inScene(el)) demoIO.observe(el);
      });
    }
  }

  /* ── 화면에 붙는 장면 ──
     트랙이 화면을 지나는 거리를 CSS 이름 구간(entry, contain, exit)으로 나눠 재요.
     SCENE 은 index.html 의 animation-range 와 같은 값이에요: 도착 entry 60% → contain 35%, 퇴장 contain 80% → exit 60%. */
  if (scenes.length) {
    var SCENE = { arrive: [['entry', 0.6], ['contain', 0.35]], depart: [['contain', 0.8], ['exit', 0.6]] };
    var timeline = !!(window.CSS && CSS.supports && CSS.supports('animation-timeline', 'view()'));
    var live = [];
    var sceneQueued = false;
    var clamp01 = function (v) { return v < 0 ? 0 : v > 1 ? 1 : v; };

    var states = scenes.map(function (track) {
      // 창 쪽 나타나기는 스크롤 움직임과 겹치지 않게 처음부터 켜 둬요.
      all('[data-reveal]', track).forEach(function (el) {
        if (!el.closest('[data-scene-copy]')) el.classList.add('is-in');
      });
      return {
        track: track,
        copy: all('[data-scene-copy] [data-reveal]', track),
        demos: all('[data-demo]', track).map(function (el) { return el.__demo; }).filter(Boolean),
        landed: false
      };
    });

    var paintScene = function (s) {
      var r = s.track.getBoundingClientRect();
      var vh = window.innerHeight;
      var span = Math.max(1, r.height - vh);
      // 트랙 위쪽이 화면 아래에 닿은 뒤로 지나온 거리
      var gone = vh - r.top;
      var point = function (pt) {
        return pt[0] === 'entry' ? pt[1] * vh : pt[0] === 'contain' ? vh + pt[1] * span : r.height + pt[1] * vh;
      };
      var a0 = point(SCENE.arrive[0]), a1 = point(SCENE.arrive[1]);
      var d0 = point(SCENE.depart[0]), d1 = point(SCENE.depart[1]);
      var arrive = clamp01((gone - a0) / (a1 - a0));
      var depart = clamp01((gone - d0) / (d1 - d0));
      var visible = r.bottom > 0 && r.top < vh;

      if (!timeline) {
        var eased = 1 - Math.pow(1 - arrive, 3);
        s.track.style.setProperty('--in', eased.toFixed(4));
        s.track.style.setProperty('--out', (depart * depart).toFixed(4));
        s.track.style.setProperty('--p', clamp01(gone / (r.height + vh)).toFixed(4));
      }

      // 다 내려앉으면 글이 올라오고, 한참 되돌아가면 다시 숨어요.
      if (!s.landed && arrive >= 0.98) {
        s.landed = true;
        s.copy.forEach(function (el) { el.classList.add('is-in'); });
      } else if (s.landed && arrive < 0.6) {
        s.landed = false;
        s.copy.forEach(function (el) { el.classList.remove('is-in'); });
      }
      s.demos.forEach(function (d) {
        if (s.landed && visible && !d.isRunning()) d.start();
        else if (!visible && d.isRunning()) d.stop();
      });
    };

    var paintScenes = function () {
      sceneQueued = false;
      live.forEach(paintScene);
    };
    var queueScenes = function () {
      if (!sceneQueued && live.length) { sceneQueued = true; requestAnimationFrame(paintScenes); }
    };

    var sceneIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var s = entry.target.__scene;
        var at = live.indexOf(s);
        if (entry.isIntersecting && at < 0) live.push(s);
        else if (!entry.isIntersecting && at >= 0) live.splice(at, 1);
        paintScene(s);
      });
    });
    states.forEach(function (s) {
      s.track.__scene = s;
      if (!timeline) paintScene(s);
      sceneIO.observe(s.track);
    });
    window.addEventListener('scroll', queueScenes, { passive: true });
    window.addEventListener('resize', queueScenes, { passive: true });
  }

  /* ── 보일 때만 재생하는 영상 ── */
  var autoVideos = all('video[data-autoplay]');
  // 움직임 줄이기 설정이면 자동 재생 대신 재생 버튼을 보여 줘요 (data-calm-controls 가 붙은 영상만).
  if (calm()) all('video[data-calm-controls]').forEach(function (v) { v.controls = true; });
  if (autoVideos.length && hasIO && !calm()) {
    var videoIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var v = entry.target;
        if (entry.isIntersecting) {
          var p = v.play();
          if (p && p.catch) p.catch(function () { /* 포스터가 그대로 보여요 */ });
        } else if (!v.paused) {
          v.pause();
        }
      });
    }, { threshold: 0.25 });
    autoVideos.forEach(function (v) { videoIO.observe(v); });
  }

  /* ── 영상에 맞춰 움직이는 단계 ── */
  all('[data-steps-for]').forEach(function (list) {
    var video = document.getElementById(list.getAttribute('data-steps-for'));
    if (!video) return;
    var steps = all('[data-from]', list).map(function (el) {
      return { el: el, from: parseFloat(el.getAttribute('data-from')), to: parseFloat(el.getAttribute('data-to')) };
    });
    var frame = 0;
    var current = null;

    function paint() {
      var t = video.currentTime;
      var end = isFinite(video.duration) ? video.duration : steps[steps.length - 1].to;
      var active = steps[0];
      steps.forEach(function (s) { if (t >= s.from) active = s; });
      if (active !== current) {
        steps.forEach(function (s) {
          if (s === active) s.el.setAttribute('aria-current', 'step');
          else s.el.removeAttribute('aria-current');
        });
        current = active;
      }
      var to = Math.min(active.to, end);
      var p = to > active.from ? (t - active.from) / (to - active.from) : 1;
      active.el.style.setProperty('--p', Math.max(0, Math.min(1, p)).toFixed(3));
      steps.forEach(function (s) { if (s !== active) s.el.style.setProperty('--p', s.to <= active.from ? '1' : '0'); });
    }
    function loop() { paint(); frame = video.paused ? 0 : requestAnimationFrame(loop); }
    video.addEventListener('play', function () { if (!frame) frame = requestAnimationFrame(loop); });
    video.addEventListener('pause', function () { cancelAnimationFrame(frame); frame = 0; paint(); });
    video.addEventListener('seeked', paint);
    video.addEventListener('loadedmetadata', paint);

    steps.forEach(function (s) {
      var trigger = s.el.querySelector('button') || s.el;
      trigger.addEventListener('click', function () {
        try { video.currentTime = s.from + 0.01; } catch (_) { /* 아직 못 불러왔어요 */ }
        if (!calm()) {
          var p = video.play();
          if (p && p.catch) p.catch(function () {});
        }
        paint();
      });
    });
    paint();
  });

  /* ── 내비게이션: 지금 보고 있는 섹션 ── */
  var navLinks = nav ? all('.nav__links a[href^="#"]', nav) : [];
  if (navLinks.length && hasIO) {
    var byId = {};
    navLinks.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
    var sectionIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var link = byId[entry.target.id];
        if (!link) return;
        if (entry.isIntersecting) {
          navLinks.forEach(function (a) { a.removeAttribute('aria-current'); });
          link.setAttribute('aria-current', 'true');
        } else if (link.hasAttribute('aria-current')) {
          link.removeAttribute('aria-current');
        }
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    Object.keys(byId).forEach(function (id) {
      var section = document.getElementById(id);
      if (section) sectionIO.observe(section);
    });
  }

  /* ── 바닥글: 본문이 걷히면서 드러나요 ── */
  var footer = document.querySelector('[data-footer]');
  var footerInner = footer && footer.querySelector('.footer__in');
  if (footer && footerInner) {
    var fitFooter = function () {
      footer.classList.remove('is-reveal');
      footer.style.height = '';
      var h = footerInner.offsetHeight;
      if (window.innerWidth > 760 && h < window.innerHeight - 96) {
        footer.style.height = h + 'px';
        footer.classList.add('is-reveal');
      }
    };
    var fitQueued = false;
    var queueFit = function () {
      if (!fitQueued) { fitQueued = true; requestAnimationFrame(function () { fitQueued = false; fitFooter(); }); }
    };
    fitFooter();
    window.addEventListener('resize', queueFit, { passive: true });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(queueFit);
  }
})();
