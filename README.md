# Flippy Desk

A desk covered in everyday stuff. Swipe up from the bottom of the desk and it flips, sending everything crashing around with 2D physics. A few seconds later it resets with a new random desk so you can flip it again.

Live at [flippydesk.com](https://flippydesk.com).

## How it works

- Plain static site: `index.html`, `style.css`, `main.js`. No build step.
- Physics is [Planck.js](https://piqnt.com/planck.js/), a JavaScript port of Box2D, vendored in `vendor/` (MIT, see `vendor/PLANCK-LICENSE`).
- Everything is drawn with canvas shapes, no image assets.
- Swipe up (touch or mouse drag) starting at or below the desktop to flip. Space or the up arrow also flips on desktop.

## Run locally

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Deploy

Hosted on Cloudflare Pages connected to this repo. Build command: none. Output directory: `/`.
