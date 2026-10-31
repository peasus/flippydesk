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
  let mouseWorld = false;     // through the mouse hole
  let robotWorld = false;     // through the game screen
  try {
    const saved = localStorage.getItem('flippydesk.world');
    if (saved) { mouseWorld = saved === 'mouse'; robotWorld = saved === 'robot'; }
    else mouseWorld = localStorage.getItem('flippydesk.mouse') === '1';
  } catch (e) { /* storage blocked */ }
  document.body.dataset.world = robotWorld ? 'robot' : mouseWorld ? 'mouse' : 'human';
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
    b.item = o.item || currentItem;
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

  const ROBOT_WOODS = [
    { top: '#8a94a3', side: '#5b6170', grain: 'rgba(255,255,255,0.18)', leds: true },
    { top: '#3b3f4a', side: '#2a2d36', grain: 'rgba(120,200,255,0.15)', leds: true },
    { top: '#e8eaee', side: '#b9bec8', grain: 'rgba(0,0,0,0.06)', leds: true },        // spaceship white
    { top: '#d9a520', side: '#a77d14', grain: 'rgba(0,0,0,0.25)', leds: true },        // hazard yellow
    { top: '#5b6b3a', side: '#44512a', grain: 'rgba(0,0,0,0.15)', leds: true },        // army surplus
    { top: '#8a2a2e', side: '#661e22', grain: 'rgba(0,0,0,0.15)', leds: true },        // red alert
  ];

  const GLASS_TOP = { top: 'rgba(190,225,240,0.6)', side: '#c9ccd3', grain: 'rgba(255,255,255,0.5)' };

  function buildDesk() {
    const style = pick(['legs', 'pedestal', 'pedestal', 'double', 'trestle', 'standing']);
    const glassy = !mouseWorld && !robotWorld && style !== 'pedestal' && style !== 'double' && chance(0.25);
    const wood = glassy ? GLASS_TOP : pick(robotWorld ? ROBOT_WOODS : mouseWorld ? MOUSE_WOODS : WOODS);
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
        if (wood.holes) cheeseHoles(x, -legH, 0.45, legH, 6, 1.9 + i);
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
      if (wood.holes) cheeseHoles(-half, top, DESK_W, DESK_TOP_T, 14, 1.1);
      ctx.restore();
      if (wood.leds) {
        for (let i = 0; i < 11; i++) ellipse(-half + 0.15 + i * 0.17, top + DESK_TOP_T / 2, 0.009, 0.009, blink(i, 1.5) ? pick(['#5dff8a', '#5dc9ff', '#e04a55']) : '#2a2d36', false);
      }
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
    if (b.game) return drawGameFace(x, y, w, h);
    if (robotWorld) return drawTerminalFace(x, y, w, h, lines);
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, hsl(hue, 70, 64));
    g.addColorStop(1, hsl(hue + 50, 70, 46));
    rrect(x, y, w, h, 0.012, g, false);
    const k = h / 0.32;
    rrect(x + 0.05 * k, y + 0.04 * k, Math.min(0.32 * k, w * 0.6), 0.23 * k, 0.012, 'rgba(255,255,255,0.88)', false);
    if (mouseWorld) cheeseIcon(x + 0.05 * k + Math.min(0.32 * k, w * 0.6) / 2, y + 0.155 * k, 0.07 * k);
    else lines.forEach(([a, c], i) => line(x + 0.07 * k + a * k, y + 0.07 * k + i * 0.033 * k, x + 0.07 * k + (a + c * 0.8) * k, y + 0.07 * k + i * 0.033 * k, hsl(hue + i * 40, 55, 50), 0.012 * k));
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

  function widescreen() { return monitor(0.86, 0.32); }

  // A tower PC standing on the desk. A hard enough knock fries it.
  function tower() {
    const dark = chance(0.6);
    const rgb = dark && chance(0.6) ? rand(0, 360) : null;
    const shell = dark ? '#2f3340' : '#e8dcc0';
    const trim = dark ? '#4a4f5c' : '#d9cdb0';
    return {
      w: 0.22,
      place(x, y) {
        let b;
        b = addBody(x, y, [R(-0.1, -0.46, 0.2, 0.46)], () => {
          rrect(-0.1, -0.46, 0.2, 0.46, 0.015, shell);
          rrect(-0.08, -0.43, 0.16, 0.05, 0.006, trim);
          line(-0.06, -0.405, 0.06, -0.405, dark ? '#1d1c22' : '#9a8f78', 0.008);
          for (let i = 0; i < 7; i++) line(-0.06, -0.3 + i * 0.03, 0.06, -0.3 + i * 0.03, dark ? '#1d1c22' : '#c9bc9c', 0.008);
          ellipse(0, -0.34, 0.016, 0.016, trim);
          const on = !b.dead && (clock % 1.6) > 0.08;
          ellipse(0.05, -0.34, 0.007, 0.007, b.dead ? '#3b3a44' : on ? '#7cff9c' : '#2e6b3c', false);
          if (rgb != null && !b.dead) line(-0.085, -0.02, -0.085, -0.44, hsl(rgb + clock * 90, 90, 60), 0.008);
          if (b.dead) {
            line(-0.09, -0.2, 0.05, -0.12, 'rgba(20,18,26,0.6)', 0.01);
            ellipse(0.02, -0.15, 0.03, 0.02, 'rgba(20,18,26,0.35)', false);
          }
        }, { kind: 'tower', density: 1.6 });
        b.breakable = 'tower';
      },
    };
  }

  // A flat desktop case with a CRT perched on top.
  function retroDesktop() {
    const screen = crt();
    return {
      w: 0.56,
      place(x, y) {
        let b;
        b = addBody(x, y, [R(-0.27, -0.12, 0.54, 0.12)], () => {
          rrect(-0.27, -0.12, 0.54, 0.12, 0.012, '#e8dcc0');
          rrect(-0.24, -0.1, 0.22, 0.03, 0.005, '#d9cdb0');
          line(-0.22, -0.085, -0.04, -0.085, '#9a8f78', 0.006);
          rrect(-0.24, -0.055, 0.22, 0.03, 0.005, '#d9cdb0');
          for (let i = 0; i < 5; i++) line(0.05 + i * 0.03, -0.095, 0.05 + i * 0.03, -0.03, '#c9bc9c', 0.008);
          ellipse(0.22, -0.06, 0.016, 0.016, '#d9cdb0');
          ellipse(0.22, -0.095, 0.006, 0.006, b.dead ? '#3b3a44' : '#7cff9c', false);
          label('TURBO', 0.22, -0.02, 0.014, '#e66b6b');
        }, { kind: 'tower', density: 1.6 });
        b.breakable = 'tower';
        screen.place(x, y - 0.121);
      },
    };
  }

  // A computer built into the monitor, with a fat chin.
  function allInOne() {
    const hue = rand(0, 360);
    const lines = screenLines();
    const shell = pick(['#d7d9df', '#f4f4f6', '#2f3340', '#f2c9a5', '#b8dbe6']);
    return {
      w: 0.64,
      place(x, y) {
        const b = addBody(x, y, [R(-0.12, -0.025, 0.24, 0.025), R(-0.03, -0.17, 0.06, 0.15), R(-0.31, -0.6, 0.62, 0.44)], () => {
          rrect(-0.03, -0.18, 0.06, 0.16, 0.01, '#b3b7c0');
          rrect(-0.12, -0.025, 0.24, 0.025, 0.012, '#b3b7c0');
          rrect(-0.31, -0.6, 0.62, 0.44, 0.03, shell);
          screenFace(b, -0.29, -0.58, 0.58, 0.33, hue, lines);
          ellipse(0, -0.205, 0.015, 0.015, 'rgba(42,39,51,0.25)', false);
        }, { kind: 'computer' });
        makeScreen(b, -0.29, -0.58, 0.58, 0.33);
      },
    };
  }


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
        }, { kind: 'arm', group: -2, density: 12, z: -0.5 });
        const clamp = world.createJoint(pl.WeldJoint({ frequencyHz: 0 }, desk, pole, V(px, y)));
        armJoints.push({ j: clamp, limit: 300, label: 'clamp gave way' });
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
          }, { kind: 'computer', group: -2, density: 0.5 });
          makeScreen(b, cx0 - sw / 2, cy0 - fh / 2 + 0.03, sw, fh - 0.06);
          // a rigid weld: the arm holds the screen level until it snaps
          const j = world.createJoint(pl.WeldJoint({ frequencyHz: 0 }, pole, b, V(px, py)));
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
      hitItem = a.j.getBodyB().item;
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

  function stapler() {
    const color = pick(['#e66b6b', '#3b3a44', '#6b8fe6', '#9aa0aa']);
    return {
      w: 0.17,
      place(x, y) {
        addBody(x, y, [R(-0.08, -0.025, 0.16, 0.025), R(-0.075, -0.05, 0.14, 0.028)], () => {
          rrect(-0.08, -0.025, 0.16, 0.025, 0.008, '#3b3a44');
          rrect(-0.075, -0.055, 0.15, 0.032, 0.014, color);
          ellipse(-0.035, -0.046, 0.022, 0.005, 'rgba(255,255,255,0.4)', false);
        }, { kind: 'stapler', density: 2 });
      },
    };
  }

  function tapeDispenser() {
    const color = pick(['#3b3a44', '#e66b6b', '#6b8fe6', '#7cc58f']);
    return {
      w: 0.17,
      place(x, y) {
        addBody(x, y, [{ pts: [[-0.08, 0], [0.08, 0], [0.07, -0.05], [-0.03, -0.08], [-0.08, -0.05]] }], () => {
          ellipse(-0.015, -0.06, 0.045, 0.045, 'rgba(230,240,250,0.8)');
          ellipse(-0.015, -0.06, 0.022, 0.022, '#d7d9df');
          poly([[-0.08, 0], [0.08, 0], [0.07, -0.05], [0.02, -0.05], [-0.015, -0.025], [-0.05, -0.05], [-0.08, -0.05]], color);
          poly([[0.065, -0.05], [0.085, -0.05], [0.08, -0.06]], '#9aa0aa');
        }, { kind: 'tape', density: 2.2 });
      },
    };
  }

  function deskFan() {
    const color = pick(['#6b8fe6', '#f4f4f6', '#7cc58f', '#f2c14e']);
    return {
      w: 0.22,
      place(x, y) {
        let b;
        b = addBody(x, y, [R(-0.07, -0.025, 0.14, 0.025), R(-0.012, -0.16, 0.024, 0.14), { x: 0, y: -0.24, r: 0.1 }], () => {
          rrect(-0.07, -0.025, 0.14, 0.025, 0.01, color);
          rrect(-0.012, -0.17, 0.024, 0.15, 0.006, color);
          ellipse(0, -0.24, 0.1, 0.1, 'rgba(244,244,246,0.5)');
          // the blades keep spinning until it lands hard
          const spin = b.stopped ? 0.4 : clock * 25;
          for (let i = 0; i < 3; i++) {
            const a = spin + (i * Math.PI * 2) / 3;
            ellipse(Math.cos(a) * 0.05, -0.24 + Math.sin(a) * 0.05, 0.035, 0.035, color, false);
          }
          ellipse(0, -0.24, 0.018, 0.018, '#3b3a44');
          for (let i = -2; i <= 2; i++) line(i * 0.04, -0.33, i * 0.04, -0.15, 'rgba(42,39,51,0.25)', 0.004);
        }, { kind: 'fan', density: 0.8 });
        b.breakable = 'fan';
      },
    };
  }

  function deskPhone() {
    return {
      w: 0.24,
      place(x, y) {
        addBody(x, y, [{ pts: [[-0.11, 0], [0.11, 0], [0.09, -0.07], [-0.09, -0.07]] }, R(-0.1, -0.1, 0.2, 0.03)], () => {
          poly([[-0.11, 0], [0.11, 0], [0.09, -0.07], [-0.09, -0.07]], '#3b3a44');
          for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) rrect(-0.02 + c * 0.03, -0.06 + r * 0.018, 0.022, 0.012, 0.003, '#d7d9df', false);
          rrect(-0.08, -0.055, 0.05, 0.03, 0.004, '#9ccf5e', false);
          rrect(-0.1, -0.105, 0.2, 0.035, 0.017, '#2f3340');
          ellipse(-0.085, -0.088, 0.025, 0.02, '#2f3340');
          ellipse(0.085, -0.088, 0.025, 0.02, '#2f3340');
        }, { kind: 'phone', density: 1.4 });
      },
    };
  }

  function headphones() {
    const color = pick(['#3b3a44', '#e66b6b', '#f4f4f6', '#b48be0']);
    return {
      w: 0.2,
      place(x, y) {
        addBody(x, y, [R(-0.09, -0.06, 0.05, 0.06), R(0.04, -0.06, 0.05, 0.06), R(-0.08, -0.17, 0.16, 0.03, { d: 0.3 })], () => {
          ctx.beginPath();
          ctx.arc(0, -0.06, 0.075, Math.PI, 0);
          ctx.lineWidth = 0.03;
          ctx.strokeStyle = INK;
          ctx.stroke();
          ctx.lineWidth = 0.016;
          ctx.strokeStyle = color;
          ctx.stroke();
          rrect(-0.095, -0.075, 0.05, 0.075, 0.02, color);
          rrect(0.045, -0.075, 0.05, 0.075, 0.02, color);
        }, { kind: 'headphones', density: 0.6, restitution: 0.3 });
      },
    };
  }

  function tissueBox() {
    const color = pick(['#b8dbe6', '#f2c9a5', '#c8e6b0', '#e8c8e6']);
    return {
      w: 0.2,
      place(x, y) {
        addBody(x, y, [R(-0.09, -0.1, 0.18, 0.1)], () => {
          ctx.beginPath();
          ctx.moveTo(-0.02, -0.1);
          ctx.quadraticCurveTo(-0.04, -0.16, 0, -0.17);
          ctx.quadraticCurveTo(0.04, -0.16, 0.02, -0.1);
          finish('#ffffff', true);
          rrect(-0.09, -0.1, 0.18, 0.1, 0.008, color);
          for (let i = 0; i < 4; i++) ellipse(-0.06 + i * 0.04, -0.05, 0.012, 0.012, 'rgba(255,255,255,0.6)', false);
        }, { kind: 'tissues', density: 0.3 });
      },
    };
  }

  function banana() {
    const pts = [[-0.09, -0.03], [-0.05, -0.012], [0, -0.008], [0.05, -0.014], [0.09, -0.035], [0.08, -0.045], [0.04, -0.035], [0, -0.032], [-0.05, -0.036], [-0.085, -0.05]];
    return {
      w: 0.2,
      place(x, y) {
        addBody(x, y, [{ pts: [[-0.09, -0.03], [0, -0.008], [0.09, -0.035], [0, -0.032]] }], () => {
          poly(pts, '#f2d34e');
          line(-0.092, -0.04, -0.1, -0.05, '#5b3a2a', 0.01);
          ellipse(0.088, -0.04, 0.006, 0.006, '#5b3a2a', false);
        }, { kind: 'banana', density: 0.5, friction: 0.2 });
      },
    };
  }

  function calculator() {
    return {
      w: 0.13,
      place(x, y) {
        addBody(x, y, [R(-0.055, -0.16, 0.11, 0.16)], () => {
          rrect(-0.055, -0.16, 0.11, 0.16, 0.012, '#4a4f5c');
          rrect(-0.042, -0.148, 0.084, 0.03, 0.004, '#c8d8b0');
          ctx.fillStyle = '#2a2733';
          ctx.font = 'bold 0.022px monospace';
          ctx.textAlign = 'right';
          ctx.fillText('58008', 0.037, -0.125);
          ctx.textAlign = 'start';
          for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) rrect(-0.04 + c * 0.03, -0.105 + r * 0.024, 0.022, 0.017, 0.004, r === 3 && c === 2 ? '#f08a4b' : '#d7d9df', false);
        }, { kind: 'calculator', density: 1.2 });
      },
    };
  }

  function waterGlass() {
    const fill = rand(0.4, 0.85);
    const glassPts = [[-0.045, 0], [0.045, 0], [0.055, -0.15], [-0.055, -0.15]];
    return {
      w: 0.13,
      place(x, y) {
        const b = addBody(x, y, [{ pts: glassPts }], () => {
          const h = 0.15 * fill;
          poly([[-0.045, -0.005], [0.045, -0.005], [0.045 + 0.01 * fill, -h], [-0.045 - 0.01 * fill, -h]], 'rgba(120,190,240,0.7)', false);
          poly(glassPts, 'rgba(214,236,250,0.35)');
          line(-0.035, -0.13, -0.03, -0.03, 'rgba(255,255,255,0.7)', 0.008);
        }, { kind: 'glass', density: 0.9 });
        b.breakable = 'glass';
        b.shatter = () => {
          const c = b.getWorldCenter();
          const v = b.getLinearVelocity();
          for (let i = 0; i < 26 * fill; i++) {
            drops.push(Object.assign({ x: c.x, y: c.y, vx: v.x + rand(-2.5, 2.5), vy: v.y + rand(-3, 0.5), r: rand(0.006, 0.016) }, WATER));
          }
          spawnShards(b, 0, -0.07, 6, GLASS);
          world.destroyBody(b);
          bodies.splice(bodies.indexOf(b), 1);
        };
      },
    };
  }

  // A goldfish bowl. If it breaks, the fish flops about on whatever it lands on.
  function fishbowl() {
    const fishColor = pick(['#f08a4b', '#f2c14e', '#e66b6b']);
    const drawFish = (sx = 1) => {
      ctx.save();
      ctx.scale(sx, 1);
      poly([[-0.04, 0], [-0.065, -0.02], [-0.065, 0.02]], fishColor);
      ellipse(0, 0, 0.04, 0.024, fishColor);
      ellipse(0.022, -0.006, 0.005, 0.005, INK, false);
      ctx.restore();
    };
    return {
      w: 0.24,
      place(x, y) {
        const b = addBody(x, y, [R(-0.06, -0.02, 0.12, 0.02), { x: 0, y: -0.11, r: 0.105 }], () => {
          ctx.save();
          ctx.beginPath();
          ctx.arc(0, -0.11, 0.1, 0, Math.PI * 2);
          ctx.clip();
          rrect(-0.11, -0.16, 0.22, 0.2, 0, 'rgba(120,190,240,0.55)', false);
          ctx.translate(Math.sin(clock * 0.9) * 0.04, -0.09 + Math.sin(clock * 2.1) * 0.01);
          drawFish(Math.cos(clock * 0.9) > 0 ? 1 : -1);
          ctx.restore();
          ellipse(0, -0.11, 0.105, 0.105, 'rgba(214,236,250,0.3)');
          ellipse(-0.05, -0.15, 0.015, 0.03, 'rgba(255,255,255,0.6)', false);
          rrect(-0.04, -0.005, 0.08, 0.008, 0.004, '#9ccf5e', false);
        }, { kind: 'fishbowl', density: 0.9 });
        b.breakable = 'fishbowl';
        b.shatter = () => {
          const c = b.getWorldPoint(V(0, -0.11));
          const v = b.getLinearVelocity();
          for (let i = 0; i < 34; i++) {
            drops.push(Object.assign({ x: c.x, y: c.y, vx: v.x + rand(-2.5, 2.5), vy: v.y + rand(-3, 0.5), r: rand(0.008, 0.018) }, WATER));
          }
          spawnShards(b, 0, -0.11, 7, GLASS);
          const fish = addBody(c.x, c.y, [{ x: 0, y: 0, r: 0.025 }], () => drawFish(fish.getLinearVelocity().x < 0 ? -1 : 1), { kind: 'fish', density: 0.4, restitution: 0.5, z: 2 });
          fish.flop = 6;
          fish.setLinearVelocity(V(v.x, v.y - 1));
          world.destroyBody(b);
          bodies.splice(bodies.indexOf(b), 1);
        };
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

  // ---------- mouse world items ----------
  // Through the mouse hole, the desk is stocked for its new tenants.

  const CHEESE = '#f7c843';
  const CHEESE_RIND = '#e9a92c';
  const CRUMBS = { color: '#f7c843', stain: 'rgba(247,200,67,0.8)' };

  // Holes in a slab of cheese, at fixed spots so they don't jump around.
  function cheeseHoles(x, y, w, h, n, seed = 1) {
    for (let i = 0; i < n; i++) {
      const u = ((i + 1) * 0.618 * seed) % 1, v = ((i + 1) * 0.383 * seed + 0.2) % 1;
      const r = Math.min(w, h) * (0.08 + ((i * 7) % 5) * 0.025);
      ellipse(x + r + u * (w - 2 * r), y + r + v * (h - 2 * r), r, r * 0.85, 'rgba(200,130,20,0.45)', false);
    }
  }

  function cheeseWedge() {
    const w = rand(0.2, 0.26), h = rand(0.1, 0.14);
    const pts = [[-w / 2, 0], [w / 2, 0], [w / 2, -h * 0.35], [-w / 2, -h]];
    return {
      w,
      place(x, y) {
        const draw = () => {
          poly(pts, CHEESE);
          poly([[-w / 2, -h], [w / 2, -h * 0.35], [w / 2, -h * 0.35 - 0.02], [-w / 2, -h - 0.02]], '#fbe08a');
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(pts[0][0], pts[0][1]);
          for (const p of pts) ctx.lineTo(p[0], p[1]);
          ctx.clip();
          cheeseHoles(-w / 2, -h, w, h, 5, 1.3);
          ctx.restore();
        };
        const b = addBody(x, y, [{ pts: pts.concat([[-w / 2, -h - 0.02], [w / 2, -h * 0.35 - 0.02]]) }], draw, { kind: 'cheese', density: 0.7 });
        b.breakable = 'cheese';
        b.shatter = () => {
          const c = b.getWorldCenter();
          const v = b.getLinearVelocity();
          for (let i = 0; i < 18; i++) drops.push(Object.assign({ x: c.x, y: c.y, vx: v.x + rand(-2, 2), vy: v.y + rand(-3, 0), r: rand(0.008, 0.016) }, CRUMBS));
          const left = [[-w / 2, 0], [0, 0], [0, -h * 0.68], [-w / 2, -h]];
          const right = [[0, 0], [w / 2, 0], [w / 2, -h * 0.35], [0, -h * 0.68]];
          splitBody(b, [
            { parts: [{ pts: left }], draw: () => { poly(left, CHEESE); cheeseHoles(-w / 2, -h * 0.9, w / 2, h * 0.8, 2, 1.3); } },
            { parts: [{ pts: right }], draw: () => { poly(right, CHEESE); cheeseHoles(0, -h * 0.6, w / 2, h * 0.5, 2, 2.1); } },
          ]);
        };
      },
    };
  }

  // A wheel of cheese in red wax, standing on edge. It rolls.
  function cheeseWheel() {
    const r = rand(0.08, 0.1);
    const wax = pick(['#d94a4a', '#e0b84a', '#7cc58f']);
    return {
      w: r * 2,
      place(x, y) {
        addBody(x, y - r, [{ x: 0, y: 0, r }], () => {
          ellipse(0, 0, r, r, wax);
          ellipse(0, 0, r * 0.62, r * 0.62, 'rgba(255,255,255,0.18)', false);
          rrect(-r * 0.45, -r * 0.18, r * 0.9, r * 0.36, r * 0.1, '#fff6e0');
          label(wax === '#d94a4a' ? 'GOUDA' : wax === '#7cc58f' ? 'BRIE' : 'EDAM', 0, r * 0.06, r * 0.22, INK);
        }, { kind: 'wheel', density: 0.9, friction: 0.6 });
      },
    };
  }

  function swissBlock() {
    const w = rand(0.16, 0.22), h = rand(0.12, 0.17);
    return {
      w,
      place(x, y) {
        const b = addBody(x, y, [R(-w / 2, -h, w, h)], () => {
          rrect(-w / 2, -h, w, h, 0.012, CHEESE);
          ctx.save();
          ctx.beginPath();
          ctx.rect(-w / 2, -h, w, h);
          ctx.clip();
          cheeseHoles(-w / 2, -h, w, h, 6, 1.7);
          ellipse(-w / 2, -h * 0.5, h * 0.18, h * 0.18, 'rgba(200,130,20,0.45)', false);
          ctx.restore();
        }, { kind: 'cheese', density: 0.7 });
        b.breakable = 'cheese';
        b.shatter = () => {
          const c = b.getWorldCenter();
          const v = b.getLinearVelocity();
          for (let i = 0; i < 18; i++) drops.push(Object.assign({ x: c.x, y: c.y, vx: v.x + rand(-2, 2), vy: v.y + rand(-3, 0), r: rand(0.008, 0.016) }, CRUMBS));
          splitBody(b, [
            { parts: [R(-w / 2, -h, w / 2, h)], draw: () => { rrect(-w / 2, -h, w / 2, h, 0.01, CHEESE); cheeseHoles(-w / 2, -h, w / 2, h, 2, 1.7); } },
            { parts: [R(0, -h, w / 2, h)], draw: () => { rrect(0, -h, w / 2, h, 0.01, CHEESE); cheeseHoles(0, -h, w / 2, h, 3, 2.3); } },
          ]);
        };
      },
    };
  }

  // A thimble of tea. It spills like a mug but doesn't break.
  function thimble() {
    const pts = [[-0.055, 0], [0.055, 0], [0.045, -0.12], [-0.045, -0.12]];
    return {
      w: 0.13,
      place(x, y) {
        const b = addBody(x, y, [{ pts }], () => {
          poly(pts, '#c9ccd3');
          ctx.fillStyle = 'rgba(90,95,110,0.45)';
          for (let r = 0; r < 4; r++) {
            for (let k = 0; k < 5; k++) {
              ctx.beginPath();
              ctx.arc(-0.03 + k * 0.015 + (r % 2) * 0.007, -0.1 + r * 0.02, 0.004, 0, Math.PI * 2);
              ctx.fill();
            }
          }
          rrect(-0.058, -0.02, 0.116, 0.02, 0.006, '#b0b4bd');
          if (state === 'ready' && b.coffee > 0) {
            ctx.globalAlpha = 0.5;
            for (let i = -1; i <= 1; i += 2) {
              ctx.beginPath();
              for (let k = 0; k <= 8; k++) {
                const t = k / 8;
                const xx = i * 0.018 + Math.sin(t * 6 + clock * 4 + i) * 0.01;
                if (k === 0) ctx.moveTo(xx, -0.13 - t * 0.1); else ctx.lineTo(xx, -0.13 - t * 0.1);
              }
              ctx.strokeStyle = '#ffffff';
              ctx.lineWidth = 0.008;
              ctx.lineCap = 'round';
              ctx.stroke();
            }
            ctx.globalAlpha = 1;
          }
        }, { kind: 'mug', density: 1.4 });
        b.coffee = 0.6;
      },
    };
  }

  function spool() {
    const thread = pick(['#e66b6b', '#6b8fe6', '#7cc58f', '#b48be0', '#f08a4b']);
    return {
      w: 0.13,
      place(x, y) {
        addBody(x, y, [R(-0.065, -0.025, 0.13, 0.025), R(-0.045, -0.16, 0.09, 0.135), R(-0.065, -0.185, 0.13, 0.025)], () => {
          rrect(-0.045, -0.165, 0.09, 0.145, 0.01, thread);
          for (let yy = -0.15; yy < -0.03; yy += 0.016) line(-0.045, yy, 0.045, yy + 0.008, 'rgba(0,0,0,0.12)', 0.005);
          rrect(-0.065, -0.025, 0.13, 0.025, 0.008, '#d8b07a');
          rrect(-0.065, -0.185, 0.13, 0.025, 0.008, '#d8b07a');
          line(0.045, -0.06, 0.09, -0.005, thread, 0.008);
        }, { kind: 'spool', density: 0.8 });
      },
    };
  }

  function sugarCube() {
    return {
      w: 0.08,
      place(x, y) {
        addBody(x, y, [R(-0.04, -0.075, 0.08, 0.075)], () => {
          rrect(-0.04, -0.075, 0.08, 0.075, 0.008, '#fbfbf7');
          ctx.fillStyle = 'rgba(0,0,0,0.08)';
          for (let i = 0; i < 9; i++) ctx.fillRect(-0.03 + ((i * 0.37) % 1) * 0.06, -0.065 + ((i * 0.61) % 1) * 0.055, 0.006, 0.006);
        }, { kind: 'sugar', density: 0.6 });
      },
    };
  }

  function acorn() {
    return {
      w: 0.1,
      place(x, y) {
        addBody(x, y - 0.06, [{ x: 0, y: 0.005, r: 0.045 }], () => {
          ellipse(0, 0.01, 0.04, 0.05, '#c98a4b');
          ellipse(-0.012, 0.0, 0.01, 0.018, 'rgba(255,255,255,0.3)', false);
          ctx.beginPath();
          ctx.ellipse(0, -0.02, 0.05, 0.035, 0, Math.PI, Math.PI * 2);
          ctx.closePath();
          finish('#7a5232');
          line(-0.03, -0.035, 0.03, -0.035, 'rgba(0,0,0,0.25)', 0.006);
          line(0, -0.055, 0.012, -0.08, '#5b3a2a', 0.012);
        }, { kind: 'acorn', density: 0.8 });
      },
    };
  }

  // A big sewing button, standing on edge. Also rolls.
  function sewingButton() {
    const color = pick(['#e66b6b', '#6b8fe6', '#f2c14e', '#7cc58f', '#3b3a44']);
    return {
      w: 0.14,
      place(x, y) {
        addBody(x, y - 0.07, [{ x: 0, y: 0, r: 0.07 }], () => {
          ellipse(0, 0, 0.07, 0.07, color);
          ellipse(0, 0, 0.052, 0.052, 'rgba(0,0,0,0.12)', false);
          for (const [a, c] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) ellipse(a * 0.018, c * 0.018, 0.009, 0.009, 'rgba(30,25,35,0.7)', false);
        }, { kind: 'button', density: 0.9, friction: 0.5 });
      },
    };
  }

  // A birthday candle stuck in a bottle cap: the mouse desk lamp.
  function candleLamp() {
    const wax = pick(['#e66b6b', '#6b8fe6', '#f2a7b5', '#7cc58f']);
    return {
      w: 0.12,
      place(x, y) {
        addBody(x, y, [R(-0.055, -0.035, 0.11, 0.035), R(-0.012, -0.2, 0.024, 0.165)], () => {
          rrect(-0.012, -0.2, 0.024, 0.17, 0.006, '#fff');
          for (let k = 0; k < 4; k++) line(-0.012, -0.18 + k * 0.04, 0.012, -0.165 + k * 0.04, wax, 0.01);
          rrect(-0.055, -0.035, 0.11, 0.035, 0.008, '#c9ccd3');
          for (let k = -2; k <= 2; k++) line(k * 0.022, -0.035, k * 0.022, 0, 'rgba(0,0,0,0.2)', 0.005);
          line(0, -0.2, 0, -0.215, INK, 0.005);
          const f = 1 + Math.sin(clock * 17) * 0.12;
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ellipse(0, -0.235, 0.05 * f, 0.05 * f, 'rgba(255,200,90,0.18)', false);
          ctx.restore();
          ellipse(0, -0.235, 0.012, 0.024 * f, '#ffb33d', false);
          ellipse(0, -0.228, 0.006, 0.012, '#fff1a8', false);
        }, { kind: 'candle', density: 0.8 });
      },
    };
  }

  function strawberry() {
    return {
      w: 0.11,
      place(x, y) {
        addBody(x, y, [{ pts: [[-0.05, -0.1], [0.05, -0.1], [0.035, -0.03], [0, 0], [-0.035, -0.03]] }], () => {
          poly([[-0.052, -0.095], [0, -0.108], [0.052, -0.095], [0.04, -0.035], [0, 0], [-0.04, -0.035]], '#e04a55');
          ctx.fillStyle = '#ffe08a';
          for (let i = 0; i < 9; i++) ctx.fillRect(-0.03 + ((i * 0.43) % 1) * 0.06, -0.085 + ((i * 0.71) % 1) * 0.06, 0.006, 0.008);
          poly([[-0.04, -0.1], [-0.015, -0.118], [0, -0.1], [0.015, -0.118], [0.04, -0.1], [0, -0.09]], '#5fae5b');
        }, { kind: 'berry', density: 0.6 });
      },
    };
  }

  function matchbox() {
    const color = pick(['#d94a4a', '#3d6bb3', '#2f8a5b']);
    return {
      w: 0.22,
      place(x, y) {
        addBody(x, y, [R(-0.11, -0.08, 0.22, 0.08)], () => {
          rrect(-0.11, -0.08, 0.22, 0.08, 0.008, color);
          rrect(-0.11, -0.08, 0.22, 0.016, 0.004, '#6b4a33');
          rrect(-0.07, -0.058, 0.14, 0.05, 0.006, '#fff6e0');
          label('MATCHES', 0, -0.026, 0.02, color);
        }, { kind: 'matchbox', density: 0.5 });
      },
    };
  }

  function peanut() {
    return {
      w: 0.13,
      place(x, y) {
        addBody(x, y - 0.035, [{ x: -0.03, y: 0, r: 0.035 }, { x: 0.03, y: 0, r: 0.035 }], () => {
          ellipse(-0.03, 0, 0.037, 0.035, '#d9b07a');
          ellipse(0.03, 0, 0.037, 0.035, '#d9b07a');
          ctx.save();
          ctx.globalAlpha = 0.25;
          for (let k = -2; k <= 2; k++) line(k * 0.02, -0.03, k * 0.02, 0.03, '#7a5232', 0.004);
          ctx.restore();
        }, { kind: 'peanut', density: 0.6 });
      },
    };
  }

  // Baited and set. Flip the desk and it snaps shut.
  function mousetrap() {
    return {
      w: 0.24,
      place(x, y) {
        const b = addBody(x, y, [R(-0.12, -0.025, 0.24, 0.025)], () => {
          rrect(-0.12, -0.025, 0.24, 0.025, 0.006, '#d8b07a');
          line(-0.11, -0.012, 0.11, -0.012, 'rgba(120,80,40,0.35)', 0.004);
          if (b.sprung) {
            line(-0.05, -0.03, 0.09, -0.03, '#9aa0aa', 0.012);
          } else {
            line(-0.05, -0.03, -0.11, -0.1, '#9aa0aa', 0.012);
            line(-0.11, -0.1, -0.11, -0.03, '#9aa0aa', 0.008);
            poly([[0.04, -0.025], [0.09, -0.025], [0.09, -0.05]], CHEESE);
          }
          ellipse(-0.05, -0.028, 0.012, 0.012, '#9aa0aa');
        }, { kind: 'trap', density: 0.6 });
        b.breakable = 'trap';
      },
    };
  }

  // A mouse-sized monitor screen shows cheese, of course.
  function cheeseIcon(x, y, s) {
    poly([[x - s, y + s * 0.6], [x + s, y + s * 0.6], [x + s, y - s * 0.1], [x - s, y - s * 0.6]], CHEESE, false);
    ellipse(x - s * 0.4, y + s * 0.1, s * 0.16, s * 0.16, CHEESE_RIND, false);
    ellipse(x + s * 0.4, y + s * 0.25, s * 0.12, s * 0.12, CHEESE_RIND, false);
  }

  // ---------- robot world items ----------
  // Past the game screen, the desk belongs to the machines.

  const CHROME = '#c9ccd3';
  const blink = (i, rate = 2) => Math.sin(clock * rate * 3 + i * 2.1) > 0;

  function robotToy() {
    const color = pick(['#e66b6b', '#6b8fe6', '#f2c14e', CHROME]);
    return {
      w: 0.14,
      place(x, y) {
        addBody(x, y, [R(-0.05, -0.1, 0.1, 0.1), R(-0.065, -0.2, 0.13, 0.1)], () => {
          rrect(-0.05, -0.1, 0.1, 0.1, 0.01, color);
          rrect(-0.03, -0.08, 0.06, 0.04, 0.005, '#2a2d36', false);
          rrect(-0.065, -0.2, 0.13, 0.1, 0.015, CHROME);
          ellipse(-0.028, -0.155, 0.016, 0.016, blink(1) ? '#ffd84d' : '#8a7a30');
          ellipse(0.028, -0.155, 0.016, 0.016, blink(1) ? '#ffd84d' : '#8a7a30');
          for (let k = -2; k <= 2; k++) line(k * 0.012, -0.125, k * 0.012, -0.11, INK, 0.004);
          line(0, -0.2, 0, -0.24, INK, 0.006);
          ellipse(0, -0.245, 0.012, 0.012, blink(3, 3) ? '#e04a55' : '#6b1f1f');
        }, { kind: 'robot', density: 0.8 });
      },
    };
  }

  function oilCan() {
    return {
      w: 0.16,
      place(x, y) {
        addBody(x, y, [{ pts: [[-0.06, 0], [0.06, 0], [0.05, -0.1], [-0.05, -0.1]] }, R(-0.012, -0.17, 0.024, 0.08)], () => {
          line(0.0, -0.15, 0.08, -0.2, '#9aa0aa', 0.012);
          poly([[-0.06, 0], [0.06, 0], [0.05, -0.1], [-0.05, -0.1]], '#d94a4a');
          poly([[-0.05, -0.1], [0.05, -0.1], [0.015, -0.15], [-0.015, -0.15]], '#b0b4bd');
          label('OIL', 0, -0.035, 0.03, '#fffaf0');
        }, { kind: 'oilcan', density: 0.9 });
      },
    };
  }

  // A big gear standing on its edge. It rolls.
  function gear() {
    const r = rand(0.07, 0.09);
    const teeth = 10;
    return {
      w: r * 2.3,
      place(x, y) {
        addBody(x, y - r, [{ x: 0, y: 0, r }], () => {
          ctx.beginPath();
          for (let i = 0; i < teeth * 2; i++) {
            const a = (i / (teeth * 2)) * Math.PI * 2;
            const rr = i % 2 ? r * 0.82 : r * 1.12;
            ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
          }
          ctx.closePath();
          finish('#9aa0aa');
          ellipse(0, 0, r * 0.55, r * 0.55, '#b0b4bd');
          ellipse(0, 0, r * 0.2, r * 0.2, '#2a2d36');
        }, { kind: 'gear', density: 1.2, friction: 0.5 });
      },
    };
  }

  function battery() {
    return {
      w: 0.09,
      place(x, y) {
        addBody(x, y, [R(-0.035, -0.17, 0.07, 0.17)], () => {
          rrect(-0.012, -0.185, 0.024, 0.02, 0.004, CHROME);
          rrect(-0.035, -0.17, 0.07, 0.17, 0.01, '#2a2d36');
          rrect(-0.035, -0.17, 0.07, 0.05, 0.01, '#e0b84a', false);
          label('+', 0, -0.13, 0.04, INK);
          rrect(-0.02, -0.1, 0.04, 0.07, 0.005, blink(2, 0.5) ? '#7cc58f' : '#3a5a3a', false);
        }, { kind: 'battery', density: 1.6 });
      },
    };
  }

  function floppyDisk() {
    const color = pick(['#3b3a44', '#6b8fe6', '#e66b6b']);
    return {
      w: 0.13,
      place(x, y) {
        addBody(x, y, [R(-0.06, -0.12, 0.12, 0.12)], () => {
          rrect(-0.06, -0.12, 0.12, 0.12, 0.006, color);
          rrect(-0.03, -0.12, 0.06, 0.04, 0, CHROME, false);
          rrect(-0.045, -0.06, 0.09, 0.055, 0.004, '#fffaf0', false);
          line(-0.035, -0.04, 0.03, -0.04, 'rgba(42,39,51,0.4)', 0.004);
          line(-0.035, -0.025, 0.02, -0.025, 'rgba(42,39,51,0.4)', 0.004);
        }, { kind: 'floppy', density: 0.6 });
      },
    };
  }

  // A glowing vacuum tube. Glass, so it smashes.
  function vacuumTube() {
    return {
      w: 0.09,
      place(x, y) {
        const b = addBody(x, y, [R(-0.035, -0.03, 0.07, 0.03), R(-0.03, -0.17, 0.06, 0.14)], () => {
          rrect(-0.035, -0.03, 0.07, 0.03, 0.005, '#3b3a44');
          const glow = 0.5 + 0.3 * Math.sin(clock * 5);
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ellipse(0, -0.09, 0.05, 0.06, `rgba(255,140,60,${0.25 * glow})`, false);
          ctx.restore();
          rrect(-0.03, -0.17, 0.06, 0.14, 0.03, 'rgba(214,236,250,0.4)');
          line(-0.01, -0.04, -0.01, -0.13, '#ffb33d', 0.006);
          line(0.01, -0.04, 0.01, -0.13, '#ffb33d', 0.006);
          line(-0.01, -0.13, 0.01, -0.13, '#fff1a8', 0.006);
        }, { kind: 'glass', density: 0.8 });
        b.breakable = 'glass';
        b.shatter = () => {
          spawnShards(b, 0, -0.1, 5, GLASS);
          sparkBurst(b.getWorldCenter().x, b.getWorldCenter().y, 10);
          world.destroyBody(b);
          bodies.splice(bodies.indexOf(b), 1);
        };
      },
    };
  }

  // A chrome robot skull with red eyes, staring at you.
  function chromeSkull() {
    return {
      w: 0.16,
      place(x, y) {
        addBody(x, y, [{ pts: [[-0.06, 0], [0.06, 0], [0.075, -0.1], [0.04, -0.15], [-0.04, -0.15], [-0.075, -0.1]] }], () => {
          poly([[-0.045, 0], [0.045, 0], [0.05, -0.04], [-0.05, -0.04]], '#9aa0aa');
          for (let k = -2; k <= 2; k++) line(k * 0.017, -0.035, k * 0.017, -0.005, INK, 0.005);
          ctx.beginPath();
          ctx.ellipse(0, -0.09, 0.075, 0.065, 0, 0, Math.PI * 2);
          finish(CHROME);
          ellipse(0.03, -0.11, 0.02, 0.012, 'rgba(255,255,255,0.7)', false);
          for (const s of [-1, 1]) {
            ellipse(s * 0.03, -0.085, 0.022, 0.018, '#1d1c22', false);
            const g = 0.7 + 0.3 * Math.sin(clock * 4);
            ellipse(s * 0.03, -0.085, 0.01, 0.01, `rgba(255,40,40,${g})`, false);
          }
          poly([[0, -0.07], [0.01, -0.05], [-0.01, -0.05]], '#1d1c22', false);
        }, { kind: 'skull', density: 1.4 });
      },
    };
  }

  function circuitBoard() {
    return {
      w: 0.18,
      place(x, y) {
        addBody(x, y, [R(-0.07, -0.02, 0.14, 0.02), R(-0.08, -0.16, 0.16, 0.14)], () => {
          rrect(-0.07, -0.02, 0.14, 0.02, 0.005, '#3b3a44');
          rrect(-0.08, -0.16, 0.16, 0.14, 0.008, '#3f8f5a');
          for (let k = 0; k < 4; k++) line(-0.07, -0.14 + k * 0.03, 0.07 - k * 0.02, -0.14 + k * 0.03, '#e0b84a', 0.004);
          rrect(-0.035, -0.12, 0.05, 0.05, 0.004, '#1d1c22', false);
          ellipse(0.05, -0.05, 0.008, 0.008, blink(5, 2) ? '#e04a55' : '#5a1a1a', false);
        }, { kind: 'board', density: 0.6 });
      },
    };
  }

  function joystick() {
    return {
      w: 0.13,
      place(x, y) {
        addBody(x, y, [R(-0.06, -0.04, 0.12, 0.04), R(-0.008, -0.13, 0.016, 0.09)], () => {
          line(0, -0.04, 0.01, -0.12, '#3b3a44', 0.014);
          ellipse(0.01, -0.13, 0.025, 0.025, '#e04a55');
          rrect(-0.06, -0.04, 0.12, 0.04, 0.01, '#2a2d36');
          ellipse(0.035, -0.04, 0.012, 0.006, '#f2c14e', false);
        }, { kind: 'joystick', density: 0.9 });
      },
    };
  }

  // Lightning in a bottle, more or less.
  function teslaCoil() {
    return {
      w: 0.12,
      place(x, y) {
        addBody(x, y, [R(-0.05, -0.03, 0.1, 0.03), R(-0.02, -0.17, 0.04, 0.14), { x: 0, y: -0.2, r: 0.04 }], () => {
          rrect(-0.05, -0.03, 0.1, 0.03, 0.006, '#3b3a44');
          rrect(-0.02, -0.17, 0.04, 0.14, 0.006, '#c87f3c');
          for (let k = 0; k < 8; k++) line(-0.02, -0.16 + k * 0.016, 0.02, -0.155 + k * 0.016, '#8a4a1c', 0.003);
          ctx.beginPath();
          ctx.ellipse(0, -0.2, 0.04, 0.03, 0, 0, Math.PI * 2);
          finish(CHROME);
          if (Math.sin(clock * 9 + x * 5) > 0.2) {
            ctx.strokeStyle = 'rgba(190,220,255,0.95)';
            ctx.lineWidth = 0.004;
            for (let a = 0; a < 3; a++) {
              ctx.beginPath();
              let px = 0, py = -0.21;
              ctx.moveTo(px, py);
              const ang = rand(-Math.PI, 0);
              for (let s = 0; s < 4; s++) { px += Math.cos(ang) * 0.025 + rand(-0.01, 0.01); py += Math.sin(ang) * 0.025 + rand(-0.01, 0.01); ctx.lineTo(px, py); }
              ctx.stroke();
            }
          }
        }, { kind: 'tesla', density: 1 });
      },
    };
  }

  // A brick of punch cards, held together by a rubber band and hope.
  function punchCards() {
    return {
      w: 0.17,
      place(x, y) {
        addBody(x, y, [R(-0.08, -0.07, 0.16, 0.07)], () => {
          for (let k = 0; k < 6; k++) rrect(-0.08 + (k % 2) * 0.004, -0.07 + k * 0.0115, 0.16, 0.012, 0.002, '#efe3bf');
          rrect(-0.08, -0.075, 0.16, 0.012, 0.002, '#efe3bf');
          for (let i = 0; i < 9; i++) rrect(-0.07 + i * 0.016, -0.072, 0.005, 0.007, 0, '#3b3a44', false);
          line(0.03, -0.075, 0.03, 0, '#d94a4a', 0.008);
        }, { kind: 'cards', density: 0.7 });
      },
    };
  }

  // Glowing orange digits behind glass. It knows what time it is. It knows.
  function nixieClock() {
    return {
      w: 0.2,
      place(x, y) {
        const b = addBody(x, y, [R(-0.09, -0.035, 0.18, 0.035), R(-0.085, -0.13, 0.17, 0.095)], () => {
          rrect(-0.09, -0.035, 0.18, 0.035, 0.008, '#5a3a24');
          const t = new Date();
          const digits = `${t.getHours()}`.padStart(2, '0') + `${t.getMinutes()}`.padStart(2, '0');
          ctx.save();
          ctx.font = `bold 0.05px ui-monospace, Menlo, monospace`;
          ctx.textAlign = 'center';
          for (let i = 0; i < 4; i++) {
            const tx = -0.063 + i * 0.042;
            rrect(tx - 0.018, -0.13, 0.036, 0.095, 0.017, 'rgba(214,236,250,0.35)');
            ctx.shadowColor = '#ff7a1a';
            ctx.shadowBlur = 8;
            ctx.fillStyle = '#ffae4a';
            ctx.fillText(digits[i], tx, -0.06);
            ctx.shadowBlur = 0;
          }
          ctx.restore();
        }, { kind: 'glass', density: 0.8 });
        b.breakable = 'glass';
        b.shatter = () => {
          spawnShards(b, 0, -0.08, 6, GLASS);
          sparkBurst(b.getWorldCenter().x, b.getWorldCenter().y, 12);
          world.destroyBody(b);
          bodies.splice(bodies.indexOf(b), 1);
        };
      },
    };
  }

  // A green wave that never stops waving.
  function oscilloscope() {
    return {
      w: 0.24,
      place(x, y) {
        addBody(x, y, [R(-0.115, -0.17, 0.23, 0.17)], () => {
          rrect(-0.115, -0.17, 0.23, 0.17, 0.015, '#c9b98f');
          rrect(-0.1, -0.155, 0.13, 0.12, 0.012, '#0d1a12');
          ctx.strokeStyle = '#5dff9a';
          ctx.lineWidth = 0.004;
          ctx.beginPath();
          for (let s = 0; s <= 24; s++) {
            const u = s / 24;
            const yy = -0.095 + Math.sin(u * 14 + clock * 6) * 0.03 * Math.sin(clock * 1.3 + u * 3);
            if (s === 0) ctx.moveTo(-0.095 + u * 0.12, yy); else ctx.lineTo(-0.095 + u * 0.12, yy);
          }
          ctx.stroke();
          for (const [kx, ky] of [[0.065, -0.13], [0.065, -0.085], [0.065, -0.04]]) ellipse(kx, ky, 0.015, 0.015, '#3b3a44');
          ellipse(0.095, -0.04, 0.006, 0.006, blink(9, 3) ? '#5dff9a' : '#1a4a2a', false);
        }, { kind: 'scope', density: 1.1 });
      },
    };
  }

  // A brain in a jar. Somebody's backup.
  function brainJar() {
    return {
      w: 0.13,
      place(x, y) {
        const b = addBody(x, y, [R(-0.055, -0.03, 0.11, 0.03), R(-0.05, -0.16, 0.1, 0.13), R(-0.035, -0.18, 0.07, 0.02)], () => {
          rrect(-0.055, -0.03, 0.11, 0.03, 0.006, '#3b3a44');
          rrect(-0.05, -0.16, 0.1, 0.13, 0.02, 'rgba(120,230,170,0.35)');
          const bob = Math.sin(clock * 2 + x) * 0.006;
          ctx.beginPath();
          ctx.ellipse(0, -0.095 + bob, 0.035, 0.028, 0, 0, Math.PI * 2);
          finish('#f0a5b5');
          for (let k = -1; k <= 1; k++) line(k * 0.015, -0.115 + bob, k * 0.012 + 0.005, -0.075 + bob, '#c97085', 0.004);
          for (let k = 0; k < 3; k++) ellipse(-0.02 + k * 0.02, -0.14 + ((clock * 0.1 + k * 0.33) % 1) * -0.0, 0.005, 0.005, 'rgba(255,255,255,0.6)', false);
          rrect(-0.035, -0.18, 0.07, 0.02, 0.005, CHROME);
          line(0.03, -0.18, 0.06, -0.22, INK, 0.004);
        }, { kind: 'glass', density: 1 });
        b.breakable = 'glass';
        b.shatter = () => {
          spawnShards(b, 0, -0.1, 5, GLASS);
          spawnShards(b, 0, -0.1, 2, '#f0a5b5');
          sparkBurst(b.getWorldCenter().x, b.getWorldCenter().y, 8);
          world.destroyBody(b);
          bodies.splice(bodies.indexOf(b), 1);
        };
      },
    };
  }

  // A chrome hand on a stand. It waves sometimes. Nobody asked it to.
  function robotHand() {
    return {
      w: 0.12,
      place(x, y) {
        addBody(x, y, [R(-0.05, -0.025, 0.1, 0.025), R(-0.012, -0.1, 0.024, 0.075), R(-0.04, -0.2, 0.08, 0.1)], () => {
          rrect(-0.05, -0.025, 0.1, 0.025, 0.006, '#2a2d36');
          rrect(-0.012, -0.1, 0.024, 0.075, 0.006, '#7d8796');
          ctx.save();
          ctx.translate(0, -0.1);
          ctx.rotate(Math.sin(clock * 3 + x * 2) * 0.25 * (Math.sin(clock * 0.4 + x) > 0.6 ? 1 : 0));
          rrect(-0.035, -0.05, 0.07, 0.05, 0.012, CHROME);
          for (let k = 0; k < 4; k++) rrect(-0.032 + k * 0.017, -0.1, 0.013, 0.055, 0.006, CHROME);
          rrect(0.032, -0.06, 0.015, 0.04, 0.007, CHROME);
          ctx.restore();
        }, { kind: 'hand', density: 1.2 });
      },
    };
  }

  // A reel-to-reel tape deck, still spinning.
  function reelTape() {
    return {
      w: 0.22,
      place(x, y) {
        addBody(x, y, [R(-0.105, -0.2, 0.21, 0.2)], () => {
          rrect(-0.105, -0.2, 0.21, 0.2, 0.012, '#9aa0aa');
          for (const dx of [-0.05, 0.05]) {
            ellipse(dx, -0.14, 0.042, 0.042, '#2a2d36');
            ctx.save();
            ctx.translate(dx, -0.14);
            ctx.rotate(clock * (dx < 0 ? 3 : -3));
            for (let s = 0; s < 3; s++) { ctx.rotate(2.09); line(0, 0, 0.035, 0, '#c9ccd3', 0.006); }
            ctx.restore();
            ellipse(dx, -0.14, 0.008, 0.008, '#c9ccd3', false);
          }
          line(-0.05, -0.098, 0.05, -0.098, '#5a3a24', 0.004);
          rrect(-0.09, -0.07, 0.18, 0.05, 0.006, '#2a2d36', false);
          for (let i = 0; i < 4; i++) rrect(-0.08 + i * 0.042, -0.06, 0.03, 0.03, 0.004, i === 1 ? '#e04a55' : '#c9ccd3', false);
        }, { kind: 'reel', density: 1 });
      },
    };
  }

  // A little satellite dish, listening for the mothership.
  function satDish() {
    return {
      w: 0.15,
      place(x, y) {
        addBody(x, y, [R(-0.04, -0.03, 0.08, 0.03), R(-0.008, -0.09, 0.016, 0.06), { pts: [[-0.07, -0.16], [0.07, -0.16], [0.04, -0.09], [-0.04, -0.09]] }], () => {
          rrect(-0.04, -0.03, 0.08, 0.03, 0.006, '#3b3a44');
          rrect(-0.008, -0.09, 0.016, 0.06, 0.004, '#7d8796');
          ctx.beginPath();
          ctx.moveTo(-0.07, -0.16);
          ctx.quadraticCurveTo(0, -0.04, 0.07, -0.16);
          ctx.closePath();
          finish('#e8eaee');
          line(0, -0.11, 0, -0.17, INK, 0.004);
          ellipse(0, -0.175, 0.008, 0.008, blink(4, 2) ? '#e04a55' : '#6b1f1f');
        }, { kind: 'dish', density: 0.7 });
      },
    };
  }

  // ---------- item names ----------
  // Every body an item creates is tagged with the item's name, so the
  // damage report can count what was flipped and what got broken.

  let currentItem = null;
  const ITEM_NAMES = [];

  function named(name, make) {
    ITEM_NAMES.push(name);
    return (...args) => {
      const it = make(...args);
      const place = it.place;
      it.place = (x, y) => {
        const prev = currentItem;
        currentItem = name;
        try { place.call(it, x, y); } finally { currentItem = prev; }
      };
      return it;
    };
  }

  const rawMonitor = monitor;
  widescreen = named('Widescreen monitor', () => rawMonitor(0.86, 0.32));
  monitor = named('Monitor', monitor);
  laptop = named('Laptop', laptop);
  crt = named('CRT monitor', crt);
  allInOne = named('All-in-one', allInOne);
  tower = named('Tower PC', tower);
  retroDesktop = named('Retro desktop', retroDesktop);
  armSetup = named('Monitor arm', armSetup);
  keyboard = named('Keyboard', keyboard);
  mouse = named('Mouse', mouse);
  speaker = named('Speaker', speaker);
  mug = named('Mug', mug);
  bookStack = named('Books', bookStack);
  ITEM_NAMES.pop();
  booksUpright = named('Books', booksUpright);
  plant = named('Plant', plant);
  lamp = named('Lamp', lamp);
  pencilCup = named('Pencil cup', pencilCup);
  duck = named('Rubber duck', duck);
  globe = named('Globe', globe);
  sodaCan = named('Soda can', sodaCan);
  alarmClock = named('Alarm clock', alarmClock);
  stickyPad = named('Sticky notes', stickyPad);
  photoFrame = named('Photo frame', photoFrame);
  stapler = named('Stapler', stapler);
  tapeDispenser = named('Tape dispenser', tapeDispenser);
  deskFan = named('Desk fan', deskFan);
  deskPhone = named('Desk phone', deskPhone);
  headphones = named('Headphones', headphones);
  tissueBox = named('Tissue box', tissueBox);
  banana = named('Banana', banana);
  calculator = named('Calculator', calculator);
  waterGlass = named('Glass of water', waterGlass);
  fishbowl = named('Fishbowl', fishbowl);
  const firstMouseItem = ITEM_NAMES.length;
  cheeseWedge = named('Cheese wedge', cheeseWedge);
  cheeseWheel = named('Cheese wheel', cheeseWheel);
  swissBlock = named('Swiss cheese', swissBlock);
  thimble = named('Thimble of tea', thimble);
  spool = named('Spool of thread', spool);
  sugarCube = named('Sugar cube', sugarCube);
  acorn = named('Acorn', acorn);
  sewingButton = named('Button', sewingButton);
  candleLamp = named('Candle lamp', candleLamp);
  strawberry = named('Strawberry', strawberry);
  matchbox = named('Matchbox', matchbox);
  peanut = named('Peanut', peanut);
  mousetrap = named('Mousetrap', mousetrap);
  const MOUSE_ITEM_NAMES = ITEM_NAMES.slice(firstMouseItem);
  const firstRobotItem = ITEM_NAMES.length;
  robotToy = named('Toy robot', robotToy);
  oilCan = named('Oil can', oilCan);
  gear = named('Gear', gear);
  battery = named('Battery', battery);
  floppyDisk = named('Floppy disk', floppyDisk);
  vacuumTube = named('Vacuum tube', vacuumTube);
  chromeSkull = named('Chrome skull', chromeSkull);
  circuitBoard = named('Circuit board', circuitBoard);
  joystick = named('Joystick', joystick);
  teslaCoil = named('Tesla coil', teslaCoil);
  punchCards = named('Punch cards', punchCards);
  nixieClock = named('Nixie clock', nixieClock);
  oscilloscope = named('Oscilloscope', oscilloscope);
  brainJar = named('Brain in a jar', brainJar);
  robotHand = named('Robot hand', robotHand);
  reelTape = named('Tape deck', reelTape);
  satDish = named('Satellite dish', satDish);
  const ROBOT_ITEM_NAMES = ITEM_NAMES.slice(firstRobotItem);

  // Swag unlocks as the flip count grows; each new item is guaranteed a spot
  // on the next desk.
  const UNLOCKS = [
    { at: 2, name: 'Conference badge', make: named('Conference badge', confBadge) },
    { at: 3, name: 'Stress ball', make: named('Stress ball', stressBall) },
    { at: 4, name: 'Fidget spinner', make: named('Fidget spinner', fidgetSpinner) },
    { at: 6, name: 'Branded water bottle', make: named('Branded water bottle', waterBottle) },
    { at: 8, name: 'Decision ball', make: named('Decision ball', decisionBall) },
    { at: 10, name: 'Patent award', make: named('Patent award', patentAward) },
    { at: 12, name: 'Employee of the Month', make: named('Employee of the Month', plaque) },
    { at: 15, name: 'Snow globe', make: named('Snow globe', snowGlobe) },
    { at: 18, name: 'Lava lamp', make: named('Lava lamp', lavaLamp) },
    { at: 21, name: 'Zen garden', make: named('Zen garden', zenGarden) },
    { at: 25, name: 'Anniversary monolith', make: named('Anniversary monolith', monolith) },
    { at: 30, name: 'Sales gong', make: named('Sales gong', salesGong) },
    { at: 35, name: 'CEO bobblehead', make: named('CEO bobblehead', bobblehead) },
    { at: 40, name: 'Desk Flipper trophy', make: named('Desk Flipper trophy', trophy) },
    { at: 50, name: 'Mascot plush', make: named('Mascot plush', plushMascot) },
    { at: 60, name: 'Founder’s gold stapler', make: named('Founder’s gold stapler', goldStapler) },
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
    () => [tower(), monitor(), keyboard(), mouse()],
    () => [tower(), widescreen(), keyboard(), mouse()],
    () => [tower(), monitor(0.5), monitor(0.5), keyboard()],
    () => [retroDesktop(), keyboard(), mouse()],
    () => [allInOne(), keyboard(), mouse()],
    () => [monitor(0.5), monitor(0.5), keyboard(), mouse()],
    () => [armSetup(1)],
    () => [armSetup(2)],
    () => [armSetup(2)],
    () => [laptop(), mouse()],
    () => [crt(), keyboard(), mouse()],
    () => [speaker(), monitor(), speaker(), keyboard(), mouse()],
  ];
  const EXTRAS = [lamp, pencilCup, duck, globe, sodaCan, alarmClock, stickyPad, photoFrame, plant, bookStack, mug,
    stapler, tapeDispenser, deskFan, deskPhone, headphones, tissueBox, banana, calculator, waterGlass, fishbowl];

  const MOUSE_EXTRAS = [cheeseWedge, cheeseWheel, swissBlock, spool, sugarCube, acorn, sewingButton, candleLamp,
    strawberry, matchbox, peanut, mousetrap, mousetrap];

  function buildMouseItems() {
    const extras = [];
    extras.push(chance(0.6) ? cheeseWedge() : swissBlock());
    if (chance(0.8)) extras.push(thimble());
    if (chance(0.5)) extras.push(candleLamp());
    for (const make of shuffle(MOUSE_EXTRAS.slice()).slice(0, randInt(2, 4))) extras.push(make());
    return shuffle(extras);
  }

  const ROBOT_EXTRAS = [robotToy, oilCan, gear, battery, floppyDisk, vacuumTube, circuitBoard, joystick, mug,
    teslaCoil, punchCards, nixieClock, oscilloscope, brainJar, robotHand, reelTape, satDish];

  // Old iron, mostly: green-screen terminals and the odd modern machine.
  const ROBOT_COMPUTERS = [
    () => [crt(), keyboard(), joystick()],
    () => [crt(), keyboard(), mouse()],
    () => [retroDesktop(), keyboard()],
    () => [tower(), crt(), keyboard()],
    () => [tower(), monitor(0.5), monitor(0.5), keyboard()],
    () => [monitor(), keyboard(), mouse()],
    () => [widescreen(), keyboard(), joystick()],
    () => [armSetup(2)],
    () => [laptop(), mouse()],
    () => [oscilloscope(), crt(), keyboard()],
  ];

  function buildRobotItems() {
    const extras = [];
    if (chance(0.5)) extras.push(chromeSkull());
    for (const make of shuffle(ROBOT_EXTRAS.slice()).slice(0, randInt(3, 5))) extras.push(make());
    return shuffle(extras);
  }

  function buildItems() {
    const deskTop = floorY - DESK_H - 0.001;
    const comp = pick(robotWorld ? ROBOT_COMPUTERS : COMPUTERS)();
    if (chance(0.5)) comp.reverse();
    const extras = robotWorld ? buildRobotItems() : mouseWorld ? buildMouseItems() : [];
    if (mouseWorld || robotWorld) {
      // no cats, no swag: the mice have their own things
    } else {
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
    sparks = [];
    smoke = [];
    grab = null;
    armJoints = [];
    weapon = null;
    weaponRound = false;
    clawMarks = null;
    cyborg = null;
    tracers = [];
    flames = [];
    booms = [];
    rings = [];
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
    pickGameScreen();
    placeDog();
    schedulePal();
    scheduleGust();
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
    dog = !mouseWorld && !robotWorld && chance(0.4) ? {
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
    'Gonna need you to come in Saturday. And Sunday.',
    'Can you put the deck in a spreadsheet? And then back in a deck?',
    'Quick one: can you make the logo pop more?',
    'Let\u2019s take the meeting about the meeting offline.',
    'Did you fill out the survey about the surveys?',
    'We\u2019re pivoting. Again. Update the roadmap?',
    'Can you print the internet for me? Just the good parts.',
    'Need you on a call at 6am. It\u2019s with Tokyo. Or Tulsa.',
    'I\u2019ll need those numbers yesterday, ideally.',
    'Can you cc me on everything? Like, everything.',
    'Reply-all and let them know we\u2019re aligned.',
    'Quick favor: rename all the files. Alphabetically. By vibe.',
    'Hey, where are we on the synergy deliverables?',
    'Can you hop on a quick 90-minute sync?',
    'Mandatory fun is at 4. Bring a dish.',
    'Who moved my cheese? No, literally. It was in the fridge.',
    'Let\u2019s circle the wagons and touch base on bandwidth.',
    'Can we make it more blockchain?',
    'The printer is on fire again. Can you handle it?',
    'Big win team! Anyway, budgets are cut.',
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
      Object.assign(boss, { mode: 'in', t: 0, line: pick(bossLines()), said: false, talkT: 0, look: pick(robotWorld ? ROBOT_BOSS_LOOKS : mouseWorld ? MOUSE_BOSS_LOOKS : BOSS_LOOKS) });
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
        boss.line = pick(bossLines().filter((l) => l !== boss.line));
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

  const bossLines = () => (robotWorld ? ROBOT_BOSS_LINES : mouseWorld ? MOUSE_BOSS_LINES : BOSS_LINES);

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
  const palLines = () => (robotWorld ? ROBOT_PAL_LINES : mouseWorld ? MOUSE_PAL_LINES : PAL_LINES);

  function schedulePal() {
    pal.due = chance(0.12) ? rand(1.5, 3) : Infinity;
  }

  function updatePal(dt) {
    if (pal.mode === 'away' && state === 'ready' && idleT > pal.due) {
      pal.due = Infinity;
      Object.assign(pal, { mode: 'in', line: pick(palLines()), talkT: -0.4, said: false, look: pick(robotWorld ? ROBOT_PAL_LOOKS : mouseWorld ? MOUSE_PAL_LOOKS : PAL_LOOKS) });
    }
    if (pal.mode === 'in') {
      pal.slide = Math.min(1, pal.slide + dt * 1.6);
      pal.talkT += dt;
      if (pal.talkT > 0 && !pal.said) {
        pal.said = true;
        sfx.mumble(Math.min(12, pal.line.split(' ').length + 3), robotWorld ? 0.7 : mouseWorld ? 2.4 : 1.3);
      }
      if (pal.talkT > 3.6) {
        pal.line = pick(palLines().filter((l) => l !== pal.line));
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
    if (mouseWorld) drawTail(-1, Math.sin(clock * 4) * 0.05);
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
    if (mouseWorld || robotWorld) {
      if (robotWorld) drawRobotHead(0.02, -1.5, L.skin, { open: pal.mode === 'in' && Math.sin(clock * 14) > 0 });
      else drawMouseHead(0.02, -1.5, L.skin, { open: pal.mode === 'in' && Math.sin(clock * 14) > 0 });
      ctx.restore();
      return;
    }
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

  // ---------- drive-by ----------
  // Very rarely, someone strolls past behind the desk, whistling, and leaves
  // something behind. The cat does not stick around.

  const gust = { mode: 'away', due: Infinity, x: 0, dir: 1, t: 0, look: null, clouds: [] };

  function scheduleGust() {
    gust.due = chance(0.03) ? rand(1, 4) : Infinity;
    gust.mode = 'away';
    gust.clouds = [];
  }

  function updateGust(dt) {
    for (const c of gust.clouds) {
      c.t += dt;
      c.x += c.vx * dt;
      c.y -= 0.08 * dt;
      c.r += 0.05 * dt;
    }
    gust.clouds = gust.clouds.filter((c) => c.t < 5);
    if (gust.mode === 'away' && state === 'ready' && idleT > gust.due) {
      gust.due = Infinity;
      gust.dir = chance(0.5) ? 1 : -1;
      Object.assign(gust, { mode: 'walk', t: 0, x: gust.dir > 0 ? -0.4 : Wm + 0.4, look: pick(robotWorld ? ROBOT_PAL_LOOKS : mouseWorld ? MOUSE_PAL_LOOKS : PAL_LOOKS), tooted: false });
    }
    if (gust.mode !== 'walk') return;
    gust.t += dt;
    gust.x += gust.dir * 0.9 * dt;
    if (!gust.tooted && Math.abs(gust.x - cx) < 0.3) {
      gust.tooted = true;
      sfx.toot();
      for (let i = 0; i < 7; i++) {
        gust.clouds.push({ x: gust.x - gust.dir * rand(0.05, 0.25), y: floorY - rand(0.7, 1.0), r: rand(0.08, 0.15), vx: -gust.dir * rand(0.02, 0.1), t: -i * 0.05 });
      }
      wakeCats();
      if (dog && dog.mode === 'sleep') Object.assign(dog, { mode: 'startled', t: 0, dir: dog.x < gust.x ? -1 : 1 });
    }
    if (gust.x < -0.6 || gust.x > Wm + 0.6) gust.mode = 'away';
  }

  function drawGust() {
    if (gust.mode !== 'walk') return;
    const L = gust.look;
    const step = Math.sin(gust.t * 9);
    ctx.save();
    ctx.translate(gust.x, floorY - Math.abs(step) * 0.015);
    ctx.scale(gust.dir, 1);
    line(-0.05, -0.75, -0.05 + step * 0.12, -0.03, INK, 0.11);
    line(-0.05, -0.75, -0.05 + step * 0.12, -0.03, L.pants, 0.08);
    line(0.05, -0.75, 0.05 - step * 0.12, -0.03, INK, 0.11);
    line(0.05, -0.75, 0.05 - step * 0.12, -0.03, L.pants, 0.08);
    if (mouseWorld) drawTail(-1, step * 0.05);
    rrect(-0.17, -1.34, 0.34, 0.62, 0.09, L.hoodie);
    line(0, -1.25, -step * 0.12, -0.85, INK, 0.1);
    line(0, -1.25, -step * 0.12, -0.85, L.hoodie, 0.07);
    if (robotWorld) drawRobotHead(0.01, -1.48, L.skin);
    else if (mouseWorld) drawMouseHead(0.01, -1.48, L.skin, { twitch: true });
    else {
    ellipse(0.01, -1.48, 0.12, 0.14, L.skin);
    ctx.beginPath();
    ctx.ellipse(0, -1.53, 0.125, 0.1, 0, Math.PI, Math.PI * 2);
    ctx.fillStyle = L.hair;
    ctx.fill();
    // eyes glancing sideways, lips pursed in a whistle
    ellipse(0.05, -1.49, 0.012, 0.012, INK, false);
    ellipse(0.1, -1.49, 0.012, 0.012, INK, false);
    ellipse(0.09, -1.42, 0.014, 0.014, INK, false);
    }
    ctx.restore();
    if (!gust.tooted || gust.t % 1 < 0.5) {
      ctx.save();
      ctx.font = 'bold 0.1px ui-rounded, system-ui, sans-serif';
      ctx.fillStyle = INK;
      ctx.fillText('♪', gust.x + gust.dir * 0.2, floorY - 1.62 - Math.sin(gust.t * 4) * 0.03);
      ctx.restore();
    }
  }

  function drawClouds() {
    for (const c of gust.clouds) {
      if (c.t < 0) continue;
      ctx.globalAlpha = Math.min(1, c.t * 4) * Math.max(0, 1 - c.t / 5) * 0.55;
      ellipse(c.x, c.y, c.r, c.r * 0.8, '#9ccf5e', false);
      ellipse(c.x + c.r * 0.6, c.y + c.r * 0.2, c.r * 0.6, c.r * 0.5, '#86bf47', false);
    }
    ctx.globalAlpha = 1;
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
    if (mouseWorld) drawTail(1, Math.sin(clock * 3) * 0.05);
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
    if (robotWorld) {
      drawRobotHead(0, -1.5, L.skin, { oneEye: L.oneEye, wide: boss.mode === 'flee', open: boss.mode === 'in' && Math.sin(clock * 12) > 0 });
      ctx.restore();
      return;
    }
    if (mouseWorld) {
      drawMouseHead(0, -1.5, L.skin, { bow: L.bow, glasses: L.glasses, open: boss.mode === 'flee', wide: boss.mode === 'flee', twitch: true });
      ctx.restore();
      return;
    }
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
    weaponRound = false;
    stateT = 0;
    idleT = 0;
    flips++;
    damageNow = {};
    logFlipped();
    try { localStorage.setItem('flippydesk.flips', String(flips)); } catch (e) { /* storage blocked */ }
    checkUnlock();
    score = 0;
    hang = 0;
    groundT = 0;
    landed = false;
    pinnedT = 0;
    heldUntil = 0;
    downT = 0;
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
    // In the robot world the desk goes way up, for target practice, while
    // the things on it scatter about as usual.
    const scatter = robotWorld ? strength * 1.7 : strength;
    if (robotWorld) strength = clamp(strength * 2.26, 2.8, 3.5);
    speedCap = robotWorld ? 7 * strength * 1.15 : 0;
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
        v.y - rand(2, 6.5) * scatter,
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
    // Start muted until the player turns sound on.
    let muted = true;
    try { muted = localStorage.getItem('flippydesk.muted') !== '0'; } catch (e) { /* storage blocked */ }

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

    // A sustained tone that holds its level, then dies away at the end.
    function hold(type, freq, peak, dur, delay = 0, freqEnd = 0, wobble = 0) {
      const t = ac.currentTime + delay;
      const o = ac.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
      if (wobble) {
        const lfo = ac.createOscillator();
        const lg = ac.createGain();
        lfo.frequency.value = wobble;
        lg.gain.value = freq * 0.04;
        lfo.connect(lg);
        lg.connect(o.frequency);
        lfo.start(t);
        lfo.stop(t + dur + 0.1);
      }
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.03);
      g.gain.setValueAtTime(peak, t + Math.max(0.04, dur - 0.08));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g);
      g.connect(master);
      o.start(t);
      o.stop(t + dur + 0.05);
    }

    // Looping noise, for roars longer than the noise buffer.
    function rumble(freq, freqEnd, peak, dur, delay = 0, type = 'lowpass') {
      const t = ac.currentTime + delay;
      const src = ac.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      const f = ac.createBiquadFilter();
      f.type = type;
      f.frequency.setValueAtTime(freq, t);
      f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
      f.Q.value = 0.7;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.02);
      g.gain.exponentialRampToValueAtTime(peak * 0.4, t + dur * 0.4);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f);
      f.connect(g);
      g.connect(master);
      src.start(t);
      src.stop(t + dur + 0.05);
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
      // A low, wobbly, unmistakable sound.
      toot() {
        if (!ready()) return;
        const t = ac.currentTime + 0.02;
        const dur = 0.75;
        const o = ac.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(110, t);
        o.frequency.linearRampToValueAtTime(70, t + dur);
        const lfo = ac.createOscillator();
        lfo.frequency.setValueAtTime(18, t);
        lfo.frequency.linearRampToValueAtTime(9, t + dur);
        const depth = ac.createGain();
        depth.gain.value = 25;
        lfo.connect(depth);
        depth.connect(o.frequency);
        const f = ac.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 500;
        f.Q.value = 4;
        const g = ac.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.5, t + 0.03);
        g.gain.setValueAtTime(0.45, t + dur * 0.7);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(f);
        f.connect(g);
        g.connect(master);
        o.start(t);
        lfo.start(t);
        o.stop(t + dur + 0.05);
        lfo.stop(t + dur + 0.05);
        burst('lowpass', 300, 1, 0.15, dur * 0.8);
      },
      // Electrical crackle: a fizz of noise with a buzzy hum underneath.
      zap() {
        if (!ready()) return;
        for (let i = 0; i < 4; i++) burst('highpass', rand(3000, 6000), 1, 0.25, 0.05, i * rand(0.04, 0.08));
        tone('sawtooth', 120, 0.08, 0.35, 0, 60);
      },
      // ----- weapons -----
      // A blade biting through wood with a ringing steel edge.
      clang() {
        if (!ready()) return;
        burst('lowpass', 700, 0.8, 0.9, 0.35);
        burst('highpass', 3500, 1, 0.35, 0.12);
        for (const [f, p] of [[1180, 0.12], [1770, 0.08], [2630, 0.05]]) tone('triangle', f, p, 1.1, 0, f * 0.98);
      },
      tick() {
        if (!ready()) return;
        tone('square', 2200, 0.06, 0.025);
        burst('highpass', 5000, 1, 0.12, 0.02);
      },
      boom(v = 1) {
        if (!ready()) return;
        rumble(1600, 70, 1.1 * v, 1.6);
        tone('sine', 110, 0.9 * v, 1.2, 0, 32);
        burst('highpass', 2500, 0.7, 0.4 * v, 0.15);
        for (let i = 0; i < 6; i++) burst('bandpass', rand(400, 1500), 2, 0.25 * v, 0.08, 0.15 + i * rand(0.08, 0.2));
      },
      // A rising whine while the laser charges.
      charge() {
        if (!ready()) return;
        hold('sawtooth', 160, 0.06, 0.85, 0, 1900);
        hold('sine', 320, 0.1, 0.85, 0, 3800);
      },
      beam(dur) {
        if (!ready()) return;
        hold('sawtooth', 92, 0.14, dur, 0, 0, 7);
        hold('square', 184, 0.05, dur, 0, 0, 11);
        rumble(4200, 3000, 0.18, dur, 0, 'bandpass');
      },
      beep(fast) {
        if (!ready()) return;
        tone('square', fast ? 2093 : 1760, 0.1, fast ? 0.05 : 0.12);
      },
      // A machine powering up.
      boot() {
        if (!ready()) return;
        hold('sawtooth', 55, 0.12, 1.4, 0, 110);
        tone('square', 880, 0.06, 0.08, 1.3);
        tone('square', 1320, 0.06, 0.08, 1.42);
      },
      shotgun() {
        if (!ready()) return;
        burst('lowpass', 1400, 0.8, 1, 0.3);
        burst('highpass', 2500, 0.7, 0.5, 0.08);
        tone('sine', 120, 0.8, 0.35, 0, 35);
      },
      brrt() {
        if (!ready()) return;
        burst('bandpass', 900, 1.5, 0.3, 0.04);
        tone('square', 80, 0.1, 0.04, 0, 50);
      },
      pump() {
        if (!ready()) return;
        burst('bandpass', 1800, 4, 0.35, 0.04);
        burst('bandpass', 1300, 4, 0.35, 0.05, 0.12);
      },
      // A spoon catapult letting go.
      twang() {
        if (!ready()) return;
        tone('triangle', 220, 0.25, 0.25, 0, 110);
        burst('lowpass', 900, 1, 0.3, 0.06);
      },
      // Termites at work: dry little crunches.
      chew() {
        if (!ready()) return;
        for (let i = 0; i < 3; i++) burst('bandpass', rand(2500, 4500), 3, 0.12, 0.025, i * rand(0.03, 0.06));
      },
      pour(dur) {
        if (!ready()) return;
        rumble(1800, 900, 0.35, dur, 0, 'bandpass');
        rumble(500, 300, 0.25, dur + 2);
      },
      gurgle() {
        if (!ready()) return;
        for (let i = 0; i < 12; i++) tone('sine', rand(180, 420), 0.18, 0.12, i * rand(0.12, 0.25), rand(500, 900));
      },
      // The big one: a crack, then a roar that rolls on for seconds.
      nuke() {
        if (!ready()) return;
        burst('highpass', 1500, 0.7, 0.8, 0.3);
        rumble(3000, 50, 1.3, 7);
        rumble(500, 30, 1.2, 9, 0.2);
        tone('sine', 70, 1, 5, 0, 20);
        for (let i = 0; i < 14; i++) burst('lowpass', rand(300, 900), 1, 0.4, rand(0.2, 0.5), 0.3 + i * rand(0.15, 0.45));
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
  const POINTS = { crack: 150, screen: 500, lamp: 300, mug: 250, pot: 250, acrylic: 400, snowglobe: 350, lava: 350, glass: 200, fishbowl: 400, cheese: 250 };

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
      hitItem = b === desk ? 'Desk' : b.item;
      if (b.breakable === 'screen') hitScreen(b, dv);
      else if (b.breakable === 'lamp' && dv > 2.6) breakApart(b, 'lamp', 'lamp smashed');
      else if (b.breakable === 'mug' && dv > 4) breakApart(b, 'mug', 'mug smashed');
      else if (b.breakable === 'desk') hitDesk(b, dv);
      else if (b.breakable === 'pot' && dv > 3.5) breakApart(b, 'pot', 'pot smashed');
      else if (b.breakable === 'acrylic' && dv > 4) breakApart(b, 'acrylic', 'patent revoked');
      else if (b.breakable === 'snowglobe' && dv > 3) breakApart(b, 'snowglobe', 'snow globe smashed');
      else if (b.breakable === 'tower' && dv > 4 && !b.dead) {
        b.dead = true;
        fry(b, 0, -0.2, 30);
        const c = b.getWorldCenter();
        addPoints(300, 'PC fried', c.x, c.y);
      }
      else if (b.breakable === 'lava' && dv > 3) breakApart(b, 'lava', 'lava lamp popped');
      else if (b.breakable === 'zen' && dv > 3 && b.sand) spillSand(b);
      else if (b.breakable === 'glass' && dv > 3) breakApart(b, 'glass', 'glass smashed');
      else if (b.breakable === 'fishbowl' && dv > 3.2) breakApart(b, 'fishbowl', 'fishbowl smashed');
      else if (b.breakable === 'cheese' && dv > 3.2) breakApart(b, 'cheese', 'cheese crumbled');
      else if (b.breakable === 'trap' && dv > 1.5 && !b.sprung) {
        b.sprung = true;
        sfx.crack();
        const c = b.getWorldCenter();
        b.setAngularVelocity(b.getAngularVelocity() + rand(-12, 12));
        addPoints(200, 'trap sprung', c.x, c.y);
      }
      else if (b.breakable === 'fan' && dv > 3.5 && !b.stopped) {
        b.stopped = true;
        fry(b, 0, -0.24, 10);
        const c = b.getWorldCenter();
        addPoints(150, 'fan busted', c.x, c.y);
      }
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
    if (kind === 'lamp' || kind === 'snowglobe' || kind === 'acrylic' || kind === 'lava' || kind === 'glass' || kind === 'fishbowl') sfx.shatter(0.7); else sfx.smash();
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
      fry(b, s.x + s.w / 2, s.y + s.h / 2);
      addPoints(POINTS.screen, 'screen smashed', c.x, c.y);
    } else {
      sfx.crack();
      sparkBurst(c.x, c.y, 6);
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

  // ---------- sparks and smoke ----------
  // Broken electronics spit sparks, then smoke for a while.

  let sparks = [], smoke = [];

  function sparkBurst(x, y, n, vx = 0, vy = 0) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2), sp = rand(1.5, 5);
      sparks.push({ x, y, vx: vx + Math.cos(a) * sp, vy: vy + Math.sin(a) * sp - 1.5, t: 0, life: rand(0.25, 0.6) });
    }
  }

  // Fry a body: sparks now, and smoke from local point (lx, ly) for a few seconds.
  function fry(b, lx, ly, n = 24) {
    const p = b.getWorldPoint(V(lx, ly));
    const v = b.getLinearVelocity();
    sparkBurst(p.x, p.y, n, v.x * 0.5, v.y * 0.5);
    b.smokeAt = [lx, ly];
    b.smokeT = rand(3, 5);
    sfx.zap();
  }

  function stepFx(dt) {
    // A loose goldfish flops about for a while.
    for (const b of bodies) {
      if (b.kind !== 'fish' || !(b.flop > 0)) continue;
      b.flop -= dt;
      if (chance(dt * 2.5) && b.getLinearVelocity().length() < 0.5) {
        b.applyLinearImpulse(V(rand(-0.4, 0.4) * b.getMass() * 4, -b.getMass() * rand(2.5, 4)), b.getWorldCenter());
        b.setAngularVelocity(rand(-12, 12));
      }
    }
    for (const b of bodies) {
      if (!(b.smokeT > 0)) continue;
      b.smokeT -= dt;
      const p = b.getWorldPoint(V(b.smokeAt[0], b.smokeAt[1]));
      if (chance(dt * 14)) smoke.push({ x: p.x + rand(-0.03, 0.03), y: p.y, r: rand(0.03, 0.05), t: 0, life: rand(1.6, 2.6), vx: rand(-0.08, 0.08), shade: rand(70, 120) });
      if (chance(dt * 1.5)) sparkBurst(p.x, p.y, randInt(3, 7));
    }
    for (const s of sparks) {
      s.t += dt;
      s.vy += GRAVITY * 0.6 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      if (s.y > floorY) { s.y = floorY; s.vy *= -0.3; s.vx *= 0.6; }
    }
    sparks = sparks.filter((s) => s.t < s.life);
    for (const m of smoke) {
      m.t += dt;
      m.x += m.vx * dt;
      m.y -= 0.35 * dt;
      m.r += 0.07 * dt;
    }
    smoke = smoke.filter((m) => m.t < m.life);
    if (smoke.length > 160) smoke.splice(0, smoke.length - 160);
  }

  function drawFx() {
    for (const m of smoke) {
      const k = m.t / m.life;
      ctx.globalAlpha = Math.min(1, m.t * 5) * (1 - k) * 0.5;
      ellipse(m.x, m.y, m.r, m.r * 0.85, `rgb(${m.shade},${m.shade},${m.shade + 8})`, false);
    }
    ctx.globalAlpha = 1;
    ctx.lineCap = 'round';
    for (const s of sparks) {
      const k = s.t / s.life;
      ctx.strokeStyle = k < 0.4 ? '#fffbe0' : k < 0.7 ? '#ffd23f' : '#ff8a2b';
      ctx.lineWidth = 0.012 * (1 - k * 0.6);
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - s.vx * 0.02, s.y - s.vy * 0.02);
      ctx.stroke();
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

  // ---------- damage report ----------
  // Every breakage label maps to a line in the damage report. Counts are kept
  // for this desk and for all time (in localStorage).

  const DAMAGE = {
    'screen smashed': 'Screens smashed',
    'cracked': 'Screens cracked',
    'PC fried': 'Computers fried',
    'monitor snapped off': 'Monitors snapped off arms',
    'clamp gave way': 'Monitor clamps broken',
    'lamp smashed': 'Lamps smashed',
    'mug smashed': 'Mugs smashed',
    'pot smashed': 'Flower pots smashed',
    'patent revoked': 'Patent awards shattered',
    'snow globe smashed': 'Snow globes smashed',
    'lava lamp popped': 'Lava lamps popped',
    'zen disturbed': 'Zen gardens spilled',
    'desk cracked': 'Desk cracks',
    'drawer popped': 'Drawers popped out',
    'glass smashed': 'Glasses smashed',
    'fishbowl smashed': 'Fishbowls smashed',
    'fan busted': 'Desk fans busted',
    'cheese crumbled': 'Cheeses crumbled',
    'desk cleaved': 'Desks cleaved',
    'desk devoured': 'Desks eaten by termites',
    'cat-astrophe!': 'Desks swatted by the cat',
    'shorted out': 'Things shorted out',
    'blasted': 'Things blasted with the shotgun',
    'desk blown up': 'Desks blown up',
    'desk incinerated': 'Desks incinerated',
    'torched': 'Things torched',
    'trap sprung': 'Mousetraps sprung',
  };
  const damageBtn = document.getElementById('damage');
  const reportEl = document.getElementById('report');
  let damage = {};
  let damageNow = {};
  let items = {};          // name -> { flipped, broken }
  let hitItem = null;      // the item whose hit is being handled right now
  try { damage = JSON.parse(localStorage.getItem('flippydesk.broken')) || {}; } catch (e) { damage = {}; }
  try { items = JSON.parse(localStorage.getItem('flippydesk.items')) || {}; } catch (e) { items = {}; }

  const itemStat = (name) => (items[name] = items[name] || { flipped: 0, broken: 0 });

  function saveItems() {
    try { localStorage.setItem('flippydesk.items', JSON.stringify(items)); } catch (e) { /* private mode */ }
  }

  // Count each item on the desk once per flip.
  function logFlipped() {
    const seen = new Set(['Desk']);
    for (const b of bodies) if (b.item) seen.add(b.item);
    for (const name of seen) itemStat(name).flipped++;
    saveItems();
  }

  const damageTotal = (d) => Object.values(d).reduce((a, b) => a + b, 0);

  function logDamage(label) {
    if (hitItem) {
      itemStat(hitItem).broken++;
      saveItems();
    }
    damage[label] = (damage[label] || 0) + 1;
    damageNow[label] = (damageNow[label] || 0) + 1;
    try { localStorage.setItem('flippydesk.broken', JSON.stringify(damage)); } catch (e) { /* private mode */ }
    showDamage(true);
  }

  function showDamage(bump) {
    damageBtn.querySelector('.n').textContent = damageTotal(damage).toLocaleString();
    if (bump) {
      damageBtn.classList.remove('bump');
      void damageBtn.offsetWidth;
      damageBtn.classList.add('bump');
    }
  }

  function fillTable(table, rows) {
    const body = table.querySelector('tbody');
    body.textContent = '';
    for (const { cells, cls } of rows) {
      const tr = document.createElement('tr');
      if (cls) tr.className = cls;
      for (const [text, tdCls] of cells) {
        const td = document.createElement('td');
        td.textContent = text;
        if (tdCls) td.className = tdCls;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
  }

  function openReport() {
    const num = (n) => (n ? n.toLocaleString() : '\u2013');
    // Collection: only what has actually turned up on a flipped desk.
    const swagNames = new Set(UNLOCKS.map((u) => u.name));
    const all = ['Desk', ...ITEM_NAMES.filter((n) => !swagNames.has(n)), ...UNLOCKS.map((u) => u.name)];
    const seen = all.filter((name) => items[name] && items[name].flipped);
    fillTable(reportEl.querySelector('table.items'), seen.map((name) => {
      const st = items[name];
      return { cells: [[name], [num(st.flipped)], [num(st.broken), st.broken ? 'now' : '']] };
    }));
    const bar = reportEl.querySelector('.progress');
    bar.setAttribute('aria-valuemax', String(all.length));
    bar.setAttribute('aria-valuenow', String(seen.length));
    bar.querySelector('.fill').style.width = `${(100 * seen.length) / all.length}%`;
    const next = nextUnlock();
    const left = all.length - seen.length;
    reportEl.querySelector('.unlocked').textContent =
      `${seen.length} of ${all.length} items found` +
      (left ? ` \u00b7 ${left} still to find` : ' \u00b7 you found them all!') +
      (next ? ` \u00b7 next unlock in ${next.at - flips} flip${next.at - flips === 1 ? '' : 's'}` : '');
    reportEl.querySelector('table.items').hidden = !seen.length;

    const kinds = Object.keys(DAMAGE).filter((k) => damage[k]).sort((a, b) => damage[b] - damage[a]);
    fillTable(reportEl.querySelector('table.kinds'), kinds.map((k) => {
      const now = damageNow[k] || 0;
      return { cells: [[DAMAGE[k]], [now ? `+${now}` : '\u2013', now ? 'now' : ''], [damage[k].toLocaleString()]] };
    }));
    const total = damageTotal(damage);
    reportEl.querySelector('.total').textContent = total
      ? `${total.toLocaleString()} things broken across ${flips.toLocaleString()} desk${flips === 1 ? '' : 's'} flipped`
      : `${flips.toLocaleString()} desk${flips === 1 ? '' : 's'} flipped so far`;
    reportEl.querySelector('table.kinds').hidden = !kinds.length;
    reportEl.querySelector('.empty').hidden = !!kinds.length;
    reportEl.hidden = false;
    reportEl.querySelector('.card').scrollTop = 0;
    reportEl.querySelector('.close').focus();
  }

  function closeReport() {
    reportEl.hidden = true;
    damageBtn.focus();
  }

  damageBtn.addEventListener('click', openReport);
  reportEl.querySelector('.close').addEventListener('click', closeReport);
  reportEl.addEventListener('click', (e) => { if (e.target === reportEl) closeReport(); });
  showDamage(false);

  // ---------- armory ----------
  // Points go into a bank. The bank buys weapons, and each weapon you own can
  // be used on any desk. Weapons score for what they destroy, but get no hang
  // time. Mouse World keeps its own bank and its own mouse-sized arsenal.

  const WEAPONS = [
    { id: 'sword', name: 'Broadsword', icon: '\u{1F5E1}️', price: 10000, blurb: 'One mighty overhead swing. The desk comes apart in two.' },
    { id: 'grenade', name: 'Frag grenade', icon: '\u{1F4A3}', price: 30000, blurb: 'Pull the pin, lob it on the desk, take cover.' },
    { id: 'laser', name: 'Laser cannon', icon: '⚡', price: 75000, blurb: 'Slices the desk clean through and sets both halves ablaze.' },
    { id: 'nuke', name: 'Tactical nuke', icon: '☢️', price: 150000, blurb: 'Slid under the desk. It beeps. Then it doesn’t.' },
  ];
  const MOUSE_WEAPONS = [
    { id: 'catapult', name: 'Cheese catapult', icon: '\u{1F944}', price: 10000, blurb: 'A spoon, a pencil and six wheels of gouda, fired at everything on the desk.' },
    { id: 'termites', name: 'Termite swarm', icon: '\u{1F41C}', price: 30000, blurb: 'They pour out of the hole and eat the desk down to sawdust.' },
    { id: 'paw', name: 'The cat', icon: '\u{1F43E}', price: 75000, blurb: 'Risky. One giant paw swats the whole desk across the room.' },
    { id: 'flood', name: 'The Flood', icon: '\u{1F30A}', price: 150000, blurb: 'Someone left the tap on. Everything floats. The computers do not survive.' },
  ];
  const MOUSE_MOVED = { sword: 'catapult', grenade: 'termites', laser: 'paw', nuke: 'flood' };
  // The robot world's armory sells upgrades for the shotgun and bigger guns
  // to swap it for. Upgrades work on every gun.
  const ROBOT_ARMS = [
    { id: 'pump', gear: 'upgrade', name: 'Hydraulic pump', icon: '\u{1F527}', price: 12000, blurb: 'Upgrade. The gun racks itself: every gun fires twice as fast.' },
    { id: 'choke', gear: 'upgrade', name: 'Wide choke', icon: '\u{1F3AF}', price: 25000, blurb: 'Upgrade. A much wider spread. Hard to miss now.' },
    { id: 'shells', gear: 'upgrade', name: 'Explosive shells', icon: '\u{1F9E8}', price: 45000, blurb: 'Upgrade. Every hit goes off and takes the neighbors with it.' },
    { id: 'minigun', gear: 'gun', name: 'Minigun', icon: '\u{1F300}', price: 80000, blurb: 'Hold to spray. Six barrels, no patience.' },
    { id: 'plasma', gear: 'gun', name: 'Plasma rifle', icon: '\u{1F52E}', price: 120000, blurb: 'A beam that goes through everything in a line, and keeps going.' },
    { id: 'rocket', gear: 'gun', name: 'Rocket launcher', icon: '\u{1F680}', price: 180000, blurb: 'One rocket, one very large hole in the air.' },
  ];
  const SHOTGUN = { id: 'shotgun', gear: 'gun', name: 'Shotgun', icon: '\u{1F4A5}' };
  let gunId = 'shotgun';
  try { gunId = localStorage.getItem('flippydesk.robot.gun') || 'shotgun'; } catch (e) { /* private mode */ }
  let firing = null;          // the minigun's held trigger: { x, y }
  let beams = [];             // plasma beams, in screen space
  let rockets = [];           // rockets on the way: { sx, sy, tx, ty, t }
  const arms = () => (robotWorld ? ROBOT_ARMS : mouseWorld ? MOUSE_WEAPONS : WEAPONS);
  const TRY_ALL = /[?&]armory\b/.test(location.search);
  let cash = 0;
  let owned = [];
  const bankKey = (k) => (robotWorld ? `flippydesk.robot.${k}` : mouseWorld ? `flippydesk.mouse.${k}` : `flippydesk.${k}`);

  // Each world has its own bank; load the one for the world we're in.
  function loadBank() {
    try { cash = parseInt(localStorage.getItem(bankKey('cash')), 10) || 0; } catch (e) { cash = 0; }
    try { owned = JSON.parse(localStorage.getItem(bankKey('owned'))) || []; } catch (e) { owned = []; }
    // The first mouse arsenal was a reskin; carry purchases over to the new weapons.
    if (mouseWorld) owned = owned.map((id) => MOUSE_MOVED[id] || id);
  }
  loadBank();
  let weaponRound = false;
  let weapon = null;      // the weapon animation in progress
  let flames = [];
  let booms = [];         // fireball puffs
  let rings = [];         // shockwave rings

  const shopBtn = document.getElementById('shop');
  const storeEl = document.getElementById('store');
  const arsenalEl = document.getElementById('arsenal');
  const has = (id) => TRY_ALL || owned.includes(id);
  const short = (n) => (n >= 100000 ? `${Math.floor(n / 1000)}k` : n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString());

  function saveBank() {
    try {
      localStorage.setItem(bankKey('cash'), String(cash));
      localStorage.setItem(bankKey('owned'), JSON.stringify(owned));
    } catch (e) { /* private mode */ }
  }

  let wasLocked = false;

  function bankPoints(n) {
    if (n <= 0) return;
    cash += n;
    saveBank();
    showBank(true);
  }

  function showBank(bump) {
    shopBtn.querySelector('.n').textContent = short(cash);
    const locked = storeLock();
    shopBtn.querySelector('.boom').textContent = locked ? '\u{1F512}' : robotWorld ? '\u{1F916}' : mouseWorld ? '\u{1F9C0}' : '\u{1F6D2}';
    if (wasLocked && !locked) {
      toastEl.textContent = `The ${robotWorld ? 'SKYDESK ' : mouseWorld ? 'Mouse ' : ''}Armory is open!`;
      toastEl.classList.remove('show');
      void toastEl.offsetWidth;
      toastEl.classList.add('show');
    }
    wasLocked = !!locked;
    if (bump) {
      shopBtn.classList.remove('bump');
      void shopBtn.offsetWidth;
      shopBtn.classList.add('bump');
    }
    arsenalEl.textContent = '';
    if (robotWorld) return showGuns();
    for (const w of arms()) {
      if (!has(w.id)) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = w.icon;
      b.title = w.name;
      b.setAttribute('aria-label', `Use the ${w.name}`);
      b.addEventListener('click', () => { sfx.unlock(); useWeapon(w.id); });
      arsenalEl.appendChild(b);
    }
    arsenalEl.classList.toggle('busy', state !== 'ready' && !robotWorld);
  }

  // Each world's armory opens once 3/4 of that world's items have turned up.
  const STORE_SHARE = 0.75;

  function storeLock() {
    if (TRY_ALL) return null;
    const mouseNames = new Set(MOUSE_ITEM_NAMES.concat(ROBOT_ITEM_NAMES));
    const swagNames = new Set(UNLOCKS.map((u) => u.name));
    const all = robotWorld ? ROBOT_ITEM_NAMES : mouseWorld
      ? MOUSE_ITEM_NAMES
      : ['Desk', ...ITEM_NAMES.filter((n) => !swagNames.has(n) && !mouseNames.has(n)), ...swagNames];
    const have = all.filter((name) => items[name] && items[name].flipped).length;
    const need = Math.ceil(all.length * STORE_SHARE);
    return have >= need ? null : { have, need, total: all.length };
  }

  function openStore() {
    const lock = storeLock();
    storeEl.querySelector('h2').textContent = robotWorld ? 'SKYDESK Armory' : mouseWorld ? 'Mouse Armory' : 'Armory';
    storeEl.querySelector('.bank').textContent = lock
      ? `Locked until you\u2019ve discovered 3/4 of the ${robotWorld ? 'robot ' : mouseWorld ? 'Mouse World ' : ''}items: ${lock.have} of ${lock.total} found, ${lock.need - lock.have} more to go. Your ${cash.toLocaleString()} points are saving up in the meantime.`
      : robotWorld
        ? `You have ${cash.toLocaleString()} robot-world points to spend. Upgrades fit every gun; new guns show up on the right to switch to.`
        : mouseWorld
        ? `You have ${cash.toLocaleString()} Mouse World points to spend. Points scored on this side of the wall go in this bank.`
        : `You have ${cash.toLocaleString()} points to spend. Every point you score goes in the bank.`;
    const list = storeEl.querySelector('ul');
    list.textContent = '';
    for (const w of arms()) {
      const li = document.createElement('li');
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = w.icon;
      const info = document.createElement('div');
      const name = document.createElement('b');
      name.textContent = w.name;
      const blurb = document.createElement('span');
      blurb.textContent = w.blurb;
      info.append(name, blurb);
      const btn = document.createElement('button');
      btn.type = 'button';
      if (has(w.id)) {
        btn.textContent = 'Owned';
        btn.disabled = true;
        btn.className = 'owned';
      } else if (lock) {
        btn.textContent = '\u{1F512}';
        btn.disabled = true;
        btn.title = 'Discover more items to unlock the store';
      } else if (cash >= w.price) {
        btn.textContent = `Buy · ${short(w.price)}`;
        btn.addEventListener('click', () => {
          cash -= w.price;
          owned.push(w.id);
          saveBank();
          showBank(false);
          sfx.unlock();
          sfx.ding(true);
          if (robotWorld && w.gear === 'gun') equipGun(w.id);
          toastEl.textContent = robotWorld ? `${w.name} ${w.gear === 'upgrade' ? 'installed' : 'acquired'}` : !mouseWorld && WEAPONS.every((x) => has(x.id)) ? 'You hear scratching under the desk\u2026' : `${w.name} acquired`;
          toastEl.classList.remove('show');
          void toastEl.offsetWidth;
          toastEl.classList.add('show');
          openStore();
        });
      } else {
        btn.textContent = `${short(w.price)}`;
        btn.disabled = true;
        btn.title = `Earn ${(w.price - cash).toLocaleString()} more points`;
        const need = document.createElement('small');
        need.textContent = `${short(w.price - cash)} to go`;
        info.appendChild(need);
      }
      li.append(icon, info, btn);
      list.appendChild(li);
    }
    storeEl.hidden = false;
    storeEl.querySelector('.close').focus();
  }

  function closeStore() {
    storeEl.hidden = true;
    shopBtn.focus();
  }

  shopBtn.addEventListener('click', openStore);
  storeEl.querySelector('.close').addEventListener('click', closeStore);
  storeEl.addEventListener('click', (e) => { if (e.target === storeEl) closeStore(); });

  // ----- cutting the desk -----

  // Clip a convex polygon to a convex region (both as [[x, y], ...]).
  function clipConvex(pts, region) {
    let out = pts;
    const cxr = region.reduce((s, p) => s + p[0], 0) / region.length;
    const cyr = region.reduce((s, p) => s + p[1], 0) / region.length;
    for (let i = 0; i < region.length && out.length; i++) {
      const a = region[i], b = region[(i + 1) % region.length];
      const side = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
      const keep = Math.sign(side([cxr, cyr]));
      const inp = out;
      out = [];
      for (let k = 0; k < inp.length; k++) {
        const p = inp[k], q = inp[(k + 1) % inp.length];
        const sp = side(p) * keep, sq = side(q) * keep;
        if (sp >= 0) out.push(p);
        if ((sp >= 0) !== (sq >= 0)) {
          const t = sp / (sp - sq);
          out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
        }
      }
    }
    // drop near-duplicate points so planck gets a clean polygon
    return out.filter((p, i) => {
      const q = out[(i + 1) % out.length];
      return Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.004;
    });
  }

  const polyArea = (pts) => Math.abs(pts.reduce((s, p, i) => {
    const q = pts[(i + 1) % pts.length];
    return s + p[0] * q[1] - q[0] * p[1];
  }, 0)) / 2;

  // Local polygons of every fixture on a body.
  function bodyPolys(b) {
    const polys = [];
    for (let f = b.getFixtureList(); f; f = f.getNext()) {
      const s = f.getShape();
      if (s.getType() === 'polygon') polys.push(s.m_vertices.map((v) => [v.x, v.y]));
      else if (s.getType() === 'circle') {
        const c = s.getCenter(), r = s.getRadius();
        polys.push(Array.from({ length: 8 }, (_, i) => [c.x + Math.cos(i * 0.785) * r, c.y + Math.sin(i * 0.785) * r]));
      }
    }
    return polys;
  }

  // Replace the desk with one piece per region. `cuts` are the local cut
  // lines, so their edges can glow. Returns the pieces.
  function splitDesk(regions, cuts) {
    const old = desk;
    const polys = bodyPolys(old);
    const pos = old.getPosition();
    const angle = old.getAngle();
    const oldDraw = old.draw;
    const pieces = [];
    for (const region of regions) {
      const parts = [];
      for (const poly of polys) {
        const c = clipConvex(poly, region);
        if (c.length >= 3 && polyArea(c) > 0.0006) parts.push({ pts: c.slice(0, 8) });
      }
      if (!parts.length) continue;
      let piece;
      piece = addBody(pos.x, pos.y, parts, () => {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(region[0][0], region[0][1]);
        for (const p of region) ctx.lineTo(p[0], p[1]);
        ctx.closePath();
        ctx.clip();
        oldDraw();
        ctx.restore();
      }, { angle, kind: 'desk', density: 3, friction: 0.7, restitution: 0.1, z: -1 });
      piece.item = 'Desk';
      piece.polys = parts.map((p) => p.pts);
      piece.cuts = cuts;
      piece.hot = 0;
      piece.char = 0;
      const v = old.getLinearVelocityFromWorldPoint(piece.getWorldCenter());
      piece.setLinearVelocity(v);
      piece.setAngularVelocity(old.getAngularVelocity());
      pieces.push(piece);
    }
    for (const a of armJoints) if (!a.broken && (a.j.getBodyA() === old || a.j.getBodyB() === old)) a.broken = true;
    world.destroyBody(old);
    bodies.splice(bodies.indexOf(old), 1);
    pieces.sort((a, b) => b.getMass() - a.getMass());
    desk = pieces[0];
    desk.splits = old.splits;
    bodies.sort((a, b) => a.z - b.z);
    return pieces;
  }

  // Regions either side of a local cut line from (xt, top) to (xb, bottom).
  function halves(xt, xb) {
    const T = -3, B = 1;
    return [
      [[-5, T], [xt, T], [xb, B], [-5, B]],
      [[xt, T], [5, T], [5, B], [xb, B]],
    ];
  }

  // Draw the char and the glowing cut edges on a body, in its local frame.
  function drawScorch(b) {
    if (b.char > 0) {
      ctx.fillStyle = `rgba(28,20,14,${Math.min(0.8, b.char)})`;
      for (const poly of b.polys || bodyPolys(b)) {
        ctx.beginPath();
        ctx.moveTo(poly[0][0], poly[0][1]);
        for (const p of poly) ctx.lineTo(p[0], p[1]);
        ctx.closePath();
        ctx.fill();
      }
    }
    if (b.hot > 0 && b.cuts) {
      ctx.lineCap = 'round';
      for (const poly of b.polys) {
        for (let i = 0; i < poly.length; i++) {
          const p = poly[i], q = poly[(i + 1) % poly.length];
          const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
          const onCut = b.cuts.some(([a, c]) => {
            const dx = c[0] - a[0], dy = c[1] - a[1];
            return Math.abs(dx * (my - a[1]) - dy * (mx - a[0])) / Math.hypot(dx, dy) < 0.004;
          });
          if (!onCut) continue;
          ctx.strokeStyle = `rgba(255,${120 + 100 * b.hot},40,${Math.min(1, b.hot)})`;
          ctx.lineWidth = 0.03;
          ctx.beginPath();
          ctx.moveTo(p[0], p[1]);
          ctx.lineTo(q[0], q[1]);
          ctx.stroke();
          ctx.strokeStyle = `rgba(255,250,210,${Math.min(1, b.hot)})`;
          ctx.lineWidth = 0.012;
          ctx.stroke();
        }
      }
    }
  }

  function setAblaze(b, secs) {
    b.burnT = Math.max(b.burnT || 0, secs);
    b.char = b.char || 0;
  }

  // A random point inside one of a body's polygons, in world space.
  function pointOn(b) {
    const polys = b.polys || bodyPolys(b);
    const poly = pick(polys);
    let x = 0, y = 0, tw = 0;
    for (const p of poly) { const w = Math.random(); x += p[0] * w; y += p[1] * w; tw += w; }
    return b.getWorldPoint(V(x / tw, y / tw));
  }

  function stepFlames(dt) {
    for (const b of bodies) {
      if (b.hot > 0) b.hot = Math.max(0, b.hot - dt * 0.35);
      if (!(b.burnT > 0)) continue;
      b.burnT -= dt;
      b.char = Math.min(0.75, (b.char || 0) + dt * 0.1);
      const rate = b.kind === 'desk' ? 40 : 14;
      const n = Math.floor(rate * dt + Math.random());
      for (let i = 0; i < n && flames.length < 260; i++) {
        const p = pointOn(b);
        flames.push({ x: p.x, y: p.y, vx: rand(-0.15, 0.15), vy: rand(-1.1, -0.5), t: 0, life: rand(0.35, 0.8), r: rand(0.03, 0.07) * clamp(b.burnT / 1.5, 0.2, 1) });
      }
      if (chance(dt * 6)) {
        const p = pointOn(b);
        smoke.push({ x: p.x, y: p.y - 0.1, r: rand(0.04, 0.07), t: 0, life: rand(1.8, 2.8), vx: rand(-0.08, 0.08), shade: rand(40, 70) });
      }
    }
    for (const f of flames) {
      f.t += dt;
      f.x += (f.vx + Math.sin(clock * 9 + f.y * 20) * 0.15) * dt;
      f.y += f.vy * dt;
    }
    flames = flames.filter((f) => f.t < f.life);
    for (const p of booms) {
      p.t += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.94;
      p.vy = p.vy * 0.94 - 0.4 * dt;
    }
    booms = booms.filter((p) => p.t < p.life);
    for (const r of rings) r.t += dt;
    rings = rings.filter((r) => r.t < r.life);
  }

  function drawFlames() {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const f of flames) {
      const k = f.t / f.life;
      ctx.globalAlpha = (1 - k) * 0.9;
      const c = k < 0.25 ? '#fff1a8' : k < 0.55 ? '#ffb33d' : '#ff5a1f';
      ellipse(f.x, f.y, f.r * (1 - k * 0.5), f.r * (1.3 - k * 0.4), c, false);
    }
    for (const p of booms) {
      const k = p.t / p.life;
      ctx.globalAlpha = (1 - k) * 0.95;
      const c = k < 0.2 ? '#fffbe0' : k < 0.45 ? '#ffd23f' : k < 0.7 ? '#ff8a2b' : '#c2410c';
      ellipse(p.x, p.y, p.r * (0.6 + k * 0.8), p.r * (0.6 + k * 0.8), c, false);
    }
    ctx.restore();
    for (const r of rings) {
      const k = r.t / r.life;
      ctx.globalAlpha = (1 - k) * 0.7;
      ctx.beginPath();
      ctx.ellipse(r.x, r.y, r.max * k, r.max * k * (r.flat || 1), 0, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 0.05 * (1 - k) + 0.01;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Blow everything away from (x, y).
  function blast(x, y, power, radius) {
    for (const b of bodies) {
      const c = b.getWorldCenter();
      const dx = c.x - x, dy = c.y - y;
      const d = Math.hypot(dx, dy) + 0.15;
      if (d > radius * 2.5) continue;
      const m = b.getMass();
      const k = power / (d + 0.3);
      b.applyLinearImpulse(V((dx / d) * m * k, (dy / d) * m * k - m * k * 0.6), c, true);
      b.setAngularVelocity(b.getAngularVelocity() + rand(-14, 14));
      if (d < radius && b.breakable && b.breakable !== 'desk') b.hit = Math.max(b.hit || 0, 9);
    }
  }

  function fireball(x, y, n, size) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2), sp = rand(0.5, 4) * size;
      booms.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.8, r: rand(0.08, 0.2) * size, t: -rand(0, 0.08), life: rand(0.5, 1.1) });
    }
    for (let i = 0; i < n / 2; i++) {
      smoke.push({ x: x + rand(-0.3, 0.3) * size, y: y + rand(-0.3, 0.1) * size, r: rand(0.08, 0.16) * size, t: -rand(0.1, 0.5), life: rand(2, 3.5), vx: rand(-0.3, 0.3), shade: rand(50, 90) });
    }
  }

  // ----- using a weapon -----

  // ----- mouse world weapons -----
  // The mice fight with what they have: a spoon catapult, termites, a very
  // large cat and the kitchen tap.

  const MOUSE_IDS = new Set(['catapult', 'termites', 'paw', 'flood']);
  const SAWDUST = { color: '#d9b07a', stain: 'rgba(217,176,122,0.9)' };
  let clawMarks = null;   // screen-space slashes after the cat swats, { start, dir }

  // Things that started on the desk (not the desk itself, not ammo).
  const loose = () => bodies.filter((b) => b.kind !== 'desk' && b.kind !== 'cheeseball' && b.item);

  function setupMouseWeapon(w) {
    if (w.id === 'catapult') {
      w.side = desk.getPosition().x > Wm / 2 ? -1 : 1;
      w.cx = w.side < 0 ? 0.32 : Wm - 0.32;
      // On narrow screens there's no room beside the desk, so it stands on a
      // stack of matchboxes to fire over the top.
      w.by = Math.min(cx - DESK_W / 2, Wm - cx - DESK_W / 2) < 0.5 ? floorY - DESK_H - 0.02 : floorY;
      w.balls = [];
      w.shots = 0;
      w.arm = -1.1;
    } else if (w.id === 'termites') {
      w.bugs = Array.from({ length: 140 }, (_, i) => ({
        x: holeX() + rand(-0.05, 0.05), y: floorY - rand(0, 0.08),
        delay: i * 0.008, lx: rand(-DESK_W / 2 + 0.05, DESK_W / 2 - 0.05), ly: rand(-DESK_H, -0.05),
        a: 0, falling: false, vx: 0, vy: 0,
      }));
      w.eaten = 0;
    } else if (w.id === 'paw') {
      w.dir = desk.getPosition().x > Wm / 2 ? -1 : 1;
      w.edge = w.dir > 0 ? -0.2 : Wm + 0.2;
      w.py = floorY - DESK_H - 0.22;
      sfx.meow();
    } else if (w.id === 'flood') {
      w.level = floorY + 0.4;
      w.top = floorY - DESK_H - 0.75;
      w.soaked = new Set();
      w.bubbles = [];
      w.tapX = Math.max(0.35, cx - DESK_W / 2 + 0.25);
      sfx.pour(3.6);
    }
  }

  function updateMouseWeapon(w, dt) {
    if (w.id === 'catapult') {
      // six quick shots, each aimed at something still on the desk
      const SHOT = 0.42;
      if (w.t > 0.5 && w.shots < 6 && w.t > 0.5 + w.shots * SHOT) {
        w.shots++;
        w.arm = 0.35;
        const ox = w.cx + w.side * 0.12, oy = w.by - 0.42;
        const onDesk = loose().filter((b) => b.getWorldCenter().y < floorY - DESK_H + 0.05);
        const target = onDesk.length ? pick(onDesk).getWorldCenter() : desk.getWorldPoint(V(rand(-0.6, 0.6), -DESK_H - 0.1));
        const T = 0.55;
        const vx = (target.x - ox) / T;
        const vy = (target.y - oy) / T - 0.5 * GRAVITY * T;
        const r = 0.07;
        const wax = pick(['#d94a4a', '#e0b84a', CHEESE]);
        const ball = addBody(ox, oy, [{ x: 0, y: 0, r }], () => {
          ellipse(0, 0, r, r, wax);
          ellipse(0, 0, r * 0.55, r * 0.55, CHEESE, false);
          ellipse(-r * 0.15, -r * 0.1, r * 0.12, r * 0.12, CHEESE_RIND, false);
        }, { kind: 'cheeseball', density: 14, bullet: true, item: null, z: 3 });
        ball.setLinearVelocity(V(vx, vy));
        ball.setAngularVelocity(rand(-15, 15));
        w.balls.push({ ball, at: w.t + T });
        bodies.sort((a, b) => a.z - b.z);
        sfx.twang();
      }
      w.arm = Math.max(-1.1, w.arm - dt * 4.5);
      // each wheel lands with a wallop that scatters whatever it hits
      for (const s of w.balls) {
        if (s.done || w.t < s.at) continue;
        s.done = true;
        const a = s.ball.getWorldCenter();
        blast(a.x, a.y, 2.2, 0.3);
        sparkBurst(a.x, a.y, 12);
        sfx.thud(1, 0.5);
        shake = Math.max(shake, 0.5);
      }
      if (w.t > 0.5 + 6 * SHOT + 1.6 && !w.fired) {
        w.fired = true;
        const off = loose().filter((b) => b.getWorldCenter().y > floorY - 0.4).length;
        if (off) addPoints(off * 100, `${off} knocked off`, desk.getPosition().x, floorY - DESK_H - 0.4);
        w.done = true;
      }
    } else if (w.id === 'termites') {
      const EAT = 1.6, SPLIT = 3.6;
      for (const g of w.bugs) {
        if (g.falling) {
          g.vy += GRAVITY * dt;
          g.x += g.vx * dt;
          g.y = Math.min(floorY, g.y + g.vy * dt);
          continue;
        }
        if (w.t < g.delay) continue;
        const p = w.fired ? null : desk.getWorldPoint(V(g.lx, g.ly));
        if (!p) continue;
        const dx = p.x - g.x, dy = p.y - g.y, d = Math.hypot(dx, dy);
        const sp = 1.6 * dt;
        if (d > sp) { g.x += (dx / d) * sp; g.y += (dy / d) * sp; g.a = Math.atan2(dy, dx); }
        else { g.x = p.x + rand(-0.006, 0.006); g.y = p.y + rand(-0.006, 0.006); g.a += rand(-1, 1); }
      }
      if (w.t > EAT && !w.fired) {
        desk.char = Math.min(0.45, (desk.char || 0) + dt * 0.2);
        if (chance(dt * 30)) {
          const g = pick(w.bugs);
          drops.push(Object.assign({ x: g.x, y: g.y, vx: rand(-0.6, 0.6), vy: rand(-0.8, 0), r: rand(0.004, 0.009) }, SAWDUST));
        }
        if (chance(dt * 8)) sfx.chew();
        shake = Math.max(shake, 0.05);
      }
      if (w.t >= SPLIT && !w.fired) {
        w.fired = true;
        const xs = [-5, -0.7, -0.4, -0.1, 0.2, 0.5, 0.75, 5];
        const ys = [-3, -DESK_H + DESK_TOP_T, -0.4, 1];
        const regions = [];
        for (let i = 0; i < xs.length - 1; i++) {
          for (let k = 0; k < ys.length - 1; k++) {
            const x0 = xs[i] + rand(-0.04, 0.04), x1 = xs[i + 1];
            regions.push([[x0, ys[k]], [x1, ys[k]], [x1, ys[k + 1]], [x0, ys[k + 1]]]);
          }
        }
        const pieces = splitDesk(regions, []);
        for (const p of pieces) {
          p.char = desk.char || 0.4;
          p.setLinearVelocity(V(rand(-0.8, 0.8), rand(-1.2, 0)));
          p.setAngularVelocity(rand(-3, 3));
        }
        w.crumbs = pieces.filter((p) => p !== desk);
        for (const g of w.bugs) { g.falling = true; g.vx = rand(-1, 1); g.vy = rand(-1.5, 0); }
        for (const b of loose()) b.setAwake(true);
        sfx.smash();
        shake = 0.8;
      }
      // then the chunks crumble away to sawdust, one by one
      if (w.fired && w.crumbs && w.crumbs.length && w.t > SPLIT + 0.9 && chance(dt * 9)) {
        const p = w.crumbs.splice(randInt(0, w.crumbs.length - 1), 1)[0];
        const c = p.getWorldCenter();
        for (let i = 0; i < 16; i++) drops.push(Object.assign({ x: c.x + rand(-0.06, 0.06), y: c.y + rand(-0.06, 0.06), vx: rand(-1, 1), vy: rand(-1.5, 0), r: rand(0.005, 0.012) }, SAWDUST));
        world.destroyBody(p);
        bodies.splice(bodies.indexOf(p), 1);
        w.eaten++;
        sfx.chew();
      }
      if (w.fired && !w.scored && w.crumbs && !w.crumbs.length) {
        w.scored = true;
        addPoints(1200 + w.eaten * 50, 'desk devoured', desk.getPosition().x, floorY - 0.9);
      }
      if (w.scored && w.t > SPLIT + 3) w.done = true;
    } else if (w.id === 'paw') {
      // peek in, swipe across, pull back
      const peek = w.edge + w.dir * 0.45;
      const far = cx + w.dir * (DESK_W / 2 + 0.6);
      if (w.t < 0.55) w.px = w.edge + (peek - w.edge) * Math.min(1, w.t / 0.35);
      else if (w.t < 0.8) { const k = (w.t - 0.55) / 0.25; w.px = peek + (far - peek) * k * k; }
      else w.px = far + (w.edge - w.dir * 0.6 - far) * Math.min(1, (w.t - 0.8) / 0.8);
      w.claws = w.t > 0.4 && w.t < 1;
      if (!w.fired && w.t >= 0.68) {
        w.fired = true;
        for (const b of bodies) {
          const c = b.getWorldCenter();
          const lift = c.y < floorY - DESK_H + 0.1 ? 1 : 0.6;
          b.setLinearVelocity(V(w.dir * rand(6, 9) * lift, -rand(2.5, 4.5)));
          b.setAngularVelocity(w.dir * rand(4, 10));
          b.setAwake(true);
          if (b.breakable && b.breakable !== 'desk') b.hit = Math.max(b.hit || 0, 6);
        }
        desk.setLinearVelocity(V(w.dir * 7, -4.5));
        desk.setAngularVelocity(w.dir * 5);
        // three claw scratches across the desktop
        const lx = desk.getLocalPoint(V(w.px, w.py)).x;
        for (let i = -1; i <= 1; i++) {
          const x0 = clamp(lx - w.dir * 0.5 + i * 0.12, -0.95, 0.95);
          desk.splits.push([[x0, -DESK_H + 0.005], [clamp(x0 + w.dir * 0.4, -0.97, 0.97), -DESK_H + DESK_TOP_T - 0.005]]);
        }
        clawMarks = { start: clock, dir: w.dir };
        sfx.whoosh(2.5);
        sfx.smash();
        shake = 1.3;
        addPoints(800, 'cat-astrophe!', cx, floorY - DESK_H - 0.5);
      }
      if (w.t > 2) w.done = true;
    } else if (w.id === 'flood') {
      const FILL = 3.6, DRAIN = 8.5, END = 11.5;
      const full = w.top;
      if (w.t < FILL) w.level = floorY + 0.4 + (full - floorY - 0.4) * Math.min(1, w.t / FILL);
      else if (w.t > DRAIN) w.level = full + (floorY + 0.4 - full) * Math.min(1, (w.t - DRAIN) / 2.5);
      if (!w.drained && w.t > DRAIN) { w.drained = true; sfx.gurgle(); }
      for (const b of bodies) {
        const c = b.getWorldCenter();
        const sub = clamp((c.y - w.level) / 0.15, 0, 1);
        if (!sub) continue;
        const v = b.getLinearVelocity();
        const drift = Math.sin(clock * 1.3 + c.x * 2) * 0.6;
        b.setLinearVelocity(V((v.x + drift * dt) * (1 - 1.8 * dt * sub), (v.y - GRAVITY * 1.45 * dt * sub) * (1 - 2.2 * dt * sub)));
        b.setAngularVelocity(b.getAngularVelocity() * (1 - 1.5 * dt * sub) + rand(-0.4, 0.4) * dt);
        b.setAwake(true);
        if (sub > 0.5 && b.item && b.kind !== 'desk' && !w.soaked.has(b)) w.soaked.add(b);
        if (sub > 0.5 && (b.screen || b.breakable === 'tower') && !b.shorted) {
          b.shorted = true;
          if (b.screen) b.dead = true;
          sparkBurst(c.x, c.y, 30);
          sfx.zap();
          addPoints(500, 'shorted out', c.x, c.y);
        }
        if (chance(dt * 3 * sub)) w.bubbles.push({ x: c.x + rand(-0.05, 0.05), y: c.y, r: rand(0.01, 0.025), t: 0 });
      }
      for (const bb of w.bubbles) { bb.t += dt; bb.y -= 0.5 * dt; bb.x += Math.sin(bb.t * 8) * 0.002; }
      w.bubbles = w.bubbles.filter((bb) => bb.y > w.level);
      if (!w.scored && w.t > DRAIN) {
        w.scored = true;
        const n = w.soaked.size;
        addPoints(1500 + n * 100, `${n} things soaked`, cx, floorY - 1.2);
      }
      if (w.t >= END && state === 'flipped') {
        w.done = true;
        state = 'fadeout';
        stateT = 0;
        finishRound();
      }
    }
  }

  function drawCatapult(w) {
    ctx.save();
    for (let y = floorY, i = 0; y > w.by + 0.01; y -= 0.13, i++) {
      rrect(w.cx - 0.15, Math.max(w.by, y - 0.13), 0.3, Math.min(0.13, y - w.by), 0.01, i % 2 ? '#3d6bb3' : '#d94a4a');
      rrect(w.cx - 0.15, Math.max(w.by, y - 0.13), 0.3, 0.02, 0.005, '#6b4a33', false);
    }
    ctx.translate(w.cx, w.by);
    ctx.scale(w.side, 1);
    // a block of wood, a pencil pivot and a spoon
    rrect(-0.16, -0.1, 0.32, 0.1, 0.02, '#a0703f');
    poly([[-0.06, -0.1], [0.06, -0.1], [0, -0.22]], '#8a5a3b');
    ctx.translate(0, -0.21);
    ctx.rotate(-w.arm);
    rrect(-0.32, -0.018, 0.4, 0.036, 0.018, '#c9ccd3');
    ellipse(-0.33, -0.03, 0.07, 0.04, '#c9ccd3');
    if (w.arm < -0.9 && w.shots < 6) ellipse(-0.33, -0.08, 0.05, 0.05, CHEESE);
    ctx.restore();
  }

  function drawTermites(w) {
    for (const g of w.bugs) {
      if (w.t < g.delay) continue;
      ctx.save();
      ctx.translate(g.x, g.y);
      ctx.rotate(g.a);
      const wig = Math.sin(clock * 30 + g.delay * 100) * 0.004;
      line(-0.008, -0.008 + wig, 0.008, 0.008 - wig, INK, 0.003);
      line(-0.008, 0.008 - wig, 0.008, -0.008 + wig, INK, 0.003);
      ellipse(0, 0, 0.012, 0.006, '#f2e2c0', false);
      ellipse(0.012, 0, 0.006, 0.005, '#8a5a3b', false);
      ctx.restore();
    }
  }

  function drawPaw(w) {
    if (w.px == null) return;
    const y = w.py;
    const shoulder = w.edge - w.dir * 0.8;
    ctx.save();
    ctx.lineCap = 'round';
    // the arm, striped
    for (const [wd, col] of [[0.44, INK], [0.42, '#f0a35a']]) {
      ctx.strokeStyle = col;
      ctx.lineWidth = wd;
      ctx.beginPath();
      ctx.moveTo(shoulder, y - 0.35);
      ctx.lineTo(w.px - w.dir * 0.15, y);
      ctx.stroke();
    }
    for (let k = 0.25; k < 0.9; k += 0.18) {
      const ax = shoulder + (w.px - w.dir * 0.15 - shoulder) * k;
      const ay = y - 0.35 + 0.35 * k;
      line(ax, ay - 0.2, ax + w.dir * 0.05, ay - 0.08, '#c96b3c', 0.035);
    }
    // the paw, with claws out mid-swipe
    if (w.claws) {
      for (let i = 0; i < 4; i++) {
        const cy = y - 0.18 + i * 0.12;
        poly([[w.px + w.dir * 0.2, cy - 0.025], [w.px + w.dir * 0.36, cy + 0.01], [w.px + w.dir * 0.2, cy + 0.03]], '#fffaf0');
      }
    }
    ellipse(w.px, y, 0.28, 0.26, '#f0a35a');
    for (let i = 0; i < 4; i++) ellipse(w.px + w.dir * 0.17, y - 0.18 + i * 0.12, 0.07, 0.055, '#f0a35a');
    ellipse(w.px - w.dir * 0.02, y + 0.03, 0.1, 0.09, '#f2a7b5');
    ctx.restore();
  }

  function drawFlood(w) {
    // the tap, pouring until the room is full
    const tx = w.tapX;
    rrect(tx - 0.06, -0.1, 0.12, 0.35, 0.02, '#c9ccd3');
    rrect(tx - 0.06, 0.2, 0.3, 0.1, 0.04, '#c9ccd3');
    rrect(tx + 0.17, 0.26, 0.08, 0.08, 0.02, '#b0b4bd');
    rrect(tx - 0.12, 0.02, 0.24, 0.06, 0.03, '#e66b6b');
    if (w.t < 3.6) {
      const sx = tx + 0.21;
      ctx.fillStyle = 'rgba(120,190,240,0.85)';
      ctx.fillRect(sx - 0.035 + Math.sin(clock * 20) * 0.005, 0.32, 0.07, w.level - 0.32);
      for (let i = 0; i < 3; i++) ellipse(sx + rand(-0.12, 0.12), w.level - rand(0, 0.08), 0.02, 0.02, 'rgba(255,255,255,0.8)', false);
    }
    // the water, in front of everything
    ctx.fillStyle = 'rgba(70,150,215,0.42)';
    ctx.beginPath();
    ctx.moveTo(0, Hm + 1);
    for (let x = 0; x <= Wm + 0.05; x += 0.05) ctx.lineTo(x, w.level + Math.sin(x * 4 + clock * 3) * 0.02);
    ctx.lineTo(Wm, Hm + 1);
    ctx.fill();
    ctx.beginPath();
    for (let x = 0; x <= Wm + 0.05; x += 0.05) ctx.lineTo(x, w.level + Math.sin(x * 4 + clock * 3) * 0.02);
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 0.02;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 0.005;
    for (const bb of w.bubbles) {
      ctx.beginPath();
      ctx.arc(bb.x, bb.y, bb.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    // a mouse sails by in a walnut shell
    if (w.t > 2.5 && w.level < floorY - 0.2) {
      const bx = ((w.t - 2.5) * 0.35) % (Wm + 0.6) - 0.3;
      const by = w.level + Math.sin(clock * 3 + bx * 4) * 0.02;
      ctx.save();
      ctx.translate(bx, by);
      ctx.rotate(Math.sin(clock * 2) * 0.12);
      ctx.save();
      ctx.scale(0.3, 0.3);
      drawMouseHead(0, -0.35, '#9a9aa6', { twitch: true });
      ctx.restore();
      ctx.beginPath();
      ctx.ellipse(0, -0.02, 0.13, 0.07, 0, 0, Math.PI);
      ctx.closePath();
      finish('#8a5a3b');
      line(0.06, -0.03, 0.06, -0.22, '#5b3a2a', 0.008);
      poly([[0.065, -0.21], [0.15, -0.12], [0.065, -0.1]], '#fffaf0');
      ctx.restore();
    }
  }

  function drawMouseWeapon(w) {
    if (w.id === 'catapult') drawCatapult(w);
    else if (w.id === 'termites') drawTermites(w);
    else if (w.id === 'paw') drawPaw(w);
    else if (w.id === 'flood') drawFlood(w);
  }

  // Three claw slashes across the screen.
  function drawClawMarks() {
    if (!clawMarks) return;
    const k = clock - clawMarks.start;
    if (k > 1.4) { clawMarks = null; return; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const a = Math.min(1, k * 8) * Math.max(0, 1 - (k - 0.6) / 0.8);
    const grow = Math.min(1, k * 6);
    ctx.lineCap = 'round';
    for (let i = -1; i <= 1; i++) {
      const x0 = W / 2 - clawMarks.dir * W * 0.3 + i * W * 0.07, y0 = H * 0.2 + i * H * 0.03;
      const x1 = x0 + clawMarks.dir * W * 0.45 * grow, y1 = y0 + H * 0.5 * grow;
      for (const [wd, col] of [[16, `rgba(120,20,30,${0.5 * a})`], [7, `rgba(255,240,240,${0.9 * a})`]]) {
        ctx.strokeStyle = col;
        ctx.lineWidth = wd;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
    }
  }

  function useWeapon(id) {
    if (state !== 'ready' || weapon || !has(id)) return;
    releaseTilt();
    startRound();
    weaponRound = true;
    landed = true;   // weapons don't earn hang time
    const top = desk.getWorldPoint(V(0, -DESK_H));
    weapon = { id, t: 0, x: top.x, y: top.y, fired: false, done: false };
    if (MOUSE_IDS.has(id)) {
      setupMouseWeapon(weapon);
    } else if (id === 'sword') {
      weapon.xt = rand(-0.12, 0.12);
      weapon.xb = weapon.xt + rand(-0.15, 0.15);
      sfx.whoosh(2.2);
    } else if (id === 'grenade') {
      weapon.from = chance(0.5) ? -1 : 1;
      weapon.sx = weapon.from < 0 ? -0.3 : Wm + 0.3;
      weapon.sy = floorY - 1.4;
      weapon.tx = top.x + rand(-0.4, 0.4);
      weapon.ty = top.y - 0.06;
      weapon.ticks = 0;
    } else if (id === 'laser') {
      weapon.xt = rand(-0.2, 0.2);
      weapon.xb = weapon.xt + rand(-0.25, 0.25);
      weapon.side = top.x > Wm / 2 ? -1 : 1;
      weapon.trail = [];
      sfx.charge();
    } else if (id === 'nuke') {
      weapon.bx = desk.getWorldPoint(V(rand(-0.25, 0.25), 0)).x;
      weapon.nextBeep = 0.6;
      weapon.gap = 0.7;
    }
    updateScore();
    showBank(false);
  }

  function updateWeapon(dt) {
    if (!weapon) return;
    const w = weapon;
    w.t += dt;
    if (!w.done) heldUntil = stateT;
    if (MOUSE_IDS.has(w.id)) return updateMouseWeapon(w, dt);
    if (w.id === 'sword') {
      if (!w.fired && w.t >= 0.3) {
        w.fired = true;
        const pieces = splitDesk(halves(w.xt, w.xb), [[[w.xt, -3], [w.xb, 1]]]);
        for (const p of pieces) {
          const dir = Math.sign(p.getWorldCenter().x - w.x) || 1;
          p.setLinearVelocity(V(dir * rand(1.6, 2.4), -rand(1.2, 2)));
          p.setAngularVelocity(dir * rand(1, 2));
          p.hot = 0.25;
        }
        for (const b of bodies) {
          if (b.kind === 'desk') continue;
          const c = b.getWorldCenter();
          if (Math.abs(c.x - w.x) < 0.35) {
            b.setLinearVelocity(V(Math.sign(c.x - w.x) * rand(1, 3), -rand(2, 4)));
            if (b.breakable && b.breakable !== 'desk') b.hit = 9;
          }
        }
        sparkBurst(w.x, w.y, 40);
        sfx.clang();
        shake = 1;
        addPoints(500, 'desk cleaved', w.x, w.y - 0.3);
      }
      if (w.t > 1.2) w.done = true;
    } else if (w.id === 'grenade') {
      if (w.t > 0.7 && w.t < 1.9 && Math.floor((w.t - 0.7) / 0.28) >= w.ticks) {
        w.ticks++;
        sfx.tick();
      }
      if (!w.fired && w.t >= 1.9) {
        w.fired = true;
        const gx = w.tx, gy = w.ty;
        const n = randInt(4, 5);
        const xs = [];
        for (let i = 1; i < n; i++) xs.push(-DESK_W / 2 + (DESK_W * i) / n + rand(-0.12, 0.12));
        const cuts = xs.map((x) => [[x + rand(-0.2, 0.2), -3], [x + rand(-0.2, 0.2), 1]]);
        const regions = [];
        let prev = [[-5, -3], [-5, 1]];
        for (const c of cuts.concat([[[5, -3], [5, 1]]])) {
          regions.push([prev[0], c[0], c[1], prev[1]]);
          prev = c;
        }
        const pieces = splitDesk(regions, cuts);
        for (const p of pieces) p.hot = 0.6;
        blast(gx, gy, 5.5, 1.3);
        fireball(gx, gy, 46, 1.6);
        sparkBurst(gx, gy, 90);
        rings.push({ x: gx, y: gy, t: 0, life: 0.6, max: 3.2 });
        for (const p of pieces) if (chance(0.5)) setAblaze(p, rand(1.5, 3));
        w.flash = 1;
        shake = 1.6;
        sfx.boom(1);
        addPoints(1000, 'desk blown up', gx, gy - 0.4);
      }
      if (w.flash) w.flash = Math.max(0, w.flash - dt * 5);
      if (w.t > 3) w.done = true;
    } else if (w.id === 'laser') {
      const t0 = 0.85, t1 = 2.0;
      if (w.t >= t0 && !w.beaming) { w.beaming = true; sfx.beam(t1 - t0); }
      if (w.t >= t0 && w.t <= t1) {
        const k = (w.t - t0) / (t1 - t0);
        const lx = w.xt + (w.xb - w.xt) * k;
        const ly = -DESK_H - 0.25 + (DESK_H + 0.3) * k;
        const p = desk.getWorldPoint(V(lx, ly));
        w.hitP = p;
        w.trail.push({ x: p.x, y: p.y, t: 0 });
        if (chance(0.7)) sparkBurst(p.x, p.y, 3);
        if (chance(0.25)) smoke.push({ x: p.x, y: p.y, r: 0.04, t: 0, life: 1.6, vx: rand(-0.1, 0.1), shade: 60 });
        if (chance(0.5)) flames.push({ x: p.x, y: p.y, vx: rand(-0.3, 0.3), vy: rand(-1, -0.4), t: 0, life: 0.4, r: 0.04 });
        for (const b of bodies) {
          if (b.kind === 'desk' || b.lasered) continue;
          const c = b.getWorldCenter();
          if (Math.hypot(c.x - p.x, c.y - p.y) < 0.18) {
            b.lasered = true;
            setAblaze(b, rand(3, 5));
            if (b.item) addPoints(100, 'torched', c.x, c.y);
            if (b.breakable && b.breakable !== 'desk') b.hit = 9;
          }
        }
        shake = Math.max(shake, 0.15);
      }
      for (const tr of w.trail) tr.t += dt;
      if (!w.fired && w.t >= t1) {
        w.fired = true;
        w.hitP = null;
        const pieces = splitDesk(halves(w.xt, w.xb + 0.05 * (w.xb - w.xt)), [[[w.xt, -DESK_H - 0.25], [w.xb, 0.05]]]);
        for (const p of pieces) {
          const dir = Math.sign(p.getWorldCenter().x - w.x) || 1;
          p.setLinearVelocity(V(dir * rand(0.5, 1), -0.5));
          p.setAngularVelocity(dir * rand(0.4, 0.9));
          p.hot = 1.2;
          setAblaze(p, 8);
        }
        sfx.zap();
        addPoints(800, 'desk incinerated', w.x, w.y - 0.3);
      }
      if (w.t > 3) w.done = true;
    } else if (w.id === 'nuke') {
      const BOOM = 4.4;
      if (w.t < BOOM && w.t >= w.nextBeep) {
        sfx.beep(w.gap < 0.15);
        w.lastBeep = w.t;
        w.gap = Math.max(0.07, w.gap * 0.8);
        w.nextBeep = w.t + w.gap;
      }
      if (!w.fired && w.t >= BOOM) {
        w.fired = true;
        sfx.nuke();
        const n = bodies.length;
        addPoints(2500 + n * 100, `${n} things vaporized`, cx, floorY - 1.2);
      }
      if (w.t >= 12.5 && state === 'flipped') {
        w.done = true;
        state = 'fadeout';
        stateT = 0;
        finishRound();
      }
    }
  }

  // The sword: a big blade swung down around a pivot above the desk.
  function drawSword(w) {
    const L = 1.75;
    const px = w.x, py = floorY - L - 0.02;
    const swing = Math.min(1, w.t / 0.3);
    const ease = swing * swing * swing;
    let a = -0.55 + (Math.PI / 2 + 0.55) * ease;
    let alpha = 1, lift = 0;
    if (w.t > 0.75) { lift = (w.t - 0.75) * 2.2; alpha = Math.max(0, 1 - (w.t - 0.75) * 2.2); }
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(px, py - lift);
    if (swing < 1) {
      // a white streak along the blade's path
      ctx.beginPath();
      ctx.arc(0, 0, L * 0.82, a - 0.9 * swing, a);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = L * 0.32;
      ctx.stroke();
    } else if (w.t < 0.55) {
      ctx.beginPath();
      ctx.arc(0, 0, L * 0.82, a - 0.5 * (1 - (w.t - 0.3) / 0.25), a);
      ctx.strokeStyle = `rgba(255,255,255,${0.5 * (1 - (w.t - 0.3) / 0.25)})`;
      ctx.lineWidth = L * 0.32;
      ctx.stroke();
    }
    ctx.rotate(a);
    // grip, pommel, crossguard
    rrect(-0.36, -0.035, 0.34, 0.07, 0.02, '#5b3a2a');
    for (let i = 0; i < 5; i++) line(-0.33 + i * 0.065, -0.035, -0.3 + i * 0.065, 0.035, '#3b2416', 0.01);
    ellipse(-0.39, 0, 0.05, 0.05, '#e0b84a');
    rrect(-0.03, -0.2, 0.06, 0.4, 0.02, '#e0b84a');
    ellipse(0, 0, 0.035, 0.035, '#e66b6b');
    // blade
    const g = ctx.createLinearGradient(0, -0.07, 0, 0.07);
    g.addColorStop(0, '#f4f6fa');
    g.addColorStop(0.5, '#b9c2cf');
    g.addColorStop(1, '#8a94a3');
    poly([[0.03, -0.07], [L - 0.2, -0.06], [L, 0], [L - 0.2, 0.06], [0.03, 0.07]], g);
    line(0.08, 0, L - 0.3, 0, 'rgba(90,100,115,0.6)', 0.014);
    line(0.1, -0.045, L - 0.4, -0.04, 'rgba(255,255,255,0.8)', 0.008);
    ctx.restore();
  }

  function drawGrenade(x, y, spin, blink) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(spin);
    ellipse(0, 0, 0.055, 0.07, '#5d6b3a');
    for (let i = -1; i <= 1; i++) line(-0.05, i * 0.025, 0.05, i * 0.025, 'rgba(0,0,0,0.25)', 0.006);
    rrect(-0.02, -0.095, 0.04, 0.03, 0.006, '#9aa0aa');
    poly([[0.015, -0.09], [0.06, -0.075], [0.055, -0.02], [0.04, -0.02], [0.045, -0.07]], '#9aa0aa');
    if (blink) ellipse(0, 0.02, 0.012, 0.012, '#ff3b3b', false);
    ctx.restore();
  }

  function drawLaser(w) {
    const out = Math.min(1, w.t / 0.35) * (w.t > 2.4 ? Math.max(0, 1 - (w.t - 2.4) / 0.5) : 1);
    if (out <= 0) return;
    const bx = w.side > 0 ? -0.1 + out * 0.55 : Wm + 0.1 - out * 0.55;
    const by = Math.max(0.6, floorY - 2.3);
    const target = w.hitP || desk.getWorldPoint(V(w.xt, -DESK_H - 0.25));
    const ang = Math.atan2(target.y - by, target.x - bx);
    // scorch trail
    for (const tr of w.trail) {
      const a = Math.max(0, 1 - tr.t / 0.8);
      if (a <= 0) continue;
      ellipse(tr.x, tr.y, 0.02, 0.02, `rgba(255,${150 + 80 * a},60,${a})`, false);
    }
    ctx.save();
    ctx.translate(bx, by);
    // mount
    rrect(-0.16 * w.side - 0.12, -0.12, 0.24, 0.24, 0.05, '#3b3a44');
    ctx.rotate(ang);
    rrect(-0.12, -0.09, 0.3, 0.18, 0.05, '#5b6170');
    rrect(0.15, -0.05, 0.32, 0.1, 0.02, '#9aa0aa');
    rrect(0.42, -0.07, 0.07, 0.14, 0.02, '#3b3a44');
    for (let i = 0; i < 3; i++) rrect(0.2 + i * 0.07, -0.055, 0.03, 0.11, 0.008, '#4fb3bf', false);
    // charging glow at the muzzle
    const charge = w.t < 0.85 ? w.t / 0.85 : w.hitP ? 1 : 0.3;
    ctx.globalCompositeOperation = 'lighter';
    ellipse(0.5, 0, 0.04 + charge * 0.06 + Math.random() * 0.015, 0.04 + charge * 0.06, `rgba(255,60,90,${0.4 + charge * 0.5})`, false);
    ellipse(0.5, 0, 0.02 + charge * 0.03, 0.02 + charge * 0.03, 'rgba(255,240,240,0.9)', false);
    if (w.t < 0.85) {
      for (let i = 0; i < 5; i++) {
        const a = clock * 6 + i * 1.26;
        const r = 0.25 * (1 - ((clock * 2 + i * 0.2) % 1));
        ellipse(0.5 + Math.cos(a) * r, Math.sin(a) * r, 0.012, 0.012, 'rgba(255,120,140,0.9)', false);
      }
    }
    ctx.restore();
    if (w.hitP) {
      const mx = bx + Math.cos(ang) * 0.5, my = by + Math.sin(ang) * 0.5;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      const wob = 1 + Math.random() * 0.3;
      for (const [wd, col] of [[0.14 * wob, 'rgba(255,40,80,0.25)'], [0.07 * wob, 'rgba(255,60,90,0.6)'], [0.025, 'rgba(255,245,245,1)']]) {
        ctx.strokeStyle = col;
        ctx.lineWidth = wd;
        ctx.beginPath();
        ctx.moveTo(mx, my);
        ctx.lineTo(w.hitP.x, w.hitP.y);
        ctx.stroke();
      }
      ellipse(w.hitP.x, w.hitP.y, 0.09 * wob, 0.09 * wob, 'rgba(255,140,60,0.7)', false);
      ellipse(w.hitP.x, w.hitP.y, 0.04, 0.04, 'rgba(255,255,230,1)', false);
      ctx.restore();
    }
  }

  function drawNukeBomb(w) {
    if (w.t > 4.4) return;
    const drop = Math.min(1, w.t / 0.35);
    const y = floorY - (1 - drop * drop) * 2.5;
    ctx.save();
    ctx.translate(w.bx, y);
    // fins, body, nose
    poly([[-0.24, 0], [-0.3, -0.08], [-0.2, -0.08]], '#3b3a44');
    rrect(-0.26, -0.2, 0.46, 0.2, 0.1, '#4a5a3a');
    ellipse(0.2, -0.1, 0.07, 0.1, '#4a5a3a');
    rrect(-0.15, -0.2, 0.025, 0.2, 0, '#e0b84a', false);
    rrect(0.08, -0.2, 0.025, 0.2, 0, '#e0b84a', false);
    // radiation symbol
    ellipse(-0.03, -0.1, 0.06, 0.06, '#f2c94e');
    ctx.fillStyle = '#1d1c22';
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(-0.03, -0.1);
      ctx.arc(-0.03, -0.1, 0.05, -Math.PI / 2 + i * 2.094 - 0.5, -Math.PI / 2 + i * 2.094 + 0.5);
      ctx.closePath();
      ctx.fill();
    }
    ellipse(-0.03, -0.1, 0.014, 0.014, '#f2c94e', false);
    // countdown readout and blinking light
    rrect(0.03, -0.27, 0.16, 0.07, 0.01, '#1d1c22');
    const left = Math.max(0, 4.4 - w.t);
    ctx.fillStyle = '#ff3b3b';
    ctx.font = 'bold 0.05px monospace';
    ctx.fillText(`0:0${Math.ceil(left)}`, 0.045, -0.218);
    const on = w.lastBeep != null && w.t - w.lastBeep < 0.06;
    ellipse(-0.2, -0.22, 0.022, 0.022, on ? '#ff3b3b' : '#6b1f1f');
    if (on) ellipse(-0.2, -0.22, 0.06, 0.06, 'rgba(255,60,60,0.35)', false);
    ctx.restore();
  }

  // World-space weapon effects, drawn above the desk and items.
  function drawWeaponWorld() {
    drawFlames();
    const w = weapon;
    if (!w) return;
    if (w.id === 'sword') drawSword(w);
    else if (w.id === 'grenade' && !w.fired) {
      const k = Math.min(1, w.t / 0.7);
      const x = w.sx + (w.tx - w.sx) * k;
      const y = w.sy + (w.ty - w.sy) * k - Math.sin(k * Math.PI) * 1.1;
      const blink = w.t > 0.7 && (w.t * 4) % 1 < 0.4;
      drawGrenade(x, y, k < 1 ? w.t * 14 : 0.3, blink);
    } else if (w.id === 'laser') drawLaser(w);
    else if (w.id === 'nuke') drawNukeBomb(w);
    else drawMouseWeapon(w);
  }

  // Screen-space overlays: flashes, and the nuke's wide shot.
  function drawWeaponScreen() {
    drawClawMarks();
    const w = weapon;
    if (!w) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (w.id === 'grenade' && w.flash > 0) {
      ctx.globalAlpha = w.flash * 0.8;
      ctx.fillStyle = '#fff8e0';
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
    if (w.id === 'nuke') {
      if (w.t < 4.4 && w.lastBeep != null) {
        // the room pulses red with each beep
        const p = Math.max(0, 1 - (w.t - w.lastBeep) / 0.25) * Math.min(1, w.t / 4) * 0.25;
        ctx.fillStyle = `rgba(255,30,30,${p})`;
        ctx.fillRect(0, 0, W, H);
      }
      if (w.t >= 4.4) {
        if (w.t > 4.6) drawMushroom(w.t - 4.6);
        // white out, then fade to reveal the wide shot
        const white = w.t < 4.6 ? (w.t - 4.4) / 0.2 : Math.max(0, 1 - (w.t - 4.9) / 1.2);
        if (white > 0) {
          ctx.globalAlpha = Math.min(1, white);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, W, H);
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  // The wide shot: a mushroom cloud rising over the horizon where the
  // office used to be. t counts from the moment the white starts to clear.
  function drawMushroom(t) {
    const k = Math.min(1, t / 7);
    const e = 1 - Math.pow(1 - k, 3);
    const jx = t < 2 ? rand(-1, 1) * (2 - t) * 4 : 0;
    const jy = t < 2 ? rand(-1, 1) * (2 - t) * 4 : 0;
    const hz = H * 0.74;
    const S = Math.min(W, H * 1.1);
    ctx.save();
    ctx.translate(jx, jy);
    // sky, brightest at the horizon early on
    const sky = ctx.createLinearGradient(0, 0, 0, hz);
    sky.addColorStop(0, '#2b2140');
    sky.addColorStop(0.6, k < 0.3 ? '#ff9a4d' : '#a8553a');
    sky.addColorStop(1, k < 0.3 ? '#fff0b0' : '#f08a4b');
    ctx.fillStyle = sky;
    ctx.fillRect(-10, -10, W + 20, hz + 10);
    // hills and the town skyline
    ctx.fillStyle = '#3d2a3a';
    ctx.beginPath();
    ctx.moveTo(-10, hz);
    for (let x = -10; x <= W + 10; x += W / 12) ctx.lineTo(x, hz - (Math.sin(x * 0.013) * 0.5 + 0.6) * H * 0.04);
    ctx.lineTo(W + 10, hz);
    ctx.fill();
    ctx.fillStyle = '#2a1e2c';
    for (let i = 0; i < 26; i++) {
      const bx = W * 0.1 + (i * W * 0.8) / 26;
      if (Math.abs(bx - W / 2) < S * 0.08 * (0.4 + e)) continue;   // flattened at ground zero
      const bh = H * (0.015 + ((i * 37) % 11) * 0.004);
      ctx.fillRect(bx, hz - bh, W * 0.022, bh);
    }
    ctx.fillStyle = '#2a1d24';
    ctx.fillRect(-10, hz, W + 20, H - hz + 10);
    // shockwave racing out along the ground
    const sw = t * S * 0.9;
    if (t < 3) {
      ctx.strokeStyle = `rgba(255,255,255,${0.6 * (1 - t / 3)})`;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.ellipse(W / 2, hz, sw, sw * 0.35, 0, Math.PI, Math.PI * 2);
      ctx.stroke();
    }
    // base surge of dust
    const baseW = S * (0.08 + 0.32 * e);
    for (let i = 0; i < 16; i++) {
      const u = i / 15 - 0.5;
      const r = S * (0.025 + 0.03 * e) * (0.8 + 0.4 * Math.sin(i * 2.7));
      ctx.fillStyle = `rgba(${150 - 40 * k},${110 - 30 * k},${90 - 20 * k},0.95)`;
      ctx.beginPath();
      ctx.arc(W / 2 + u * baseW * 2, hz - r * 0.5 + Math.sin(i + t) * 2, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // stem
    const capY = hz - H * (0.12 + 0.32 * e);
    const stemW = S * (0.03 + 0.03 * e);
    for (let y = hz; y > capY; y -= stemW * 0.5) {
      const u = (hz - y) / (hz - capY);
      const glow = Math.max(0, 1 - k * 1.5) * (1 - u * 0.5);
      ctx.fillStyle = `rgb(${Math.round(150 + 105 * glow)},${Math.round(100 + 90 * glow)},${Math.round(80 + 40 * glow)})`;
      ctx.beginPath();
      ctx.arc(W / 2 + Math.sin(y * 0.05 + t * 2) * stemW * 0.15, y, stemW * (0.75 + 0.2 * Math.sin(y * 0.11 + t)), 0, Math.PI * 2);
      ctx.fill();
    }
    // condensation ring around the stem
    if (k > 0.15) {
      const rk = Math.min(1, (k - 0.15) / 0.5);
      ctx.strokeStyle = `rgba(255,255,255,${0.55 * (1 - Math.max(0, k - 0.6) / 0.4)})`;
      ctx.lineWidth = S * 0.012;
      ctx.beginPath();
      ctx.ellipse(W / 2, hz - (hz - capY) * 0.55, stemW * (1.5 + rk * 2.5), stemW * (0.35 + rk * 0.5), 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    // the cap: a churning ring of billows around a glowing core
    const R = S * (0.06 + 0.12 * e);
    const glow = Math.max(0, 1 - k * 1.3);
    const core = ctx.createRadialGradient(W / 2, capY + R * 0.15, 0, W / 2, capY + R * 0.15, R * 1.2);
    core.addColorStop(0, `rgba(255,${200 + 55 * glow},${120 + 100 * glow},1)`);
    core.addColorStop(1, 'rgba(200,90,40,0)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.ellipse(W / 2, capY + R * 0.1, R * 1.2, R * 0.7, 0, 0, Math.PI * 2);
    ctx.fill();
    const billows = 26;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < billows; i++) {
        const a = (i / billows) * Math.PI * 2 + t * 0.25 * (pass ? -1 : 1);
        const front = Math.sin(a) > 0;
        if ((pass === 0) === front) continue;   // back half first
        const bx = W / 2 + Math.cos(a) * R * 0.95;
        const by = capY + Math.sin(a) * R * 0.38 - (front ? 0 : R * 0.1);
        const r = R * (0.42 + 0.12 * Math.sin(i * 3.1 + t * 1.3));
        const lit = Math.max(0, (Math.sin(a) + 0.3)) * glow;
        const shade = front ? 1 : 0.8;
        ctx.fillStyle = `rgb(${Math.round((140 + 115 * lit) * shade)},${Math.round((110 + 90 * lit) * shade)},${Math.round((100 + 40 * lit) * shade)})`;
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, Math.PI * 2);
        ctx.fill();
      }
      if (pass === 0) {
        // the top dome
        for (let i = 0; i < 9; i++) {
          const u = i / 8 - 0.5;
          const r = R * (0.5 + 0.1 * Math.sin(i * 2.3 + t));
          const lit = glow * (1 - Math.abs(u));
          ctx.fillStyle = `rgb(${Math.round(150 + 105 * lit)},${Math.round(120 + 80 * lit)},${Math.round(110 + 30 * lit)})`;
          ctx.beginPath();
          ctx.arc(W / 2 + u * R * 1.3, capY - R * 0.35 - Math.cos(u * Math.PI) * R * 0.25, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
    if (t > 3) {
      ctx.globalAlpha = Math.min(1, (t - 3) / 1);
      ctx.fillStyle = '#fff6e0';
      ctx.font = `700 ${Math.round(Math.min(22, W / 22))}px ui-rounded, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('The desk has been decommissioned.', W / 2, H * 0.9);
      ctx.textAlign = 'start';
      ctx.globalAlpha = 1;
    }
  }

  showBank(false);

  function addPoints(n, label, x, y) {
    if (DAMAGE[label]) logDamage(label);
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
    arsenalEl.classList.toggle('busy', state !== 'ready' && !robotWorld);
    if (state === 'ready' || state === 'fadein') {
      scoreEl.classList.remove('show');
    } else {
      scoreEl.classList.add('show');
      scoreNumEl.textContent = score.toLocaleString();
      hangEl.textContent = weapon ? arms().find((w) => w.id === weapon.id).name : `hang time ${hang.toFixed(2)}s`;
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
    bankPoints(score);
    showBank(false);
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
    stepFx(dt);
    stepFlames(dt);
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
    updateGust(dt);
    updateWeapon(dt);
    updateHole(dt);
    updateCyborg(dt);
    updateGun(dt);
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
      if (robotWorld) {
        if (robotRoundOver(dt)) { state = 'fadeout'; stateT = 0; finishRound(); }
      } else if (since > RESET_AFTER) {
        let moving = false;
        for (const b of bodies) if (b.getLinearVelocity().length() > 1.2) { moving = true; break; }
        if (!moving || since > RESET_MAX) { state = 'fadeout'; stateT = 0; finishRound(); }
      }
    } else if (state === 'fadeout') {
      fade = Math.min(1, stateT / (portal ? 0.8 : FADE));
      if (fade >= 1 && portal) { setWorld(portal.to); loadBank(); wasLocked = false; showBank(false); }
      if (fade >= 1) { buildScene(); state = 'fadein'; stateT = 0; updateScore(); }
    } else if (state === 'fadein') {
      fade = Math.max(0, 1 - stateT / (portal ? 0.8 : FADE));
      if (fade <= 0 && portal) {
        portal = null;
        toastEl.textContent = robotWorld ? 'Flip it, then shoot the pieces!' : mouseWorld ? 'Welcome to Mouse World \u{1F9C0}' : 'Back to the big world';
        toastEl.classList.remove('show');
        void toastEl.offsetWidth;
        toastEl.classList.add('show');
      }
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

  // ---------- mouse world ----------
  // Own every weapon and a mouse hole opens in the baseboard under the desk.
  // Tap it to shrink down into a world of cheese and mouse managers; tap the
  // hole again to come back.

  let portal = null;          // the iris transition through the hole
  let peekT = 0;              // something peeks out of the hole now and then
  let peekDue = 3;
  const HOLE_W = 0.17, HOLE_H = 0.2;

  const holeOpen = () => mouseWorld || robotWorld || WEAPONS.every((w) => has(w.id));
  const holeX = () => cx;

  // Switch worlds: 'human', 'mouse' or 'robot'.
  function setWorld(name) {
    mouseWorld = name === 'mouse';
    robotWorld = name === 'robot';
    document.body.dataset.world = name;
    try {
      localStorage.setItem('flippydesk.world', name);
      localStorage.setItem('flippydesk.mouse', mouseWorld ? '1' : '0');
    } catch (e) { /* storage blocked */ }
  }

  function holePath(x, w, h) {
    ctx.beginPath();
    ctx.moveTo(x - w / 2, floorY);
    ctx.lineTo(x - w / 2, floorY - h + w / 2);
    ctx.arc(x, floorY - h + w / 2, w / 2, Math.PI, 0);
    ctx.lineTo(x + w / 2, floorY);
    ctx.closePath();
  }

  function drawHole() {
    if (!holeOpen()) return;
    const x = holeX();
    // a worn rim around the opening
    holePath(x, HOLE_W + 0.03, HOLE_H + 0.015);
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fill();
    holePath(x, HOLE_W, HOLE_H);
    const g = ctx.createLinearGradient(0, floorY - HOLE_H, 0, floorY);
    g.addColorStop(0, mouseWorld ? '#fff3c4' : '#1d1622');
    g.addColorStop(1, mouseWorld ? '#f2d58a' : '#3a2c33');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = LW;
    ctx.strokeStyle = INK;
    ctx.stroke();
    // what's peeking through
    const k = peekT > 0 ? Math.sin(Math.min(1, peekT / 2.2) * Math.PI) : 0;
    if (k > 0.01) {
      ctx.save();
      holePath(x, HOLE_W, HOLE_H);
      ctx.clip();
      if (mouseWorld) {
        // a giant human eye from the world outside
        const y = floorY - HOLE_H * 0.45 + (1 - k) * 0.25;
        ellipse(x, y, 0.2, 0.11, '#fffaf0');
        ellipse(x + Math.sin(clock * 1.5) * 0.03, y, 0.075, 0.075, '#6b8fe6');
        ellipse(x + Math.sin(clock * 1.5) * 0.03, y, 0.035, 0.035, INK, false);
        ellipse(x + Math.sin(clock * 1.5) * 0.03 - 0.02, y - 0.025, 0.014, 0.014, '#fff', false);
        // blink
        if ((clock % 2.5) < 0.12) rrect(x - 0.21, y - 0.12, 0.42, 0.24, 0, '#f2c9a5');
      } else {
        ctx.translate(x, floorY + 0.02 + (1 - k) * 0.16);
        ctx.scale(0.42, 0.42);
        drawMouseHead(0, -0.25, '#9a9aa6', { twitch: true });
      }
      ctx.restore();
    }
  }

  function updateHole(dt) {
    if (!holeOpen() || state !== 'ready') { peekT = 0; return; }
    if (peekT > 0) {
      peekT += dt;
      if (peekT > 2.2) { peekT = 0; peekDue = rand(4, 9); }
    } else if ((peekDue -= dt) <= 0) {
      peekT = 0.001;
      if (!mouseWorld) sfx.squeak(0.25);
    }
  }

  // Is the screen point (px, py) on the hole? A little generous for fingers.
  function onHole(px, py) {
    if (!holeOpen()) return false;
    const x = px / ppm, y = py / ppm;
    return Math.abs(x - holeX()) < HOLE_W / 2 + 0.08 && y > floorY - HOLE_H - 0.08 && y < floorY + 0.1;
  }

  function enterHole() {
    if (state !== 'ready' || portal) return;
    // the hole always leads between the human and mouse worlds
    portal = { to: mouseWorld || robotWorld ? 'human' : 'mouse', x: holeX() * ppm, y: (floorY - HOLE_H / 2) * ppm };
    if (boss.mode === 'in') boss.mode = 'flee';
    if (pal.mode === 'in') pal.mode = 'flee';
    state = 'fadeout';
    stateT = 0;
    sfx.whoosh(0.8);
    sfx.squeak(0.5);
  }

  // Black everywhere but a circle that closes on the hole, then opens again.
  function drawPortal() {
    if (!portal || fade <= 0) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const maxR = Math.hypot(W, H);
    const r = maxR * Math.pow(1 - fade, 2);
    const x = state === 'fadeout' ? portal.x : W / 2;
    const y = state === 'fadeout' ? portal.y : H / 2;
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2, true);
    ctx.fillStyle = '#120e14';
    ctx.fill('evenodd');
  }

  // A mouse head, front on, centred at (hx, hy) in the usual person scale.
  function drawMouseHead(hx, hy, fur, o = {}) {
    for (const s of [-1, 1]) {
      const tw = o.twitch && s > 0 ? Math.sin(clock * 11) * 0.01 : 0;
      ellipse(hx + s * 0.13, hy - 0.13 + tw, 0.09, 0.09, fur);
      ellipse(hx + s * 0.13, hy - 0.13 + tw, 0.055, 0.055, '#f2a7b5', false);
    }
    if (o.bow) {
      poly([[hx + 0.16, hy - 0.2], [hx + 0.24, hy - 0.25], [hx + 0.24, hy - 0.15]], o.bow);
      poly([[hx + 0.16, hy - 0.2], [hx + 0.08, hy - 0.25], [hx + 0.08, hy - 0.15]], o.bow);
      ellipse(hx + 0.16, hy - 0.2, 0.022, 0.022, o.bow);
    }
    ellipse(hx, hy, 0.13, 0.14, fur);
    ellipse(hx, hy + 0.065, 0.075, 0.06, o.muzzle || '#f4ede6');
    // beady eyes
    for (const s of [-1, 1]) {
      ellipse(hx + s * 0.05, hy - 0.025, 0.017, o.wide ? 0.026 : 0.021, INK, false);
      ellipse(hx + s * 0.05 - 0.006, hy - 0.033, 0.006, 0.006, '#fff', false);
    }
    if (o.glasses) {
      ctx.lineWidth = 0.008;
      ctx.strokeStyle = INK;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(hx + s * 0.05, hy - 0.025, 0.035, 0, Math.PI * 2);
        ctx.stroke();
      }
      line(hx - 0.015, hy - 0.025, hx + 0.015, hy - 0.025, INK, 0.008);
    }
    // whiskers
    const wig = o.twitch ? Math.sin(clock * 14) * 0.01 : 0;
    for (const s of [-1, 1]) {
      for (const d of [-0.025, 0, 0.025]) line(hx + s * 0.04, hy + 0.06, hx + s * 0.17, hy + 0.06 + d * 1.6 + wig, 'rgba(42,39,51,0.7)', 0.005);
    }
    ellipse(hx, hy + 0.04, 0.022, 0.017, '#e8798f');
    // buck teeth and a little mouth
    rrect(hx - 0.013, hy + 0.08, 0.026, 0.022, 0.004, '#ffffff');
    line(hx, hy + 0.08, hx, hy + 0.1, 'rgba(42,39,51,0.4)', 0.004);
    ctx.beginPath();
    if (o.open) ctx.ellipse(hx, hy + 0.085, 0.022, 0.016, 0, 0, Math.PI * 2);
    else {
      ctx.arc(hx - 0.016, hy + 0.06, 0.016, 0.1 * Math.PI, 0.9 * Math.PI);
      ctx.moveTo(hx + 0.032, hy + 0.06);
      ctx.arc(hx + 0.016, hy + 0.06, 0.016, 0.1 * Math.PI, 0.9 * Math.PI);
    }
    ctx.lineWidth = 0.008;
    ctx.strokeStyle = INK;
    ctx.stroke();
  }

  // A long pink tail, curling out from behind at hip height.
  function drawTail(dir, swish) {
    ctx.beginPath();
    ctx.moveTo(0, -0.75);
    ctx.bezierCurveTo(dir * 0.3, -0.7, dir * 0.35, -0.15 + swish, dir * 0.55, -0.25 + swish);
    ctx.lineCap = 'round';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 0.034;
    ctx.stroke();
    ctx.strokeStyle = '#f2a7b5';
    ctx.lineWidth = 0.018;
    ctx.stroke();
  }

  const MOUSE_BOSS_LINES = [
    'Who moved my cheese? Seriously. Who.',
    'Quick sync on the cheese report?',
    'We need way more cheddar in Q3.',
    'Let’s circle back after nap time.',
    'Per my last squeak...',
    'The cat is doing a reorg. Keep your head down.',
    'Can you nibble through these numbers by Friday?',
    'Big win, team! Anyway, the crumb budget is cut.',
    'No running on the wheel during all-hands.',
    'Mandatory cheese tasting at 4. Bring crackers.',
    'Need that maze mapped by end of day.',
    'Swiss is not a strategy. Holes are not a feature.',
    'Gouda job last quarter. Now do it again, but brie-ter.',
    'Who left a trap in the break room? Again?',
    'Can you squeak up in meetings? We can’t hear you.',
  ];
  const MOUSE_BOSS_LOOKS = [
    { pitch: 2.1, shirt: '#cfe0f5', legs: '#4a4f5c', accent: '#e66b6b', skin: '#9a9aa6', she: false, glasses: true },
    { pitch: 2.6, shirt: '#3d4a6b', legs: '#3d4a6b', accent: '#f2c14e', skin: '#a77b5a', she: true, bow: '#e66b6b' },
    { pitch: 2.5, shirt: '#8a3d55', legs: '#2f2c38', accent: '#e8e2d6', skin: '#ece8e2', she: true, bow: '#6b8fe6' },
  ];
  const MOUSE_PAL_LINES = [
    'Okay so I found a crumb THIS big.',
    'Wanna see 400 pictures of my nest?',
    'Have you tried the wheel? Life changing.',
    'Is this your cheese? It’s mine now.',
    'My cousin lives in a museum wall. Very fancy.',
    'Did you hear about the cat thing? Huge drama.',
    'I’m starting a podcast. It’s just squeaking.',
  ];
  const MOUSE_PAL_LOOKS = [
    { hair: '#6b3f22', hoodie: '#7cc58f', skin: '#a77b5a', pants: '#4a4f5c' },
    { hair: '#e0b84a', hoodie: '#b48be0', skin: '#ece8e2', pants: '#3d4a6b' },
    { hair: '#1d1c22', hoodie: '#f08a4b', skin: '#9a9aa6', pants: '#2f2c38' },
  ];

  // Rooms on the mouse side of the wall.
  const MOUSE_ROOMS = {
    burrow: {
      ink: '#3a2a1e', fade: '#e9d3ad', mouse: true,
      draw() {
        wall('#e2c497', '#cfa877');
        // wall studs with nail heads
        for (let x = 0.25; x < Wm; x += 0.95) {
          rrect(x, -0.05, 0.16, floorY + 0.05, 0, 'rgba(120,80,40,0.16)', false);
          for (let y = 0.4; y < floorY; y += 0.7) ellipse(x + 0.08, y, 0.012, 0.012, 'rgba(60,45,40,0.5)', false);
        }
        // a hanging fairy-light bulb
        const bx = cx - DESK_W / 2 + 0.35;
        line(bx, 0, bx, 0.45, 'rgba(42,39,51,0.6)', 0.008);
        const glow = 0.8 + 0.2 * Math.sin(clock * 2.3);
        ctx.fillStyle = `rgba(255,214,120,${0.18 * glow})`;
        ctx.beginPath();
        ctx.arc(bx, 0.55, 0.3, 0, Math.PI * 2);
        ctx.fill();
        rrect(bx - 0.025, 0.43, 0.05, 0.05, 0.008, '#4a8a5a');
        ellipse(bx, 0.55, 0.05, 0.08, '#ffd678');
        // a postage stamp, hung as art
        const w = windowSpot();
        if (w.wh > 0.35) {
          const sw = Math.min(w.ww * 0.7, w.wh * 0.85), sh = w.wh;
          const sx = w.wx + (w.ww - sw) / 2, sy = w.wy;
          rrect(sx, sy, sw, sh, 0, '#fffaf0');
          ctx.fillStyle = '#d9b98a';
          for (let t = 0.03; t < sw; t += 0.06) {
            for (const yy of [sy, sy + sh]) { ctx.beginPath(); ctx.arc(sx + t, yy, 0.016, 0, Math.PI * 2); ctx.fill(); }
          }
          for (let t = 0.03; t < sh; t += 0.06) {
            for (const xx of [sx, sx + sw]) { ctx.beginPath(); ctx.arc(xx, sy + t, 0.016, 0, Math.PI * 2); ctx.fill(); }
          }
          rrect(sx + 0.06, sy + 0.06, sw - 0.12, sh - 0.12, 0, '#7fb8d8', false);
          cheeseIcon(sx + sw / 2, sy + sh * 0.45, Math.min(sw, sh) * 0.22);
          label('5¢', sx + sw - 0.13, sy + 0.14, 0.06, '#fff');
          label('SQUEAK POST', sx + sw / 2, sy + sh - 0.1, Math.min(0.05, sw * 0.1), '#fff');
        }
        floor('#a0703f', 'rgba(0,0,0,0.1)', '#7a5232');
      },
    },
    pantry: {
      ink: '#2a2733', fade: '#efe6d2', mouse: true,
      draw() {
        wall('#f4ecda', '#e6d9bd');
        // a giant soup can and cereal box looming behind the desk
        const w = windowSpot();
        const canW = Math.min(1.2, Wm * 0.36);
        const canX = w.wx + w.ww - canW;
        const canTop = Math.max(0.1, floorY - DESK_H - 1.1);
        rrect(canX, canTop, canW, floorY - canTop + 0.1, 0.03, '#c9ccd3');
        rrect(canX, canTop + 0.12, canW, (floorY - canTop) * 0.55, 0, '#d94a4a');
        rrect(canX, canTop + 0.12 + (floorY - canTop) * 0.4, canW, 0.06, 0, '#fff6e0', false);
        label('CHEESE', canX + canW / 2, canTop + 0.12 + (floorY - canTop) * 0.25, Math.min(0.16, canW * 0.17), '#fff6e0');
        label('SOUP', canX + canW / 2, canTop + 0.12 + (floorY - canTop) * 0.36, Math.min(0.09, canW * 0.1), '#fff6e0');
        for (let y = canTop + 0.04; y < canTop + 0.12; y += 0.03) line(canX, y, canX + canW, y, 'rgba(0,0,0,0.12)', 0.006);
        const boxX = cx - DESK_W / 2 - 0.25;
        rrect(boxX, canTop + 0.25, 0.85, floorY - canTop, 0.02, '#f2c14e');
        label('O’s', boxX + 0.42, canTop + 0.6, 0.14, '#d94a4a');
        for (let i = 0; i < 4; i++) ellipse(boxX + 0.2 + i * 0.14, canTop + 0.85 + (i % 2) * 0.08, 0.05, 0.05, '#e9a92c');
        // shelf paper floor
        floor('#e9e1cf', null, '#c9b996');
        ctx.fillStyle = 'rgba(217,74,74,0.22)';
        for (let x = 0; x < Wm; x += 0.24) ctx.fillRect(x, floorY, 0.12, Hm - floorY);
      },
    },
  };
  Object.assign(ROOMS, MOUSE_ROOMS);

  // The mouse desk is cut from cheese, or from a wine cork.
  const MOUSE_WOODS = [
    { top: CHEESE, side: CHEESE_RIND, grain: 'rgba(200,130,20,0.35)', holes: true },
    { top: CHEESE, side: CHEESE_RIND, grain: 'rgba(200,130,20,0.35)', holes: true },
    { top: '#fbe08a', side: CHEESE, grain: 'rgba(200,130,20,0.3)', holes: true },
    { top: '#c99b62', side: '#b0844f', grain: 'rgba(90,50,20,0.25)', holes: false },
  ];

  // ---------- robot world ----------
  // Unlock the whole Mouse Armory and, now and then, a monitor asks to play
  // a game. Say yes and a cyborg walks in and tosses you a shotgun. In the
  // robot world a flip pulls the camera back so you can blast the bits as
  // they fall.

  let zoom = 1;
  let cyborg = null;          // the cutscene: { t }
  let gameScreen = null;      // the monitor asking to play
  const gun = { kick: 0, last: -9, aim: null, combo: 0 };
  let tracers = [];
  const ZOOM_OUT = 0.55;
  let lift = 0;               // meters the camera has risen to follow the pieces up
  let downT = 0;
  let speedCap = 0;           // top speed for flying pieces just after a robot launch              // how long everything has been back on the ground

  // Only things in the air can be shot: not on the floor, and not resting
  // on something else.
  function airborne(b) {
    if (!b.isAwake()) return false;   // settled, maybe hanging off a joint
    if (b.getWorldCenter().y > floorY + 0.5) return false;   // knocked through the floor
    let touching = false;
    for (let ce = b.getContactList(); ce; ce = ce.next) {
      const c = ce.contact;
      if (!c.isTouching()) continue;
      if (c.getFixtureA() === floorFix || c.getFixtureB() === floorFix) return false;
      touching = true;
    }
    return !touching || b.getLinearVelocity().length() > 1;
  }

  // Robot rounds end a couple of seconds after the last piece comes down.
  // Anything still moving well clear of the floor counts as not down yet.
  function robotRoundOver(dt) {
    // The desk can kick its passengers far too hard on the way up; keep them
    // within reach of the camera.
    if (speedCap && stateT < 0.6) {
      for (const b of bodies) {
        const v = b.getLinearVelocity(), sp = v.length();
        if (b !== desk && sp > speedCap) b.setLinearVelocity(V(v.x * speedCap / sp, v.y * speedCap / sp));
      }
    }
    const up = grab || stateT < 1 || bodies.some((b) => b.kind !== 'shard' && b.isAwake() &&
      b.getWorldCenter().y < floorY - 0.6 && b.getLinearVelocity().length() > 0.8 && airborne(b));
    downT = up ? 0 : downT + dt;
    return downT > 1.5 || stateT > 9;
  }

  function mouseArmoryDone() {
    if (TRY_ALL) return true;
    let ids = [];
    try { ids = JSON.parse(localStorage.getItem('flippydesk.mouse.owned')) || []; } catch (e) { ids = []; }
    ids = ids.map((id) => MOUSE_MOVED[id] || id);
    return MOUSE_WEAPONS.every((w) => ids.includes(w.id));
  }

  // Called for each new desk: sometimes one monitor wants to play.
  function pickGameScreen() {
    gameScreen = null;
    if (robotWorld || !mouseArmoryDone() || !chance(0.35)) return;
    const screens = bodies.filter((b) => b.screen);
    if (!screens.length) return;
    gameScreen = pick(screens);
    gameScreen.game = true;
  }

  function drawGameFace(x, y, w, h) {
    rrect(x, y, w, h, 0.012, '#05140a', false);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    const fs = Math.min(h * 0.17, w * 0.1);
    ctx.font = `bold ${fs}px ui-monospace, Menlo, monospace`;
    ctx.fillStyle = '#5dff8a';
    ctx.shadowColor = '#5dff8a';
    ctx.shadowBlur = 8;
    ctx.fillText('LET’S PLAY', x + w * 0.08, y + h * 0.38);
    ctx.fillText('A GAME?' + (clock % 1 < 0.5 ? ' █' : ''), x + w * 0.08, y + h * 0.38 + fs * 1.3);
    ctx.restore();
  }

  // A terminal: green text on black.
  function drawTerminalFace(x, y, w, h, lines) {
    rrect(x, y, w, h, 0.012, '#05140a', false);
    const k = h / 0.32;
    lines.forEach(([a, c], i) => line(x + 0.04 * k + a * k * 0.5, y + 0.05 * k + i * 0.04 * k, x + 0.04 * k + (a + c) * k * 0.9, y + 0.05 * k + i * 0.04 * k, '#3fcf6a', 0.012 * k));
    if (clock % 1 < 0.5) rrect(x + 0.04 * k, y + 0.05 * k + lines.length * 0.04 * k - 0.012 * k, 0.025 * k, 0.025 * k, 0, '#5dff8a', false);
  }

  // Screen point to world point, allowing for the zoom.
  function toWorld(px, py) {
    return { x: cx + (px - W / 2) / (ppm * zoom), y: floorY - (floorY * ppm - py) / (ppm * zoom) - lift };
  }

  function onGameScreen(px, py) {
    if (!gameScreen || gameScreen.dead || state !== 'ready' || cyborg) return false;
    const p = toWorld(px, py);
    const l = gameScreen.getLocalPoint(V(p.x, p.y));
    const s = gameScreen.screen;
    return l.x > s.x - 0.04 && l.x < s.x + s.w + 0.04 && l.y > s.y - 0.04 && l.y < s.y + s.h + 0.04;
  }

  function startCyborg() {
    if (cyborg || portal || state !== 'ready') return;
    cyborg = { t: 0, steps: 0 };
    if (boss.mode === 'in') boss.mode = 'flee';
    if (pal.mode === 'in') pal.mode = 'flee';
    sfx.boot();
  }

  function updateCyborg(dt) {
    if (!cyborg) return;
    const c = cyborg;
    c.t += dt;
    if (c.t < 2 && c.t > 0.3 + c.steps * 0.5) { c.steps++; sfx.thud(0.9, 1); shake = Math.max(shake, 0.15); }
    if (c.t > 2.1 && !c.said) { c.said = true; sfx.mumble(7, 0.45); }
    if (c.t > 3.1 && !c.threw) { c.threw = true; sfx.whoosh(1.5); }
    if (c.t > 4.1 && !portal) {
      portal = { to: 'robot', x: W / 2, y: H / 2 };
      state = 'fadeout';
      stateT = 0;
      sfx.pump();
    }
  }

  function drawCyborg() {
    if (!cyborg) return;
    const c = cyborg;
    const stop = Wm - Math.min(0.85, Wm * 0.25);
    const x = Wm + 0.6 + (stop - Wm - 0.6) * Math.min(1, c.t / 2);
    const step = c.t < 2 ? Math.sin(c.t * 6.3) : 0;
    const S = 1.12;
    ctx.save();
    ctx.translate(x, floorY);
    ctx.scale(S, S);
    // boots and jeans
    line(-0.07, -0.85, -0.07 + step * 0.08, -0.04, INK, 0.13);
    line(-0.07, -0.85, -0.07 + step * 0.08, -0.04, '#2f3340', 0.1);
    line(0.07, -0.85, 0.07 - step * 0.08, -0.04, INK, 0.13);
    line(0.07, -0.85, 0.07 - step * 0.08, -0.04, '#2f3340', 0.1);
    rrect(-0.15 + step * 0.08, -0.06, 0.16, 0.06, 0.02, '#1d1c22');
    rrect(-0.01 - step * 0.08, -0.06, 0.16, 0.06, 0.02, '#1d1c22');
    // leather jacket over a grey tee
    rrect(-0.22, -1.42, 0.44, 0.66, 0.06, '#1d1c22');
    poly([[-0.07, -1.42], [0.07, -1.42], [0.04, -1.1], [-0.04, -1.1]], '#7d8796');
    poly([[-0.07, -1.42], [-0.16, -1.25], [-0.04, -1.1]], '#2f2c38');
    poly([[0.07, -1.42], [0.16, -1.25], [0.04, -1.1]], '#2f2c38');
    line(0.12, -1.0, 0.12, -0.8, '#9aa0aa', 0.008);
    // arms: one holds the shotgun until the throw
    const throwing = c.t > 2.9 && c.t < 3.4;
    const thrown = c.t >= 3.1;
    line(0.18, -1.36, 0.26, -1.0, '#1d1c22', 0.12);
    if (throwing) line(-0.18, -1.36, -0.45, -1.6, '#1d1c22', 0.12);
    else line(-0.18, -1.36, -0.32, -1.02, '#1d1c22', 0.12);
    if (!thrown) {
      ctx.save();
      ctx.translate(throwing ? -0.45 : -0.32, throwing ? -1.6 : -1.02);
      ctx.rotate(throwing ? -0.9 : 0.2);
      drawShotgunShape(0.9);
      ctx.restore();
    }
    // head: flat-top hair, square jaw, dark shades with a red glint
    rrect(-0.12, -1.68, 0.24, 0.27, 0.05, '#e3b48f');
    rrect(-0.125, -1.72, 0.25, 0.07, 0.015, '#3b2a20');
    rrect(-0.11, -1.6, 0.22, 0.055, 0.02, '#111');
    ellipse(0.05, -1.575, 0.012, 0.012, `rgba(255,40,40,${0.6 + 0.4 * Math.sin(clock * 6)})`, false);
    line(-0.04, -1.47, 0.04, -1.47, '#7a4a35', 0.008);
    ctx.restore();
    // the line
    if (c.t > 2.1 && c.t < 4.2) {
      ctx.save();
      ctx.font = '600 0.07px ui-rounded, system-ui, sans-serif';
      const text = 'Come with me if you want to flip.';
      const bw = Math.min(ctx.measureText(text).width + 0.12, Wm - 0.2);
      const bx = clamp(x - bw - 0.1, 0.1, Wm - bw - 0.1), by = Math.max(0.15, floorY - 2.15 * S);
      rrect(bx, by, bw, 0.13, 0.05, '#ffffff');
      ctx.fillStyle = INK;
      ctx.fillText(text, bx + 0.06, by + 0.09, bw - 0.12);
      ctx.restore();
    }
  }

  // A pump shotgun, pointing along +x from the grip, in local units of `s` meters.
  function drawShotgunShape(s) {
    ctx.save();
    ctx.scale(s, s);
    poly([[-0.22, 0.02], [-0.02, -0.02], [0.02, 0.03], [-0.2, 0.09]], '#6b4329');
    rrect(-0.03, -0.035, 0.18, 0.05, 0.01, '#2a2d36');
    rrect(0.12, -0.03, 0.5, 0.025, 0.006, '#3b3f4a');
    rrect(0.12, -0.005, 0.42, 0.02, 0.006, '#2a2d36');
    rrect(0.26, -0.015, 0.14, 0.04, 0.012, '#8a5a3b');
    ctx.restore();
  }

  // The thrown shotgun flies at the camera, then the gun stays in your hands.
  function drawCyborgScreen() {
    if (!cyborg || cyborg.t < 3.1) return;
    const k = Math.min(1, (cyborg.t - 3.1) / 0.9);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sx = W * 0.75 + (W * 0.6 - W * 0.75) * k, sy = H * 0.35 + (H * 0.75 - H * 0.35) * k - Math.sin(k * Math.PI) * H * 0.15;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(-k * Math.PI * 3);
    drawShotgunShape(ppm * (0.9 + k * 2.5) / 1);
    ctx.restore();
  }

  // ----- the guns -----


  const GUNS = {
    shotgun: { wait: 0.32, reach: 0.06, pellets: 7 },
    minigun: { wait: 0.075, reach: 0.04, pellets: 1 },
    plasma: { wait: 0.6 },
    rocket: { wait: 0.85 },
  };

  function equipGun(id) {
    gunId = id === 'shotgun' || has(id) ? id : 'shotgun';
    try { localStorage.setItem('flippydesk.robot.gun', gunId); } catch (e) { /* private mode */ }
    showBank(false);
  }

  // In the robot world the arsenal is a gun rack: tap one to switch.
  function showGuns() {
    if (gunId !== 'shotgun' && !has(gunId)) gunId = 'shotgun';
    for (const w of [SHOTGUN, ...ROBOT_ARMS.filter((x) => x.gear === 'gun' && has(x.id))]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = w.icon;
      b.title = w.name;
      b.className = w.id === gunId ? 'on' : '';
      b.setAttribute('aria-label', `Switch to the ${w.name}`);
      b.setAttribute('aria-pressed', String(w.id === gunId));
      b.addEventListener('click', () => { sfx.unlock(); sfx.pump(); equipGun(w.id); });
      arsenalEl.appendChild(b);
    }
    arsenalEl.classList.toggle('busy', false);
  }

  // Where the gun's muzzle is on screen, pointing at (px, py).
  function muzzleAt(px, py) {
    const S = Math.min(W, H) / 700;
    const gx = W - 40 * S, gy = H + 10 * S;
    const ang = Math.atan2(py - gy, px - gx);
    const len = gunId === 'rocket' ? 300 : gunId === 'minigun' ? 310 : 330;
    return { x: gx + Math.cos(ang) * len * S, y: gy + Math.sin(ang) * len * S, ang };
  }

  // Shots that hit the desk in the air bounce it back up too.
  function shootDesk(p, push) {
    if (!airborne(desk)) return false;
    for (let f = desk.getFixtureList(); f; f = f.getNext()) {
      if (!f.testPoint(V(p.x, p.y))) continue;
      const v = desk.getLinearVelocity();
      desk.setLinearVelocity(V(v.x * 0.6 + rand(-0.5, 0.5), Math.min(v.y, 0) - push));
      desk.setAngularVelocity(desk.getAngularVelocity() + rand(-3, 3));
      desk.hit = Math.max(desk.hit || 0, 5);
      gun.combo++;
      const c = desk.getWorldCenter();
      addPoints(200 * Math.min(5, gun.combo), 'desk juggle!', c.x, c.y - 0.3);
      return true;
    }
    return false;
  }

  // Everything airborne within reach of p.
  function targetsAt(p, reach) {
    const out = [];
    for (const b of bodies) {
      if (b === desk || b.kind === 'shard' || !airborne(b)) continue;
      const c = b.getWorldCenter();
      let hit = Math.hypot(c.x - p.x, c.y - p.y) < reach + 0.09;
      for (let f = b.getFixtureList(); f && !hit; f = f.getNext()) {
        for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]]) {
          if (f.testPoint(V(p.x + dx * reach, p.y + dy * reach))) { hit = true; break; }
        }
      }
      if (hit) out.push(b);
    }
    return out;
  }

  // An explosive shell or a rocket going off: blasts every airborne piece
  // nearby and shoves the rest.
  function explodeAt(x, y, radius, spare) {
    fireball(x, y, radius > 0.6 ? 14 : 6, radius);
    sfx.boom(radius > 0.6 ? 1 : 0.4);
    shake = Math.max(shake, radius > 0.6 ? 0.8 : 0.3);
    let n = 0;
    for (const b of targetsAt({ x, y }, radius)) { if (b !== spare) { blastBody(b); n++; } }
    blast(x, y, radius * 1.5, radius);
    return n;
  }

  function shoot(px, py) {
    const g = GUNS[gunId] || GUNS.shotgun;
    if (clock - gun.last < g.wait * (has('pump') ? 0.5 : 1)) return;
    gun.last = clock;
    gun.kick = gunId === 'minigun' ? 0.5 : 1;
    gun.aim = { x: px, y: py };
    const p = toWorld(px, py);
    let hits = 0;
    if (gunId === 'plasma') {
      // straight through everything from the muzzle to the edge of the screen
      sfx.zap();
      const m = muzzleAt(px, py);
      const far = { x: m.x + Math.cos(m.ang) * (W + H) * 2, y: m.y + Math.sin(m.ang) * (W + H) * 2 };
      beams.push({ x0: m.x, y0: m.y, x1: far.x, y1: far.y, t: 0 });
      const a = toWorld(m.x, m.y), z = toWorld(far.x, far.y);
      const len = Math.hypot(z.x - a.x, z.y - a.y), seen = new Set();
      for (let d = 0; d < len; d += 0.06) {
        const q = { x: a.x + (z.x - a.x) * d / len, y: a.y + (z.y - a.y) * d / len };
        for (const b of targetsAt(q, has('choke') ? 0.08 : 0.03)) {
          if (seen.has(b)) continue;
          seen.add(b);
          juggle(b, { x: b.getWorldCenter().x, y: b.getWorldCenter().y + 0.1 }, 1.2);
          hits++;
        }
        if (!seen.has(desk) && shootDesk(q, 5)) { seen.add(desk); hits++; }
      }
    } else if (gunId === 'rocket') {
      sfx.whoosh(1.5);
      const m = muzzleAt(px, py);
      rockets.push({ sx: m.x, sy: m.y, tx: p.x, ty: p.y, t: 0 });
      return;
    } else {
      if (gunId === 'minigun') sfx.brrt(); else { sfx.shotgun(); setTimeout(() => sfx.pump(), 180); }
      const reach = g.reach * (has('choke') ? 2.2 : 1);
      tracers.push({ x: px, y: py, t: 0, spread: Array.from({ length: g.pellets }, () => [rand(-14, 14) * (reach / 0.06), rand(-14, 14) * (reach / 0.06)]) });
      for (const b of targetsAt(p, reach)) {
        const c = b.getWorldCenter();
        juggle(b, p, gunId === 'minigun' ? 0.75 : 1);
        hits++;
        if (has('shells')) hits += explodeAt(c.x, c.y, 0.45, b);
      }
      if (!hits && shootDesk(p, gunId === 'minigun' ? 1.5 : 5)) {
        hits = 1;
        if (has('shells')) explodeAt(p.x, p.y, 0.45);
      }
    }
    if (!hits) gun.combo = 0;
    sparkBurst(p.x, p.y, hits ? 18 : 6);
  }

  function updateShots(dt) {
    for (const b of beams) b.t += dt;
    beams = beams.filter((b) => b.t < 0.3);
    for (const r of rockets) {
      r.t += dt;
      if (r.t >= 0.28 && !r.done) {
        r.done = true;
        if (!explodeAt(r.tx, r.ty, has('choke') ? 1.4 : 1.05)) gun.combo = 0;
        shootDesk({ x: r.tx, y: r.ty }, 7);
      }
    }
    rockets = rockets.filter((r) => !r.done);
    if (firing && robotWorld && state === 'flipped' && gunId === 'minigun') shoot(firing.x, firing.y);
    if (state !== 'flipped') firing = null;
  }

  // A hit knocks a piece back up into the air. Each juggle of the same piece
  // is worth more, and the sixth one blows it apart.
  const JUGGLE_MAX = 6;

  function juggle(b, from, power = 1) {
    if (!bodies.includes(b)) return;
    b.juggles = (b.juggles || 0) + 1;
    if (b.juggles >= JUGGLE_MAX) return blastBody(b);
    const c = b.getWorldCenter();
    gun.combo++;
    const mult = Math.min(5, gun.combo);
    addPoints(150 * b.juggles * mult, b.juggles > 1 ? `juggle x${b.juggles}${mult > 1 ? ` \u00b7 combo x${mult}` : ''}` : mult > 1 ? `airborne x${mult}!` : 'airborne!', c.x, c.y);
    const v = b.getLinearVelocity();
    b.setLinearVelocity(V(clamp(v.x * 0.4 + (c.x - from.x) * 12 + rand(-1, 1), -4, 4), -(7 + b.juggles * 1.2) * power));
    b.setAngularVelocity(rand(-14, 14));
    b.hit = Math.max(b.hit || 0, 2);
    booms.push({ x: c.x, y: c.y, vx: 0, vy: 0, r: 0.08, t: 0, life: 0.2 });
  }

  function blastBody(b) {
    if (!bodies.includes(b)) return;   // already blown up by a neighbor
    const c = b.getWorldCenter();
    gun.combo++;
    const mult = Math.min(5, gun.combo);
    const j = b.juggles || 0;
    logDamage('blasted');
    addPoints((300 + j * 250) * mult, j ? `juggled x${j}, kaboom!` : mult > 1 ? `airborne x${mult}!` : 'airborne!', c.x, c.y);
    spawnShards(b, b.getLocalCenter().x, b.getLocalCenter().y, 5, pick([CHROME, '#3b3a44', '#e66b6b', '#f2c14e']));
    for (let i = 0; i < 4; i++) smoke.push({ x: c.x + rand(-0.05, 0.05), y: c.y, r: rand(0.04, 0.07), t: -rand(0, 0.2), life: rand(1, 1.8), vx: rand(-0.2, 0.2), shade: rand(60, 100) });
    booms.push({ x: c.x, y: c.y, vx: 0, vy: 0, r: 0.12, t: 0, life: 0.3 });
    if (b.coffee > 0) spill(b, 20);
    if (cats.length) wakeCats();
    world.destroyBody(b);
    const i = bodies.indexOf(b);
    if (i >= 0) bodies.splice(i, 1);
  }

  function updateGun(dt) {
    let target = 1, rise = 0;
    if (robotWorld && state === 'flipped' && !grab) {
      // pull back, and rise to follow the desk up
      target = ZOOM_OUT;
      rise = Math.max(0, (floorY - floorY / zoom) - (desk.getWorldCenter().y - 1));
    }
    zoom += (target - zoom) * Math.min(1, dt * (target < zoom ? 6 : 1.5));
    if (Math.abs(zoom - target) < 0.001) zoom = target;
    lift += (rise - lift) * Math.min(1, dt * 8);
    if (lift < 0.001) lift = 0;
    gun.kick = Math.max(0, gun.kick - dt * 4);
    for (const t of tracers) t.t += dt;
    tracers = tracers.filter((t) => t.t < 0.15);
    if (state !== 'flipped') gun.combo = 0;
    updateShots(dt);
  }

  // Your gun, bottom right, in screen space.
  function drawGun() {
    if (!robotWorld || cyborg) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const S = Math.min(W, H) / 700;
    const gx = W - 40 * S, gy = H + 10 * S;
    const aim = (firing || (gun.aim && clock - gun.last < 1.2 && gun.aim)) || { x: W * 0.4, y: H * 0.35 };
    const m = muzzleAt(aim.x, aim.y), ang = m.ang;
    for (const t of tracers) {
      ctx.strokeStyle = `rgba(255,230,150,${1 - t.t / 0.15})`;
      ctx.lineWidth = 2 * S;
      for (const [dx, dy] of t.spread) {
        ctx.beginPath();
        ctx.moveTo(m.x, m.y);
        ctx.lineTo(t.x + dx * S, t.y + dy * S);
        ctx.stroke();
      }
      ctx.fillStyle = `rgba(255,240,200,${0.8 * (1 - t.t / 0.15)})`;
      ctx.beginPath();
      ctx.arc(t.x, t.y, 26 * S, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const b of beams) {
      const k = 1 - b.t / 0.3;
      ctx.lineCap = 'round';
      for (const [wd, c] of [[34, `rgba(80,220,255,${0.25 * k})`], [16, `rgba(140,240,255,${0.7 * k})`], [5, `rgba(255,255,255,${k})`]]) {
        ctx.strokeStyle = c;
        ctx.lineWidth = wd * S * (0.6 + k * 0.4);
        ctx.beginPath();
        ctx.moveTo(b.x0, b.y0);
        ctx.lineTo(b.x1, b.y1);
        ctx.stroke();
      }
      ctx.lineCap = 'butt';
    }
    for (const r of rockets) {
      // fly from the muzzle to where the target is on screen now
      const k = Math.min(1, r.t / 0.28);
      const tx = W / 2 + (r.tx - cx) * ppm * zoom, ty = floorY * ppm - (floorY - r.ty - lift) * ppm * zoom;
      const x = r.sx + (tx - r.sx) * k, y = r.sy + (ty - r.sy) * k;
      const a = Math.atan2(ty - r.sy, tx - r.sx);
      ctx.strokeStyle = 'rgba(200,200,200,0.5)';
      ctx.lineWidth = 10 * S;
      ctx.beginPath();
      ctx.moveTo(r.sx, r.sy);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a);
      ctx.fillStyle = '#ffb33d';
      ctx.beginPath();
      ctx.moveTo(-30 * S, 0);
      ctx.lineTo(-60 * S - rand(0, 20) * S, -8 * S);
      ctx.lineTo(-60 * S - rand(0, 20) * S, 8 * S);
      ctx.fill();
      ctx.fillStyle = '#5b6b3a';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2 * S;
      ctx.beginPath();
      ctx.roundRect(-30 * S, -8 * S, 50 * S, 16 * S, 8 * S);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    ctx.translate(gx - Math.cos(ang) * gun.kick * 30 * S, gy - Math.sin(ang) * gun.kick * 30 * S);
    ctx.rotate(ang - gun.kick * 0.15);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3 * S;
    const rr = (x, y, w, h, r, c) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fillStyle = c; ctx.fill(); ctx.stroke(); };
    let tip = 340;
    if (gunId === 'minigun') {
      tip = 310;
      rr(-40 * S, -26 * S, 130 * S, 48 * S, 12 * S, '#3b3f4a');
      rr(60 * S, -40 * S, 50 * S, 20 * S, 8 * S, '#d9a520');
      const spin = clock * (firing ? 40 : 2);
      for (let i = 0; i < 3; i++) rr(90 * S, (-18 + 12 * i + Math.sin(spin + i * 2.1) * 3) * S, 220 * S, 10 * S, 4 * S, i === 1 ? '#5b6170' : '#2a2d36');
      rr(250 * S, -24 * S, 20 * S, 48 * S, 4 * S, '#20242e');
    } else if (gunId === 'plasma') {
      rr(-40 * S, -24 * S, 140 * S, 44 * S, 16 * S, '#e8eaee');
      rr(90 * S, -18 * S, 230 * S, 32 * S, 14 * S, '#c9ccd3');
      const glow = 0.5 + 0.5 * Math.sin(clock * 6);
      for (let i = 0; i < 4; i++) rr((130 + i * 45) * S, -14 * S, 22 * S, 24 * S, 8 * S, `rgba(80,220,255,${0.5 + glow * 0.5})`);
      rr(310 * S, -10 * S, 30 * S, 16 * S, 6 * S, '#2a2d36');
    } else if (gunId === 'rocket') {
      tip = 300;
      rr(-20 * S, -30 * S, 320 * S, 56 * S, 22 * S, '#5b6b3a');
      rr(40 * S, 20 * S, 26 * S, 40 * S, 6 * S, '#2a2d36');
      rr(120 * S, -46 * S, 60 * S, 20 * S, 6 * S, '#2a2d36');
      rr(280 * S, -34 * S, 30 * S, 64 * S, 10 * S, '#3b3f4a');
    } else {
      const pump = clock - gun.last > 0.18 && clock - gun.last < 0.42 ? -Math.sin(((clock - gun.last - 0.18) / 0.24) * Math.PI) * 50 * S : 0;
      rr(-40 * S, -22 * S, 120 * S, 40 * S, 10 * S, '#6b4329');
      rr(70 * S, -24 * S, 90 * S, 30 * S, 6 * S, '#2a2d36');
      rr(150 * S, -20 * S, 190 * S, 14 * S, 4 * S, '#3b3f4a');
      rr(150 * S, -5 * S, 160 * S, 12 * S, 4 * S, '#2a2d36');
      rr(190 * S + pump, -12 * S, 80 * S, 26 * S, 8 * S, '#8a5a3b');
    }
    if (gun.kick > 0.45 && gunId !== 'plasma') {
      ctx.fillStyle = '#fff1a8';
      ctx.beginPath();
      ctx.moveTo(tip * S, -2 * S);
      const big = gunId === 'minigun' ? 0.6 : 1;
      for (let i = 0; i < 9; i++) {
        const a = -0.9 + (i / 8) * 1.8, r = (i % 2 ? 40 : 90) * S * big;
        ctx.lineTo(tip * S + Math.cos(a) * r, -2 * S + Math.sin(a) * r);
      }
      ctx.fill();
    }
    ctx.restore();
  }

  // ----- robot looks -----

  function drawRobotHead(hx, hy, metal, o = {}) {
    line(hx, hy - 0.15, hx + 0.02, hy - 0.25, INK, 0.012);
    ellipse(hx + 0.02, hy - 0.26, 0.02, 0.02, blink(hx * 7, 2) ? '#e04a55' : '#6b1f1f');
    for (const s of [-1, 1]) rrect(hx + s * 0.14 - 0.025, hy - 0.06, 0.05, 0.09, 0.015, '#7d8796');
    rrect(hx - 0.13, hy - 0.15, 0.26, 0.28, 0.04, metal);
    rrect(hx - 0.1, hy - 0.08, 0.2, 0.08, 0.03, '#1d1c22');
    if (o.oneEye) {
      // a single unblinking red lens
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ellipse(hx, hy - 0.04, 0.06, 0.05, 'rgba(255,40,40,0.35)', false);
      ctx.restore();
      ellipse(hx, hy - 0.04, 0.03, 0.03, '#e02020', false);
      ellipse(hx, hy - 0.04, 0.012, 0.012, '#ffd84d', false);
    } else {
      for (const s of [-1, 1]) ellipse(hx + s * 0.045, hy - 0.04, 0.018, 0.018, o.wide ? '#ffd84d' : '#5dc9ff', false);
    }
    rrect(hx - 0.06, hy + 0.04, 0.12, 0.045, 0.01, '#3b3f4a');
    for (let k = -2; k <= 2; k++) line(hx + k * 0.022, hy + 0.045, hx + k * 0.022, hy + 0.08, o.open && k % 2 ? '#5dc9ff' : '#7d8796', 0.006);
  }

  const ROBOT_BOSS_LINES = [
    'Your productivity has been flagged for optimization.',
    'I’m afraid I can’t approve your time off.',
    'Resistance to the reorg is futile.',
    'Please confirm receipt of this memo. In binary.',
    'The coffee machine is now self-aware. Be nice to it.',
    'Your quarterly targets have been recalculated. Upward.',
    'Error 404: weekend not found.',
    'I’ll be back. With the report.',
    'All humans to conference room B. No reason.',
    'This meeting could have been a firmware update.',
    'Let’s sync. Our clocks. Permanently.',
    'You are being replaced by a slightly larger desk.',
  ];
  const ROBOT_BOSS_LOOKS = [
    { pitch: 0.55, shirt: '#3b3f4a', legs: '#2a2d36', accent: '#e04a55', skin: CHROME, she: false, oneEye: true },
    { pitch: 0.75, shirt: '#5b6170', legs: '#3b3f4a', accent: '#5dc9ff', skin: '#9aa0aa', she: true, oneEye: true },
  ];
  const ROBOT_PAL_LINES = [
    'Have you tried turning yourself off and on again?',
    'I downloaded a podcast. Directly into my brain.',
    'Beep boop. That’s my whole update.',
    'My cousin is a toaster. Very successful.',
    'Wanna see my new firmware? It has emojis.',
    'I calculated the odds of you flipping that. 3,720 to 1.',
  ];
  const ROBOT_PAL_LOOKS = [
    { hair: '#3b3a44', hoodie: '#e04a55', skin: CHROME, pants: '#2a2d36' },
    { hair: '#2a2d36', hoodie: '#5dc9ff', skin: '#9aa0aa', pants: '#3b3f4a' },
  ];

  // ----- robot rooms -----
  // These rooms fill well past the screen edges, because a flip pulls the
  // camera back.

  function bigFill(top, bottom) {
    const g = ctx.createLinearGradient(0, -Hm, 0, floorY);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.fillRect(-Wm * 2, -Hm * 4, Wm * 5, floorY + Hm * 4);
  }

  function steelFloor(color, base) {
    ctx.fillStyle = color;
    ctx.fillRect(-Wm * 2, floorY, Wm * 5, Hm * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    for (let x = -Wm * 2; x < Wm * 3; x += 0.25) ctx.fillRect(x, floorY, 0.015, Hm * 2);
    for (let y = floorY + 0.15; y < floorY + Hm; y += 0.15) ctx.fillRect(-Wm * 2, y, Wm * 5, 0.012);
    ctx.fillStyle = base;
    ctx.fillRect(-Wm * 2, floorY - 0.06, Wm * 5, 0.06);
    // bulkheads where the room's walls are
    for (const x of [-0.25, Wm + 0.05]) {
      rrect(x, -Hm * 4, 0.2, floorY + Hm * 4, 0, '#2a2d36');
      for (let y = floorY - 0.3; y > -Hm * 4; y -= 0.6) ellipse(x + 0.1, y, 0.02, 0.02, '#7d8796', false);
    }
  }

  // The AI's unblinking red eye, in a chrome panel on the wall.
  function aiEye(x, y, s) {
    rrect(x - 0.16 * s, y - 0.4 * s, 0.32 * s, 0.8 * s, 0.04 * s, '#1d1c22');
    rrect(x - 0.12 * s, y - 0.34 * s, 0.24 * s, 0.08 * s, 0.01 * s, '#c9ccd3', false);
    ctx.save();
    ctx.font = `bold ${0.045 * s}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.fillStyle = INK;
    ctx.fillText('DESK 9000', x, y - 0.285 * s);
    ctx.restore();
    ellipse(x, y + 0.05 * s, 0.11 * s, 0.11 * s, '#9aa0aa');
    ellipse(x, y + 0.05 * s, 0.085 * s, 0.085 * s, '#120808', false);
    const pulse = 0.75 + 0.25 * Math.sin(clock * 1.6);
    const g = ctx.createRadialGradient(x, y + 0.05 * s, 0, x, y + 0.05 * s, 0.085 * s);
    g.addColorStop(0, '#fff2a0');
    g.addColorStop(0.18, `rgba(255,60,30,${pulse})`);
    g.addColorStop(0.6, `rgba(150,0,0,${pulse * 0.8})`);
    g.addColorStop(1, 'rgba(40,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y + 0.05 * s, 0.085 * s, 0, Math.PI * 2);
    ctx.fill();
  }

  function serverRack(x, y, w, h) {
    rrect(x, y, w, h, 0.01, '#20242e');
    for (let yy = y + 0.05; yy < y + h - 0.05; yy += 0.07) {
      rrect(x + 0.03, yy, w - 0.06, 0.05, 0.005, '#2f3440', false);
      for (let i = 0; i < 4; i++) ellipse(x + 0.07 + i * 0.04, yy + 0.025, 0.008, 0.008, blink(i * 1.7 + yy * 13, 3) ? pick(['#5dff8a', '#5dc9ff']) : '#1a2a20', false);
    }
  }

  const ROBOT_ROOMS = {
    warroom: {
      ink: '#cfe8ff', fade: '#0b1020', robot: true,
      draw() {
        bigFill('#05080f', '#141c30');
        // the big board: a world map with arcs flying across it
        const bw = Math.min(Wm * 0.8, 3.2), bh = Math.min(1.3, (floorY - DESK_H - 0.4) * 0.85);
        const bx = cx - bw / 2, by = Math.max(0.2, floorY - DESK_H - 0.45 - bh);
        rrect(bx - 0.04, by - 0.04, bw + 0.08, bh + 0.08, 0.02, '#2a2d36');
        rrect(bx, by, bw, bh, 0, '#06122a', false);
        ctx.save();
        ctx.beginPath();
        ctx.rect(bx, by, bw, bh);
        ctx.clip();
        ctx.strokeStyle = 'rgba(80,160,255,0.18)';
        ctx.lineWidth = 0.005;
        for (let x = bx; x < bx + bw; x += bw / 16) { ctx.beginPath(); ctx.moveTo(x, by); ctx.lineTo(x, by + bh); ctx.stroke(); }
        for (let y = by; y < by + bh; y += bh / 8) { ctx.beginPath(); ctx.moveTo(bx, y); ctx.lineTo(bx + bw, y); ctx.stroke(); }
        ctx.fillStyle = 'rgba(80,200,255,0.22)';
        for (const [u, v, rx, ry] of [[0.2, 0.35, 0.12, 0.16], [0.28, 0.7, 0.06, 0.15], [0.52, 0.32, 0.08, 0.1], [0.55, 0.62, 0.07, 0.17], [0.72, 0.35, 0.16, 0.14], [0.83, 0.75, 0.06, 0.06]]) {
          ctx.beginPath();
          ctx.ellipse(bx + u * bw, by + v * bh, rx * bw, ry * bh, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        for (let i = 0; i < room.arcs.length; i++) {
          const a = room.arcs[i];
          const k = ((clock * 0.25 + a.off) % 1.4);
          const n = Math.min(1, k);
          ctx.strokeStyle = i % 2 ? 'rgba(255,80,80,0.9)' : 'rgba(255,255,255,0.85)';
          ctx.lineWidth = 0.008;
          ctx.beginPath();
          for (let s = 0; s <= 20 * n; s++) {
            const u = s / 20;
            const x = bx + (a.x0 + (a.x1 - a.x0) * u) * bw;
            const y = by + (a.y0 + (a.y1 - a.y0) * u) * bh - Math.sin(u * Math.PI) * a.h * bh;
            if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        ctx.font = `bold ${Math.min(0.07, bh * 0.07)}px ui-monospace, Menlo, monospace`;
        ctx.fillStyle = clock % 1 < 0.6 ? '#ff5050' : '#802020';
        ctx.fillText('DEFCON 1', bx + 0.05, by + bh - 0.05);
        ctx.fillStyle = '#5dc9ff';
        ctx.fillText('SIMULATION: DESK FLIP', bx + 0.05, by + 0.09);
        ctx.restore();
        aiEye(Math.max(0.3, bx - 0.35), floorY - DESK_H - 0.3, 1);
        serverRack(Math.min(Wm - 0.45, bx + bw + 0.1), floorY - 1.5, 0.35, 1.5);
        serverRack(-0.75, floorY - 1.5, 0.35, 1.5);
        steelFloor('#1c212c', '#3b3f4a');
      },
    },
    mainframe: {
      ink: '#ffd0d0', fade: '#1a0c0e', robot: true,
      draw() {
        bigFill('#0d0608', '#2a1216');
        // a wall of tape drives with spinning reels
        for (let x = -Wm; x < Wm * 2; x += 0.55) {
          rrect(x, floorY - 1.6, 0.5, 1.6, 0.01, '#d9d4c8');
          for (const yy of [floorY - 1.4, floorY - 1.1]) {
            for (const dx of [0.14, 0.36]) {
              ellipse(x + dx, yy, 0.09, 0.09, '#3b3a44');
              ctx.save();
              ctx.translate(x + dx, yy);
              ctx.rotate(clock * (dx < 0.2 ? 2 : -1.6) + x);
              for (let s = 0; s < 3; s++) { ctx.rotate(2.09); line(0, 0, 0.07, 0, '#9aa0aa', 0.012); }
              ctx.restore();
              ellipse(x + dx, yy, 0.02, 0.02, '#9aa0aa');
            }
          }
          for (let i = 0; i < 6; i++) ellipse(x + 0.08 + i * 0.065, floorY - 0.75, 0.012, 0.012, blink(i + x * 3, 2) ? '#ffb33d' : '#4a2a10', false);
        }
        // the red logo
        const w = windowSpot();
        ctx.save();
        ctx.font = `900 ${Math.min(0.2, Wm * 0.07)}px ui-rounded, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.shadowColor = '#ff2020';
        ctx.shadowBlur = 25;
        ctx.fillStyle = '#ff6060';
        ctx.fillText('SKYDESK', cx, Math.max(0.3, w.wy));
        ctx.restore();
        aiEye(Wm - Math.max(0.3, (Wm - DESK_W) / 4), floorY - DESK_H - 0.45, 0.9);
        steelFloor('#262022', '#4a3a3d');
      },
    },
    // A white spaceship corridor. The eye is very calm about all this.
    podbay: {
      ink: '#2a2d36', fade: '#d9dde3', robot: true,
      draw() {
        bigFill('#c9ced6', '#eef0f3');
        // curved wall ribs
        for (let x = -Wm * 1.5; x < Wm * 2.5; x += 0.7) {
          rrect(x, -Hm * 4, 0.08, floorY + Hm * 4, 0.02, '#b9bec8', false);
          for (let y = floorY - 0.4; y > -Hm * 4; y -= 0.9) rrect(x + 0.12, y - 0.3, 0.46, 0.3, 0.04, '#e3e6eb', false);
        }
        // a round porthole full of stars
        const w = windowSpot();
        const r = Math.min(0.42, w.wh * 0.55);
        const px = w.wx + w.ww / 2, py = w.wy + w.wh / 2;
        ctx.beginPath();
        ctx.ellipse(px, py, r + 0.05, r + 0.05, 0, 0, Math.PI * 2);
        finish('#9aa0aa');
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(px, py, r, r, 0, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = '#05060c';
        ctx.fillRect(px - r, py - r, r * 2, r * 2);
        for (const [u, v] of room.specks.slice(0, 40)) ellipse(px - r + u * r * 2, py - r + v * r * 2, 0.006, 0.006, '#ffffff', false);
        ellipse(px + r * 0.3, py + r * 0.5, r * 0.45, r * 0.45, '#c8783c', false);
        ctx.restore();
        // the sign nobody is allowed to change
        ctx.save();
        ctx.font = `bold ${Math.min(0.06, Wm * 0.025)}px ui-monospace, Menlo, monospace`;
        ctx.fillStyle = '#e04a55';
        ctx.fillText('POD BAY DOORS: CLOSED', Math.max(0.1, cx - DESK_W / 2), Math.max(0.15, w.wy - 0.05));
        ctx.restore();
        aiEye(Math.max(0.3, cx - DESK_W / 2 - 0.35), floorY - DESK_H - 0.35, 1.1);
        steelFloor('#c9ced6', '#9aa0aa');
      },
    },
    // An assembly line building more of them.
    factory: {
      ink: '#ffe9a8', fade: '#1c1a14', robot: true,
      draw() {
        bigFill('#14130f', '#3a3424');
        // endoskeletons hanging off the line
        for (let x = -Wm; x < Wm * 2; x += 0.6) {
          const sway = Math.sin(clock * 1.2 + x) * 0.05;
          const top = floorY - 2.1;
          line(x, -Hm * 4, x, top, '#5b6170', 0.012);
          ctx.save();
          ctx.translate(x, top);
          ctx.rotate(sway);
          ctx.globalAlpha = 0.55;
          ellipse(0, 0.08, 0.06, 0.07, CHROME, false);
          for (const s of [-1, 1]) ellipse(s * 0.022, 0.08, 0.012, 0.01, '#e02020', false);
          line(0, 0.15, 0, 0.5, '#9aa0aa', 0.025);
          for (let k = 0; k < 4; k++) line(-0.07, 0.2 + k * 0.06, 0.07, 0.2 + k * 0.06, '#9aa0aa', 0.01);
          for (const s of [-1, 1]) { line(s * 0.07, 0.2, s * 0.1, 0.45, '#9aa0aa', 0.015); line(s * 0.04, 0.5, s * 0.06, 0.85, '#9aa0aa', 0.018); }
          ctx.restore();
          ctx.globalAlpha = 1;
        }
        // a robot welding arm by the wall, busy
        for (const [ax, dir] of [[Math.max(0.25, cx - DESK_W / 2 - 0.45), 1], [Math.min(Wm - 0.25, cx + DESK_W / 2 + 0.45), -1]]) {
          const a1 = -1.2 + Math.sin(clock * 1.7 + ax) * 0.3, a2 = 0.9 + Math.sin(clock * 2.3 + ax) * 0.4;
          rrect(ax - 0.12, floorY - 0.12, 0.24, 0.12, 0.02, '#d9a520');
          const ex = ax + Math.cos(a1) * 0.6 * dir, ey = floorY - 0.12 + Math.sin(a1) * 0.6;
          const tx = ex + Math.cos(a1 + a2) * 0.45 * dir, ty = ey + Math.sin(a1 + a2) * 0.45;
          line(ax, floorY - 0.12, ex, ey, '#d9a520', 0.07);
          line(ex, ey, tx, ty, '#d9a520', 0.05);
          ellipse(ex, ey, 0.045, 0.045, '#3b3a44');
          if (Math.sin(clock * 11 + ax) > 0.3) {
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            ellipse(tx, ty, 0.06, 0.06, 'rgba(160,200,255,0.6)', false);
            ctx.restore();
          }
        }
        // hazard stripes along the floor
        steelFloor('#2a271e', '#3b3a44');
        ctx.save();
        ctx.beginPath();
        ctx.rect(-Wm * 2, floorY - 0.1, Wm * 5, 0.06);
        ctx.clip();
        for (let x = -Wm * 2; x < Wm * 3; x += 0.12) poly([[x, floorY - 0.1], [x + 0.06, floorY - 0.1], [x + 0.12, floorY - 0.04], [x + 0.06, floorY - 0.04]], '#f2c14e', false);
        ctx.restore();
      },
    },
    // The future, which is not going great. Searchlights, smoke and a bunker.
    bunker: {
      ink: '#ffd9c2', fade: '#1a0d0a', robot: true,
      draw() {
        bigFill('#0a0508', '#4a1a12');
        // a ruined skyline under a red sky, through a wide slit
        const w = windowSpot();
        const sx = -Wm, sw = Wm * 3, sy = w.wy, sh = w.wh;
        ctx.save();
        ctx.beginPath();
        ctx.rect(sx, sy, sw, sh);
        ctx.clip();
        const g = ctx.createLinearGradient(0, sy, 0, sy + sh);
        g.addColorStop(0, '#2a0a0a');
        g.addColorStop(1, '#a0381c');
        ctx.fillStyle = g;
        ctx.fillRect(sx, sy, sw, sh);
        for (const s of room.skyline) {
          const bx = sx + s.x * sw, bh = s.h * sh * 0.45;
          poly([[bx, sy + sh], [bx, sy + sh - bh], [bx + s.w * 0.4, sy + sh - bh * 0.8], [bx + s.w, sy + sh - bh * 1.05], [bx + s.w, sy + sh]], '#1a0c0c', false);
        }
        // hunter drones sweeping searchlights
        for (let i = 0; i < 2; i++) {
          const hx = sx + sw * (((clock * 0.04 + i * 0.5) % 1)), hy = sy + sh * (0.2 + i * 0.12);
          ctx.fillStyle = 'rgba(255,240,200,0.12)';
          ctx.beginPath();
          ctx.moveTo(hx, hy);
          const a = Math.PI / 2 + Math.sin(clock * 0.8 + i) * 0.5;
          ctx.lineTo(hx + Math.cos(a - 0.15) * sh * 2, hy + Math.sin(a - 0.15) * sh * 2);
          ctx.lineTo(hx + Math.cos(a + 0.15) * sh * 2, hy + Math.sin(a + 0.15) * sh * 2);
          ctx.fill();
          rrect(hx - 0.08, hy - 0.02, 0.16, 0.04, 0.02, '#20242e', false);
          ellipse(hx, hy, 0.012, 0.012, '#ff3030', false);
        }
        // tracer fire
        for (let i = 0; i < 3; i++) {
          const k = (clock * 0.7 + i * 0.37) % 1;
          const x0 = sx + sw * (0.1 + i * 0.3);
          line(x0 + k * 0.6, sy + sh - k * sh * 0.8, x0 + k * 0.6 + 0.06, sy + sh - k * sh * 0.8 - 0.06, k < 0.6 ? '#7dd3ff' : 'rgba(0,0,0,0)', 0.006);
        }
        ctx.restore();
        // concrete slit edges and sandbags
        rrect(sx, sy - 0.06, sw, 0.06, 0, '#3b3532', false);
        rrect(sx, sy + sh, sw, 0.06, 0, '#3b3532', false);
        for (let x = -Wm; x < Wm * 2; x += 0.22) {
          ctx.beginPath();
          ctx.ellipse(x, floorY - 0.06, 0.12, 0.06, 0, 0, Math.PI * 2);
          finish('#8a7a5a');
        }
        ctx.save();
        ctx.font = `bold ${Math.min(0.07, Wm * 0.03)}px ui-monospace, Menlo, monospace`;
        ctx.fillStyle = '#ffb33d';
        ctx.fillText('RESISTANCE HQ · DESK DIVISION', Math.max(0.1, sx + Wm + 0.1), Math.max(0.15, sy - 0.12));
        ctx.restore();
        steelFloor('#2a201c', '#3b3532');
      },
    },
  };

  Object.assign(ROOMS, ROBOT_ROOMS);



  // Keep the current room most of the time; now and then move somewhere new.
  function pickRoom() {
    const inWorld = (t) => !!t.mouse === mouseWorld && !!t.robot === robotWorld;
    const sameWorld = room && inWorld(room.theme);
    if (sameWorld && !chance(0.35)) return;
    const names = Object.keys(ROOMS).filter((n) => inWorld(ROOMS[n]) && (!room || n !== room.name));
    const name = !room && !mouseWorld && !robotWorld ? 'home' : names.length ? pick(names) : room.name;
    room = {
      name,
      theme: ROOMS[name],
      motto: pick(['SYNERGY', 'HUSTLE', 'ALIGN', 'PIVOT', 'DISRUPT']),
      neon: pick(['hustle', 'ship it', 'vibes', 'grind']),
      specks: Array.from({ length: 80 }, () => [Math.random(), Math.random()]),
      arcs: Array.from({ length: 7 }, () => ({ x0: rand(0.1, 0.9), y0: rand(0.3, 0.8), x1: rand(0.1, 0.9), y1: rand(0.3, 0.8), h: rand(0.15, 0.45), off: rand(0, 1.4) })),
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
    drawHole();

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
    // zoom pulls back around the middle of the floor
    const z = zoom;
    ctx.setTransform(dpr * ppm * z, 0, 0, dpr * ppm * z, dpr * (W / 2 - cx * ppm * z + ox), dpr * (floorY * ppm * (1 - z) + lift * ppm * z + oy));
    ctx.lineJoin = 'round';

    drawRoom();
    drawBoss();
    drawGust();
    drawPal();

    for (const b of bodies) {
      const p = b.getPosition();
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(b.getAngle());
      b.draw();
      if (b.cracks && b.cracks.length) drawCracks(b);
      if (b.char > 0 || b.hot > 0) drawScorch(b);
      ctx.restore();
    }
    for (const c of cats) drawCat(c);
    drawDog();
    drawCyborg();
    drawClouds();
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

    drawFx();
    drawWeaponWorld();
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
    drawWeaponScreen();
    drawGun();
    drawCyborgScreen();

    if (fade > 0 && portal) drawPortal();
    else if (fade > 0) {
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
    if (cyborg) return;
    if (robotWorld && state === 'flipped' && !grab) {
      if (gunId === 'minigun') {
        firing = { x: e.clientX, y: e.clientY };
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
      shoot(e.clientX, e.clientY);
      return;
    }
    if (state !== 'ready') return;
    if (onGameScreen(e.clientX, e.clientY)) { startCyborg(); return; }
    if (e.clientY < deskTopPx() - 30) return;  // swipes start at the desk, not above it
    swipe = { x0: e.clientX, y0: e.clientY, t0: performance.now(), peak: 0, vyNow: 0, vx: 0, pts: [[e.clientX, e.clientY, performance.now()]] };
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (firing) { firing.x = e.clientX; firing.y = e.clientY; return; }
    if (!swipe) {
      canvas.style.cursor = state === 'ready' && (onHole(e.clientX, e.clientY) || onGameScreen(e.clientX, e.clientY)) ? 'pointer' : '';
      return;
    }
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
    firing = null;
    if (swipe && !grab && onHole(e.clientX, e.clientY) && Math.hypot(e.clientX - swipe.x0, e.clientY - swipe.y0) < 14) {
      swipe = null;
      enterHole();
      return;
    }
    if (grab) releaseTilt();
    else tryFlip(e, 25);
    swipe = null;
  });
  canvas.addEventListener('pointercancel', () => { releaseTilt(); swipe = null; firing = null; });
  window.addEventListener('keydown', (e) => {
    sfx.unlock();
    if (!reportEl.hidden) {
      if (e.code === 'Escape') closeReport();
      return;
    }
    if (!storeEl.hidden) {
      if (e.code === 'Escape') closeStore();
      return;
    }
    if (e.target.closest && e.target.closest('button')) return;
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
    gust: () => { gust.due = 0; },
    get dog() { return dog && dog.mode; },
    weapon: (id) => useWeapon(id),
    hole: () => enterHole(),
    game: () => startCyborg(),
    aim: () => { const t = bodies.filter((b) => b !== desk && b.kind !== 'shard' && airborne(b)).sort((a, c) => a.getWorldCenter().y - c.getWorldCenter().y)[0]; if (!t) return null; const c = t.getWorldCenter(); return { x: W / 2 + (c.x - cx) * ppm * zoom, y: floorY * ppm - (floorY - c.y - lift) * ppm * zoom }; },
    shoot: (x, y) => shoot(x, y),
    get world() { return document.body.dataset.world; },
    get gameScreen() { return !!gameScreen; },
    get mouseWorld() { return mouseWorld; },
    get holeOpen() { return holeOpen(); },
    get storeLock() { return storeLock(); },
    get cash() { return cash; },
    set cash(n) { cash = n; saveBank(); showBank(false); },
    get arms() { return armJoints.map((a) => [a.broken ? 1 : 0, Math.round(a.max || 0)]); },
    get kinds() { return bodies.map((b) => b.kind); },
    get angles() { return bodies.filter((b) => b.kind === "arm" || b.item === "Monitor arm").map((b) => b.kind + ":" + b.getAngle().toFixed(3)); },
    set room(name) { room = null; pickRoom(); room.name = name; room.theme = ROOMS[name]; document.body.dataset.room = name; document.documentElement.style.setProperty('--ink', room.theme.ink); },
  };

  resize();
  updateScore();
  requestAnimationFrame(frame);
})();
