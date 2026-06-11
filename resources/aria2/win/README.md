Place `aria2c.exe` in this directory for the embedded downloader:

`resources/aria2/win/aria2c.exe`

Current behavior:

- If `aria2c.exe` exists, the Electron app starts it as a local sidecar
- If `aria2c.exe` is missing, Quark parsing still works and browser download remains available
- The built-in downloader will be shown as unavailable until the executable is present
