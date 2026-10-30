# OpenPurpose site

Static marketing site for OpenPurpose, published at https://purpose.openstuff.dev. Plain HTML, CSS and a small vanilla JS file. No build step, no trackers, no external requests. Fonts (Geist, Geist Mono, SIL OFL) are self-hosted.

```
index.html        the landing page
404.html          served by GitHub Pages for missing paths (uses root-absolute URLs)
CNAME             purpose.openstuff.dev
favicon.svg       adapts to light/dark; favicon-32.png as fallback
assets/css        site.css: all tokens are --os-* light-dark() pairs
assets/js         site.js: pointer glow, tap-to-play, copy buttons (optional)
assets/logo       sprite.svg: the OpenStuff, OpenPurpose and OpenStuff Design marks
assets/fonts      Geist variable fonts + licence
assets/img        og.png (1200x630), apple-touch-icon.png
```

## Deploy

`.github/workflows/pages.yml` publishes this folder to GitHub Pages on every push to `master` that changes `site/`. You can also run it by hand from the Actions tab.

To preview locally: `python3 -m http.server` in this folder, then open http://localhost:8000. (Opening `index.html` from disk won't show the logos, because browsers block external SVG `<use>` on `file://`. The 404 page only works once published.)

The domain is a `CNAME` record `purpose` → `openstuff-dev.github.io` at the DNS provider for `openstuff.dev`. Because the site deploys through Actions, GitHub reads the custom domain from **Settings → Pages**, not from the `CNAME` file; keep both the same.

## Swapping in the real tokens

Every colour, radius and duration is an `--os-*` custom property at the top of `assets/css/site.css`. Replace that `:root` block with the stylesheet from `@openstuff-dev/tokens` and keep the names that match.
