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
  const scoreEl = document.getElementById('score');
  const scoreNumEl = scoreEl.querySelector('.num');
  const hangEl = scoreEl.querySelector('.hang');
  const muteEl = document.getElementById('mute');

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
  let ground, floorFix, shardCount = 0, pinnedT = 0;
  let score = 0, hang = 0, groundT = 0, landed = false, popups = [];
  let flips = 0, best = 0;
  try {
    flips = parseInt(localStorage.getItem('flippydesk.flips'), 10) || 0;
    best = parseInt(localStorage.getItem('flippydesk.best'), 10) || 0;
  } catch (e) { /* storage blocked */ }

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
        filterGroupIndex: o.group || 0,
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
        const b = addBody(x, y, [R(-0.13, -0.03, 0.26, 0.03), R(-0.025, -0.17, 0.05, 0.14), R(-0.31, -0.54, 0.62, 0.38)], () => {
          rrect(-0.025, -0.19, 0.05, 0.17, 0.005, '#5b6170');
          rrect(-0.13, -0.03, 0.26, 0.03, 0.012, '#4a4f5c');
          rrect(-0.31, -0.54, 0.62, 0.38, 0.025, '#2f3340');
          if (b.dead) return rrect(-0.29, -0.52, 0.58, 0.32, 0.012, DEAD_SCREEN, false);
          const g = ctx.createLinearGradient(0, -0.52, 0, -0.19);
          g.addColorStop(0, hsl(hue, 70, 64));
          g.addColorStop(1, hsl(hue + 50, 70, 46));
          rrect(-0.29, -0.52, 0.58, 0.32, 0.012, g, false);
          rrect(-0.24, -0.48, 0.32, 0.23, 0.012, 'rgba(255,255,255,0.88)', false);
          lines.forEach(([a, b], i) => line(-0.22 + a, -0.45 + i * 0.033, -0.22 + a + b * 0.8, -0.45 + i * 0.033, hsl(hue + i * 40, 55, 50), 0.012));
          ellipse(0.17, -0.3, 0.035, 0.035, 'rgba(255,255,255,0.35)', false);
        }, { kind: 'computer' });
        makeScreen(b, -0.29, -0.52, 0.58, 0.32);
      },
    };
  }

  function laptop() {
    const hue = rand(0, 360);
    return {
      w: 0.46,
      place(x, y) {
        const b = addBody(x, y, [R(-0.23, -0.028, 0.46, 0.028), R(-0.2, -0.31, 0.4, 0.282)], () => {
          rrect(-0.2, -0.31, 0.4, 0.29, 0.02, '#c9ccd3');
          if (b.dead) {
            rrect(-0.18, -0.29, 0.36, 0.245, 0.01, DEAD_SCREEN, false);
          } else {
            const g = ctx.createLinearGradient(0, -0.29, 0, -0.05);
            g.addColorStop(0, hsl(hue, 60, 66));
            g.addColorStop(1, hsl(hue + 40, 65, 48));
            rrect(-0.18, -0.29, 0.36, 0.245, 0.01, g, false);
            ellipse(0, -0.17, 0.04, 0.04, 'rgba(255,255,255,0.5)', false);
          }
          rrect(-0.23, -0.028, 0.46, 0.028, 0.012, '#b3b7c0');
        }, { kind: 'computer' });
        makeScreen(b, -0.18, -0.29, 0.36, 0.245);
      },
    };
  }

  function crt() {
    return {
      w: 0.5,
      place(x, y) {
        const b = addBody(x, y, [R(-0.17, -0.04, 0.34, 0.04), R(-0.25, -0.46, 0.5, 0.42)], () => {
          rrect(-0.17, -0.05, 0.34, 0.05, 0.01, '#d9cdb0');
          rrect(-0.25, -0.46, 0.5, 0.42, 0.04, '#e8dcc0');
          rrect(-0.2, -0.42, 0.4, 0.3, 0.06, b.dead ? DEAD_SCREEN : '#1f3a2c');
          if (!b.dead) {
            ctx.fillStyle = '#6dff9c';
            ctx.font = 'bold 0.06px monospace';
            ctx.fillText('C:\\>_', -0.16, -0.33);
          }
          rrect(0.12, -0.1, 0.06, 0.03, 0.01, '#c9bc9c');
        }, { kind: 'computer' });
        makeScreen(b, -0.2, -0.42, 0.4, 0.3);
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
        const handle = () => {
          ctx.beginPath();
          ctx.ellipse(0.07, -0.085, 0.042, 0.042, 0, -Math.PI / 2, Math.PI / 2);
          ctx.lineCap = 'butt';
          ctx.strokeStyle = INK;
          ctx.lineWidth = 0.032;
          ctx.stroke();
          ctx.strokeStyle = color;
          ctx.lineWidth = 0.014;
          ctx.stroke();
        };
        const b = addBody(x - 0.02, y, [R(-0.07, -0.16, 0.14, 0.16), R(0.07, -0.13, 0.045, 0.09, { d: 0.3 })], () => {
          handle();
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
        b.breakable = 'mug';
        // Two jagged halves and the handle.
        const left = [[-0.07, 0], [0, 0], [0.012, -0.09], [-0.02, -0.16], [-0.07, -0.16]];
        const right = [[0, 0], [0.07, 0], [0.07, -0.16], [-0.02, -0.16], [0.012, -0.09]];
        b.shatter = () => {
          spill(b, 30);
          spawnShards(b, 0, -0.08, 3, color);
          splitBody(b, [
            { parts: [{ pts: left }], draw: () => poly(left, color) },
            { parts: [{ pts: [[0, 0], [0.07, 0], [0.07, -0.16], [-0.02, -0.16]] }], draw: () => poly(right, color) },
            { parts: [R(0.07, -0.13, 0.045, 0.09)], draw: handle, o: { density: 0.3 } },
          ]);
        };
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
        const drawPot = () => {
          poly(potPts, pot);
          rrect(-0.1, -0.18, 0.2, 0.035, 0.01, pot);
        };
        const drawPlant = () => {
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
        };
        const b = addBody(x, y, parts, () => {
          drawPlant();
          drawPot();
        }, { kind: 'plant' });
        b.breakable = 'pot';
        // The pot splits in two and loses its rim; the plant keeps a clump
        // of roots and dirt and the rest of the soil spills out.
        const left = [[-0.07, 0], [0.005, 0], [-0.015, -0.08], [0.01, -0.15], [-0.09, -0.15]];
        const right = [[0.005, 0], [0.07, 0], [0.09, -0.15], [0.01, -0.15], [-0.015, -0.08]];
        b.shatter = () => {
          spillDirt(b, 40);
          splitBody(b, [
            { parts: [{ pts: left }], draw: () => poly(left, pot) },
            { parts: [{ pts: [[0.005, 0], [0.07, 0], [0.09, -0.15], [-0.015, -0.15]] }], draw: () => poly(right, pot) },
            { parts: [R(-0.1, -0.18, 0.2, 0.035)], draw: () => rrect(-0.1, -0.18, 0.2, 0.035, 0.01, pot) },
            {
              parts: [{ x: 0, y: -0.14, r: 0.055 }, ...parts.slice(2)],
              draw: () => { drawPlant(); ellipse(0, -0.14, 0.065, 0.05, '#5a3d2b'); },
              o: { density: 0.4 },
            },
          ]);
        };
      },
    };
  }

  function lamp() {
    const color = pick(['#e66b6b', '#f2c14e', '#6b8fe6', '#3b3a44', '#7cc58f']);
    const armA = Math.atan2(0.1, 0.27);
    return {
      w: 0.26,
      place(x, y) {
        const baseR = R(-0.09, -0.03, 0.18, 0.03);
        const armP = { x: 0.05, y: -0.165, w: 0.025, h: 0.29, a: armA };
        const headP = { x: 0.02, y: -0.3, w: 0.2, h: 0.07, a: -0.5, d: 0.4 };
        const drawArm = () => {
          ctx.save();
          ctx.translate(0.05, -0.165);
          ctx.rotate(armA);
          rrect(-0.0125, -0.15, 0.025, 0.3, 0.01, '#9aa0ad');
          ctx.restore();
        };
        const drawHead = (lit) => {
          ctx.save();
          ctx.translate(0.02, -0.3);
          ctx.rotate(-0.5);
          if (lit) {
            ellipse(-0.1, 0.005, 0.02, 0.028, '#fff2b3');
          } else {
            poly([[-0.1, -0.02], [-0.115, -0.005], [-0.105, 0.008], [-0.118, 0.022], [-0.1, 0.03]], '#5b6170');
          }
          poly([[-0.1, -0.035], [0.1, -0.02], [0.1, 0.02], [-0.1, 0.035]], color);
          ctx.restore();
        };
        const drawBase = () => rrect(-0.09, -0.03, 0.18, 0.03, 0.012, color);
        const b = addBody(x - 0.02, y, [baseR, armP, headP], () => {
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
          drawArm();
          drawHead(true);
          drawBase();
        }, { kind: 'lamp' });
        b.breakable = 'lamp';
        b.shatter = () => {
          spawnShards(b, -0.065, -0.248, 4, '#fff2b3');
          splitBody(b, [
            { parts: [baseR], draw: drawBase },
            { parts: [armP], draw: drawArm },
            { parts: [headP], draw: () => drawHead(false), o: { density: 0.4 } },
          ]);
        };
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
    const kitty = chance(0.7) ? cat() : null;
    for (const make of shuffle(EXTRAS.slice()).slice(0, randInt(1, 4))) extras.push(make());
    shuffle(extras);
    if (kitty) extras.unshift(kitty);  // the fit below drops from the end

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

    shardCount = 0;
    popups = [];
    cats = [];
    grab = null;
    world.on('post-solve', onPostSolve);
    world.on('begin-contact', onBeginContact);

    ground = world.createBody();
    floorFix = ground.createFixture(pl.Box(Wm, 1, V(Wm / 2, floorY + 1)), { friction: 0.8 });
    // Frictionless side walls so things slide down them instead of sticking.
    ground.createFixture(pl.Box(0.5, 20, V(-0.5, floorY - 19)), { friction: 0 });
    ground.createFixture(pl.Box(0.5, 20, V(Wm + 0.5, floorY - 19)), { friction: 0 });

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

  // ---------- the cat ----------
  // Cats aren't physics bodies: one naps on the desk, then on a flip it
  // wakes, leaps clear and sits on the floor looking unimpressed.

  let cats = [];
  const CAT_COATS = [
    { fur: '#f0a35e', dark: '#d9823e' },
    { fur: '#3b3a44', dark: '#2a2733' },
    { fur: '#f4f4f6', dark: '#d9d4c8' },
    { fur: '#9aa0ad', dark: '#7d8391' },
  ];

  function cat() {
    const coat = pick(CAT_COATS);
    const dir = chance(0.5) ? 1 : -1;
    return {
      w: 0.3,
      place(x, y) {
        cats.push({ lx: x - cx, ly: y - floorY, coat, dir, mode: 'sleep', t: 0 });
      },
    };
  }

  function wakeCats() {
    for (const c of cats) {
      if (c.mode !== 'sleep') continue;
      const p = desk.getWorldPoint(V(c.lx, c.ly));
      Object.assign(c, { mode: 'alert', t: 0, x: p.x, y: p.y, a: desk.getAngle() });
      sfx.meow();
    }
  }

  function updateCats(dt) {
    for (const c of cats) {
      c.t += dt;
      if (c.mode === 'alert' && c.t > 0.15) {
        // Jump toward whichever side of the screen is nearer.
        c.mode = 'jump';
        c.t = 0;
        c.sx = c.x;
        c.sy = c.y;
        c.tx = c.x < cx ? rand(0.25, 0.45) : Wm - rand(0.25, 0.45);
        c.dir = c.tx < c.x ? -1 : 1;
        c.dur = 0.6;
      } else if (c.mode === 'jump') {
        const k = Math.min(1, c.t / c.dur);
        c.x = c.sx + (c.tx - c.sx) * k;
        c.y = c.sy + (floorY - c.sy) * k - Math.sin(k * Math.PI) * 0.6;
        c.a = 0;
        if (k >= 1) {
          c.mode = 'sit';
          c.t = 0;
          c.dir = -c.dir;  // turn around to watch the mess
        }
      }
    }
  }

  function drawCat(c) {
    const { fur, dark } = c.coat;
    ctx.save();
    if (c.mode === 'sleep') {
      const p = desk.getWorldPoint(V(c.lx, c.ly));
      ctx.translate(p.x, p.y);
      ctx.rotate(desk.getAngle());
    } else {
      ctx.translate(c.x, c.y);
      ctx.rotate(c.a || 0);
    }
    ctx.scale(c.dir, 1);
    const ear = (x, y, s) => poly([[x - s, y], [x + s * 0.2, y - s * 1.6], [x + s, y]], fur);
    const eye = (x, y, open) => {
      if (open) ellipse(x, y, 0.008, 0.012, INK, false);
      else line(x - 0.01, y, x + 0.01, y, INK, 0.006);
    };
    if (c.mode === 'sleep') {
      // A loaf with its tail wrapped round the front.
      ellipse(0, -0.06, 0.13, 0.06, fur);
      ear(0.06, -0.1, 0.022);
      ear(0.115, -0.1, 0.022);
      ellipse(0.09, -0.065, 0.055, 0.045, fur);
      eye(0.07, -0.07, false);
      eye(0.11, -0.07, false);
      ctx.beginPath();
      ctx.ellipse(-0.02, -0.01, 0.12, 0.025, 0, 0, Math.PI);
      ctx.lineWidth = 0.03;
      ctx.strokeStyle = INK;
      ctx.stroke();
      ctx.lineWidth = 0.016;
      ctx.strokeStyle = dark;
      ctx.stroke();
      ctx.restore();
      // Zzz floats up in screen space.
      const p = desk.getWorldPoint(V(c.lx, c.ly - 0.14));
      ctx.save();
      ctx.font = 'bold 0.05px ui-rounded, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(42,39,51,0.55)';
      for (let i = 0; i < 3; i++) {
        const k = (clock * 0.5 + i / 3) % 1;
        ctx.globalAlpha = Math.sin(k * Math.PI);
        ctx.fillText('z', p.x + k * 0.1 * c.dir, p.y - k * 0.15);
      }
      ctx.restore();
      return;
    }
    if (c.mode === 'jump') {
      // Stretched out mid-leap.
      ctx.beginPath();
      ctx.moveTo(-0.1, -0.06);
      ctx.quadraticCurveTo(-0.2, -0.12, -0.24, -0.04);
      ctx.lineWidth = 0.026;
      ctx.strokeStyle = INK;
      ctx.stroke();
      ctx.lineWidth = 0.012;
      ctx.strokeStyle = fur;
      ctx.stroke();
      line(0.07, -0.04, 0.14, -0.01, INK, 0.018);
      line(-0.07, -0.05, -0.14, -0.01, INK, 0.018);
      ellipse(0, -0.06, 0.13, 0.04, fur);
      ear(0.13, -0.1, 0.02);
      ear(0.17, -0.1, 0.02);
      ellipse(0.15, -0.075, 0.045, 0.04, fur);
      eye(0.165, -0.08, true);
      ctx.restore();
      return;
    }
    // Sitting (or startled, ears up).
    const swish = Math.sin(clock * 3) * 0.03;
    ctx.beginPath();
    ctx.moveTo(-0.05, -0.01);
    ctx.quadraticCurveTo(-0.16, 0, -0.14 + swish, -0.09);
    ctx.lineWidth = 0.026;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.lineWidth = 0.012;
    ctx.strokeStyle = fur;
    ctx.stroke();
    ellipse(0, -0.08, 0.065, 0.08, fur);
    ellipse(0.02, -0.01, 0.03, 0.012, fur);
    ear(-0.025, -0.24, 0.022);
    ear(0.03, -0.24, 0.022);
    ellipse(0.005, -0.2, 0.052, 0.045, fur);
    const blink = c.mode === 'sit' && (clock % 3.2) < 0.12;
    eye(-0.012, -0.205, !blink);
    eye(0.025, -0.205, !blink);
    if (c.mode === 'alert') {
      ctx.font = 'bold 0.09px ui-rounded, system-ui, sans-serif';
      ctx.fillStyle = INK;
      ctx.fillText('!', 0.06, -0.27);
    }
    ctx.restore();
  }

  // ---------- the boss ----------
  // An original nosy manager who wanders in, mug in hand, if you stand
  // around too long without flipping anything.

  const BOSS_IDLE = 6;
  const BOSS_LINES = [
    'So... just circling back on that report.',
    'Got a sec? Quick sync about the report.',
    'Per my last email... the report?',
    'Love the energy! Report by end of day?',
    'Hey buddy. That report. Any update?',
  ];
  const boss = { mode: 'away', t: 0, slide: 0, line: '' };

  function updateBoss(dt) {
    boss.t += dt;
    if (boss.mode === 'away' && state === 'ready' && idleT > BOSS_IDLE) {
      Object.assign(boss, { mode: 'in', t: 0, line: pick(BOSS_LINES) });
      sfx.ding(false);
    }
    if (boss.mode === 'in') boss.slide = Math.min(1, boss.slide + dt * 2);
    if (boss.mode === 'flee') {
      boss.slide = Math.max(0, boss.slide - dt * 4);
      if (boss.slide === 0) boss.mode = 'away';
    }
    if (boss.mode === 'in' && state !== 'ready') bossFlee();
  }

  function bossFlee() {
    if (boss.mode !== 'in') return;
    if (boss.slide > 0.6) addPoints(300, 'boss startled', Wm - 0.5, floorY - 1.3);
    boss.mode = 'flee';
    boss.t = 0;
  }

  function drawBoss() {
    if (boss.slide <= 0) return;
    const e = 1 - Math.pow(1 - boss.slide, 3);
    const x = Wm + 0.45 - e * 0.85;
    const y = floorY;
    const jolt = boss.mode === 'flee' ? -0.05 : 0;
    ctx.save();
    ctx.translate(x, y + jolt);
    // legs and shoes
    rrect(-0.14, -0.8, 0.12, 0.78, 0.02, '#4a4f5c');
    rrect(0.02, -0.8, 0.12, 0.78, 0.02, '#4a4f5c');
    rrect(-0.17, -0.04, 0.15, 0.04, 0.02, INK);
    rrect(0.0, -0.04, 0.15, 0.04, 0.02, INK);
    // shirt, belt, tie
    rrect(-0.2, -1.38, 0.4, 0.62, 0.08, '#cfe0f5');
    rrect(-0.2, -0.82, 0.4, 0.05, 0.01, '#5b3a2a');
    poly([[-0.03, -1.35], [0.03, -1.35], [0.045, -0.95], [0, -0.9], [-0.045, -0.95]], '#e66b6b');
    // arm holding a mug
    rrect(-0.3, -1.32, 0.1, 0.42, 0.05, '#cfe0f5');
    rrect(-0.38, -1.05, 0.16, 0.08, 0.04, '#cfe0f5');
    rrect(-0.47, -1.1, 0.11, 0.13, 0.015, '#f4f4f6');
    ctx.save();
    ctx.font = 'bold 0.03px ui-rounded, system-ui, sans-serif';
    ctx.fillStyle = '#e66b6b';
    ctx.fillText('#1', -0.45, -1.03);
    ctx.restore();
    // head: thinning hair, glasses, polite smile
    ellipse(0, -1.5, 0.13, 0.15, '#f2c9a5');
    for (const [a0, a1] of [[0.82, 1.12], [-0.12, 0.18]]) {
      ctx.beginPath();
      ctx.ellipse(0, -1.52, 0.135, 0.14, 0, Math.PI * a0, Math.PI * a1);
      ctx.lineWidth = 0.04;
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#8a8f99';
      ctx.stroke();
    }
    ellipse(-0.05, -1.52, 0.035, 0.03, 'rgba(255,255,255,0.4)');
    ellipse(0.05, -1.52, 0.035, 0.03, 'rgba(255,255,255,0.4)');
    line(-0.015, -1.52, 0.015, -1.52, INK, 0.008);
    ellipse(-0.05, -1.52, 0.008, 0.008, INK, false);
    ellipse(0.05, -1.52, 0.008, 0.008, INK, false);
    ctx.beginPath();
    if (boss.mode === 'flee') ctx.ellipse(0, -1.43, 0.025, 0.02, 0, 0, Math.PI * 2);
    else ctx.arc(0, -1.46, 0.04, 0.2 * Math.PI, 0.8 * Math.PI);
    ctx.lineWidth = 0.01;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.restore();
  }

  function drawBossBubble() {
    if (boss.mode !== 'in' || boss.slide < 1) return;
    ctx.save();
    ctx.font = '600 0.07px ui-rounded, system-ui, sans-serif';
    const maxW = Math.min(1.5, Wm - 0.6);
    const words = boss.line.split(' ');
    const lines = [''];
    for (const w of words) {
      const next = lines[lines.length - 1] ? lines[lines.length - 1] + ' ' + w : w;
      if (ctx.measureText(next).width > maxW && lines[lines.length - 1]) lines.push(w);
      else lines[lines.length - 1] = next;
    }
    const lh = 0.085;
    const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 0.12;
    const bh = lines.length * lh + 0.08;
    const bx = Wm - 0.45 - bw;
    const by = floorY - 1.75 - bh;
    poly([[bx + bw - 0.18, by + bh - 0.01], [bx + bw - 0.06, by + bh - 0.01], [bx + bw + 0.02, by + bh + 0.1]], '#ffffff');
    rrect(bx, by, bw, bh, 0.05, '#ffffff');
    ctx.fillStyle = INK;
    lines.forEach((l, i) => ctx.fillText(l, bx + 0.06, by + 0.04 + (i + 0.8) * lh));
    ctx.restore();
  }

  // ---------- flipping ----------

  // Starts a round: the scoring, breakage and reset timer all run from here.
  function startRound() {
    state = 'flipped';
    stateT = 0;
    idleT = 0;
    flips++;
    try { localStorage.setItem('flippydesk.flips', String(flips)); } catch (e) { /* storage blocked */ }
    score = 0;
    hang = 0;
    groundT = 0;
    landed = false;
    pinnedT = 0;
    heldUntil = 0;
    updateScore();
    wakeCats();
    bossFlee();
  }

  function flip(strength, side, sideways) {
    if (state !== 'ready') return;
    startRound();
    launch(strength, side, sideways);
  }

  function launch(strength, side, sideways) {
    // strength runs from about 0.3 (a lazy drag) to 2.6 (a hard flick). Lift
    // grows linearly with it, spin and scatter a little slower, so gentle
    // swipes tip the desk over and hard ones send it cartwheeling.
    sfx.whoosh(strength);
    const m = desk.getMass();
    const spin = Math.sqrt(strength);
    const p = desk.getWorldPoint(V(side * rand(0.3, 0.45) * clamp(spin, 0.7, 1.3), 0));
    desk.applyLinearImpulse(V(m * sideways * 2.5 * spin, -m * 7 * strength), p, true);
    for (const b of bodies) {
      if (b === desk) continue;
      const v = b.getLinearVelocity();
      b.setLinearVelocity(V(
        v.x + (rand(-2.5, 2.5) + sideways * 2 - side * rand(0, 1.5)) * spin,
        v.y - rand(2, 6.5) * strength,
      ));
      b.setAngularVelocity(rand(-9, 9) * spin);
      b.setAwake(true);
    }
  }


  // A slow drag grabs the underside of the desktop and lifts it with the
  // finger, so things slide off. A mouse joint pulls that point toward the
  // finger while the far legs stay on the floor.
  let grab = null, grabOffset = null, heldUntil = 0;

  function startTilt(px, py) {
    startRound();
    const lx = clamp(px / ppm - desk.getPosition().x, -DESK_W / 2 + 0.05, DESK_W / 2 - 0.05);
    const anchor = desk.getWorldPoint(V(lx, -DESK_H + DESK_TOP_T));
    grabOffset = V(anchor.x - px / ppm, anchor.y - py / ppm);
    grab = world.createJoint(pl.MouseJoint({ maxForce: desk.getMass() * 140, frequencyHz: 4, dampingRatio: 0.8 }, ground, desk, anchor));
    for (const b of bodies) b.setAwake(true);
  }

  function moveTilt(px, py) {
    if (grab) grab.setTarget(V(px / ppm + grabOffset.x, py / ppm + grabOffset.y));
  }

  function releaseTilt() {
    if (!grab) return;
    world.destroyJoint(grab);
    grab = null;
    heldUntil = stateT;
  }

  // ---------- sound ----------
  // Everything is synthesized with Web Audio, so there are no files to load.

  const sfx = (() => {
    let ac = null, master = null, noise = null, recent = [];
    let muted = false;
    try { muted = localStorage.getItem('flippydesk.muted') === '1'; } catch (e) { /* storage blocked */ }

    // Browsers only allow audio after a user gesture, so this runs on every
    // tap, click or key press until the audio context is running.
    function unlock() {
      if (ac && ac.state === 'running') return;
      // iOS can leave a context 'interrupted' for good after the phone
      // sleeps; start over with a fresh one.
      if (ac && ac.state !== 'suspended') reset();
      if (!ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        // On iOS 17+, play through the silent switch like a game would; the
        // page has its own mute button.
        try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* unsupported */ }
        ac = new AC();
        master = ac.createGain();
        master.gain.value = muted ? 0 : 0.7;
        const comp = ac.createDynamicsCompressor();
        master.connect(comp);
        comp.connect(ac.destination);
        noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
        const d = noise.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      // iOS Safari only unlocks once a sound actually starts inside the gesture.
      const blip = ac.createBufferSource();
      blip.buffer = ac.createBuffer(1, 1, 22050);
      blip.connect(ac.destination);
      blip.start(0);
      if (ac.state !== 'running') ac.resume().catch(() => {});
    }

    // Drop sounds when lots start at once, so a big crash doesn't clip.
    function ready() {
      if (!ac || muted || ac.state !== 'running') return false;
      const now = ac.currentTime;
      recent = recent.filter((t) => now - t < 0.05);
      if (recent.length >= 6) return false;
      recent.push(now);
      return true;
    }

    function env(g, t, peak, dur) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    }

    function burst(type, freq, q, peak, dur, delay = 0, freqEnd = 0) {
      const t = ac.currentTime + delay;
      const src = ac.createBufferSource();
      src.buffer = noise;
      src.playbackRate.value = rand(0.8, 1.2);
      const f = ac.createBiquadFilter();
      f.type = type;
      f.frequency.setValueAtTime(freq, t);
      if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
      f.Q.value = q;
      const g = ac.createGain();
      env(g, t, peak, dur);
      src.connect(f);
      f.connect(g);
      g.connect(master);
      src.start(t, rand(0, 0.5));
      src.stop(t + dur + 0.05);
    }

    function tone(type, freq, peak, dur, delay = 0, freqEnd = 0) {
      const t = ac.currentTime + delay;
      const o = ac.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
      const g = ac.createGain();
      env(g, t, peak, dur);
      o.connect(g);
      g.connect(master);
      o.start(t);
      o.stop(t + dur + 0.05);
    }

    function reset() {
      try { ac.close(); } catch (e) { /* already closed */ }
      ac = null;
    }

    // Coming back from sleep or another tab: rebuild on the next tap.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && ac) reset();
    });

    return {
      unlock,
      get muted() { return muted; },
      setMuted(m) {
        muted = m;
        try { localStorage.setItem('flippydesk.muted', m ? '1' : '0'); } catch (e) { /* storage blocked */ }
        if (master) master.gain.setTargetAtTime(m ? 0 : 0.7, ac.currentTime, 0.02);
      },
      // v is loudness 0..1; size 0..1 makes it lower and longer.
      thud(v, size) {
        if (!ready()) return;
        burst('lowpass', 300 + (1 - size) * 1800, 0.8, 0.5 * v, 0.08 + size * 0.2);
        tone('sine', 140 - size * 90, 0.6 * v * size + 0.05 * v, 0.1 + size * 0.25, 0, 40);
      },
      whoosh(strength) {
        if (!ready()) return;
        burst('bandpass', 300, 1.2, clamp(0.15 * strength, 0.05, 0.4), 0.45, 0, 1600);
      },
      crack() {
        if (!ready()) return;
        burst('highpass', 2500, 0.7, 0.5, 0.06);
        tone('square', rand(1800, 2600), 0.08, 0.04);
      },
      shatter(v = 1) {
        if (!ready()) return;
        burst('highpass', 3000, 0.5, 0.6 * v, 0.4);
        burst('bandpass', 6000, 2, 0.35 * v, 0.25, 0.03);
        for (let i = 0; i < 7; i++) tone('sine', rand(2500, 6500), 0.06 * v, rand(0.05, 0.15), rand(0.02, 0.35));
      },
      smash() {
        if (!ready()) return;
        burst('bandpass', 1800, 1.5, 0.5, 0.18);
        for (let i = 0; i < 4; i++) tone('triangle', rand(900, 2200), 0.08, rand(0.05, 0.12), rand(0, 0.15));
      },
      squeak(v) {
        if (!ready()) return;
        tone('square', 1500, 0.06 * v + 0.02, 0.09, 0, 2300);
        tone('square', 2300, 0.05 * v + 0.02, 0.12, 0.08, 1400);
      },
      meow() {
        if (!ready()) return;
        tone('sawtooth', 700, 0.05, 0.12, 0, 1100);
        tone('sawtooth', 1100, 0.05, 0.25, 0.1, 550);
        tone('sine', 1400, 0.05, 0.3, 0.05, 900);
      },
      ding(big) {
        if (!ready()) return;
        const f = big ? 1320 : 880;
        tone('sine', f, 0.09, 0.18);
        tone('sine', f * 1.5, 0.07, 0.25, 0.07);
      },
    };
  })();

  // ---------- breaking things ----------

  const DEAD_SCREEN = '#15171d';
  const GLASS = 'rgba(214,236,250,0.9)';
  const GRACE = 0.25;        // ignore the hits from the launch itself
  const MAX_SHARDS = 40;
  const POINTS = { crack: 150, screen: 500, lamp: 300, mug: 250, pot: 250 };

  function makeScreen(b, x, y, w, h) {
    b.breakable = 'screen';
    b.screen = { x, y, w, h };
    b.cracks = [];
  }

  // Record the hardest hit each breakable body took during a physics step,
  // as a change in velocity (impulse / mass), so heavy things need bigger hits.
  function onPostSolve(contact, impulse) {
    if (state !== 'flipped') return;
    const n = contact.getManifold().pointCount;
    let total = 0;
    for (let i = 0; i < n; i++) total += impulse.normalImpulses[i];
    for (const b of [contact.getFixtureA().getBody(), contact.getFixtureB().getBody()]) {
      if (!b.isDynamic()) continue;
      const dv = total / b.getMass();
      if (b.breakable && stateT >= GRACE && dv > (b.hit || 0)) b.hit = dv;
    }
  }

  // Impact sounds use how fast two things were closing when they first
  // touched. Resting and jittering contacts close at almost nothing, so they
  // stay quiet.
  function onBeginContact(contact) {
    if (state !== 'flipped') return;
    const a = contact.getFixtureA().getBody();
    const b = contact.getFixtureB().getBody();
    const wm = contact.getWorldManifold(null);
    if (!wm || !wm.points.length) return;
    const p = wm.points[0];
    const va = a.getLinearVelocityFromWorldPoint(p);
    const vb = b.getLinearVelocityFromWorldPoint(p);
    const closing = Math.abs((vb.x - va.x) * wm.normal.x + (vb.y - va.y) * wm.normal.y);
    for (const body of [a, b]) {
      if (body.isDynamic() && closing > (body.thud || 0)) body.thud = closing;
    }
  }

  // Bodies can't be created or destroyed mid-step, so breaking happens here.
  function processHits() {
    let thuds = 0;
    for (const b of bodies) {
      const t = b.thud;
      if (!t) continue;
      b.thud = 0;
      if (t < 1.8 || thuds >= 3 || clock - (b.lastThud || 0) < 0.15) continue;
      b.lastThud = clock;
      thuds++;
      if (b.kind === 'duck') sfx.squeak(Math.min(1, t / 6));
      else sfx.thud(Math.min(1, t / 8), b === desk ? 1 : clamp(b.getMass() / 0.4, 0.15, 0.8));
    }
    for (const b of bodies.slice()) {
      const dv = b.hit;
      if (!dv) continue;
      b.hit = 0;
      if (b.breakable === 'screen') hitScreen(b, dv);
      else if (b.breakable === 'lamp' && dv > 2.6) breakApart(b, 'lamp', 'lamp smashed');
      else if (b.breakable === 'mug' && dv > 4) breakApart(b, 'mug', 'mug smashed');
      else if (b.breakable === 'pot' && dv > 3.5) breakApart(b, 'pot', 'pot smashed');
    }
  }

  function breakApart(b, kind, label) {
    const c = b.getWorldCenter();
    b.shatter();
    if (kind === 'lamp') sfx.shatter(0.7); else sfx.smash();
    addPoints(POINTS[kind], label, c.x, c.y);
    shake = Math.min(1, shake + 0.2);
  }

  function hitScreen(b, dv) {
    if (b.dead || dv < 2.2) return;
    b.cracks.push(makeCrack(b.screen, dv));
    const s = b.screen;
    const c = b.getWorldPoint(V(s.x + s.w / 2, s.y + s.h / 2));
    shake = Math.min(1, shake + 0.15);
    if (b.cracks.length >= 3 || dv > 7) {
      b.dead = true;
      sfx.shatter(1);
      spawnShards(b, s.x + s.w / 2, s.y + s.h / 2, randInt(4, 7), GLASS);
      addPoints(POINTS.screen, 'screen smashed', c.x, c.y);
    } else {
      sfx.crack();
      addPoints(POINTS.crack, 'cracked', c.x, c.y);
    }
  }

  function makeCrack(s, dv) {
    const x0 = rand(s.x + s.w * 0.15, s.x + s.w * 0.85);
    const y0 = rand(s.y + s.h * 0.15, s.y + s.h * 0.85);
    const size = clamp(0.06 + dv * 0.03, 0.08, 0.35);
    const rays = [];
    const n = randInt(5, 9);
    for (let i = 0; i < n; i++) {
      let a = (i / n) * Math.PI * 2 + rand(-0.3, 0.3);
      let x = x0, y = y0;
      const pts = [[x, y]];
      const segs = randInt(3, 5);
      const step = (size * rand(0.5, 1.1)) / segs;
      for (let k = 0; k < segs; k++) {
        a += rand(-0.45, 0.45);
        x += Math.cos(a) * step;
        y += Math.sin(a) * step;
        pts.push([x, y]);
      }
      rays.push(pts);
    }
    return { x: x0, y: y0, rays, ring: rays.map((r) => r[1]) };
  }

  function drawCracks(b) {
    const s = b.screen;
    ctx.save();
    ctx.beginPath();
    ctx.rect(s.x, s.y, s.w, s.h);
    ctx.clip();
    ctx.lineCap = 'round';
    for (const c of b.cracks) {
      for (const [color, width] of [['rgba(0,0,0,0.35)', 0.01], ['rgba(255,255,255,0.9)', 0.005]]) {
        ctx.beginPath();
        for (const r of c.rays) {
          ctx.moveTo(r[0][0], r[0][1]);
          for (const p of r) ctx.lineTo(p[0], p[1]);
        }
        ctx.moveTo(c.ring[0][0], c.ring[0][1]);
        for (const p of c.ring) ctx.lineTo(p[0], p[1]);
        ctx.closePath();
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.arc(c.x, c.y, 0.012, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Small triangle bodies flung out from a point on body b (local coords).
  function spawnShards(b, lx, ly, n, color) {
    const wp = b.getWorldPoint(V(lx, ly));
    const v = b.getLinearVelocityFromWorldPoint(wp);
    for (let i = 0; i < n && shardCount < MAX_SHARDS; i++, shardCount++) {
      const s = rand(0.02, 0.045);
      const pts = [[0, -s], [s * rand(0.6, 1), s * rand(0.2, 0.8)], [-s * rand(0.6, 1), s * rand(0.2, 0.8)]];
      const sh = addBody(wp.x + rand(-0.05, 0.05), wp.y + rand(-0.05, 0.05), [{ pts }], () => poly(pts, color),
        { kind: 'shard', group: -1, density: 0.5, z: 2, angle: rand(0, 6.28) });
      sh.setLinearVelocity(V(v.x + rand(-2.5, 2.5), v.y + rand(-3.5, 0.5)));
      sh.setAngularVelocity(rand(-15, 15));
    }
    bodies.sort((a, c) => a.z - c.z);
  }

  // Replace body b with pieces that share its frame, so each piece's local
  // coordinates match the original drawing.
  function splitBody(b, pieces) {
    const pos = b.getPosition();
    const angle = b.getAngle();
    const w = b.getAngularVelocity();
    for (const pc of pieces) {
      const nb = addBody(pos.x, pos.y, pc.parts, pc.draw, Object.assign({ angle, kind: b.kind + '-piece', z: b.z }, pc.o));
      const v = b.getLinearVelocityFromWorldPoint(nb.getWorldCenter());
      nb.setLinearVelocity(V(v.x + rand(-1.2, 1.2), v.y + rand(-1.5, 0.3)));
      nb.setAngularVelocity(w + rand(-6, 6));
    }
    world.destroyBody(b);
    bodies.splice(bodies.indexOf(b), 1);
    bodies.sort((a, c) => a.z - c.z);
  }

  function spill(b, n) {
    if (!(b.coffee > 0)) return;
    const c = b.getWorldCenter();
    const v = b.getLinearVelocity();
    for (let i = 0; i < n * b.coffee; i++) {
      drops.push(Object.assign({ x: c.x, y: c.y, vx: v.x + rand(-2.5, 2.5), vy: v.y + rand(-3, 0.5), r: rand(0.008, 0.02) }, COFFEE));
    }
    b.coffee = 0;
  }

  const COFFEE = { color: '#6b3f22', stain: 'rgba(92,55,30,0.55)' };
  const DIRT = { color: '#5a3d2b', stain: 'rgba(74,50,34,0.9)' };

  function spillDirt(b, n) {
    const c = b.getWorldPoint(V(0, -0.1));
    const v = b.getLinearVelocity();
    for (let i = 0; i < n; i++) {
      drops.push(Object.assign({ x: c.x + rand(-0.06, 0.06), y: c.y + rand(-0.05, 0.05), vx: v.x + rand(-2, 2), vy: v.y + rand(-2.5, 0.5), r: rand(0.01, 0.022) }, DIRT));
    }
  }

  // ---------- score ----------

  function addPoints(n, label, x, y) {
    score += n;
    sfx.ding(n >= 500);
    popups.push({ x: clamp(x, 0.7, Wm - 0.7), y: Math.max(y, 1), text: `+${n} ${label}`, t: 0 });
    updateScore();
  }

  function deskOnFloor() {
    for (let ce = desk.getContactList(); ce; ce = ce.next) {
      const c = ce.contact;
      if (c.isTouching() && (c.getFixtureA() === floorFix || c.getFixtureB() === floorFix)) return true;
    }
    return false;
  }

  // Hang time adds up every moment the desk is fully off the floor. It is
  // scored once the desk has been back on the floor for a moment.
  function trackHang(dt) {
    if (state !== 'flipped' || landed || grab) return;
    if (!deskOnFloor()) {
      // Resting on top of other stuff doesn't count as hanging.
      if (desk.getLinearVelocity().length() > 0.5) hang += dt;
      groundT = 0;
    } else if (hang > 0 && (groundT += dt) > 0.6) {
      awardHang();
    }
  }

  function awardHang() {
    if (landed) return;
    landed = true;
    const p = desk.getWorldCenter();
    if (hang > 0.05) addPoints(Math.round(hang * 100) * 10, `hang time ${hang.toFixed(2)}s`, p.x, p.y - 0.4);
  }

  function updateScore() {
    if (state === 'ready' || state === 'fadein') {
      scoreEl.classList.remove('show');
    } else {
      scoreEl.classList.add('show');
      scoreNumEl.textContent = score.toLocaleString();
      hangEl.textContent = `hang time ${hang.toFixed(2)}s`;
    }
    countEl.textContent = [
      state === 'ready' && score ? `last ${score.toLocaleString()}` : '',
      best ? `best ${best.toLocaleString()}` : '',
      flips ? `${flips} flipped` : '',
    ].filter(Boolean).join(' · ');
  }

  function finishRound() {
    awardHang();
    if (score > best) {
      best = score;
      try { localStorage.setItem('flippydesk.best', String(best)); } catch (e) { /* storage blocked */ }
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
        drops.push(Object.assign({ x: mouth.x, y: mouth.y, vx: v.x + rand(-0.8, 0.8), vy: v.y + rand(-0.8, 0.8), r: rand(0.008, 0.018) }, COFFEE));
      }
      b.coffee -= 0.012;
    }
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.vy += GRAVITY * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      if (d.y >= floorY) {
        if (d.x > 0 && d.x < Wm) stains.push({ x: d.x, r: d.r * rand(1.5, 3), color: d.stain });
        drops.splice(i, 1);
      }
    }

    const speed = desk.getLinearVelocity().length();
    const jolt = lastDeskSpeed - speed;
    if (jolt > 2.5) shake = Math.min(1, shake + jolt * 0.08);
    lastDeskSpeed = speed;

    trackHang(dt);

    // On narrow screens the desk can end up standing on end, leaning on a
    // wall. If it sits there, tip its top back toward the middle.
    const c = desk.getWorldCenter();
    const leaning = Math.abs(Math.sin(desk.getAngle())) > 0.35 && Math.min(c.x, Wm - c.x) < 0.75;
    pinnedT = state === 'flipped' && stateT > 1 && leaning && speed < 0.8 ? pinnedT + dt : 0;
    if (pinnedT > 0.3) {
      const toward = c.x < cx ? 1 : -1;
      desk.applyForce(V(toward * desk.getMass() * 14, 0), V(c.x, c.y - 0.8), true);
    }
  }

  // ---------- main loop ----------

  let acc = 0;
  let last = performance.now();

  function update(dt) {
    clock += dt;
    acc += dt;
    while (acc >= STEP) {
      world.step(STEP, 8, 3);
      processHits();
      stepExtras(STEP);
      acc -= STEP;
    }
    updateCats(dt);
    updateBoss(dt);
    for (const p of popups) p.t += dt;
    popups = popups.filter((p) => p.t < 1.4);
    if (state === 'flipped' && !landed) hangEl.textContent = `hang time ${hang.toFixed(2)}s`;
    shake = Math.max(0, shake - dt * 2.5);
    stateT += dt;

    if (state === 'ready') {
      idleT += dt;
    } else if (state === 'flipped') {
      if (grab) heldUntil = stateT;
      const since = stateT - heldUntil;
      if (since > RESET_AFTER) {
        let moving = false;
        for (const b of bodies) if (b.getLinearVelocity().length() > 1.2) { moving = true; break; }
        if (!moving || since > RESET_MAX) { state = 'fadeout'; stateT = 0; finishRound(); }
      }
    } else if (state === 'fadeout') {
      fade = Math.min(1, stateT / FADE);
      if (fade >= 1) { buildScene(); state = 'fadein'; stateT = 0; updateScore(); }
    } else if (state === 'fadein') {
      fade = Math.max(0, 1 - stateT / FADE);
      if (fade <= 0) { state = 'ready'; stateT = 0; idleT = 0; updateScore(); }
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

    // coffee stains and spilled dirt
    for (const s of stains) {
      ctx.fillStyle = s.color;
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
    drawBoss();

    for (const b of bodies) {
      const p = b.getPosition();
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(b.getAngle());
      b.draw();
      if (b.cracks && b.cracks.length) drawCracks(b);
      ctx.restore();
    }
    for (const c of cats) drawCat(c);
    drawBossBubble();

    ctx.font = 'bold 0.075px ui-rounded, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 0.018;
    ctx.strokeStyle = INK;
    ctx.fillStyle = '#ffd84d';
    for (const p of popups) {
      ctx.globalAlpha = Math.min(1, (1.4 - p.t) * 2.5);
      const y = p.y - 0.15 - p.t * 0.35;
      ctx.strokeText(p.text, p.x, y);
      ctx.fillText(p.text, p.x, y);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'start';

    for (const d of drops) {
      ctx.fillStyle = d.color;
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

  // ---------- input ----------

  let swipe = null;

  function deskTopPx() {
    return (floorY - DESK_H) * ppm;
  }

  // Track the fastest upward speed seen during the swipe (px per ms, over a
  // short window), and flip once the finger has travelled far enough or lifts.
  function trackSwipe(e) {
    const now = performance.now();
    swipe.pts.push([e.clientX, e.clientY, now]);
    while (swipe.pts.length > 2 && now - swipe.pts[0][2] > 60) swipe.pts.shift();
    const [px, py, pt] = swipe.pts[0];
    const ms = Math.max(25, now - pt);
    const vy = (py - e.clientY) / ms;
    swipe.vyNow = vy;
    if (vy > swipe.peak) {
      swipe.peak = vy;
      swipe.vx = (e.clientX - px) / ms;
    }
  }

  function tryFlip(e, minDist) {
    if (!swipe) return;
    trackSwipe(e);
    if (swipe.y0 - e.clientY < minDist) return;
    // ~0.5 px/ms is a slow drag, ~2 a normal swipe, 5+ a hard flick.
    const strength = clamp(0.2 + swipe.peak * 0.45, 0.3, 2.6);
    const deskX = swipe.x0 / ppm - cx;
    const side = Math.abs(deskX) > 0.15 ? Math.sign(deskX) : (chance(0.5) ? 1 : -1);
    flip(strength, side, clamp(swipe.vx / 2, -1, 1));
    swipe = null;
  }

  canvas.addEventListener('pointerdown', (e) => {
    sfx.unlock();
    if (state !== 'ready') return;
    if (e.clientY < deskTopPx() - 30) return;  // swipes start at the desk, not above it
    swipe = { x0: e.clientX, y0: e.clientY, t0: performance.now(), peak: 0, vyNow: 0, vx: 0, pts: [[e.clientX, e.clientY, performance.now()]] };
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!swipe) return;
    if (grab) {
      trackSwipe(e);
      moveTilt(e.clientX, e.clientY);
      // A flick while holding the desk throws it.
      if (swipe.vyNow > 2.5) {
        releaseTilt();
        launch(clamp(0.2 + swipe.vyNow * 0.45, 0.3, 2.6), Math.sign(grabOffset.x + e.clientX / ppm - cx) || 1, 0);
        swipe = null;
      }
      return;
    }
    tryFlip(e, 110);
    if (!swipe) return;
    // Slow and steady for a moment means tilt rather than flip.
    const held = performance.now() - swipe.t0;
    if (held > 180 && swipe.y0 - e.clientY > 12 && swipe.peak < 0.8 && state === 'ready') {
      startTilt(e.clientX, e.clientY);
    }
  });
  canvas.addEventListener('pointerup', (e) => {
    if (grab) releaseTilt();
    else tryFlip(e, 25);
    swipe = null;
  });
  canvas.addEventListener('pointercancel', () => { releaseTilt(); swipe = null; });
  window.addEventListener('keydown', (e) => {
    sfx.unlock();
    if (e.code === 'Space' || e.code === 'ArrowUp') {
      e.preventDefault();
      flip(rand(1, 1.8), chance(0.5) ? 1 : -1, rand(-0.4, 0.4));
    }
  });

  function showMute() {
    muteEl.textContent = sfx.muted ? '🔇' : '🔊';
    muteEl.setAttribute('aria-pressed', String(sfx.muted));
  }
  // Older iOS only counts touchend and click as gestures that can start audio.
  for (const type of ['touchend', 'click', 'pointerup']) {
    window.addEventListener(type, sfx.unlock, { passive: true });
  }
  muteEl.addEventListener('click', () => {
    sfx.unlock();
    sfx.setMuted(!sfx.muted);
    showMute();
  });
  showMute();

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 150);
  });

  // Expose a tiny hook for automated testing.
  window.flippyDesk = {
    flip: (s = 1.2) => flip(s, 1, 0),
    get state() { return state; },
    get score() { return score; },
    get hang() { return hang; },
    get bodies() { return bodies.length; },
  };

  resize();
  updateScore();
  requestAnimationFrame(frame);
})();
