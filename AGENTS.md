# WebSub - Agent Instructions

## Overview
This is a vanilla HTML/JS/CSS frontend application for editing subtitles (WebSub).
There is no build step, no bundler, and no package manager.

## Architecture
- `index.html`: The main entrypoint.
- `app.js`: Contains all the application state, DOM manipulation, file parsing (ASS/VTT/SRT), and export logic.
- `style.css`: Contains all the styling.

## Development Workflow
- **Running:** Simply open `index.html` in a web browser. Alternatively, use any basic static file server (e.g., `python -m http.server`, `npx serve`, or Live Server).
- **Modifying:** Edit the static files directly. No compile step is required.
- **Dependencies:** Uses a few external fonts (Google Fonts `Inter`), but otherwise relies on pure browser APIs. No npm dependencies.

## Key Quirks / Conventions
- Uses vanilla JS DOM selectors: `const $ = (sel) => document.querySelector(sel);`
- State is managed via global variables in `app.js` (`subtitles`, `selectedIndices`, `undoStack`, etc.).
- When adding features, try to keep the zero-dependency vanilla JS architecture intact rather than introducing React/Vue or build tools unless explicitly requested.
