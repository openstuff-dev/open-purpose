/**
 * Cache-Control for a file of the web app. The build gives bundles, styles and fonts an
 * 8-character content hash (`main-VEVG7XFE.js`), so a new version gets a new name and the old
 * one can be cached for good. Everything else keeps its name between releases (`index.html`,
 * `favicon.svg`), so browsers must check it on every load or they keep the old one.
 */
export function cacheControl(filePath: string): string {
  return /-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/i.test(filePath)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
}
