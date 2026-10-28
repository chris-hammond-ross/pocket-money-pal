# Landing site (pocketmoneypal.com)

Plain HTML and CSS in `public/`: no build step, no JavaScript, no cookies. Open `public/index.html` in a browser to preview it, or run `npx wrangler dev` in this folder to serve it the way Cloudflare does (headers, 404 page).

## Deployment

A static-assets-only Cloudflare Worker (`wrangler.jsonc`), deployed by Workers Builds from this GitHub repo. Every push to `main` that touches `apps/site/` deploys production, and the Worker serves `pocketmoneypal.com` as a custom domain. Pushes to other branches upload preview versions.

| Setting (Workers & Pages → the Worker → Settings → Build) | Value                 |
| --------------------------------------------------------- | --------------------- |
| Git branch                                                | `main`                |
| Build command                                             | _(empty)_             |
| Deploy command                                            | `npx wrangler deploy` |
| Preview command                                           | Cloudflare's default  |
| Root directory (path)                                     | `apps/site`           |
| Build watch paths                                         | include `apps/site/*` |

- `_headers` sets the security headers and CSP. If you add a script, an analytics beacon or another font host, update the CSP.
- `404.html` is served, with a 404 status, for any missing path (`not_found_handling`).
- The screenshots in `public/img/` are copies of `screenshots/` at the repo root. Re-copy them when the app's look changes.
