// Flippy Desk: a desk full of stuff that you flip with an upward swipe.
// Physics is Planck.js (a JavaScript port of Box2D). The world uses meters
// with y pointing down, so it lines up with canvas coordinates.
(() => {
  'use strict';

  const pl = planck;
  const V = pl.Vec2;

  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');
  const hintEl = document.getElementById('hint');
  const countEl = document.getElementById('count');

  const INK = '#2a2733';
  const LW = 0.011;              // outline width, in meters
  const GRAVITY = 22;            // a bit more than real, so it feels snappy
  const STEP = 1 / 60;
  const DESK_W = 2.0;
  const DESK_H = 0.78;
  const DESK_TOP_T = 0.07;
  const LAYOUT_SPAN = 1.92;      // usable width of the desktop
  const RESET_AFTER = 4.5;       // seconds after a flip before we reset
  const RESET_MAX = 8;
  const FADE = 0.35;

  // ---------- small helpers ----------

  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const chance = (p) => Math.random() < p;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // A rectangle given by its top-left corner, used both for drawing and as
  // a physics box. Items use local coordinates with the origin at their
  // bottom center, so "up" is negative y.
  const R = (x, y, w, h, extra) => Object.assign({ x: x + w / 2, y: y + h / 2, w, h }, extra);

  // ---------- drawing primitives (all in meters) ----------

  function finish(fill, stroke = true) {
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.lineWidth = LW;
      ctx.strokeStyle = INK;
      ctx.stroke();
    }
  }
  function rrect(x, y, w, h, r, fill, stroke = true) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    finish(fill, stroke);
  }
  function ellipse(x, y, rx, ry, fill, stroke = true) {
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    finish(fill, stroke);
  }
  function poly(pts, fill, stroke = true) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    finish(fill, stroke);
  }
  function line(x1, y1, x2, y2, color, width) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.stroke();
  }
  const hsl = (h, s, l) => `hsl(${h % 360},${s}%,${l}%)`;

  // ---------- world state ----------

  let W = 0, H = 0, dpr = 1, ppm = 100, Wm = 0, Hm = 0, floorY = 0, cx = 0;
  let world, desk, bodies, drops, stains;
  let state = 'ready';          // ready | flipped | fadeout | fadein
  let stateT = 0, fade = 0, shake = 0, idleT = 0, clock = 0;
  let lastDeskSpeed = 0;
  let flips = 0;
  try { flips = parseInt(localStorage.getItem('flippydesk.flips'), 10) || 0; } catch (e) { /* storage blocked */ }

  function addBody(x, y, parts, draw, o = {}) {
    const b = world.createBody({
      type: 'dynamic',
      position: V(x, y),
      angle: o.angle || 0,
      bullet: !!o.bullet,
      angularDamping: 0.05,
    });
    for (const p of parts) {
      let shape;
      if (p.r != null) shape = pl.Circle(V(p.x, p.y), p.r);
      else if (p.pts) shape = pl.Polygon(p.pts.map((q) => V(q[0], q[1])));
      else shape = pl.Box(p.w / 2, p.h / 2, V(p.x, p.y), p.a || 0);
      b.createFixture(shape, {
        density: p.d ?? o.density ?? 1,
        friction: o.friction ?? 0.55,
        restitution: o.restitution ?? 0.18,
      });
    }
    b.draw = draw;
    b.kind = o.kind || '';
    b.z = o.z || 0;
    bodies.push(b);
    return b;
  }

  // ---------- desk ----------

  const WOODS = [
    { top: '#c8915a', side: '#a8723f', grain: 'rgba(90,50,20,0.18)' },   // oak
    { top: '#8a5a3b', side: '#6b4329', grain: 'rgba(40,20,10,0.22)' },   // walnut
    { top: '#f2efe8', side: '#d9d4c8', grain: 'rgba(0,0,0,0.05)' },      // white
    { top: '#3b3a44', side: '#2c2b33', grain: 'rgba(255,255,255,0.06)' },// black
    { top: '#6fa7a0', side: '#558b84', grain: 'rgba(0,0,0,0.08)' },      // teal
  ];

  function buildDesk() {
    const wood = pick(WOODS);
    const style = pick(['legs', 'pedestal', 'pedestal', 'double']);
    const top = -DESK_H;
    const half = DESK_W / 2;
    const legH = DESK_H - DESK_TOP_T;
    const parts = [R(-half, top, DESK_W, DESK_TOP_T)];
    const peds = [];
    const legs = [];
    if (style === 'legs') {
      legs.push(-half + 0.06, half - 0.13);
    } else if (style === 'pedestal') {
      const left = chance(0.5);
      peds.push(left ? -half + 0.05 : half - 0.5);
      legs.push(left ? half - 0.13 : -half + 0.06);
    } else {
      peds.push(-half + 0.05, half - 0.5);
    }
    for (const x of legs) parts.push(R(x, -legH, 0.07, legH));
    for (const x of peds) parts.push(R(x, -legH, 0.45, legH));
    const drawers = peds.map(() => randInt(2, 3));
    const handle = pick(['#d8b25a', '#c9ccd3', INK]);

    desk = addBody(cx, floorY, parts, () => {
      for (const x of legs) rrect(x, -legH - 0.01, 0.07, legH + 0.01, 0.01, wood.side);
      peds.forEach((x, i) => {
        rrect(x, -legH - 0.01, 0.45, legH + 0.01, 0.01, wood.side);
        const n = drawers[i];
        const dh = (legH - 0.06) / n;
        for (let k = 0; k < n; k++) {
          const y = -legH + 0.03 + k * dh;
          rrect(x + 0.03, y, 0.39, dh - 0.025, 0.012, wood.top);
          rrect(x + 0.17, y + dh / 2 - 0.025, 0.11, 0.025, 0.012, handle);
        }
      });
      rrect(-half, top, DESK_W, DESK_TOP_T, 0.015, wood.top);
      ctx.save();
      ctx.beginPath();
      ctx.rect(-half, top, DESK_W, DESK_TOP_T);
      ctx.clip();
      line(-half + 0.1, top + 0.025, half - 0.6, top + 0.025, wood.grain, 0.008);
      line(-half + 0.5, top + 0.045, half - 0.1, top + 0.045, wood.grain, 0.008);
      ctx.restore();
    }, { kind: 'desk', density: 3, friction: 0.7, restitution: 0.1, z: -1 });
  }

  // ---------- desk items ----------
  // Each factory returns { w, place(x, y) } where (x, y) is the bottom
  // center of the item's footprint on the desktop.

  function monitor() {
    const hue = rand(0, 360);
    const lines = Array.from({ length: 6 }, () => [rand(0, 0.06), rand(0.06, 0.22)]);
    return {
      w: 0.62,
      place(x, y) {
        addBody(x, y, [R(-0.13, -0.03, 0.26, 0.03), R(-0.025, -0.17, 0.05, 0.14), R(-0.31, -0.54, 0.62, 0.38)], () => {
          rrect(-0.025, -0.19, 0.05, 0.17, 0.005, '#5b6170');
          rrect(-0.13, -0.03, 0.26, 0.03, 0.012, '#4a4f5c');
          rrect(-0.31, -0.54, 0.62, 0.38, 0.025, '#2f3340');
          const g = ctx.createLinearGradient(0, -0.52, 0, -0.19);
          g.addColorStop(0, hsl(hue, 70, 64));
          g.addColorStop(1, hsl(hue + 50, 70, 46));
          rrect(-0.29, -0.52, 0.58, 0.32, 0.012, g, false);
          rrect(-0.24, -0.48, 0.32, 0.23, 0.012, 'rgba(255,255,255,0.88)', false);
          lines.forEach(([a, b], i) => line(-0.22 + a, -0.45 + i * 0.033, -0.22 + a + b * 0.8, -0.45 + i * 0.033, hsl(hue + i * 40, 55, 50), 0.012));
          ellipse(0.17, -0.3, 0.035, 0.035, 'rgba(255,255,255,0.35)', false);
        }, { kind: 'computer' });
      },
    };
  }

  function laptop() {
    const hue = rand(0, 360);
    return {
      w: 0.46,
      place(x, y) {
        addBody(x, y, [R(-0.23, -0.028, 0.46, 0.028), R(-0.2, -0.31, 0.4, 0.282)], () => {
          rrect(-0.2, -0.31, 0.4, 0.29, 0.02, '#c9ccd3');
          const g = ctx.createLinearGradient(0, -0.29, 0, -0.05);
          g.addColorStop(0, hsl(hue, 60, 66));
          g.addColorStop(1, hsl(hue + 40, 65, 48));
          rrect(-0.18, -0.29, 0.36, 0.245, 0.01, g, false);
          ellipse(0, -0.17, 0.04, 0.04, 'rgba(255,255,255,0.5)', false);
          rrect(-0.23, -0.028, 0.46, 0.028, 0.012, '#b3b7c0');
        }, { kind: 'computer' });
      },
    };
  }

  function crt() {
    return {
      w: 0.5,
      place(x, y) {
        addBody(x, y, [R(-0.17, -0.04, 0.34, 0.04), R(-0.25, -0.46, 0.5, 0.42)], () => {
          rrect(-0.17, -0.05, 0.34, 0.05, 0.01, '#d9cdb0');
          rrect(-0.25, -0.46, 0.5, 0.42, 0.04, '#e8dcc0');
          rrect(-0.2, -0.42, 0.4, 0.3, 0.06, '#1f3a2c');
          ctx.fillStyle = '#6dff9c';
          ctx.font = 'bold 0.06px monospace';
          ctx.fillText('C:\\>_', -0.16, -0.33);
          rrect(0.12, -0.1, 0.06, 0.03, 0.01, '#c9bc9c');
        }, { kind: 'computer' });
      },
    };
  }

  function keyboard() {
    const dark = chance(0.5);
    return {
      w: 0.44,
      place(x, y) {
        addBody(x, y, [R(-0.22, -0.05, 0.44, 0.05)], () => {
          for (let i = 0; i < 9; i++) rrect(-0.2 + i * 0.045, -0.055, 0.035, 0.025, 0.006, dark ? '#4b4f5c' : '#f4f4f6');
          rrect(-0.22, -0.038, 0.44, 0.038, 0.012, dark ? '#2f3340' : '#d7d9df');
        }, { kind: 'computer' });
      },
    };
  }

  function mouse() {
    const pts = [];
    for (let i = 0; i <= 6; i++) {
      const a = (Math.PI * i) / 6;
      pts.push([-Math.cos(a) * 0.06, -Math.sin(a) * 0.055]);
    }
    const color = pick(['#f4f4f6', '#2f3340', '#e66b6b', '#6b8fe6']);
    return {
      w: 0.13,
      place(x, y) {
        addBody(x, y, [{ pts }], () => {
          ctx.beginPath();
          ctx.ellipse(0, 0, 0.06, 0.055, 0, Math.PI, Math.PI * 2);
          ctx.closePath();
          finish(color);
          line(0, -0.055, 0, -0.03, INK, 0.008);
        }, { kind: 'mouse' });
      },
    };
  }

  function speaker() {
    return {
      w: 0.13,
      place(x, y) {
        addBody(x, y, [R(-0.065, -0.24, 0.13, 0.24)], () => {
          rrect(-0.065, -0.24, 0.13, 0.24, 0.015, '#363a47');
          ellipse(0, -0.17, 0.03, 0.03, '#5b6170');
          ellipse(0, -0.075, 0.045, 0.045, '#5b6170');
          ellipse(0, -0.075, 0.015, 0.015, '#2a2733', false);
        });
      },
    };
  }

  function mug() {
    const color = pick(['#e66b6b', '#f2c14e', '#6b8fe6', '#f4f4f6', '#7cc58f', '#b48be0']);
    const stripe = chance(0.5);
    return {
      w: 0.2,
      place(x, y) {
        const b = addBody(x - 0.02, y, [R(-0.07, -0.16, 0.14, 0.16), R(0.07, -0.13, 0.045, 0.09, { d: 0.3 })], () => {
          ctx.beginPath();
          ctx.ellipse(0.07, -0.085, 0.042, 0.042, 0, -Math.PI / 2, Math.PI / 2);
          ctx.lineCap = 'butt';
          ctx.strokeStyle = INK;
          ctx.lineWidth = 0.032;
          ctx.stroke();
          ctx.strokeStyle = color;
          ctx.lineWidth = 0.014;
          ctx.stroke();
          rrect(-0.07, -0.16, 0.14, 0.16, 0.018, color);
          if (stripe) rrect(-0.07, -0.11, 0.14, 0.025, 0, 'rgba(255,255,255,0.55)', false);
          if (state === 'ready' && b.coffee > 0) {
            ctx.globalAlpha = 0.5;
            for (let i = -1; i <= 1; i++) {
              ctx.beginPath();
              for (let k = 0; k <= 10; k++) {
                const t = k / 10;
                const yy = -0.18 - t * 0.14;
                const xx = i * 0.035 + Math.sin(t * 6 + clock * 4 + i * 2) * 0.012;
                if (k === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
              }
              ctx.strokeStyle = '#ffffff';
              ctx.lineWidth = 0.01;
              ctx.lineCap = 'round';
              ctx.stroke();
            }
            ctx.globalAlpha = 1;
          }
        }, { kind: 'mug' });
        b.coffee = 1;
      },
    };
  }

  const BOOK_COLORS = ['#e66b6b', '#f2c14e', '#6b8fe6', '#7cc58f', '#b48be0', '#f08a4b', '#4fb3bf', '#3b3a44'];

  function bookStack() {
    const books = Array.from({ length: randInt(2, 4) }, () => ({
      w: rand(0.26, 0.36), h: rand(0.045, 0.07), off: rand(-0.03, 0.03), color: pick(BOOK_COLORS),
    }));
    return {
      w: Math.max(...books.map((b) => b.w)) + 0.07,
      place(x, y) {
        let yy = y;
        for (const bk of books) {
          addBody(x + bk.off, yy - 0.001, [R(-bk.w / 2, -bk.h, bk.w, bk.h)], () => {
            rrect(-bk.w / 2, -bk.h, bk.w, bk.h, 0.01, bk.color);
            rrect(-bk.w / 2 + 0.03, -bk.h + 0.012, 0.03, bk.h - 0.024, 0, 'rgba(255,255,255,0.5)', false);
            rrect(bk.w / 2 - 0.06, -bk.h + 0.012, 0.03, bk.h - 0.024, 0, 'rgba(255,255,255,0.5)', false);
          }, { kind: 'book', density: 0.8 });
          yy -= bk.h;
        }
      },
    };
  }

  function booksUpright() {
    const books = Array.from({ length: randInt(3, 6) }, () => ({
      w: rand(0.045, 0.07), h: rand(0.22, 0.32), color: pick(BOOK_COLORS),
    }));
    return {
      w: books.reduce((s, b) => s + b.w + 0.004, 0),
      place(x, y) {
        let xx = x - this.w / 2;
        for (const bk of books) {
          addBody(xx + bk.w / 2, y, [R(-bk.w / 2, -bk.h, bk.w, bk.h)], () => {
            rrect(-bk.w / 2, -bk.h, bk.w, bk.h, 0.008, bk.color);
            rrect(-bk.w / 2, -bk.h + 0.03, bk.w, 0.015, 0, 'rgba(255,255,255,0.5)', false);
            rrect(-bk.w / 2 + 0.01, -bk.h * 0.6, bk.w - 0.02, 0.05, 0.004, 'rgba(255,255,255,0.7)', false);
            rrect(-bk.w / 2, -0.045, bk.w, 0.015, 0, 'rgba(255,255,255,0.5)', false);
          }, { kind: 'book', density: 0.8 });
          xx += bk.w + 0.004;
        }
      },
    };
  }

  function plant() {
    const kind = pick(['leafy', 'leafy', 'cactus', 'snake', 'flower']);
    const pot = pick(['#d9774a', '#f4f4f6', '#6b8fe6', '#f2c14e', '#3b3a44']);
    const potPts = [[-0.07, 0], [0.07, 0], [0.09, -0.15], [-0.09, -0.15]];
    const leaves = Array.from({ length: 9 }, (_, i) => ({ a: -Math.PI / 2 + (i - 4) * 0.33 + rand(-0.1, 0.1), l: rand(0.1, 0.16) }));
    const parts = [{ pts: potPts }, R(-0.1, -0.18, 0.2, 0.035)];
    if (kind === 'leafy') parts.push({ x: 0, y: -0.28, r: 0.12, d: 0.2 });
    if (kind === 'cactus') parts.push(R(-0.045, -0.4, 0.09, 0.23, { d: 0.6 }));
    if (kind === 'snake') parts.push(R(-0.08, -0.44, 0.16, 0.27, { d: 0.2 }));
    if (kind === 'flower') parts.push({ x: 0, y: -0.38, r: 0.07, d: 0.2 }, R(-0.01, -0.35, 0.02, 0.18, { d: 0.2 }));
    return {
      w: kind === 'leafy' ? 0.28 : 0.22,
      place(x, y) {
        addBody(x, y, parts, () => {
          if (kind === 'leafy') {
            for (const lf of leaves) {
              ctx.save();
              ctx.translate(0, -0.18);
              ctx.rotate(lf.a + Math.PI / 2);
              ellipse(0, -lf.l, 0.04, lf.l, '#5fae6a');
              line(0, -0.02, 0, -lf.l * 1.6, 'rgba(0,0,0,0.15)', 0.006);
              ctx.restore();
            }
          } else if (kind === 'cactus') {
            rrect(-0.1, -0.33, 0.04, 0.09, 0.02, '#6cbf7a');
            rrect(0.06, -0.36, 0.04, 0.1, 0.02, '#6cbf7a');
            rrect(-0.08, -0.27, 0.06, 0.03, 0.015, '#6cbf7a');
            rrect(0.02, -0.29, 0.06, 0.03, 0.015, '#6cbf7a');
            rrect(-0.045, -0.4, 0.09, 0.25, 0.045, '#6cbf7a');
            ellipse(0, -0.41, 0.02, 0.015, '#f2879b');
          } else if (kind === 'snake') {
            for (let i = 0; i < 5; i++) {
              const bx = -0.07 + i * 0.035;
              const h = 0.2 + Math.sin(i * 2.3) * 0.05 + 0.04;
              poly([[bx - 0.02, -0.17], [bx + 0.02, -0.17], [bx + 0.004, -0.17 - h]], i % 2 ? '#4e9a5a' : '#6cbf7a');
            }
          } else {
            line(0, -0.17, 0, -0.36, '#4e9a5a', 0.015);
            ellipse(-0.035, -0.26, 0.035, 0.015, '#6cbf7a');
            for (let i = 0; i < 6; i++) {
              const a = (i / 6) * Math.PI * 2;
              ellipse(Math.cos(a) * 0.045, -0.38 + Math.sin(a) * 0.045, 0.03, 0.03, '#f2879b');
            }
            ellipse(0, -0.38, 0.028, 0.028, '#f2c14e');
          }
          poly(potPts, pot);
          rrect(-0.1, -0.18, 0.2, 0.035, 0.01, pot);
        }, { kind: 'plant' });
      },
    };
  }

  function lamp() {
    const color = pick(['#e66b6b', '#f2c14e', '#6b8fe6', '#3b3a44', '#7cc58f']);
    const armA = Math.atan2(0.1, 0.27);
    return {
      w: 0.26,
      place(x, y) {
        addBody(x - 0.02, y, [R(-0.09, -0.03, 0.18, 0.03), { x: 0.05, y: -0.165, w: 0.025, h: 0.29, a: armA },
          { x: 0.02, y: -0.3, w: 0.2, h: 0.07, a: -0.5, d: 0.4 }], () => {
          if (state === 'ready') {
            ctx.save();
            ctx.translate(0.02, -0.3);
            ctx.rotate(-0.5);
            ctx.beginPath();
            ctx.moveTo(-0.1, -0.02);
            ctx.lineTo(-0.1, 0.03);
            ctx.lineTo(-0.35, 0.25);
            ctx.lineTo(-0.02, 0.35);
            ctx.closePath();
            ctx.fillStyle = 'rgba(255,230,140,0.22)';
            ctx.fill();
            ctx.restore();
          }
          ctx.save();
          ctx.translate(0.05, -0.165);
          ctx.rotate(armA);
          rrect(-0.0125, -0.15, 0.025, 0.3, 0.01, '#9aa0ad');
          ctx.restore();
          ctx.save();
          ctx.translate(0.02, -0.3);
          ctx.rotate(-0.5);
          ellipse(-0.1, 0.005, 0.02, 0.028, '#fff2b3');
          poly([[-0.1, -0.035], [0.1, -0.02], [0.1, 0.02], [-0.1, 0.035]], color);
          ctx.restore();
          rrect(-0.09, -0.03, 0.18, 0.03, 0.012, color);
        }, { kind: 'lamp' });
      },
    };
  }

  function pencilCup() {
    const color = pick(['#6b8fe6', '#e66b6b', '#3b3a44', '#7cc58f']);
    const pencils = [-0.026, 0, 0.026].map((dx) => ({
      dx, h: rand(0.17, 0.22), color: pick(['#f2c14e', '#f2c14e', '#e66b6b', '#6b8fe6']),
    }));
    return {
      w: 0.13,
      place(x, y) {
        for (const p of pencils) {
          addBody(x + p.dx, y - 0.016, [R(-0.008, -p.h, 0.016, p.h)], () => {
            rrect(-0.008, -p.h, 0.016, 0.02, 0.004, '#f2879b');
            rrect(-0.008, -p.h + 0.02, 0.016, p.h - 0.04, 0, p.color);
            poly([[-0.008, -0.02], [0.008, -0.02], [0, 0]], '#f0d9b5');
          }, { kind: 'pencil', bullet: true, density: 0.6 });
        }
        addBody(x, y, [R(-0.055, -0.016, 0.11, 0.016), R(-0.055, -0.13, 0.012, 0.13), R(0.043, -0.13, 0.012, 0.13)], () => {
          rrect(-0.055, -0.13, 0.11, 0.13, 0.012, color);
          rrect(-0.055, -0.1, 0.11, 0.02, 0, 'rgba(255,255,255,0.35)', false);
        }, { kind: 'cup', z: 1 });
      },
    };
  }

  function duck() {
    return {
      w: 0.17,
      place(x, y) {
        addBody(x, y, [{ x: 0, y: -0.065, r: 0.065 }, { x: 0.035, y: -0.15, r: 0.042 }], () => {
          ellipse(0.075, -0.145, 0.03, 0.013, '#f08a4b');
          ellipse(0, -0.065, 0.075, 0.065, '#f7d23e');
          ellipse(0.035, -0.15, 0.042, 0.042, '#f7d23e');
          ellipse(0.045, -0.16, 0.007, 0.007, INK, false);
          ellipse(-0.02, -0.07, 0.035, 0.02, '#f2c14e');
        }, { kind: 'duck', restitution: 0.4 });
      },
    };
  }

  function globe() {
    return {
      w: 0.24,
      place(x, y) {
        addBody(x, y, [R(-0.07, -0.025, 0.14, 0.025), R(-0.01, -0.07, 0.02, 0.05), { x: 0, y: -0.18, r: 0.11 }], () => {
          rrect(-0.01, -0.08, 0.02, 0.06, 0, '#9aa0ad');
          rrect(-0.07, -0.025, 0.14, 0.025, 0.01, '#5b6170');
          ellipse(0, -0.18, 0.11, 0.11, '#5aa9e6');
          ctx.save();
          ctx.beginPath();
          ctx.arc(0, -0.18, 0.105, 0, Math.PI * 2);
          ctx.clip();
          ellipse(-0.04, -0.22, 0.05, 0.035, '#7cc58f', false);
          ellipse(0.05, -0.15, 0.035, 0.05, '#7cc58f', false);
          ellipse(-0.03, -0.12, 0.025, 0.018, '#7cc58f', false);
          ctx.restore();
          ctx.beginPath();
          ctx.arc(0, -0.18, 0.13, -2.2, 2.2 - Math.PI * 2 + Math.PI * 2);
          ctx.lineWidth = 0.012;
          ctx.strokeStyle = '#9aa0ad';
          ctx.stroke();
        }, { kind: 'globe' });
      },
    };
  }

  function sodaCan() {
    const color = pick(['#e64b4b', '#4b7be6', '#3bb36a', '#f2c14e']);
    return {
      w: 0.09,
      place(x, y) {
        addBody(x, y, [R(-0.035, -0.13, 0.07, 0.13)], () => {
          rrect(-0.035, -0.13, 0.07, 0.13, 0.012, color);
          rrect(-0.03, -0.135, 0.06, 0.01, 0.004, '#c9ccd3');
          ctx.beginPath();
          ctx.moveTo(-0.035, -0.07);
          ctx.bezierCurveTo(-0.01, -0.1, 0.01, -0.04, 0.035, -0.07);
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 0.012;
          ctx.stroke();
        }, { kind: 'can', density: 0.4 });
      },
    };
  }

  function alarmClock() {
    const color = pick(['#e66b6b', '#6b8fe6', '#f2c14e', '#7cc58f']);
    return {
      w: 0.2,
      place(x, y) {
        addBody(x, y, [R(-0.06, -0.025, 0.12, 0.025), { x: 0, y: -0.11, r: 0.085 }], () => {
          ellipse(-0.06, -0.19, 0.03, 0.03, color);
          ellipse(0.06, -0.19, 0.03, 0.03, color);
          line(-0.05, -0.02, -0.07, 0, INK, 0.014);
          line(0.05, -0.02, 0.07, 0, INK, 0.014);
          ellipse(0, -0.11, 0.085, 0.085, color);
          ellipse(0, -0.11, 0.065, 0.065, '#fffaf0');
          const d = new Date();
          const ha = ((d.getHours() % 12) + d.getMinutes() / 60) * (Math.PI / 6);
          const ma = (d.getMinutes() + d.getSeconds() / 60) * (Math.PI / 30);
          line(0, -0.11, Math.sin(ha) * 0.035, -0.11 - Math.cos(ha) * 0.035, INK, 0.01);
          line(0, -0.11, Math.sin(ma) * 0.05, -0.11 - Math.cos(ma) * 0.05, INK, 0.007);
        }, { kind: 'clock' });
      },
    };
  }

  function stickyPad() {
    const color = pick(['#f7e36b', '#f2879b', '#8fd3f0', '#a8e08f']);
    return {
      w: 0.11,
      place(x, y) {
        addBody(x, y, [R(-0.05, -0.04, 0.1, 0.04)], () => {
          rrect(-0.05, -0.04, 0.1, 0.04, 0.006, color);
          line(-0.045, -0.027, 0.045, -0.027, 'rgba(0,0,0,0.15)', 0.004);
          line(-0.045, -0.014, 0.045, -0.014, 'rgba(0,0,0,0.15)', 0.004);
        }, { kind: 'sticky', density: 0.5 });
      },
    };
  }

  function photoFrame() {
    const sky = pick(['#8fd3f0', '#f7b267', '#b48be0']);
    return {
      w: 0.18,
      place(x, y) {
        addBody(x, y, [R(-0.08, -0.2, 0.16, 0.2)], () => {
          rrect(-0.08, -0.2, 0.16, 0.2, 0.01, '#3b3a44');
          rrect(-0.065, -0.185, 0.13, 0.17, 0, sky, false);
          ellipse(0.03, -0.14, 0.018, 0.018, '#fff2b3', false);
          poly([[-0.065, -0.015], [-0.02, -0.1], [0.02, -0.04], [0.04, -0.07], [0.065, -0.015]], '#5fae6a', false);
        }, { kind: 'frame' });
      },
    };
  }

  const COMPUTERS = [
    () => [monitor(), keyboard(), mouse()],
    () => [monitor(), keyboard(), mouse()],
    () => [laptop(), mouse()],
    () => [crt(), keyboard(), mouse()],
    () => [speaker(), monitor(), speaker(), keyboard(), mouse()],
  ];
  const EXTRAS = [lamp, pencilCup, duck, globe, sodaCan, alarmClock, stickyPad, photoFrame, plant, bookStack, mug];

  function buildItems() {
    const deskTop = floorY - DESK_H - 0.001;
    const comp = pick(COMPUTERS)();
    if (chance(0.5)) comp.reverse();
    const extras = [];
    if (chance(0.9)) extras.push(mug());
    if (chance(0.85)) extras.push(chance(0.5) ? bookStack() : booksUpright());
    if (chance(0.85)) extras.push(plant());
    for (const make of shuffle(EXTRAS.slice()).slice(0, randInt(1, 4))) extras.push(make());
    shuffle(extras);

    const GAP = 0.015;
    const widthOf = (list) => list.reduce((s, it) => s + it.w, 0) + GAP * (list.length - 1);
    while (extras.length && widthOf(comp.concat(extras)) > LAYOUT_SPAN) extras.pop();

    // Keep the computer setup together as one block among the extras.
    const blocks = extras.map((e) => [e]);
    blocks.splice(randInt(0, blocks.length), 0, comp);
    const seq = blocks.flat();

    const free = LAYOUT_SPAN - widthOf(seq);
    const weights = Array.from({ length: seq.length + 1 }, () => Math.random());
    const total = weights.reduce((a, b) => a + b, 0);
    let x = cx - LAYOUT_SPAN / 2 + (free * weights[0]) / total;
    seq.forEach((it, i) => {
      it.place(x + it.w / 2, deskTop);
      x += it.w + GAP + (free * weights[i + 1]) / total;
    });
  }

  // ---------- scene ----------

  function buildScene() {
    world = new pl.World({ gravity: V(0, GRAVITY) });
    bodies = [];
    drops = [];
    stains = [];

    const ground = world.createBody();
    ground.createFixture(pl.Box(Wm, 1, V(Wm / 2, floorY + 1)), { friction: 0.8 });
    ground.createFixture(pl.Box(0.5, 20, V(-0.5, floorY - 19)), { friction: 0.3 });
    ground.createFixture(pl.Box(0.5, 20, V(Wm + 0.5, floorY - 19)), { friction: 0.3 });

    buildDesk();
    buildItems();
    bodies.sort((a, b) => a.z - b.z);
    lastDeskSpeed = 0;
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ppm = Math.min(W / 2.3, H / 2.6);
    Wm = W / ppm;
    Hm = H / ppm;
    // On tall phone screens, raise the floor so the desk sits nearer the middle.
    floorY = Math.min(Hm - Math.max(0.3, Hm * 0.16), Math.max(DESK_H + 1.7, Hm * 0.64));
    cx = Wm / 2;
    buildScene();
    state = 'ready';
    stateT = 0;
    fade = 0;
  }

  // ---------- flipping ----------

  function flip(strength, side, sideways) {
    if (state !== 'ready') return;
    state = 'flipped';
    stateT = 0;
    idleT = 0;
    flips++;
    try { localStorage.setItem('flippydesk.flips', String(flips)); } catch (e) { /* storage blocked */ }
    updateCount();

    const m = desk.getMass();
    const p = desk.getWorldPoint(V(side * rand(0.3, 0.45), 0));
    desk.applyLinearImpulse(V(m * sideways * 2.5, -m * 10 * strength), p, true);
    for (const b of bodies) {
      if (b === desk) continue;
      const v = b.getLinearVelocity();
      b.setLinearVelocity(V(v.x + rand(-2.5, 2.5) + sideways * 2 - side * rand(0, 1.5), v.y - rand(3, 7.5) * strength));
      b.setAngularVelocity(rand(-9, 9));
      b.setAwake(true);
    }
  }

  // ---------- coffee + shake ----------

  function stepExtras(dt) {
    for (const b of bodies) {
      if (b.kind !== 'mug' || !(b.coffee > 0)) continue;
      if (Math.cos(b.getAngle()) > 0.35) continue;
      const mouth = b.getWorldPoint(V(rand(-0.05, 0.05), -0.16));
      const v = b.getLinearVelocity();
      for (let i = 0; i < 2; i++) {
        drops.push({ x: mouth.x, y: mouth.y, vx: v.x + rand(-0.8, 0.8), vy: v.y + rand(-0.8, 0.8), r: rand(0.008, 0.018) });
      }
      b.coffee -= 0.012;
    }
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.vy += GRAVITY * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      if (d.y >= floorY) {
        if (d.x > 0 && d.x < Wm) stains.push({ x: d.x, r: d.r * rand(1.5, 3) });
        drops.splice(i, 1);
      }
    }

    const speed = desk.getLinearVelocity().length();
    const jolt = lastDeskSpeed - speed;
    if (jolt > 2.5) shake = Math.min(1, shake + jolt * 0.08);
    lastDeskSpeed = speed;
  }

  // ---------- main loop ----------

  let acc = 0;
  let last = performance.now();

  function update(dt) {
    clock += dt;
    acc += dt;
    while (acc >= STEP) {
      world.step(STEP, 8, 3);
      stepExtras(STEP);
      acc -= STEP;
    }
    shake = Math.max(0, shake - dt * 2.5);
    stateT += dt;

    if (state === 'ready') {
      idleT += dt;
    } else if (state === 'flipped') {
      if (stateT > RESET_AFTER) {
        let moving = false;
        for (const b of bodies) if (b.getLinearVelocity().length() > 1.2) { moving = true; break; }
        if (!moving || stateT > RESET_MAX) { state = 'fadeout'; stateT = 0; }
      }
    } else if (state === 'fadeout') {
      fade = Math.min(1, stateT / FADE);
      if (fade >= 1) { buildScene(); state = 'fadein'; stateT = 0; }
    } else if (state === 'fadein') {
      fade = Math.max(0, 1 - stateT / FADE);
      if (fade <= 0) { state = 'ready'; stateT = 0; idleT = 0; }
    }
    hintEl.classList.toggle('show', state === 'ready' && idleT > (flips ? 3 : 0.8));
  }

  function drawRoom() {
    // wall
    const g = ctx.createLinearGradient(0, 0, 0, floorY);
    g.addColorStop(0, '#f6eedf');
    g.addColorStop(1, '#efe2cb');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, Wm, floorY);
    ctx.fillStyle = 'rgba(0,0,0,0.025)';
    for (let x = 0.15; x < Wm; x += 0.3) ctx.fillRect(x, 0, 0.12, floorY);

    // window
    const ww = Math.min(1.1, Wm * 0.32);
    const wh = Math.min(0.85, (floorY - DESK_H - 0.75) * 0.9);
    if (wh > 0.35) {
      const wx = cx + DESK_W / 2 - ww - 0.1;
      const wy = Math.max(0.35, floorY - DESK_H - 0.75 - wh);
      rrect(wx - 0.04, wy - 0.04, ww + 0.08, wh + 0.08, 0.02, '#ffffff');
      const sky = ctx.createLinearGradient(0, wy, 0, wy + wh);
      sky.addColorStop(0, '#8fcff0');
      sky.addColorStop(1, '#d3eefa');
      rrect(wx, wy, ww, wh, 0.01, sky);
      const cl = (clock * 0.03) % (ww + 0.4) - 0.2;
      ctx.save();
      ctx.beginPath();
      ctx.rect(wx, wy, ww, wh);
      ctx.clip();
      ellipse(wx + cl, wy + wh * 0.35, 0.12, 0.045, '#fff', false);
      ellipse(wx + cl + 0.08, wy + wh * 0.32, 0.08, 0.05, '#fff', false);
      ctx.restore();
      line(wx + ww / 2, wy, wx + ww / 2, wy + wh, '#ffffff', 0.03);
      line(wx, wy + wh / 2, wx + ww, wy + wh / 2, '#ffffff', 0.03);
    }

    // floor
    ctx.fillStyle = '#c99a6b';
    ctx.fillRect(0, floorY, Wm, Hm - floorY);
    ctx.fillStyle = 'rgba(0,0,0,0.06)';
    for (let y = floorY + 0.12; y < Hm; y += 0.12) ctx.fillRect(0, y, Wm, 0.008);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, floorY - 0.06, Wm, 0.06);
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.fillRect(0, floorY - 0.008, Wm, 0.008);

    // coffee stains
    ctx.fillStyle = 'rgba(92,55,30,0.55)';
    for (const s of stains) {
      ctx.beginPath();
      ctx.ellipse(s.x, floorY + 0.02, s.r * 1.6, s.r * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // desk shadow
    const dp = desk.getPosition();
    const lift = Math.max(0, floorY - dp.y);
    ctx.fillStyle = `rgba(0,0,0,${0.13 * Math.max(0, 1 - lift / 2)})`;
    ctx.beginPath();
    ctx.ellipse(dp.x, floorY + 0.03, DESK_W * 0.55, 0.05, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function render() {
    const ox = shake ? rand(-1, 1) * shake * 10 : 0;
    const oy = shake ? rand(-1, 1) * shake * 10 : 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#f3e9d8';
    ctx.fillRect(0, 0, W, H);
    ctx.setTransform(dpr * ppm, 0, 0, dpr * ppm, ox * dpr, oy * dpr);
    ctx.lineJoin = 'round';

    drawRoom();

    for (const b of bodies) {
      const p = b.getPosition();
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(b.getAngle());
      b.draw();
      ctx.restore();
    }

    ctx.fillStyle = '#6b3f22';
    for (const d of drops) {
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }

    if (fade > 0) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = `rgba(243,233,216,${fade})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }

  function updateCount() {
    countEl.textContent = flips ? `${flips} flipped` : '';
  }

  // ---------- input ----------

  let swipe = null;

  function deskTopPx() {
    return (floorY - DESK_H) * ppm;
  }

  function tryFlip(e, minDist) {
    if (!swipe) return;
    const now = performance.now();
    swipe.pts.push([e.clientX, e.clientY, now]);
    while (swipe.pts.length > 2 && now - swipe.pts[0][2] > 120) swipe.pts.shift();
    const dy = swipe.y0 - e.clientY;
    if (dy < minDist) return;
    const [px, py, pt] = swipe.pts[0];
    const ms = Math.max(16, now - pt);
    const vy = (py - e.clientY) / ms;          // px per ms, upward positive
    const vx = (e.clientX - px) / ms;
    const strength = clamp(0.75 + vy / 2.5, 0.75, 1.6);
    const deskX = swipe.x0 / ppm - cx;
    const side = Math.abs(deskX) > 0.15 ? Math.sign(deskX) : (chance(0.5) ? 1 : -1);
    flip(strength, side, clamp(vx / 1.5, -1, 1));
    swipe = null;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (state !== 'ready') return;
    if (e.clientY < deskTopPx() - 30) return;  // swipes start at the desk, not above it
    swipe = { x0: e.clientX, y0: e.clientY, pts: [[e.clientX, e.clientY, performance.now()]] };
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });
  canvas.addEventListener('pointermove', (e) => tryFlip(e, 60));
  canvas.addEventListener('pointerup', (e) => { tryFlip(e, 30); swipe = null; });
  canvas.addEventListener('pointercancel', () => { swipe = null; });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.code === 'ArrowUp') {
      e.preventDefault();
      flip(rand(1, 1.3), chance(0.5) ? 1 : -1, rand(-0.4, 0.4));
    }
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 150);
  });

  // Expose a tiny hook for automated testing.
  window.flippyDesk = { flip: () => flip(1.2, 1, 0), get state() { return state; } };

  resize();
  updateCount();
  requestAnimationFrame(frame);
})();
