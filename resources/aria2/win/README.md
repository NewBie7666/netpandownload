Place `aria2c.exe` in this directory for the embedded downloader:

`resources/aria2/win/aria2c.exe`

Current behavior:

- If `aria2c.exe` exists, the Electron app starts it as a local sidecar
- If `aria2c.exe` is missing, Quark parsing still works and browser download remains available
- The built-in downloader will be shown as unavailable until the executable is present

The source repository does not commit `aria2c.exe`.

To prepare it locally, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-aria2.ps1
```

Official portable release builds should run the prepare script before `npm run dist:win` if the release package is expected to include the built-in downloader binary.
