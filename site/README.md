# Website

Marketing and documentation site for the codex-claude bridge. React 18 + Vite,
no UI framework, no runtime dependencies beyond React itself.

```bash
cd site
npm install
npm run dev        # http://localhost:5173/codex_claude_bridgectl/
npm run build      # -> site/dist
npm run preview    # serve the production build locally
```

## Deployment

`.github/workflows/deploy-site.yml` builds and publishes `site/dist` to GitHub
Pages on every push to `main` that touches `site/`. Enable it once under
**Settings > Pages > Source: GitHub Actions**.

The published URL is `https://devzahirul.github.io/codex_claude_bridgectl/`, so
`vite.config.js` sets `base` to that sub-path. Deploying anywhere else (Netlify,
Vercel, a bare domain) needs a different base:

```bash
SITE_BASE=/ npm run build
```

## Structure

| Path | Role |
|---|---|
| `src/App.jsx` | Whole page: nav, hero, and one section per topic |
| `src/data.js` | All copy that belongs in a table or list |
| `src/components/Section.jsx` | Section shell with eyebrow, title and lead |
| `src/components/CodeBlock.jsx` | Code sample with a clipboard button |
| `src/styles.css` | Design tokens and layout, mobile-first breakpoints |

Content lives in `data.js` wherever it is repetitive, so updating the profile,
command, config or cost tables does not mean touching JSX. Keep those tables in
sync with the root `README.md` - they are duplicated by hand, not generated.
