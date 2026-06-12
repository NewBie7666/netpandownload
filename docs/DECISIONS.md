# Architecture Decisions

## ADR-001 - Delay Electron until the desktop-shell stage

### Context
The project first needed a working `Web + Local Express` MVP for Quark parsing and download validation.

### Decision
Do not introduce Electron before the desktop-shell stage.

### Reason
Desktop packaging is a separate concern. Bringing it in too early would increase integration risk before the parsing and proxy flows were stabilized.

### Consequence
The browser-based MVP stayed stable first. Electron is introduced later in `V0.4` as a minimal shell without changing Quark business APIs.

## ADR-002 - Delay aria2 until the downloader stage

### Context
The project initially relied on direct links and local proxy streaming.

### Decision
Do not integrate aria2 before the downloader stage.

### Reason
Multithreaded downloading belongs to the dedicated downloader phase, not to the initial MVP validation phase.

### Consequence
Current downloads stay browser-driven or proxy-driven until `V0.5`. In `V0.5`, aria2 is introduced as a local sidecar rather than as a remote service.

## ADR-003 - Add Bilibili through yt-dlp before custom parsing

### Context
Bilibili support would introduce additional complexity around auth, DASH resources, merge flows, and compliance boundaries.

### Decision
Use `yt-dlp` as the first real Bilibili parsing sidecar in `V0.8`, while keeping mock fallback and avoiding custom Bilibili API parsing.

### Reason
The downloader engine and Provider boundary now exist. `yt-dlp` gives a stable command-line JSON boundary for public-resource parsing without committing to custom Bilibili API behavior yet.

### Consequence
Bilibili can parse public resources when `yt-dlp.exe` is available. DASH merge, member/paid/region/DRM handling, and login-state support remain future work.

## ADR-004 - Wrap Quark with a first-stage Provider before moving internals

### Context
Current Quark MVP behavior is already working through `server/services/quark/*`, `server/adapters/quarkApi.ts`, and `/api/quark/*`.

### Decision
Introduce a Quark Provider wrapper in `V0.6`, but keep Quark services and adapter internals in their current locations.

### Reason
Provider registration is needed before adding new sources, but moving the working Quark adapter internals at the same time would add avoidable regression risk.

### Consequence
The Provider Registry is active and Quark is the first Provider. Existing Quark services/adapters remain the runtime implementation until a later, safer migration.

## ADR-005 - Keep `/api/quark/*` unchanged in the current stage

### Context
The current frontend and backend both depend on the existing Quark API paths.

### Decision
Keep `/api/quark/*` unchanged in this round.

### Reason
Provider abstraction is internal architecture work, not an API redesign.

### Consequence
Current frontend behavior and integration points remain compatible while the long-term architecture is clarified.
