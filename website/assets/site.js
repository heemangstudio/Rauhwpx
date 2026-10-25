/* 사이트 목차와 스크롤 연필. 문서와 구매 흐름은 각 페이지가 맡아요. */
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

  var book = document.querySelector('.sketchbook');
  var trail = document.querySelector('[data-pencil-trail]');
  if (!book || !trail) return;
  var ink = trail.querySelector('[data-pencil-ink]');
  var pencil = trail.querySelector('[data-pencil-tip]');
  var stroke = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  var segments = [stroke];
  for (var n = 1; n < 8; n++) segments.push(document.createElementNS('http://www.w3.org/2000/svg', 'path'));
  ink.replaceChildren.apply(ink, segments);
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var marks = [], cursor = null, queued = false, lastFrame = 0, totalLength = 0;
  var trailStart = 0, lastDistance = null, lastMovement = 0, travelDirection = 1;

  function bridge(a, b, direction) {
    var bend = book.clientWidth * .18 * direction;
    var c1 = Math.max(24, Math.min(book.clientWidth - 24, a.x + bend));
    var c2 = Math.max(24, Math.min(book.clientWidth - 24, b.x - bend));
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M' + a.x + ' ' + a.y + ' C' + c1 + ' ' + a.y + ' ' + c2 + ' ' + b.y + ' ' + b.x + ' ' + b.y);
    return path;
  }

  function paint(at, now) {
    var distance = 0;
    for (var i = 0; i < marks.length; i++) {
      var mark = marks[i];
      if (at < mark.start) {
        if (i) {
          var previous = marks[i - 1];
          var progress = Math.max(0, Math.min(1, (at - previous.end) / (mark.start - previous.end)));
          distance = mark.travelOffset + mark.travelLength * progress;
        }
        break;
      }
      var progress = Math.max(0, Math.min(1, (at - mark.start) / (mark.end - mark.start)));
      distance = mark.offset + mark.length * progress;
      if (progress < 1) break;
    }
    // 최근에 지나온 짧은 선만 남기고, 꼬리부터 옅어지며 사라지게 해요.
    if (lastDistance === null) lastDistance = trailStart = distance;
    var delta = distance - lastDistance;
    if (Math.abs(delta) > .01) {
      var direction = delta > 0 ? 1 : -1;
      if (now - lastMovement > 700 || direction !== travelDirection) trailStart = lastDistance;
      travelDirection = direction;
      lastMovement = now;
      lastDistance = distance;
    }
    var tail = book.clientWidth < 761 ? 130 : 220;
    var piece = tail / segments.length;
    var available = Math.min(tail, Math.abs(distance - trailStart));
    var fade = Math.max(0, 1 - (now - lastMovement) / 700);
    segments.forEach(function (segment, i) {
      var from = i * piece;
      var to = Math.min((i + 1) * piece, available);
      if (to <= from) { segment.style.opacity = '0'; return; }
      var a = distance - travelDirection * from;
      var b = distance - travelDirection * to;
      var size = Math.abs(a - b);
      segment.style.strokeDasharray = size + ' ' + (totalLength + tail);
      segment.style.strokeDashoffset = String(size - Math.max(a, b));
      segment.style.opacity = String(.88 * Math.pow(1 - i / segments.length, 1.7) * fade);
    });
    var point = stroke.getPointAtLength(distance);
    var angle = 20 * (1 - 2 * point.x / book.clientWidth) + 14 * Math.sin(at * .008);
    pencil.setAttribute('transform', 'translate(' + point.x + ' ' + point.y + ') rotate(' + angle + ') scale(' + (book.clientWidth < 761 ? '.64' : '.85') + ')');
    pencil.style.visibility = 'visible';
  }

  function draw(now) {
    queued = false;
    if (!marks.length) return;
    if (reduce.matches) {
      segments.forEach(function (segment) { segment.style.opacity = '0'; });
      lastDistance = null;
      lastMovement = 0;
      pencil.style.visibility = 'hidden';
      lastFrame = 0;
      return;
    }
    var top = -book.getBoundingClientRect().top;
    var target = top + window.innerHeight * .62;
    if (cursor === null) cursor = marks[0].start;
    // 빨리 스크롤하면 지나간 낙서를 기다리지 않고 현재 화면에서 시작해요.
    if (Math.abs(target - cursor) > window.innerHeight * .7) {
      var visible = marks.find(function (mark) { return mark.y > top + 40 && mark.y < top + window.innerHeight * .85; });
      cursor = visible ? visible.start : target;
    }
    var elapsed = Math.min(32, lastFrame ? now - lastFrame : 16);
    lastFrame = now;
    var forward = target >= cursor;
    var active = marks.find(function (mark) {
      return forward ? cursor >= mark.start && cursor < mark.end : cursor > mark.start && cursor <= mark.end;
    });
    // 원은 약 1초, 밑줄은 약 0.6초 동안 실제로 그려져요.
    var speed = active ? active.duration / (active.kind === 'circle' ? 1000 : 600) : 1.2;
    var step = Math.min(Math.abs(target - cursor), elapsed * speed);
    marks.forEach(function (mark) {
      [mark.start, mark.end].forEach(function (boundary) {
        var distance = forward ? boundary - cursor : cursor - boundary;
        if (distance > .01) step = Math.min(step, distance);
      });
    });
    cursor += step * (forward ? 1 : -1);
    paint(cursor, now);
    if (Math.abs(target - cursor) > .01 || now - lastMovement < 700) queue();
    else lastFrame = 0;
  }
  function queue() { if (!queued) { queued = true; requestAnimationFrame(draw); } }

  function layout() {
    marks = [];
    var bounds = book.getBoundingClientRect();
    var width = book.clientWidth;
    function annotate(selector, kind) {
      var element = book.querySelector(selector);
      if (!element) return;
      var range = document.createRange();
      range.selectNodeContents(element);
      var rects = Array.prototype.slice.call(range.getClientRects()).filter(function (r) { return r.width > 0 && r.height > 0; });
      if (!rects.length) return;
      // 밑줄은 마지막 줄을 따라가고, 동그라미는 제목의 실제 글자 영역을 감싸요.
      var r = kind === 'underline' ? rects[rects.length - 1] : range.getBoundingClientRect();
      var left = Math.max(14, r.left - bounds.left - (kind === 'circle' ? 12 : 0));
      var right = Math.min(width - 14, r.right - bounds.left + (kind === 'circle' ? 12 : 0));
      var top = r.top - bounds.top;
      var bottom = r.bottom - bounds.top;
      var middle = (top + bottom) / 2;
      var span = right - left;
      var d;
      if (kind === 'circle') {
        top -= 8;
        bottom += 14;
        d = 'M' + left + ' ' + middle +
          ' C' + (left - 8) + ' ' + (top - 12) + ' ' + (right + 8) + ' ' + (top - 6) + ' ' + right + ' ' + middle +
          ' C' + (right + 5) + ' ' + (bottom + 16) + ' ' + (left - 12) + ' ' + (bottom + 8) + ' ' + (left + 3) + ' ' + (middle - 4) +
          ' C' + (left + 4) + ' ' + (middle - 12) + ' ' + (left + 8) + ' ' + (middle - 18) + ' ' + (left + 14) + ' ' + (middle - 22);
      } else {
        var y = bottom + 4;
        d = 'M' + left + ' ' + y + ' C' + (left + span * .3) + ' ' + (y + 6) + ' ' + (left + span * .7) + ' ' + (y - 5) + ' ' + right + ' ' + (y + 1);
      }
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      marks.push({ path: path, y: middle, kind: kind, duration: kind === 'circle' ? 168 : 96 });
    }
    annotate('.hero-marked-title', 'circle');
    annotate('.hero-platforms a', 'underline');
    annotate('#document-title', 'underline');
    annotate('.document-heading .handnote', 'underline');
    annotate('.keyword-splash li:nth-child(1)', 'circle');
    annotate('.keyword-splash li:nth-child(10)', 'underline');
    annotate('#connect-title', 'underline');
    annotate('#start-title', 'underline');
    marks.sort(function (a, b) { return a.y - b.y; });
    var route = '';
    var distance = 0;
    var move = /^M[-\d.]+\s+[-\d.]+/;
    marks.forEach(function (mark, i) {
      mark.start = Math.max(mark.y - mark.duration / 2, i ? marks[i - 1].end + 40 : 0);
      mark.end = mark.start + mark.duration;
      mark.length = mark.path.getTotalLength();
      if (i) {
        var previous = marks[i - 1];
        var travel = bridge(previous.path.getPointAtLength(previous.length), mark.path.getPointAtLength(0), i % 2 ? -1 : 1);
        mark.travelOffset = distance;
        mark.travelLength = travel.getTotalLength();
        route += travel.getAttribute('d').replace(move, '');
        distance += mark.travelLength;
      }
      mark.offset = distance;
      route += i ? mark.path.getAttribute('d').replace(move, '') : mark.path.getAttribute('d');
      distance += mark.length;
    });
    trail.setAttribute('viewBox', '0 0 ' + width + ' ' + book.offsetHeight);
    if (stroke.getAttribute('d') !== route) {
      segments.forEach(function (segment) {
        segment.setAttribute('d', route);
        segment.style.opacity = '0';
      });
      totalLength = stroke.getTotalLength();
      lastDistance = null;
      lastMovement = 0;
    }
    queue();
  }
  window.addEventListener('scroll', queue, { passive: true });
  window.addEventListener('resize', layout, { passive: true });
  if (reduce.addEventListener) reduce.addEventListener('change', queue);
  if ('ResizeObserver' in window) new ResizeObserver(layout).observe(book);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);
  layout();
})();
