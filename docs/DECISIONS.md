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

## ADR-003 - Do not implement Bilibili in the current stage

### Context
Bilibili support would introduce additional complexity around auth, DASH resources, merge flows, and compliance boundaries.

### Decision
Do not implement Bilibili in this round.

### Reason
The provider boundary and downloader engine do not exist yet, so adding Bilibili now would couple new media logic to an unstable architecture.

### Consequence
Bilibili remains future work after provider and downloader foundations are in place.

## ADR-004 - Keep current Quark code outside the future Provider directory for now

### Context
Current Quark MVP behavior is already working through `server/services/quark/*`, `server/adapters/quarkApi.ts`, and `/api/quark/*`.

### Decision
Do not migrate current Quark code into a new Provider abstraction in this round.

### Reason
Early migration would add regression risk without immediate product benefit.

### Consequence
The working Quark code remains in place. Provider migration is deferred to `V0.6`.

## ADR-005 - Keep `/api/quark/*` unchanged in the current stage

### Context
The current frontend and backend both depend on the existing Quark API paths.

### Decision
Keep `/api/quark/*` unchanged in this round.

### Reason
The goal is direction setting and documentation, not API redesign.

### Consequence
Current frontend behavior and integration points remain compatible while the long-term architecture is clarified.
