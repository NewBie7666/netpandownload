# Downloader

This directory now contains the V0.5 downloader control layer.

Current scope:

- Control `aria2` through local JSON-RPC
- Add download tasks from app-generated URLs only
- List active / waiting / stopped tasks
- Pause, resume, and remove tasks
- Open the default download directory

Current limitations:

- Downloads still depend on `aria2c.exe` being present at `resources/aria2/win/aria2c.exe`
- No embedded binary is shipped in the repository
- No persistent download history database yet
- No save-directory picker yet
- No ffmpeg integration
- No Bilibili support

Security boundary:

- The frontend never receives the aria2 RPC secret
- The downloader API does not accept arbitrary external URLs as a general-purpose download service
- Existing `/api/quark/*` boundaries remain unchanged
