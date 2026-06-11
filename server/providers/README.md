# Providers Placeholder

This directory is reserved for a future Provider system.

Current status:

- No Provider system is enabled yet
- Current Quark logic still lives in `server/services/quark/*`
- Current Quark adapter still lives in `server/adapters/quarkApi.ts`
- This round does not migrate any runtime code into this directory

Future responsibility:

- Match an input link or source
- Resolve it into one or more downloadable resources
- Normalize source-specific behavior behind a common boundary

Design sketch only, not a current code contract:

```ts
interface Provider {
  id: string
  name: string
  match(input: string): boolean
  resolve(input: string): Promise<ResolvedResource[]>
}
```

The sketch above is only a planning note. It is not active in the current codebase.
