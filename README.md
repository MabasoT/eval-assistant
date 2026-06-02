# ⚖ Eval Assistant

A workbench for Model Response Evaluations (repo-based coding tasks). Built to streamline the evaluation workflow from the labeling instructions.

## Features

- **Guided workflow** — step-by-step checklist for the three-pass reading method
- **Scratch notes** — track tool calls and file mutations per response
- **Taxonomy selector** — all 12 weakness codes with inline justification fields
- **Live validation** — character minimums, rating-rationale consistency check, symmetry warnings
- **Timer** — track time per evaluation
- **History** — auto-saves past evaluations in localStorage
- **Export** — copy to clipboard or download as JSON
- **Persistent state** — everything auto-saves, survives page refresh

## Quick Start

```bash
npm install
npm run dev
```

## Deploy

### Netlify
```bash
npm install -g netlify-cli
netlify deploy --prod --dir=dist
```

### Vercel
```bash
npm install -g vercel
vercel --prod
```

### GitHub Pages
```bash
npm run build
# push dist/ contents to gh-pages branch
```

## Tech

Vite + React. No external UI libraries. ~215KB production bundle.
