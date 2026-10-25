/* 설치 안내는 화면에 보이는 동안만 재생해요. */
(function () {
  'use strict';
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var demos = Array.from(document.querySelectorAll('.installation-guide [data-demo]')).map(function (element) {
    var parts = Array.from(element.querySelectorAll('[data-at]'));
    var timers = [], visible = false;
    function stop() { timers.forEach(clearTimeout); timers = []; }
    function play() {
      stop();
      if (!visible || document.hidden || reduce.matches) return;
      parts.forEach(function (part) {
        part.classList.remove('is-on');
        timers.push(setTimeout(function () { part.classList.add('is-on'); }, Number(part.dataset.at)));
      });
      var end = Math.max.apply(null, parts.map(function (part) { return Number(part.dataset.at); }));
      timers.push(setTimeout(play, end + Number(element.dataset.loop || 2400)));
    }
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) { visible = entries[0].isIntersecting; play(); }, { threshold: 0.25 }).observe(element);
    } else {
      parts.forEach(function (part) { part.classList.add('is-on'); });
    }
    return { play: play };
  });
  function sync() { demos.forEach(function (demo) { demo.play(); }); }
  document.addEventListener('visibilitychange', sync);
  reduce.addEventListener('change', sync);
})();
