# NodeService collaboration rules

## UI workflow

- Before changing any production UI, first create and present an interactive showcase with 3–5 distinct visual variants.
- Put local showcases in `_dev/design/` and keep them visually consistent with the current NodeService design system.
- Do not implement the production UI until the user has selected a variant. A direct user instruction to skip the showcase is the only exception.
- Include the relevant desktop and mobile behavior in the showcase or describe it explicitly when the responsive behavior is shared by all variants.

## Release bookkeeping

- Every completed product change must update the panel version, `packages/shared/src/changelog.ts`, and the local audit report together.
- Do not create a release tag unless the user explicitly asks to release.
