// Страница 404: монстр из папки следит глазами за курсором, тянется к нему и кусает,
// если подвести курсор близко ко рту.
(function () {
  var NS = 'http://www.w3.org/2000/svg';
  var svg = document.getElementById('scene');
  var monster = document.getElementById('monster');
  var reach = document.getElementById('reach');
  var cavity = document.getElementById('cavity');
  var jawTop = document.getElementById('jaw-top');
  var jawBottom = document.getElementById('jaw-bottom');
  var chomp = document.getElementById('chomp');
  var calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var MOUTH = { x: 200, y: 196 };
  var REACH_ORIGIN = { x: 248, y: 150 };
  var REACH_BASE = Math.atan2(86 - 150, 254 - 248); // куда смотрит кончик в покое

  // Точка вращения щупалец (CSS-анимация покачивания).
  document.querySelectorAll('.tentacle[data-origin]').forEach(function (g) {
    var o = g.getAttribute('data-origin').split(' ');
    g.style.transformOrigin = o[0] + 'px ' + o[1] + 'px';
  });

  // Зубы: верхние смотрят вниз, нижние вверх; в закрытом рту смыкаются «молнией».
  function tooth(parent, x, w, tip) {
    var p = document.createElementNS(NS, 'polygon');
    p.setAttribute('points', x + ',' + MOUTH.y + ' ' + (x + w) + ',' + MOUTH.y + ' ' + (x + w / 2) + ',' + (MOUTH.y + tip));
    p.setAttribute('class', 'tooth');
    parent.appendChild(p);
  }
  for (var i = 0; i < 7; i++) tooth(jawTop, 167 + i * 9.5, 9.5, 9);
  for (var j = 0; j < 6; j++) tooth(jawBottom, 171.75 + j * 9.5, 9.5, -9);

  var eyes = Array.prototype.map.call(document.querySelectorAll('.eye'), function (g) {
    var c = g.querySelector('.sclera');
    var pupil = g.querySelector('.pupil');
    return {
      g: g,
      pupilG: g.querySelector('.pupil-g'),
      pupil: pupil,
      rx: Number(pupil.getAttribute('rx')),
      x: Number(c.getAttribute('cx')),
      y: Number(c.getAttribute('cy')),
      r: Number(g.getAttribute('data-r')),
      ox: 0,
      oy: 0,
    };
  });

  var cursor = null; // в координатах SVG
  function toSvg(e) {
    var m = svg.getScreenCTM();
    if (!m) return null;
    var pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    return pt.matrixTransform(m.inverse());
  }
  window.addEventListener('pointermove', function (e) { cursor = toSvg(e); });
  window.addEventListener('pointerdown', function (e) { cursor = toSvg(e); });
  document.addEventListener('pointerout', function (e) { if (!e.relatedTarget) cursor = null; });
  window.addEventListener('blur', function () { cursor = null; });

  // Моргание в случайные моменты.
  function blink() {
    eyes.forEach(function (eye, k) {
      setTimeout(function () {
        eye.g.classList.add('blink');
        setTimeout(function () { eye.g.classList.remove('blink'); }, 170);
      }, k * 40);
    });
    setTimeout(blink, 2000 + Math.random() * 3500);
  }
  setTimeout(blink, 1500);

  var pos = { x: 0, y: 0 };
  var open = 0;
  var reachAngle = 0;
  var phase = 'idle';
  var phaseAt = 0;
  var excite = 0;

  var lerp = function (a, b, k) { return a + (b - a) * k; };
  var clamp = function (v, lo, hi) { return Math.max(lo, Math.min(hi, v)); };

  function setPhase(p, now) { phase = p; phaseAt = now; }

  function frame(now) {
    var t = now / 1000;
    var target = { x: Math.sin(t * 0.7) * 3, y: Math.sin(t * 1.3) * 2 };
    var targetOpen = 1 + Math.sin(t * 1.1);
    var speed = 0.08;
    var near = 0;

    if (cursor) {
      var dx = cursor.x - MOUTH.x;
      var dy = cursor.y - MOUTH.y;
      var d = Math.hypot(dx, dy) || 1;
      near = clamp((170 - d) / 100, 0, 1); // 0 — далеко, 1 — у самого рта

      if (!calm && phase === 'idle' && d < 95) setPhase('lunge', now);

      if (phase === 'lunge' || phase === 'snap') {
        var len = Math.min(d - 8, 72);
        target = { x: dx / d * len, y: dy / d * len };
        targetOpen = phase === 'lunge' ? 26 : 0;
        speed = phase === 'lunge' ? 0.32 : 0.6;
      } else if (near > 0 && !calm) {
        var lean = Math.min(d - 20, 50) * 0.45 * near;
        target = { x: dx / d * lean, y: dy / d * lean };
        targetOpen = 4 + near * 16;
        speed = 0.1;
      } else if (near > 0) {
        targetOpen = 4 + near * 10;
      }
    }

    // Укус: раскрыть пасть и броситься — захлопнуть — отпрянуть.
    if (phase === 'lunge' && now - phaseAt > 150) setPhase('snap', now);
    else if (phase === 'snap' && now - phaseAt > 90) {
      var caught = cursor && Math.hypot(cursor.x - (MOUTH.x + pos.x), cursor.y - (MOUTH.y + pos.y)) < 34;
      if (caught) {
        chomp.classList.add('show');
        svg.classList.remove('shake');
        void svg.getBoundingClientRect(); // перезапуск анимации тряски
        svg.classList.add('shake');
        setTimeout(function () { chomp.classList.remove('show'); }, 650);
      }
      setPhase('cool', now);
    } else if (phase === 'cool') {
      target = { x: 0, y: 4 };
      targetOpen = 0;
      speed = 0.12;
      if (now - phaseAt > 650) setPhase('idle', now);
    }

    pos.x = lerp(pos.x, clamp(target.x, -72, 72), speed);
    pos.y = lerp(pos.y, clamp(target.y, -64, 14), speed);
    open = lerp(open, targetOpen, phase === 'snap' ? 0.6 : 0.25);
    excite = lerp(excite, phase === 'idle' ? near : 1, 0.15);

    var tilt = pos.x * 0.18;
    monster.setAttribute('transform', 'translate(' + pos.x.toFixed(2) + ' ' + pos.y.toFixed(2) + ') rotate(' + tilt.toFixed(2) + ' 200 300)');

    cavity.setAttribute('ry', (open / 2 + 3).toFixed(2));
    cavity.setAttribute('rx', (34 + open * 0.25).toFixed(2));
    jawTop.setAttribute('transform', 'translate(0 ' + (-open / 2).toFixed(2) + ')');
    jawBottom.setAttribute('transform', 'translate(0 ' + (open / 2).toFixed(2) + ')');

    // Глаза: зрачок смещается к курсору, при приближении — расширяется.
    eyes.forEach(function (eye, k) {
      var tx;
      var ty;
      if (cursor) {
        var vx = cursor.x - (eye.x + pos.x);
        var vy = cursor.y - (eye.y + pos.y);
        var vd = Math.hypot(vx, vy) || 1;
        var m = Math.min(eye.r, vd / 6);
        tx = vx / vd * m;
        ty = vy / vd * m;
      } else { // курсора нет — осматривается
        tx = Math.sin(t * 0.9 + k) * eye.r * 0.7;
        ty = Math.cos(t * 0.6 + k * 2) * eye.r * 0.4;
      }
      eye.ox = lerp(eye.ox, tx, 0.25);
      eye.oy = lerp(eye.oy, ty, 0.25);
      eye.pupilG.setAttribute('transform', 'translate(' + eye.ox.toFixed(2) + ' ' + eye.oy.toFixed(2) + ')');
      eye.pupil.setAttribute('rx', (eye.rx * (1 + excite * 0.9)).toFixed(2));
    });

    // Одно щупальце тянется к курсору.
    var targetAngle = Math.sin(t * 1.4) * 10;
    if (cursor) {
      var a = Math.atan2(cursor.y - (REACH_ORIGIN.y + pos.y), cursor.x - (REACH_ORIGIN.x + pos.x));
      var diff = (a - REACH_BASE) * 180 / Math.PI;
      if (diff > 180) diff -= 360;
      if (diff < -180) diff += 360;
      targetAngle = clamp(diff, -70, 80) + Math.sin(t * 3) * 3;
    }
    reachAngle = lerp(reachAngle, targetAngle, 0.08);
    reach.setAttribute('transform', 'rotate(' + reachAngle.toFixed(2) + ' ' + REACH_ORIGIN.x + ' ' + REACH_ORIGIN.y + ')');

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
