# Winnow (working name)

Local, cross-platform (macOS + Windows) photo culler. Groups near-duplicate shots, flags blur, bad exposure and closed eyes, suggests the best frame per group, and writes XMP sidecars that Lightroom, Bridge and darktable read. No cloud. Originals are never modified.

Status: early development. See `PLAN.md`.

## Develop

Requires Node 24 (`.nvmrc`).

```
npm ci
npm test
npx tsc --noEmit
npx tsx src/cli/index.ts --help
```

Licence: MIT.
