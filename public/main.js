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
  const toastEl = document.getElementById('toast');
  const unlockEl = document.getElementById('unlock');

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
  let world, desk, bodies, drops, stains, armJoints = [];
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

  const GLASS_TOP = { top: 'rgba(190,225,240,0.6)', side: '#c9ccd3', grain: 'rgba(255,255,255,0.5)' };

  function buildDesk() {
    const style = pick(['legs', 'pedestal', 'pedestal', 'double', 'trestle', 'standing']);
    const glassy = style !== 'pedestal' && style !== 'double' && chance(0.25);
    const wood = glassy ? GLASS_TOP : pick(WOODS);
    const metal = pick(['#3b3a44', '#c9ccd3', '#2f3340']);
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
    // Trestle: crossed legs at each end joined by a stretcher.
    const trestles = style === 'trestle' ? [-half + 0.2, half - 0.2] : [];
    const xLegs = [];
    for (const x of trestles) {
      for (const a of [-0.32, 0.32]) xLegs.push({ x, y: -legH / 2, w: 0.06, h: legH * 1.04, a });
    }
    // Standing desk: a column and a wide foot at each end.
    const columns = style === 'standing' ? [-half + 0.28, half - 0.28] : [];
    for (const p of xLegs) parts.push(p);
    if (trestles.length) parts.push(R(-half + 0.2, -legH * 0.5, DESK_W - 0.4, 0.04));
    for (const x of columns) parts.push(R(x - 0.045, -legH, 0.09, legH), R(x - 0.26, -0.045, 0.52, 0.045));
    for (const x of legs) parts.push(R(x, -legH, 0.07, legH));
    for (const x of peds) parts.push(R(x, -legH, 0.45, legH));
    const legColor = glassy ? metal : wood.side;
    const drawers = peds.map(() => randInt(2, 3));
    const slots = [];
    peds.forEach((x, i) => {
      const dh = (legH - 0.06) / drawers[i];
      for (let k = 0; k < drawers[i]; k++) slots.push({ x: x + 0.03, y: -legH + 0.03 + k * dh, w: 0.39, h: dh - 0.025, out: false });
    });
    const drawDrawer = (d) => {
      rrect(d.x, d.y, d.w, d.h, 0.012, wood.top);
      rrect(d.x + 0.14, d.y + d.h / 2 - 0.0125, 0.11, 0.025, 0.012, handle);
    };
    const handle = pick(['#d8b25a', '#c9ccd3', INK]);

    desk = addBody(cx, floorY, parts, () => {
      if (trestles.length) rrect(-half + 0.2, -legH * 0.5, DESK_W - 0.4, 0.04, 0.01, legColor);
      for (const p of xLegs) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.a);
        rrect(-p.w / 2, -p.h / 2, p.w, p.h, 0.012, legColor);
        ctx.restore();
      }
      for (const x of columns) {
        rrect(x - 0.035, -legH - 0.01, 0.07, legH * 0.55, 0.008, metal);
        rrect(x - 0.045, -legH * 0.5, 0.09, legH * 0.5, 0.008, metal);
        rrect(x - 0.26, -0.045, 0.52, 0.045, 0.02, metal);
      }
      for (const x of legs) rrect(x, -legH - 0.01, 0.07, legH + 0.01, 0.01, legColor);
      peds.forEach((x, i) => {
        rrect(x, -legH - 0.01, 0.45, legH + 0.01, 0.01, wood.side);
      });
      for (const d of slots) {
        if (d.out) rrect(d.x, d.y, d.w, d.h, 0.012, 'rgba(20,18,26,0.75)');
        else drawDrawer(d);
      }
      rrect(-half, top, DESK_W, DESK_TOP_T, 0.015, wood.top);
      ctx.save();
      ctx.beginPath();
      ctx.rect(-half, top, DESK_W, DESK_TOP_T);
      ctx.clip();
      line(-half + 0.1, top + 0.025, half - 0.6, top + 0.025, wood.grain, 0.008);
      line(-half + 0.5, top + 0.045, half - 0.1, top + 0.045, wood.grain, 0.008);
      ctx.restore();
      if (columns.length) {
        // the up/down buttons
        rrect(half - 0.42, top + DESK_TOP_T, 0.14, 0.04, 0.01, '#2a2733');
        ellipse(half - 0.385, top + DESK_TOP_T + 0.02, 0.01, 0.01, '#7cc58f', false);
        ellipse(half - 0.325, top + DESK_TOP_T + 0.02, 0.01, 0.01, '#e66b6b', false);
      }
      for (const c of desk.splits) {
        ctx.beginPath();
        ctx.moveTo(c[0][0], c[0][1]);
        for (const pt of c) ctx.lineTo(pt[0], pt[1]);
        ctx.strokeStyle = 'rgba(20,18,26,0.8)';
        ctx.lineWidth = 0.009;
        ctx.stroke();
      }
    }, { kind: 'desk', density: 3, friction: 0.7, restitution: 0.1, z: -1 });
    desk.breakable = 'desk';
    desk.splits = [];
    // Pops one drawer out of the desk as its own body.
    desk.popDrawer = () => {
      const d = pick(slots.filter((x) => !x.out));
      if (!d) return false;
      d.out = true;
      const pos = desk.getPosition();
      const nb = addBody(pos.x, pos.y, [R(d.x, d.y, d.w, d.h)], () => drawDrawer(d), { angle: desk.getAngle(), kind: 'drawer', density: 0.8 });
      const c = nb.getWorldCenter();
      const v = desk.getLinearVelocityFromWorldPoint(c);
      nb.setLinearVelocity(V(v.x + rand(-2, 2), v.y + rand(-3, -1)));
      nb.setAngularVelocity(rand(-6, 6));
      // Desk drawer junk: paperclips, rubber bands, a lost pen cap.
      for (let i = 0; i < 12; i++) {
        drops.push(Object.assign({ x: c.x, y: c.y, vx: v.x + rand(-2, 2), vy: v.y + rand(-3, 0), r: rand(0.006, 0.012) }, pick([CLIP, BAND])));
      }
      return true;
    };
    // A zigzag crack through the desktop at a random spot.
    desk.addCrack = () => {
      let x = rand(-half + 0.15, half - 0.15);
      const pts = [[x, top]];
      for (let y = top; y < top + DESK_TOP_T; ) {
        y = Math.min(top + DESK_TOP_T, y + rand(0.012, 0.025));
        x += rand(-0.02, 0.02);
        pts.push([x, y]);
      }
      desk.splits.push(pts);
    };
  }

  // ---------- desk items ----------
  // Each factory returns { w, place(x, y) } where (x, y) is the bottom
  // center of the item's footprint on the desktop.

  // A screen face with its wallpaper, drawn into the rectangle (x, y, w, h).
  function screenFace(b, x, y, w, h, hue, lines) {
    if (b.dead) return rrect(x, y, w, h, 0.012, DEAD_SCREEN, false);
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, hsl(hue, 70, 64));
    g.addColorStop(1, hsl(hue + 50, 70, 46));
    rrect(x, y, w, h, 0.012, g, false);
    const k = h / 0.32;
    rrect(x + 0.05 * k, y + 0.04 * k, Math.min(0.32 * k, w * 0.6), 0.23 * k, 0.012, 'rgba(255,255,255,0.88)', false);
    lines.forEach(([a, c], i) => line(x + 0.07 * k + a * k, y + 0.07 * k + i * 0.033 * k, x + 0.07 * k + (a + c * 0.8) * k, y + 0.07 * k + i * 0.033 * k, hsl(hue + i * 40, 55, 50), 0.012 * k));
    ellipse(x + w - 0.12 * k, y + h - 0.1 * k, 0.035 * k, 0.035 * k, 'rgba(255,255,255,0.35)', false);
  }

  const screenLines = () => Array.from({ length: 6 }, () => [rand(0, 0.06), rand(0.06, 0.22)]);

  // A monitor on a stand. sw and sh are the screen size; widescreens are wider.
  function monitor(sw = 0.58, sh = 0.32) {
    const hue = rand(0, 360);
    const lines = screenLines();
    const fw = sw + 0.04, fh = sh + 0.06;
    const top = -0.16 - fh;
    return {
      w: fw,
      place(x, y) {
        const b = addBody(x, y, [R(-0.13, -0.03, 0.26, 0.03), R(-0.025, -0.17, 0.05, 0.14), R(-fw / 2, top, fw, fh)], () => {
          rrect(-0.025, -0.19, 0.05, 0.17, 0.005, '#5b6170');
          rrect(-0.13, -0.03, 0.26, 0.03, 0.012, '#4a4f5c');
          rrect(-fw / 2, top, fw, fh, 0.025, '#2f3340');
          screenFace(b, -sw / 2, top + 0.02, sw, sh, hue, lines);
        }, { kind: 'computer' });
        makeScreen(b, -sw / 2, top + 0.02, sw, sh);
      },
    };
  }

  const widescreen = () => monitor(0.86, 0.32);

  // One or two screens floating on arms from a pole clamped to the back of
  // the desk, with the keyboard tucked underneath. The clamp and each arm
  // hold until a hard enough yank snaps them.
  function armSetup(count) {
    const sw = count === 1 ? pick([0.58, 0.82]) : 0.5;
    const fw = sw + 0.04, fh = 0.38;
    const gap = 0.04;
    const span = count * fw + (count - 1) * gap;
    const screens = Array.from({ length: count }, () => ({ hue: rand(0, 360), lines: screenLines() }));
    const kb = keyboard();
    const ms = mouse();
    const poleH = 0.62;
    return {
      w: span + 0.1,
      place(x, y) {
        const left = x - (span + 0.1) / 2;
        const px = left + 0.04;
        const py = y - poleH;
        const pole = addBody(px, y, [R(-0.04, -0.05, 0.08, 0.05), R(-0.016, -poleH, 0.032, poleH - 0.05)], () => {
          rrect(-0.016, -poleH - 0.01, 0.032, poleH - 0.04, 0.01, '#9aa0aa');
          rrect(-0.04, -0.05, 0.08, 0.05, 0.01, '#5b6170');
          ellipse(0, -poleH, 0.022, 0.022, '#5b6170');
        }, { kind: 'arm', group: -2, density: 1.5, z: -0.5 });
        const clamp = world.createJoint(pl.WeldJoint({ frequencyHz: 0 }, desk, pole, V(px, y)));
        armJoints.push({ j: clamp, limit: 140, label: 'clamp gave way' });
        screens.forEach((sc, i) => {
          const cx0 = 0.06 + fw / 2 + i * (fw + gap);   // screen center, relative to the pole
          const cy0 = 0.1;
          const b = addBody(px, py, [R(cx0 - fw / 2, cy0 - fh / 2, fw, fh)], () => {
            line(0, 0, cx0 * 0.5, -0.06, INK, 0.05);
            line(cx0 * 0.5, -0.06, cx0, cy0, INK, 0.05);
            line(0, 0, cx0 * 0.5, -0.06, '#9aa0aa', 0.03);
            line(cx0 * 0.5, -0.06, cx0, cy0, '#9aa0aa', 0.03);
            ellipse(cx0 * 0.5, -0.06, 0.018, 0.018, '#5b6170');
            rrect(cx0 - fw / 2, cy0 - fh / 2, fw, fh, 0.025, '#2f3340');
            screenFace(b, cx0 - sw / 2, cy0 - fh / 2 + 0.03, sw, fh - 0.06, sc.hue, sc.lines);
          }, { kind: 'computer', group: -2 });
          makeScreen(b, cx0 - sw / 2, cy0 - fh / 2 + 0.03, sw, fh - 0.06);
          const j = world.createJoint(pl.RevoluteJoint({
            enableLimit: true, lowerAngle: -0.35, upperAngle: 0.35,
            enableMotor: true, motorSpeed: 0, maxMotorTorque: 8,
          }, pole, b, V(px, py)));
          armJoints.push({ j, limit: 75, label: 'monitor snapped off' });
        });
        kb.place(x + 0.05 - (span > 0.9 ? 0.12 : 0), y);
        ms.place(x + 0.05 + kb.w / 2 + 0.08 - (span > 0.9 ? 0.12 : 0), y);
      },
    };
  }

  // Snap any arm or clamp that took more force than it can hold.
  function checkArms(dt) {
    if (state !== 'flipped') return;
    for (const a of armJoints) {
      if (a.broken) continue;
      const f = a.j.getReactionForce(1 / dt).length();
      a.max = Math.max(a.max || 0, f);
      if (f < a.limit) continue;
      a.broken = true;
      const p = a.j.getAnchorB();
      world.destroyJoint(a.j);
      sfx.crack();
      addPoints(200, a.label, p.x, p.y);
    }
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
    const brand = chance(0.4) ? pick(BRANDS) : null;
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
          if (brand) label(brand.name, 0, -0.075, 0.022, brand.color === color ? '#fff' : brand.color);
          else if (stripe) rrect(-0.07, -0.11, 0.14, 0.025, 0, 'rgba(255,255,255,0.55)', false);
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

  // ---------- work swag ----------
  // Merch from companies that don't exist. Most of it unlocks as you flip.

  const BRANDS = [
    { name: 'SYNERGEX', color: '#6b8fe6' },
    { name: 'Cloudloaf', color: '#f08a4b' },
    { name: 'PIVOTLY', color: '#7cc58f' },
    { name: 'Q-Bagel', color: '#b48be0' },
    { name: 'HYPERLINQ', color: '#e66b6b' },
    { name: 'Blockchair', color: '#4fb3bf' },
    { name: 'Dataduck', color: '#f2c14e' },
  ];

  function label(text, x, y, size, color, weight = 800) {
    ctx.font = `${weight} ${size}px ui-rounded, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.textAlign = 'start';
  }

  function stressBall() {
    const brand = pick(BRANDS);
    return {
      w: 0.12,
      place(x, y) {
        addBody(x, y, [{ x: 0, y: -0.05, r: 0.05 }], () => {
          ellipse(0, -0.05, 0.05, 0.05, brand.color);
          ellipse(-0.017, -0.068, 0.015, 0.01, 'rgba(255,255,255,0.45)', false);
          label(brand.name.slice(0, 4), 0, -0.04, 0.022, '#fff');
        }, { kind: 'ball', restitution: 0.75, density: 0.4 });
      },
    };
  }

  function waterBottle() {
    const brand = pick(BRANDS);
    return {
      w: 0.09,
      place(x, y) {
        const b = addBody(x, y, [R(-0.035, -0.25, 0.07, 0.25)], () => {
          rrect(-0.025, -0.28, 0.05, 0.04, 0.01, INK);
          rrect(-0.035, -0.25, 0.07, 0.25, 0.025, brand.color);
          rrect(-0.035, -0.16, 0.07, 0.06, 0, '#fff', false);
          ctx.save();
          ctx.translate(0.004, -0.13);
          ctx.rotate(-Math.PI / 2);
          label(brand.name, 0, 0.004, 0.018, brand.color);
          ctx.restore();
        }, { kind: 'bottle', density: 0.6 });
        b.spun = 0;
        b.stillT = 0;
      },
    };
  }

  function patentAward() {
    const no = `No. 11,${randInt(100, 999)},${randInt(100, 999)}`;
    const title = pick(['Method for Synergy', 'Recursive Meeting', 'Cloud-Based Stapler', 'Agile Toaster', 'Self-Scheduling Sync']);
    const block = R(-0.085, -0.2, 0.17, 0.2);
    const draw = (part) => {
      ctx.save();
      if (part) {
        ctx.beginPath();
        ctx.rect(part < 0 ? -0.1 : 0.005, -0.25, 0.1, 0.3);
        ctx.clip();
      }
      rrect(-0.085, -0.2, 0.17, 0.2, 0.012, 'rgba(205,232,250,0.65)');
      ellipse(0, -0.15, 0.025, 0.025, '#e0b84a');
      label('U.S. PATENT', 0, -0.098, 0.017, INK);
      label(no, 0, -0.075, 0.014, INK, 600);
      label(title, 0, -0.05, 0.012, INK, 600);
      line(-0.06, -0.03, 0.06, -0.03, 'rgba(42,39,51,0.35)', 0.004);
      ellipse(-0.06, -0.17, 0.012, 0.03, 'rgba(255,255,255,0.5)', false);
      ctx.restore();
    };
    return {
      w: 0.19,
      place(x, y) {
        const b = addBody(x, y, [block], () => draw(0), { kind: 'acrylic', density: 1.6 });
        b.breakable = 'acrylic';
        b.shatter = () => {
          spawnShards(b, 0, -0.1, 4, 'rgba(205,232,250,0.8)');
          splitBody(b, [
            { parts: [R(-0.085, -0.2, 0.085, 0.2)], draw: () => draw(-1) },
            { parts: [R(0, -0.2, 0.085, 0.2)], draw: () => draw(1) },
          ]);
        };
      },
    };
  }

  function snowGlobe() {
    const brand = pick(BRANDS);
    const flakes = Array.from({ length: 12 }, () => [rand(-0.06, 0.06), rand(-0.19, -0.07)]);
    return {
      w: 0.18,
      place(x, y) {
        const drawBase = () => {
          rrect(-0.075, -0.045, 0.15, 0.045, 0.012, '#8a5a3b');
          label(brand.name, 0, -0.016, 0.017, '#f2e2c4');
        };
        const b = addBody(x, y, [R(-0.075, -0.045, 0.15, 0.045), { x: 0, y: -0.125, r: 0.085 }], () => {
          ellipse(0, -0.125, 0.085, 0.085, 'rgba(205,232,250,0.55)');
          rrect(-0.03, -0.1, 0.06, 0.05, 0.01, brand.color);
          poly([[-0.035, -0.1], [0, -0.13], [0.035, -0.1]], brand.color);
          ctx.fillStyle = '#fff';
          for (const [fx, fy] of flakes) {
            ctx.beginPath();
            ctx.arc(fx, fy + Math.sin(clock + fx * 40) * 0.006, 0.005, 0, Math.PI * 2);
            ctx.fill();
          }
          ellipse(-0.035, -0.16, 0.015, 0.025, 'rgba(255,255,255,0.6)', false);
          drawBase();
        }, { kind: 'snowglobe' });
        b.breakable = 'snowglobe';
        b.shatter = () => {
          const c = b.getWorldPoint(V(0, -0.125));
          const v = b.getLinearVelocity();
          for (let i = 0; i < 30; i++) {
            const kind = i % 3 ? WATER : SNOW;
            drops.push(Object.assign({ x: c.x, y: c.y, vx: v.x + rand(-2.5, 2.5), vy: v.y + rand(-3, 0.5), r: rand(0.006, 0.016) }, kind));
          }
          spawnShards(b, 0, -0.125, 5, 'rgba(205,232,250,0.85)');
          splitBody(b, [{ parts: [R(-0.075, -0.045, 0.15, 0.045)], draw: drawBase }]);
        };
      },
    };
  }

  function monolith() {
    const brand = pick(BRANDS);
    const years = pick([5, 10, 15, 20]);
    return {
      w: 0.15,
      place(x, y) {
        addBody(x, y, [R(-0.06, -0.36, 0.12, 0.36)], () => {
          rrect(-0.06, -0.36, 0.12, 0.36, 0.008, '#1d1c22');
          poly([[-0.06, -0.36], [-0.02, -0.36], [-0.06, -0.2]], 'rgba(255,255,255,0.08)', false);
          label(String(years), 0, -0.22, 0.075, '#e0b84a');
          label('YEARS', 0, -0.185, 0.02, '#e0b84a');
          label(brand.name, 0, -0.06, 0.016, '#e0b84a', 600);
        }, { kind: 'monolith', density: 3, restitution: 0.05 });
      },
    };
  }

  function trophy() {
    return {
      w: 0.17,
      place(x, y) {
        addBody(x, y, [R(-0.07, -0.05, 0.14, 0.05), R(-0.015, -0.12, 0.03, 0.07), { pts: [[-0.08, -0.26], [0.08, -0.26], [0.04, -0.12], [-0.04, -0.12]] }], () => {
          rrect(-0.07, -0.05, 0.14, 0.05, 0.008, '#3b3a44');
          label('DESK FLIPPER', 0, -0.02, 0.013, '#e0b84a');
          rrect(-0.015, -0.13, 0.03, 0.08, 0.005, '#e0b84a');
          for (const sx of [-1, 1]) {
            ctx.beginPath();
            ctx.ellipse(sx * 0.075, -0.21, 0.03, 0.035, 0, 0, Math.PI * 2);
            ctx.lineWidth = 0.022;
            ctx.strokeStyle = INK;
            ctx.stroke();
            ctx.lineWidth = 0.01;
            ctx.strokeStyle = '#e0b84a';
            ctx.stroke();
          }
          poly([[-0.08, -0.26], [0.08, -0.26], [0.04, -0.12], [-0.04, -0.12]], '#f2c94e');
          label('★', 0, -0.18, 0.05, '#fff6c8');
        }, { kind: 'trophy', density: 2 });
      },
    };
  }

  function confBadge() {
    const brand = pick(BRANDS);
    const role = pick(['SPEAKER', 'VIP', 'ATTENDEE', 'STAFF', 'THOUGHT LEADER']);
    return {
      w: 0.12,
      place(x, y) {
        addBody(x, y, [R(-0.05, -0.13, 0.1, 0.13)], () => {
          ctx.beginPath();
          ctx.moveTo(-0.03, -0.13);
          ctx.lineTo(-0.045, -0.2);
          ctx.lineTo(0.045, -0.2);
          ctx.lineTo(0.03, -0.13);
          ctx.strokeStyle = brand.color;
          ctx.lineWidth = 0.012;
          ctx.stroke();
          rrect(-0.05, -0.13, 0.1, 0.13, 0.01, '#ffffff');
          rrect(-0.05, -0.13, 0.1, 0.035, 0.01, brand.color, false);
          label(brand.name, 0, -0.103, 0.014, '#fff');
          label('HELLO', 0, -0.07, 0.013, INK, 600);
          label(role, 0, -0.03, role.length > 8 ? 0.009 : 0.014, brand.color);
        }, { kind: 'badge', density: 0.3 });
      },
    };
  }

  function fidgetSpinner() {
    const brand = pick(BRANDS);
    const lobes = [0, 1, 2].map((i) => [Math.cos(i * 2.094 - 1.571) * 0.045, Math.sin(i * 2.094 - 1.571) * 0.045 - 0.055]);
    return {
      w: 0.13,
      place(x, y) {
        const b = addBody(x, y, [{ x: 0, y: -0.055, r: 0.025 }].concat(lobes.map(([lx, ly]) => ({ x: lx, y: ly, r: 0.025 }))), () => {
          for (const [lx, ly] of lobes) line(0, -0.055, lx, ly, INK, 0.03);
          for (const [lx, ly] of lobes) line(0, -0.055, lx, ly, brand.color, 0.018);
          for (const [lx, ly] of lobes) {
            ellipse(lx, ly, 0.025, 0.025, brand.color);
            ellipse(lx, ly, 0.012, 0.012, '#c9ccd3');
          }
          ellipse(0, -0.055, 0.022, 0.022, '#e0b84a');
        }, { kind: 'spinner', density: 0.8, restitution: 0.3 });
        b.setAngularDamping(0.01);
      },
    };
  }

  function decisionBall() {
    const answers = ['CIRCLE BACK', 'TAKE IT OFFLINE', 'ASK IN Q3', 'SYNERGY SAYS YES', 'PARK IT', 'LET’S ALIGN', 'NEW PROCESS'];
    let answer = pick(answers);
    return {
      w: 0.13,
      place(x, y) {
        let b;
        b = addBody(x, y, [{ x: 0, y: -0.06, r: 0.06 }], () => {
          ellipse(0, -0.06, 0.06, 0.06, '#1d1c22');
          ellipse(-0.02, -0.085, 0.015, 0.01, 'rgba(255,255,255,0.3)', false);
          const spinning = Math.abs(b.getAngularVelocity()) > 1.5;
          if (spinning && !b.shaken) { b.shaken = true; }
          if (!spinning && b.shaken) { b.shaken = false; answer = pick(answers); }
          // the answer window stays upright so it can be read
          ctx.save();
          ctx.translate(0, -0.06);
          ctx.rotate(-b.getAngle());
          poly([[-0.04, -0.025], [0.04, -0.025], [0, 0.04]], '#3d5fd6', false);
          const words = spinning ? ['...'] : answer.split(' ');
          words.forEach((w, i) => label(w, 0, -0.012 + i * 0.012 - (words.length - 1) * 0.004, 0.0095, '#dce6ff'));
          ctx.restore();
        }, { kind: 'ball', density: 0.9, restitution: 0.35 });
      },
    };
  }

  function plaque() {
    const month = pick(['JANUARY', 'MARCH', 'MAY', 'JULY', 'SEPTEMBER', 'NOVEMBER', 'Q4 (AGAIN)']);
    const hue = rand(0, 360);
    return {
      w: 0.18,
      place(x, y) {
        addBody(x, y, [R(-0.08, -0.22, 0.16, 0.22)], () => {
          rrect(-0.08, -0.22, 0.16, 0.22, 0.012, '#8a5a3b');
          rrect(-0.065, -0.205, 0.13, 0.11, 0.006, '#e0b84a');
          ellipse(0, -0.16, 0.022, 0.022, hsl(hue, 45, 70));
          rrect(-0.035, -0.14, 0.07, 0.04, 0.02, hsl(hue + 180, 40, 50), false);
          label('EMPLOYEE', 0, -0.07, 0.015, '#f2e2c4');
          label('OF THE MONTH', 0, -0.05, 0.012, '#f2e2c4');
          label(month, 0, -0.025, 0.011, '#e0b84a', 600);
        }, { kind: 'plaque', density: 1.4 });
      },
    };
  }

  function lavaLamp() {
    const brand = pick(BRANDS);
    const goo = brand.color;
    const blobs = Array.from({ length: 4 }, (_, i) => [rand(-0.01, 0.01), rand(0.01, 0.02), rand(0, 6.28), 0.3 + i * 0.15]);
    const drawBase = () => {
      poly([[-0.03, -0.07], [0.03, -0.07], [0.055, 0], [-0.055, 0]], '#9aa0aa');
      label(brand.name.slice(0, 6), 0, -0.02, 0.012, '#fff');
    };
    return {
      w: 0.12,
      place(x, y) {
        const b = addBody(x, y, [{ pts: [[-0.03, -0.07], [0.03, -0.07], [0.055, 0], [-0.055, 0]] }, R(-0.035, -0.26, 0.07, 0.19)], () => {
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(-0.025, -0.07);
          ctx.lineTo(-0.04, -0.17);
          ctx.lineTo(-0.02, -0.25);
          ctx.lineTo(0.02, -0.25);
          ctx.lineTo(0.04, -0.17);
          ctx.lineTo(0.025, -0.07);
          ctx.closePath();
          finish('rgba(255,180,200,0.45)', true);
          ctx.clip();
          for (const [bx, r, ph, sp] of blobs) {
            const by = -0.16 + Math.sin(clock * sp + ph) * 0.07;
            ellipse(bx, by, r * 1.1, r * 1.4, goo, false);
          }
          ctx.restore();
          poly([[-0.02, -0.25], [0.02, -0.25], [0.012, -0.28], [-0.012, -0.28]], '#9aa0aa');
          drawBase();
        }, { kind: 'lava', density: 0.8 });
        b.breakable = 'lava';
        b.shatter = () => {
          const c = b.getWorldPoint(V(0, -0.17));
          const v = b.getLinearVelocity();
          const GOO = { color: goo, stain: goo };
          for (let i = 0; i < 18; i++) {
            drops.push(Object.assign({ x: c.x, y: c.y, vx: v.x + rand(-2, 2), vy: v.y + rand(-2.5, 0.5), r: rand(0.01, 0.022) }, GOO));
          }
          spawnShards(b, 0, -0.17, 4, 'rgba(255,200,215,0.8)');
          splitBody(b, [{ parts: [{ pts: [[-0.03, -0.07], [0.03, -0.07], [0.055, 0], [-0.055, 0]] }], draw: drawBase }]);
        };
      },
    };
  }

  function zenGarden() {
    const rocks = [[rand(-0.06, -0.02), rand(0.012, 0.018)], [rand(0.02, 0.06), rand(0.008, 0.014)]];
    return {
      w: 0.22,
      place(x, y) {
        let b;
        b = addBody(x, y, [R(-0.1, -0.045, 0.2, 0.045)], () => {
          rrect(-0.1, -0.045, 0.2, 0.045, 0.006, '#8a5a3b');
          if (b.sand) {
            rrect(-0.088, -0.04, 0.176, 0.02, 0.004, '#e8d7a8', false);
            for (let i = 0; i < 3; i++) line(-0.08, -0.034 + i * 0.006, 0.08, -0.034 + i * 0.006, 'rgba(160,130,80,0.5)', 0.002);
            for (const [rx, r] of rocks) ellipse(rx, -0.04 - r * 0.5, r * 1.3, r, '#7d7a85');
          }
          line(0.06, -0.045, 0.1, -0.11, '#c8915a', 0.008);
          line(0.05, -0.05, 0.07, -0.045, '#c8915a', 0.012);
        }, { kind: 'zen', density: 1.6 });
        b.sand = true;
        b.breakable = 'zen';
      },
    };
  }

  function salesGong() {
    const brand = pick(BRANDS);
    return {
      w: 0.2,
      place(x, y) {
        addBody(x, y, [R(-0.09, -0.24, 0.02, 0.24), R(0.07, -0.24, 0.02, 0.24), R(-0.09, -0.26, 0.18, 0.025), R(-0.1, -0.02, 0.2, 0.02)], () => {
          rrect(-0.1, -0.02, 0.2, 0.02, 0.004, '#5b3a2a');
          rrect(-0.09, -0.24, 0.02, 0.23, 0.004, '#8a3d2a');
          rrect(0.07, -0.24, 0.02, 0.23, 0.004, '#8a3d2a');
          rrect(-0.1, -0.265, 0.2, 0.03, 0.006, '#8a3d2a');
          line(-0.03, -0.235, -0.03, -0.21, INK, 0.004);
          line(0.03, -0.235, 0.03, -0.21, INK, 0.004);
          const sw = Math.sin(clock * 3) * 0.004;
          ellipse(sw, -0.14, 0.065, 0.065, '#e0b84a');
          ellipse(sw, -0.14, 0.035, 0.035, '#f2c94e', false);
          label('CLOSE', sw, -0.145, 0.014, '#8a5a3b');
          label('IT!', sw, -0.128, 0.014, '#8a5a3b');
          label(brand.name, 0, -0.005, 0.011, '#f2e2c4');
        }, { kind: 'gong', density: 1.2 });
      },
    };
  }

  function bobblehead() {
    const brand = pick(BRANDS);
    const skin = pick(['#f2c9a5', '#c98d62', '#8d5a3b', '#f5d3b8']);
    const hair = pick(['#2e2230', '#8a8f99', '#c96b3c', '#e0b84a']);
    return {
      w: 0.11,
      place(x, y) {
        let b;
        b = addBody(x, y, [R(-0.045, -0.03, 0.09, 0.03), R(-0.03, -0.11, 0.06, 0.08), { x: 0, y: -0.15, r: 0.045 }], () => {
          rrect(-0.045, -0.03, 0.09, 0.03, 0.005, '#1d1c22');
          label('CEO', 0, -0.009, 0.012, '#e0b84a');
          rrect(-0.03, -0.11, 0.06, 0.08, 0.012, '#3d4a6b');
          poly([[-0.006, -0.11], [0.006, -0.11], [0.008, -0.07], [-0.008, -0.07]], brand.color, false);
          b.bob = (b.bob || 0) * 0.985;
          const wob = Math.sin(clock * 22) * b.bob;
          ctx.save();
          ctx.translate(0, -0.11);
          ctx.rotate(wob * 0.5);
          ellipse(0, -0.045, 0.05, 0.048, skin);
          ctx.beginPath();
          ctx.ellipse(0, -0.055, 0.051, 0.045, 0, Math.PI, Math.PI * 2);
          ctx.fillStyle = hair;
          ctx.fill();
          ellipse(-0.017, -0.045, 0.006, 0.006, INK, false);
          ellipse(0.017, -0.045, 0.006, 0.006, INK, false);
          ctx.beginPath();
          ctx.arc(0, -0.035, 0.022, 0.15 * Math.PI, 0.85 * Math.PI);
          ctx.lineWidth = 0.005;
          ctx.strokeStyle = INK;
          ctx.stroke();
          ctx.restore();
        }, { kind: 'bobble', density: 1 });
        b.bob = 0.4;
      },
    };
  }

  function plushMascot() {
    const brand = pick(BRANDS);
    return {
      w: 0.17,
      place(x, y) {
        addBody(x, y, [R(-0.075, -0.09, 0.15, 0.09)], () => {
          rrect(-0.075, -0.09, 0.15, 0.09, 0.03, '#f0c27a');
          ctx.beginPath();
          for (const sx of [-0.045, 0, 0.045]) ctx.ellipse(sx, -0.09, 0.03, 0.022, 0, Math.PI, Math.PI * 2);
          ctx.fillStyle = '#d99c52';
          ctx.fill();
          ellipse(-0.028, -0.05, 0.007, 0.009, INK, false);
          ellipse(0.028, -0.05, 0.007, 0.009, INK, false);
          ellipse(-0.045, -0.035, 0.012, 0.007, 'rgba(230,107,107,0.5)', false);
          ellipse(0.045, -0.035, 0.012, 0.007, 'rgba(230,107,107,0.5)', false);
          ctx.beginPath();
          ctx.arc(0, -0.042, 0.012, 0.1 * Math.PI, 0.9 * Math.PI);
          ctx.lineWidth = 0.005;
          ctx.strokeStyle = INK;
          ctx.stroke();
          rrect(-0.04, -0.018, 0.08, 0.014, 0.005, brand.color, false);
          label(brand.name, 0, -0.007, 0.0095, '#fff');
        }, { kind: 'plush', density: 0.25, restitution: 0.6, friction: 0.9 });
      },
    };
  }

  function goldStapler() {
    return {
      w: 0.17,
      place(x, y) {
        addBody(x, y, [R(-0.08, -0.025, 0.16, 0.025), R(-0.075, -0.055, 0.15, 0.03)], () => {
          rrect(-0.08, -0.025, 0.16, 0.025, 0.008, '#b8912f');
          rrect(-0.075, -0.058, 0.15, 0.034, 0.014, '#f2c94e');
          ellipse(-0.04, -0.048, 0.025, 0.006, 'rgba(255,255,255,0.55)', false);
          label('FOUNDER', 0.015, -0.034, 0.01, '#8a6a20');
        }, { kind: 'stapler', density: 3 });
      },
    };
  }

  // Swag unlocks as the flip count grows; each new item is guaranteed a spot
  // on the next desk.
  const UNLOCKS = [
    { at: 2, name: 'Conference badge', make: confBadge },
    { at: 3, name: 'Stress ball', make: stressBall },
    { at: 4, name: 'Fidget spinner', make: fidgetSpinner },
    { at: 6, name: 'Branded water bottle', make: waterBottle },
    { at: 8, name: 'Decision ball', make: decisionBall },
    { at: 10, name: 'Patent award', make: patentAward },
    { at: 12, name: 'Employee of the Month', make: plaque },
    { at: 15, name: 'Snow globe', make: snowGlobe },
    { at: 18, name: 'Lava lamp', make: lavaLamp },
    { at: 21, name: 'Zen garden', make: zenGarden },
    { at: 25, name: 'Anniversary monolith', make: monolith },
    { at: 30, name: 'Sales gong', make: salesGong },
    { at: 35, name: 'CEO bobblehead', make: bobblehead },
    { at: 40, name: 'Desk Flipper trophy', make: trophy },
    { at: 50, name: 'Mascot plush', make: plushMascot },
    { at: 60, name: 'Founder’s gold stapler', make: goldStapler },
  ];
  let freshUnlock = null;

  function unlockedSwag() {
    return UNLOCKS.filter((u) => flips >= u.at).map((u) => u.make);
  }

  function nextUnlock() {
    return UNLOCKS.find((u) => flips < u.at);
  }

  function checkUnlock() {
    const u = UNLOCKS.find((x) => x.at === flips);
    if (!u) return;
    freshUnlock = u;
    toastEl.textContent = `Unlocked: ${u.name}`;
    toastEl.classList.remove('show');
    void toastEl.offsetWidth;
    toastEl.classList.add('show');
    sfx.ding(true);
  }

  const COMPUTERS = [
    () => [monitor(), keyboard(), mouse()],
    () => [monitor(), keyboard(), mouse()],
    () => [widescreen(), keyboard(), mouse()],
    () => [monitor(0.5), monitor(0.5), keyboard(), mouse()],
    () => [armSetup(1)],
    () => [armSetup(2)],
    () => [armSetup(2)],
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
    const swag = unlockedSwag();
    // Early on, double up the few unlocked items so they show up often.
    const pool = EXTRAS.concat(swag, swag.length < 6 ? swag : []);
    for (const make of shuffle(pool).slice(0, randInt(1, 4))) extras.push(make());
    shuffle(extras);
    if (kitty) extras.unshift(kitty);  // the fit below drops from the end
    if (freshUnlock) {
      extras.unshift(freshUnlock.make());
      freshUnlock = null;
    }

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
    confetti = [];
    grab = null;
    armJoints = [];
    world.on('post-solve', onPostSolve);
    world.on('begin-contact', onBeginContact);

    ground = world.createBody();
    floorFix = ground.createFixture(pl.Box(Wm, 1, V(Wm / 2, floorY + 1)), { friction: 0.8 });
    // Frictionless side walls so things slide down them instead of sticking.
    ground.createFixture(pl.Box(0.5, 20, V(-0.5, floorY - 19)), { friction: 0 });
    ground.createFixture(pl.Box(0.5, 20, V(Wm + 0.5, floorY - 19)), { friction: 0 });

    pickRoom();
    buildDesk();
    buildItems();
    placeDog();
    schedulePal();
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
  // ---------- dog ----------
  // Sometimes a dog naps on the floor by the desk. Anything crashing down
  // nearby (the desk most of all) sends it yelping off the side of the screen.

  const DOG_COATS = [
    { fur: '#c8915a', dark: '#8a5a3b' },
    { fur: '#f4f4f6', dark: '#3b3a44' },
    { fur: '#3b3a44', dark: '#1d1c22' },
    { fur: '#e0b84a', dark: '#b8912f' },
  ];
  let dog = null;

  function placeDog() {
    dog = chance(0.4) ? {
      x: clamp(cx + rand(-0.9, 0.9), 0.4, Wm - 0.4),
      dir: chance(0.5) ? 1 : -1,
      coat: pick(DOG_COATS),
      mode: 'sleep',
      t: 0,
    } : null;
  }

  function updateDog(dt) {
    if (!dog) return;
    dog.t += dt;
    if (dog.mode === 'sleep' && state === 'flipped' && stateT > GRACE) {
      let scared = deskOnFloor() && Math.abs(desk.getPosition().x - dog.x) < 1.6;
      for (const b of bodies) {
        if (scared) break;
        const p = b.getPosition();
        scared = Math.abs(p.x - dog.x) < 0.45 && p.y > floorY - 0.35 && b.getLinearVelocity().length() > 1.5;
      }
      if (scared) {
        Object.assign(dog, { mode: 'startled', t: 0 });
        // run away from the desk
        dog.dir = dog.x < desk.getPosition().x ? -1 : 1;
        sfx.bark();
        addPoints(150, 'dog spooked', dog.x, floorY - 0.4);
      }
    } else if (dog.mode === 'startled' && dog.t > 0.45) {
      Object.assign(dog, { mode: 'run', t: 0 });
    } else if (dog.mode === 'run') {
      dog.x += dog.dir * Math.min(4.5, 1 + dog.t * 8) * dt;
      if (dog.x < -0.6 || dog.x > Wm + 0.6) dog.mode = 'gone';
    }
  }

  function drawDog() {
    if (!dog || dog.mode === 'gone') return;
    const { fur, dark } = dog.coat;
    ctx.save();
    ctx.translate(dog.x, floorY);
    ctx.scale(dog.dir, 1);
    if (dog.mode === 'sleep') {
      const breathe = Math.sin(clock * 2) * 0.006;
      ellipse(-0.02, -0.075, 0.2, 0.075 + breathe, fur);
      ellipse(-0.08, -0.09, 0.07, 0.04, dark, false);
      line(-0.2, -0.03, -0.29, -0.02, INK, 0.035);
      line(-0.2, -0.03, -0.29, -0.02, fur, 0.02);
      rrect(0.08, -0.03, 0.17, 0.03, 0.015, fur);
      ellipse(0.17, -0.07, 0.08, 0.06, fur);
      ellipse(0.24, -0.06, 0.035, 0.028, fur);
      ellipse(0.27, -0.065, 0.013, 0.011, INK, false);
      ellipse(0.13, -0.075, 0.03, 0.05, dark);
      line(0.17, -0.08, 0.2, -0.08, INK, 0.006);
      ctx.restore();
      ctx.save();
      ctx.font = 'bold 0.06px ui-rounded, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(42,39,51,0.55)';
      for (let i = 0; i < 3; i++) {
        const k = (clock * 0.4 + i / 3) % 1;
        ctx.globalAlpha = Math.sin(k * Math.PI);
        ctx.fillText('z', dog.x + dog.dir * (0.18 + k * 0.1), floorY - 0.16 - k * 0.18);
      }
      ctx.restore();
      return;
    }
    const run = dog.mode === 'run';
    const ph = run ? dog.t * 22 : 0;
    const hop = run ? Math.abs(Math.sin(ph)) * 0.04 : 0.03;
    ctx.translate(0, -hop);
    // legs
    const leg = (x, a) => {
      const sw = run ? Math.sin(ph + a) * 0.07 : 0;
      line(x, -0.13, x + sw, -0.01, INK, 0.04);
      line(x, -0.13, x + sw, -0.01, fur, 0.024);
    };
    leg(-0.13, 0);
    leg(0.12, Math.PI);
    // tail straight up in alarm, streaming back when running
    const tx = run ? -0.32 : -0.24, ty = run ? -0.2 : -0.36;
    line(-0.19, -0.2, tx, ty, INK, 0.035);
    line(-0.19, -0.2, tx, ty, fur, 0.02);
    ellipse(0, -0.19, 0.2, 0.08, fur);
    ellipse(-0.07, -0.21, 0.07, 0.045, dark, false);
    leg(-0.09, Math.PI);
    leg(0.16, 0);
    // head
    ellipse(0.2, -0.29, 0.08, 0.07, fur);
    ellipse(0.27, -0.275, 0.045, 0.032, fur);
    ellipse(0.31, -0.285, 0.014, 0.012, INK, false);
    const flap = run ? Math.sin(ph) * 0.3 : -0.6;
    ctx.save();
    ctx.translate(0.17, -0.33);
    ctx.rotate(flap);
    ellipse(-0.02, 0.04, 0.025, 0.055, dark);
    ctx.restore();
    ellipse(0.22, -0.305, 0.014, 0.017, '#ffffff');
    ellipse(0.225, -0.305, 0.007, 0.009, INK, false);
    if (dog.mode === 'startled') {
      ctx.font = 'bold 0.11px ui-rounded, system-ui, sans-serif';
      ctx.fillStyle = INK;
      ctx.fillText('!', 0.2, -0.4);
    }
    ctx.restore();
  }

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
  // Two managers share the job; each visit is one or the other.
  const BOSS_LOOKS = [
    { pitch: 1, shirt: '#cfe0f5', legs: '#4a4f5c', accent: '#e66b6b', skin: '#f2c9a5', hair: '#8a8f99', she: false },
    { pitch: 1.7, shirt: '#3d4a6b', legs: '#3d4a6b', accent: '#f2c14e', skin: '#c98d62', hair: '#2e2230', she: true },
    { pitch: 1.6, shirt: '#8a3d55', legs: '#2f2c38', accent: '#e8e2d6', skin: '#f5d3b8', hair: '#c96b3c', she: true },
  ];
  const boss = { mode: 'away', t: 0, slide: 0, line: '', look: BOSS_LOOKS[0] };

  function updateBoss(dt) {
    boss.t += dt;
    if (boss.mode === 'away' && state === 'ready' && idleT > BOSS_IDLE) {
      Object.assign(boss, { mode: 'in', t: 0, line: pick(BOSS_LINES), said: false, talkT: 0, look: pick(BOSS_LOOKS) });
    }
    if (boss.mode === 'in') {
      const was = boss.slide;
      boss.slide = Math.min(1, boss.slide + dt * 2);
      if (was < 1 && boss.slide === 1) boss.talkT = 0;
      if (boss.slide === 1 && (boss.talkT += dt) > 0 && !boss.said) {
        boss.said = true;
        sfx.mumble(boss.line.split(' ').length, boss.look.pitch);
      }
      if (boss.talkT > 5) {
        boss.line = pick(BOSS_LINES.filter((l) => l !== boss.line));
        boss.talkT = 0;
        boss.said = false;
      }
    }
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

  // ---------- chatty coworker ----------
  // Once in a while a long-haired coworker leans in from the left with their
  // phone and won't stop talking. Flipping the desk is the only way out.

  const PAL_LINES = [
    'Hey! Got a minute? Okay so my podcast...',
    'Wanna see 400 photos of my sourdough?',
    'So I’ve been getting really into crypto.',
    'Is this your stapler? It’s mine now.',
    'Have you tried standing meetings? Like, standing ON the desk?',
    'Quick question. Not a question. A story.',
    'My cousin says desks are a scam, actually.',
    'Did you get my 14 reply-alls?',
  ];
  const PAL_LOOKS = [
    { hair: '#6b3f22', hoodie: '#7cc58f', skin: '#f2c9a5', pants: '#4a4f5c' },
    { hair: '#e0b84a', hoodie: '#b48be0', skin: '#f5d3b8', pants: '#3d4a6b' },
    { hair: '#1d1c22', hoodie: '#f08a4b', skin: '#8d5a3b', pants: '#2f2c38' },
  ];
  const pal = { mode: 'away', slide: 0, due: Infinity, line: '', talkT: 0, look: PAL_LOOKS[0] };

  // Called for each new desk: rarely, the coworker is coming.
  function schedulePal() {
    pal.due = chance(0.12) ? rand(1.5, 3) : Infinity;
  }

  function updatePal(dt) {
    if (pal.mode === 'away' && state === 'ready' && idleT > pal.due) {
      pal.due = Infinity;
      Object.assign(pal, { mode: 'in', line: pick(PAL_LINES), talkT: -0.4, said: false, look: pick(PAL_LOOKS) });
    }
    if (pal.mode === 'in') {
      pal.slide = Math.min(1, pal.slide + dt * 1.6);
      pal.talkT += dt;
      if (pal.talkT > 0 && !pal.said) {
        pal.said = true;
        sfx.mumble(Math.min(12, pal.line.split(' ').length + 3), 1.3);
      }
      if (pal.talkT > 3.6) {
        pal.line = pick(PAL_LINES.filter((l) => l !== pal.line));
        pal.talkT = 0;
        pal.said = false;
      }
      if (state !== 'ready') {
        if (pal.slide > 0.6) addPoints(400, 'coworker shooed', 0.6, floorY - 1.3);
        pal.mode = 'flee';
      } else if (boss.mode === 'in') {
        pal.mode = 'flee';  // even they avoid the boss
      }
    }
    if (pal.mode === 'flee') {
      pal.slide = Math.max(0, pal.slide - dt * 4);
      if (pal.slide === 0) pal.mode = 'away';
    }
  }

  function drawPal() {
    if (pal.slide <= 0) return;
    const e = 1 - Math.pow(1 - pal.slide, 3);
    const x = -0.45 + e * 0.8;
    const L = pal.look;
    const bob = pal.mode === 'in' ? Math.sin(clock * 9) * 0.008 : -0.05;
    ctx.save();
    ctx.translate(x, floorY + bob);
    // hair hangs down the back, behind everything
    rrect(-0.17, -1.62, 0.22, 0.5, 0.09, L.hair);
    // legs and sneakers
    rrect(-0.12, -0.78, 0.11, 0.76, 0.02, L.pants);
    rrect(0.02, -0.78, 0.11, 0.76, 0.02, L.pants);
    rrect(-0.14, -0.05, 0.15, 0.05, 0.025, '#f4f4f6');
    rrect(0.0, -0.05, 0.15, 0.05, 0.025, '#f4f4f6');
    // hoodie with pocket and strings
    rrect(-0.19, -1.36, 0.38, 0.62, 0.09, L.hoodie);
    rrect(-0.11, -0.98, 0.22, 0.12, 0.03, 'rgba(0,0,0,0.12)', false);
    line(-0.03, -1.33, -0.035, -1.2, '#f4f4f6', 0.01);
    line(0.03, -1.33, 0.035, -1.2, '#f4f4f6', 0.01);
    // arm holding up a phone toward you
    rrect(0.16, -1.3, 0.1, 0.3, 0.05, L.hoodie);
    rrect(0.18, -1.08, 0.22, 0.09, 0.045, L.hoodie);
    rrect(0.36, -1.2, 0.08, 0.15, 0.015, '#1d1c22');
    rrect(0.37, -1.19, 0.06, 0.12, 0.008, pal.talkT % 0.8 < 0.4 ? '#f2c14e' : '#6b8fe6', false);
    ellipse(0.39, -1.05, 0.03, 0.025, L.skin);
    // head: big grin, eyebrows up
    ellipse(0, -1.5, 0.13, 0.15, L.skin);
    ctx.beginPath();
    ctx.ellipse(-0.01, -1.56, 0.14, 0.12, 0, Math.PI * 0.95, Math.PI * 2.05);
    ctx.fillStyle = L.hair;
    ctx.fill();
    rrect(-0.15, -1.58, 0.07, 0.3, 0.035, L.hair, false);
    ellipse(0.02, -1.52, 0.01, 0.012, INK, false);
    ellipse(0.075, -1.52, 0.01, 0.012, INK, false);
    line(0.0, -1.565, 0.035, -1.575, INK, 0.007);
    line(0.06, -1.575, 0.095, -1.565, INK, 0.007);
    ctx.beginPath();
    const open = pal.mode === 'in' && Math.sin(clock * 14) > 0;
    if (open) ctx.ellipse(0.05, -1.44, 0.035, 0.022, 0, 0, Math.PI * 2);
    else ctx.arc(0.05, -1.46, 0.04, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.lineWidth = 0.01;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.restore();
  }

  function drawPalBubble() {
    if (pal.mode !== 'in' || pal.slide < 1) return;
    ctx.save();
    ctx.font = '600 0.07px ui-rounded, system-ui, sans-serif';
    const maxW = Math.min(1.5, Wm - 0.6);
    const lines = [''];
    for (const w of pal.line.split(' ')) {
      const next = lines[lines.length - 1] ? lines[lines.length - 1] + ' ' + w : w;
      if (ctx.measureText(next).width > maxW && lines[lines.length - 1]) lines.push(w);
      else lines[lines.length - 1] = next;
    }
    const lh = 0.085;
    const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 0.12;
    const bh = lines.length * lh + 0.08;
    const bx = 0.55;
    const by = floorY - 1.66 - bh;
    poly([[bx + 0.04, by + bh - 0.01], [bx + 0.16, by + bh - 0.01], [bx - 0.04, by + bh + 0.1]], '#ffffff');
    rrect(bx, by, bw, bh, 0.05, '#ffffff');
    ctx.fillStyle = INK;
    lines.forEach((l, i) => ctx.fillText(l, bx + 0.06, by + 0.04 + (i + 0.8) * lh));
    ctx.restore();
  }

  function drawBoss() {
    if (boss.slide <= 0) return;
    const e = 1 - Math.pow(1 - boss.slide, 3);
    const x = Wm + 0.45 - e * 0.85;
    const y = floorY;
    const jolt = boss.mode === 'flee' ? -0.05 : 0;
    ctx.save();
    ctx.translate(x, y + jolt);
    const L = boss.look;
    // legs and shoes
    if (L.she) {
      rrect(-0.12, -0.5, 0.09, 0.48, 0.02, L.skin);
      rrect(0.03, -0.5, 0.09, 0.48, 0.02, L.skin);
      rrect(-0.15, -0.04, 0.13, 0.04, 0.02, INK);
      rrect(0.01, -0.04, 0.13, 0.04, 0.02, INK);
      poly([[-0.19, -0.86], [0.19, -0.86], [0.22, -0.46], [-0.22, -0.46]], L.legs);
    } else {
      rrect(-0.14, -0.8, 0.12, 0.78, 0.02, L.legs);
      rrect(0.02, -0.8, 0.12, 0.78, 0.02, L.legs);
      rrect(-0.17, -0.04, 0.15, 0.04, 0.02, INK);
      rrect(0.0, -0.04, 0.15, 0.04, 0.02, INK);
    }
    // top: shirt and tie, or blazer over a blouse with a lanyard
    rrect(-0.2, -1.38, 0.4, 0.62, 0.08, L.shirt);
    if (L.she) {
      poly([[-0.07, -1.37], [0.07, -1.37], [0, -1.15]], L.accent);
      line(-0.07, -1.37, -0.02, -1.0, '#4fb3bf', 0.012);
      line(0.07, -1.37, 0.02, -1.0, '#4fb3bf', 0.012);
      rrect(-0.04, -1.02, 0.08, 0.1, 0.01, '#ffffff');
    } else {
      rrect(-0.2, -0.82, 0.4, 0.05, 0.01, '#5b3a2a');
      poly([[-0.03, -1.35], [0.03, -1.35], [0.045, -0.95], [0, -0.9], [-0.045, -0.95]], L.accent);
    }
    // arm holding a mug
    rrect(-0.3, -1.32, 0.1, 0.42, 0.05, L.shirt);
    rrect(-0.38, -1.05, 0.16, 0.08, 0.04, L.shirt);
    rrect(-0.47, -1.1, 0.11, 0.13, 0.015, '#f4f4f6');
    ctx.save();
    ctx.font = 'bold 0.03px ui-rounded, system-ui, sans-serif';
    ctx.fillStyle = '#e66b6b';
    ctx.fillText(L.she ? 'CEO' : '#1', -0.45, -1.03);
    ctx.restore();
    // head
    if (L.she) {
      // bob with a bun on top, earrings
      ellipse(0, -1.5, 0.165, 0.18, L.hair);
      ellipse(0.03, -1.7, 0.06, 0.05, L.hair);
      rrect(-0.165, -1.5, 0.33, 0.13, 0.04, L.hair, false);
      ellipse(0, -1.49, 0.12, 0.145, L.skin);
      ctx.beginPath();
      ctx.ellipse(0, -1.55, 0.13, 0.1, 0, Math.PI, Math.PI * 2);
      ctx.fillStyle = L.hair;
      ctx.fill();
      ellipse(-0.125, -1.44, 0.014, 0.014, L.accent);
      ellipse(0.125, -1.44, 0.014, 0.014, L.accent);
      line(-0.075, -1.55, -0.03, -1.56, INK, 0.008);
      line(0.03, -1.56, 0.075, -1.55, INK, 0.008);
      ellipse(-0.05, -1.51, 0.01, 0.01, INK, false);
      ellipse(0.05, -1.51, 0.01, 0.01, INK, false);
    } else {
      // thinning hair, glasses, polite smile
      ellipse(0, -1.5, 0.13, 0.15, L.skin);
      for (const [a0, a1] of [[0.82, 1.12], [-0.12, 0.18]]) {
        ctx.beginPath();
        ctx.ellipse(0, -1.52, 0.135, 0.14, 0, Math.PI * a0, Math.PI * a1);
        ctx.lineWidth = 0.04;
        ctx.lineCap = 'round';
        ctx.strokeStyle = L.hair;
        ctx.stroke();
      }
      ellipse(-0.05, -1.52, 0.035, 0.03, 'rgba(255,255,255,0.4)');
      ellipse(0.05, -1.52, 0.035, 0.03, 'rgba(255,255,255,0.4)');
      line(-0.015, -1.52, 0.015, -1.52, INK, 0.008);
      ellipse(-0.05, -1.52, 0.008, 0.008, INK, false);
      ellipse(0.05, -1.52, 0.008, 0.008, INK, false);
    }
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
    checkUnlock();
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
      // A context that is still starting up queues sounds and plays them
      // once it runs, so the first flip isn't silent.
      if (!ac || muted || ac.state === 'closed') return false;
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
      // Muted-trombone "wah wah" mumbling, one syllable per word.
      mumble(words, pitch = 1) {
        if (!ready()) return;
        let t = ac.currentTime + 0.02;
        for (let i = 0; i < words; i++) {
          const dur = rand(0.12, 0.22);
          const f0 = rand(150, 230) * pitch * (i === words - 1 ? 0.8 : 1);
          const o = ac.createOscillator();
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(f0, t);
          o.frequency.linearRampToValueAtTime(f0 * rand(0.85, 1.1), t + dur);
          const f = ac.createBiquadFilter();
          f.type = 'lowpass';
          f.Q.value = 6;
          f.frequency.setValueAtTime(350, t);
          f.frequency.linearRampToValueAtTime(1300, t + dur * 0.35);
          f.frequency.linearRampToValueAtTime(450, t + dur);
          const g = ac.createGain();
          env(g, t, 0.22, dur);
          o.connect(f);
          f.connect(g);
          g.connect(master);
          o.start(t);
          o.stop(t + dur + 0.05);
          t += dur + rand(0.03, 0.09);
        }
      },
      fanfare() {
        if (!ready()) return;
        const notes = [[523, 0, 0.12], [659, 0.12, 0.12], [784, 0.24, 0.12], [1047, 0.36, 0.5]];
        for (const [f, d, len] of notes) {
          tone('square', f, 0.07, len, d);
          tone('sawtooth', f / 2, 0.04, len, d);
        }
        burst('highpass', 4000, 0.5, 0.12, 0.6, 0.36);
      },
      squeak(v) {
        if (!ready()) return;
        tone('square', 1500, 0.06 * v + 0.02, 0.09, 0, 2300);
        tone('square', 2300, 0.05 * v + 0.02, 0.12, 0.08, 1400);
      },
      // "Mee-ow": a rising then falling voice through a sweeping filter.
      meow() {
        if (!ready()) return;
        const t = ac.currentTime + 0.02;
        const o = ac.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(520, t);
        o.frequency.linearRampToValueAtTime(780, t + 0.12);
        o.frequency.linearRampToValueAtTime(720, t + 0.3);
        o.frequency.linearRampToValueAtTime(430, t + 0.55);
        const f = ac.createBiquadFilter();
        f.type = 'bandpass';
        f.Q.value = 3;
        f.frequency.setValueAtTime(900, t);
        f.frequency.linearRampToValueAtTime(2200, t + 0.15);
        f.frequency.linearRampToValueAtTime(800, t + 0.55);
        const g = ac.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.35, t + 0.06);
        g.gain.setValueAtTime(0.35, t + 0.35);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
        o.connect(f);
        f.connect(g);
        g.connect(master);
        o.start(t);
        o.stop(t + 0.65);
      },
      gong(v) {
        if (!ready()) return;
        const p = 0.08 + 0.17 * v;
        tone('sine', 140, p, 2.4);
        tone('sine', 223, p * 0.6, 1.9);
        tone('triangle', 377, p * 0.3, 1.3);
        tone('sine', 512, p * 0.2, 0.9);
        burst('lowpass', 900, 1, p * 0.6, 0.15);
      },
      // Two quick startled yips.
      bark() {
        if (!ready()) return;
        for (const d of [0, 0.17]) {
          const t = ac.currentTime + 0.02 + d;
          const o = ac.createOscillator();
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(420, t);
          o.frequency.exponentialRampToValueAtTime(230, t + 0.11);
          const f = ac.createBiquadFilter();
          f.type = 'bandpass';
          f.Q.value = 2;
          f.frequency.setValueAtTime(1100, t);
          const g = ac.createGain();
          env(g, t, 0.35, 0.13);
          o.connect(f);
          f.connect(g);
          g.connect(master);
          o.start(t);
          o.stop(t + 0.18);
        }
        burst('bandpass', 1500, 1.5, 0.12, 0.08);
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
  const POINTS = { crack: 150, screen: 500, lamp: 300, mug: 250, pot: 250, acrylic: 400, snowglobe: 350, lava: 350 };

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
      if (b.kind === 'bobble') b.bob = Math.min(1.2, (b.bob || 0) + t / 6);
      if (b.kind === 'duck') sfx.squeak(Math.min(1, t / 6));
      else if (b.kind === 'gong') {
        sfx.gong(Math.min(1, t / 6));
        if (!b.rung && t > 3) {
          b.rung = true;
          const c = b.getWorldCenter();
          addPoints(200, 'deal closed!', c.x, c.y);
        }
      }
      else sfx.thud(Math.min(1, t / 8), b === desk ? 1 : clamp(b.getMass() / 0.4, 0.15, 0.8));
    }
    for (const b of bodies.slice()) {
      const dv = b.hit;
      if (!dv) continue;
      b.hit = 0;
      if (b.breakable === 'screen') hitScreen(b, dv);
      else if (b.breakable === 'lamp' && dv > 2.6) breakApart(b, 'lamp', 'lamp smashed');
      else if (b.breakable === 'mug' && dv > 4) breakApart(b, 'mug', 'mug smashed');
      else if (b.breakable === 'desk') hitDesk(b, dv);
      else if (b.breakable === 'pot' && dv > 3.5) breakApart(b, 'pot', 'pot smashed');
      else if (b.breakable === 'acrylic' && dv > 4) breakApart(b, 'acrylic', 'patent revoked');
      else if (b.breakable === 'snowglobe' && dv > 3) breakApart(b, 'snowglobe', 'snow globe smashed');
      else if (b.breakable === 'lava' && dv > 3) breakApart(b, 'lava', 'lava lamp popped');
      else if (b.breakable === 'zen' && dv > 3 && b.sand) spillSand(b);
    }
  }

  function spillSand(b) {
    b.sand = false;
    const c = b.getWorldPoint(V(0, -0.04));
    const v = b.getLinearVelocity();
    for (let i = 0; i < 24; i++) {
      drops.push(Object.assign({ x: c.x + rand(-0.08, 0.08), y: c.y, vx: v.x + rand(-1.5, 1.5), vy: v.y + rand(-2.5, 0), r: rand(0.006, 0.014) }, SAND));
    }
    addPoints(150, 'zen disturbed', c.x, c.y);
  }

  function breakApart(b, kind, label) {
    const c = b.getWorldCenter();
    b.shatter();
    if (kind === 'lamp' || kind === 'snowglobe' || kind === 'acrylic' || kind === 'lava') sfx.shatter(0.7); else sfx.smash();
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

  function hitDesk(d, dv) {
    if (dv < 3) return;
    const c = d.getWorldCenter();
    if (d.popDrawer()) {
      sfx.thud(0.8, 0.5);
      addPoints(100, 'drawer popped', c.x, c.y);
    }
    if (dv > 4.5 && d.splits.length < 3) {
      d.addCrack();
      sfx.crack();
      addPoints(200, 'desk cracked', c.x, c.y - 0.3);
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
  const WATER = { color: 'rgba(120,190,240,0.9)', stain: 'rgba(120,190,240,0.4)' };
  const SNOW = { color: '#ffffff', stain: 'rgba(255,255,255,0.85)' };
  const CLIP = { color: '#c9ccd3', stain: 'rgba(201,204,211,0.9)' };
  const BAND = { color: '#e66b6b', stain: 'rgba(230,107,107,0.8)' };
  const SAND = { color: '#e8d7a8', stain: 'rgba(232,215,168,0.9)' };

  function spillDirt(b, n) {
    const c = b.getWorldPoint(V(0, -0.1));
    const v = b.getLinearVelocity();
    for (let i = 0; i < n; i++) {
      drops.push(Object.assign({ x: c.x + rand(-0.06, 0.06), y: c.y + rand(-0.05, 0.05), vx: v.x + rand(-2, 2), vy: v.y + rand(-2.5, 0.5), r: rand(0.01, 0.022) }, DIRT));
    }
  }

  // ---------- bottle flip ----------
  // A water bottle that spins at least once and comes to rest standing up
  // gets the full celebration.

  let confetti = [];

  function trackBottles(dt) {
    if (state !== 'flipped') return;
    for (const b of bodies) {
      if (b.kind !== 'bottle' || b.celebrated) continue;
      b.spun += Math.abs(b.getAngularVelocity()) * dt;
      const a = b.getAngle();
      const upright = Math.cos(a) > 0.97;
      const still = b.getLinearVelocity().length() < 0.15 && Math.abs(b.getAngularVelocity()) < 0.3;
      b.stillT = upright && still ? b.stillT + dt : 0;
      if (b.spun > 5 && b.stillT > 0.4) {
        b.celebrated = true;
        celebrate(b);
      }
    }
  }

  function celebrate(b) {
    const p = b.getWorldPoint(V(0, -0.25));
    sfx.fanfare();
    addPoints(1000, 'BOTTLE FLIP!', p.x, p.y - 0.1);
    toastEl.textContent = 'Bottle flip!';
    toastEl.classList.remove('show');
    void toastEl.offsetWidth;
    toastEl.classList.add('show');
    const colors = ['#e66b6b', '#f2c14e', '#6b8fe6', '#7cc58f', '#b48be0', '#f08a4b'];
    for (let i = 0; i < 70; i++) {
      const ang = -Math.PI / 2 + rand(-0.9, 0.9);
      const sp = rand(2.5, 6);
      confetti.push({ x: p.x, y: p.y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, a: rand(0, 6.28), spin: rand(-12, 12), c: pick(colors) });
    }
    // Give the reset a moment so you can enjoy it.
    heldUntil = Math.max(heldUntil, stateT - RESET_AFTER + 2.5);
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
    const next = nextUnlock();
    unlockEl.textContent = next && state === 'ready' ? `next swag in ${next.at - flips} flip${next.at - flips === 1 ? '' : 's'}` : '';
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
    checkArms(dt);
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
    trackBottles(dt);
    for (let i = confetti.length - 1; i >= 0; i--) {
      const c = confetti[i];
      c.vy += GRAVITY * 0.25 * dt;
      c.vx *= 0.99;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.a += c.spin * dt;
      if (c.y > floorY + 0.02) confetti.splice(i, 1);
    }

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
    updateDog(dt);
    updateBoss(dt);
    updatePal(dt);
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

  // ---------- rooms ----------
  // Every so often the desk turns up somewhere new. Each room draws its own
  // wall, floor and decorations; `ink` is for the corner text on top of it.

  function drawWindow(wx, wy, ww, wh, frame, night) {
    rrect(wx - 0.04, wy - 0.04, ww + 0.08, wh + 0.08, 0.02, frame);
    const sky = ctx.createLinearGradient(0, wy, 0, wy + wh);
    sky.addColorStop(0, night ? '#141a33' : '#8fcff0');
    sky.addColorStop(1, night ? '#2c3666' : '#d3eefa');
    rrect(wx, wy, ww, wh, 0.01, sky);
    ctx.save();
    ctx.beginPath();
    ctx.rect(wx, wy, ww, wh);
    ctx.clip();
    if (night) {
      ellipse(wx + ww * 0.72, wy + wh * 0.28, 0.07, 0.07, '#f7f1d0', false);
      ellipse(wx + ww * 0.72 + 0.03, wy + wh * 0.28 - 0.02, 0.06, 0.06, '#141a33', false);
      ctx.fillStyle = '#fff';
      for (let i = 0; i < 14; i++) {
        const tw = 0.5 + 0.5 * Math.sin(clock * 2 + i * 1.7);
        ctx.globalAlpha = 0.4 + 0.6 * tw;
        ctx.fillRect(wx + ((i * 0.37) % 1) * ww, wy + ((i * 0.61) % 1) * wh * 0.8, 0.012, 0.012);
      }
      ctx.globalAlpha = 1;
    } else {
      const cl = (clock * 0.03) % (ww + 0.4) - 0.2;
      ellipse(wx + cl, wy + wh * 0.35, 0.12, 0.045, '#fff', false);
      ellipse(wx + cl + 0.08, wy + wh * 0.32, 0.08, 0.05, '#fff', false);
    }
    ctx.restore();
    line(wx + ww / 2, wy, wx + ww / 2, wy + wh, frame, 0.03);
    line(wx, wy + wh / 2, wx + ww, wy + wh / 2, frame, 0.03);
  }

  // Where wall decorations go: above the desk, off to the right.
  function windowSpot() {
    const ww = Math.min(1.1, Wm * 0.32);
    const wh = Math.min(0.85, (floorY - DESK_H - 0.75) * 0.9);
    return { ww, wh, wx: cx + DESK_W / 2 - ww - 0.1, wy: Math.max(0.35, floorY - DESK_H - 0.75 - wh) };
  }

  function wall(top, bottom) {
    const g = ctx.createLinearGradient(0, 0, 0, floorY);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, Wm, floorY);
  }

  function floor(color, lines, base) {
    ctx.fillStyle = color;
    ctx.fillRect(0, floorY, Wm, Hm - floorY);
    if (lines) {
      ctx.fillStyle = lines;
      for (let y = floorY + 0.12; y < Hm; y += 0.12) ctx.fillRect(0, y, Wm, 0.008);
    }
    ctx.fillStyle = base;
    ctx.fillRect(0, floorY - 0.06, Wm, 0.06);
    ctx.fillStyle = 'rgba(0,0,0,0.1)';
    ctx.fillRect(0, floorY - 0.008, Wm, 0.008);
  }

  function poster(x, y, w, h, bg, title, art) {
    rrect(x - 0.025, y - 0.025, w + 0.05, h + 0.05, 0.01, '#2a2733');
    rrect(x, y, w, h, 0, bg, false);
    art(x, y, w, h);
    label(title, x + w / 2, y + h - 0.05, Math.min(0.07, w * 0.16), '#fff');
  }

  const ROOMS = {
    home: {
      ink: '#2a2733', fade: '#f3e9d8',
      draw() {
        wall('#f6eedf', '#efe2cb');
        ctx.fillStyle = 'rgba(0,0,0,0.025)';
        for (let x = 0.15; x < Wm; x += 0.3) ctx.fillRect(x, 0, 0.12, floorY);
        const w = windowSpot();
        if (w.wh > 0.35) drawWindow(w.wx, w.wy, w.ww, w.wh, '#ffffff', false);
        floor('#c99a6b', 'rgba(0,0,0,0.06)', '#ffffff');
      },
    },
    office: {
      ink: '#2a2733', fade: '#dfe3e8',
      draw() {
        wall('#e6e9ee', '#d3d8df');
        // ceiling lights
        for (let x = 0.3; x < Wm; x += 1.2) {
          rrect(x, -0.02, 0.6, 0.06, 0.01, '#fdfdf6');
          ctx.fillStyle = 'rgba(255,255,230,0.12)';
          ctx.beginPath();
          ctx.moveTo(x, 0.04);
          ctx.lineTo(x + 0.6, 0.04);
          ctx.lineTo(x + 0.8, 0.6);
          ctx.lineTo(x - 0.2, 0.6);
          ctx.fill();
        }
        const w = windowSpot();
        if (w.wh > 0.35) {
          poster(w.wx + w.ww * 0.15, w.wy, w.ww * 0.7, w.wh, '#4fb3bf', room.motto, (x, y, pw, ph) => {
            poly([[x, y + ph * 0.75], [x + pw * 0.4, y + ph * 0.25], [x + pw * 0.6, y + ph * 0.5], [x + pw * 0.75, y + ph * 0.35], [x + pw, y + ph * 0.75]], '#e9f6f7', false);
          });
        }
        // cubicle partitions behind the desk
        const ph = 0.55;
        rrect(-0.1, floorY - ph, Wm + 0.2, ph, 0.02, '#8e98a8');
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        for (let x = 0.4; x < Wm; x += 0.8) ctx.fillRect(x, floorY - ph, 0.03, ph);
        floor('#7d8796', null, '#5b6170');
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        for (const [fx, fy] of room.specks) ctx.fillRect(fx * Wm, floorY + fy * (Hm - floorY), 0.02, 0.01);
      },
    },
    night: {
      ink: '#f3e9d8', fade: '#2f3550',
      draw() {
        wall('#2b3150', '#3b4263');
        const w = windowSpot();
        if (w.wh > 0.35) drawWindow(w.wx, w.wy, w.ww, w.wh, '#4a5277', true);
        // string lights
        ctx.beginPath();
        for (let x = 0; x <= Wm; x += 0.05) ctx.lineTo(x, 0.25 + Math.sin(x * 2.2) * 0.06);
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.lineWidth = 0.008;
        ctx.stroke();
        for (let x = 0.2; x < Wm; x += 0.3) {
          const glow = 0.6 + 0.4 * Math.sin(clock * 3 + x * 5);
          ctx.fillStyle = `rgba(255,214,120,${0.25 * glow})`;
          ctx.beginPath();
          ctx.arc(x, 0.27 + Math.sin(x * 2.2) * 0.06, 0.06, 0, Math.PI * 2);
          ctx.fill();
          ellipse(x, 0.27 + Math.sin(x * 2.2) * 0.06, 0.018, 0.022, '#ffd678', false);
        }
        floor('#5a4636', 'rgba(0,0,0,0.12)', '#454c70');
      },
    },
    loft: {
      ink: '#f3e9d8', fade: '#9a4f3c',
      draw() {
        wall('#a5573f', '#8f4a35');
        ctx.strokeStyle = 'rgba(240,220,200,0.35)';
        ctx.lineWidth = 0.008;
        ctx.beginPath();
        for (let r = 0, y = 0; y < floorY; r++, y += 0.09) {
          ctx.moveTo(0, y);
          ctx.lineTo(Wm, y);
          for (let x = (r % 2) * 0.13; x < Wm; x += 0.26) {
            ctx.moveTo(x, y);
            ctx.lineTo(x, Math.min(floorY, y + 0.09));
          }
        }
        ctx.stroke();
        const w = windowSpot();
        if (w.wh > 0.35) {
          // neon sign
          const flicker = Math.sin(clock * 37) > 0.97 ? 0.3 : 1;
          ctx.save();
          ctx.font = 'italic 800 0.2px ui-rounded, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.shadowColor = '#ff5fa2';
          ctx.shadowBlur = 25;
          ctx.globalAlpha = flicker;
          ctx.fillStyle = '#ffd1e6';
          ctx.fillText(room.neon, w.wx + w.ww / 2, w.wy + w.wh * 0.6);
          ctx.restore();
        }
        floor('#a9a9a4', 'rgba(0,0,0,0.05)', '#6f6f6b');
      },
    },
    corner: {
      ink: '#2a2733', fade: '#e9e4da',
      draw() {
        wall('#ece7dd', '#ddd5c6');
        // floor-to-ceiling window with a city in it
        const x0 = 0.15, y0 = 0.15, w = Wm - 0.3, h = floorY - 0.25;
        const sky = ctx.createLinearGradient(0, y0, 0, y0 + h);
        sky.addColorStop(0, '#f7c08a');
        sky.addColorStop(1, '#f7e2c0');
        rrect(x0, y0, w, h, 0, sky);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, y0, w, h);
        ctx.clip();
        for (const b of room.skyline) {
          const bx = x0 + b.x * w;
          const by = y0 + h - b.h;
          ctx.fillStyle = b.c;
          ctx.fillRect(bx, by, b.w, b.h);
          ctx.fillStyle = 'rgba(255,240,200,0.5)';
          for (let wy2 = by + 0.05; wy2 < y0 + h - 0.05; wy2 += 0.08) {
            for (let wx2 = bx + 0.03; wx2 < bx + b.w - 0.03; wx2 += 0.06) {
              if ((wx2 * 31 + wy2 * 17) % 1 > 0.45) ctx.fillRect(wx2, wy2, 0.025, 0.035);
            }
          }
        }
        ctx.restore();
        for (let x = x0; x <= x0 + w + 0.001; x += w / 3) line(x, y0, x, y0 + h, '#3b3a44', 0.04);
        line(x0, y0, x0 + w, y0, '#3b3a44', 0.04);
        floor('#6b4a33', 'rgba(0,0,0,0.12)', '#3b3a44');
      },
    },
  };

  let room = null;

  // Keep the current room most of the time; now and then move somewhere new.
  function pickRoom() {
    if (room && !chance(0.35)) return;
    const names = Object.keys(ROOMS).filter((n) => !room || n !== room.name);
    const name = room ? pick(names) : 'home';
    room = {
      name,
      theme: ROOMS[name],
      motto: pick(['SYNERGY', 'HUSTLE', 'ALIGN', 'PIVOT', 'DISRUPT']),
      neon: pick(['hustle', 'ship it', 'vibes', 'grind']),
      specks: Array.from({ length: 80 }, () => [Math.random(), Math.random()]),
      skyline: Array.from({ length: 14 }, (_, i) => ({
        x: i / 14 + rand(-0.02, 0.02), w: rand(0.2, 0.45), h: rand(0.4, 1.6),
        c: pick(['#8a7f8e', '#6f6a7d', '#9c8f9a', '#5d5a6b']),
      })),
    };
    document.body.dataset.room = name;
    document.documentElement.style.setProperty('--ink', room.theme.ink);
    document.body.style.background = room.theme.fade;
  }

  function drawRoom() {
    room.theme.draw();

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
    ctx.fillStyle = room.theme.fade;
    ctx.fillRect(0, 0, W, H);
    ctx.setTransform(dpr * ppm, 0, 0, dpr * ppm, ox * dpr, oy * dpr);
    ctx.lineJoin = 'round';

    drawRoom();
    drawBoss();
    drawPal();

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
    drawDog();
    drawBossBubble();
    drawPalBubble();

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

    for (const c of confetti) {
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.a);
      ctx.fillStyle = c.c;
      ctx.fillRect(-0.012, -0.006, 0.024, 0.012);
      ctx.restore();
    }
    for (const d of drops) {
      ctx.fillStyle = d.color;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }

    if (fade > 0) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = fade;
      ctx.fillStyle = room.theme.fade;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
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
    celebrate: () => celebrate(desk),
    get deskInfo() { return { cracks: desk.splits.length, drawers: bodies.filter(b => b.kind === "drawer").length }; },
    pal: () => { pal.due = 0; },
    get dog() { return dog && dog.mode; },
    get arms() { return armJoints.map((a) => [a.broken ? 1 : 0, Math.round(a.max || 0)]); },
    get kinds() { return bodies.map((b) => b.kind); },
    set room(name) { room = null; pickRoom(); room.name = name; room.theme = ROOMS[name]; document.body.dataset.room = name; document.documentElement.style.setProperty('--ink', room.theme.ink); },
  };

  resize();
  updateScore();
  requestAnimationFrame(frame);
})();
