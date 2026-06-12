# aria2 Binary Setup

The source repository does not commit `aria2c.exe`.

For local development or for building a portable release with the embedded downloader enabled, prepare the Windows aria2 binary before starting Electron or running `npm run dist:win`.

## Where to Put aria2c.exe

The required path is:

```text
resources/aria2/win/aria2c.exe
```

Both development mode and packaged portable mode use this resource:

- Development mode reads `resources/aria2/win/aria2c.exe`
- Packaged mode reads `process.resourcesPath/aria2/win/aria2c.exe`
- `electron-builder` copies `resources/aria2` into the packaged `aria2` resource directory

## Prepare with Script

Run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-aria2.ps1
```

Optional parameters:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-aria2.ps1 -Version 1.37.0
powershell -ExecutionPolicy Bypass -File scripts/prepare-aria2.ps1 -Force
```

Default version: `1.37.0`.

If `aria2c.exe` already exists, the script skips download unless `-Force` is provided.

After download and extraction, the script runs:

```powershell
resources/aria2/win/aria2c.exe --version
```

The script exits non-zero if download, extraction, or runtime verification fails.

## Release Packaging

GitHub source code does not include `aria2c.exe`.

Official portable release builds should run `scripts/prepare-aria2.ps1` before `npm run dist:win` so the packaged app includes `aria2c.exe`.

If `aria2c.exe` is missing:

- Quark parsing still works
- Browser download still works
- Local proxy download still works
- The built-in aria2 downloader is shown as unavailable
