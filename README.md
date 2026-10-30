# Flippy Desk

A desk covered in everyday stuff. Swipe up from the bottom of the desk and it flips, sending everything crashing around with 2D physics. A few seconds later it resets with a new random desk so you can flip it again.

Live at [flippydesk.com](https://flippydesk.com).

## How it works

- Plain static site in `public/`: `index.html`, `style.css`, `main.js`. No build step.
- Physics is [Planck.js](https://piqnt.com/planck.js/), a JavaScript port of Box2D, vendored in `public/vendor/` (MIT, see `public/vendor/PLANCK-LICENSE`).
- Everything is drawn with canvas shapes, no image assets.
- Swipe up (touch or mouse drag) starting at or below the desktop to flip. Space or the up arrow also flips on desktop.

## Run locally

```sh
python3 -m http.server 8000 -d public
```

Then open http://localhost:8000.

## Deploy

Hosted on Cloudflare Workers (static assets), connected to this repo. `wrangler.jsonc` points at `public/`. The deploy command is `npx wrangler deploy` with no build command.
