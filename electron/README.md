# Electron Placeholder

This directory contains the minimal Electron desktop shell.

Current status:

- Electron is integrated as the V0.4 desktop shell
- The app still keeps `Vite + Vue + TypeScript + Local Express + TypeScript` as the core runtime
- Electron only manages window lifecycle and local backend startup/shutdown in the current stage

Future responsibility:

- Electron main process
- Preload scripts
- Window lifecycle
- Backend bootstrap and shutdown
- Desktop packaging entrypoints

This directory is intentionally small. Future downloader, Provider, and media-processing logic still belong outside the Electron shell.
