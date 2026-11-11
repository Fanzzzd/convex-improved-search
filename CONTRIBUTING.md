# Developing guide

## Running locally

```sh
npm i
npm run dev
```

## Testing

```sh
npm ci
npm run clean
npm run typecheck
npm run lint
npm run format:check
npm run test
```

## Changesets

A pull request that changes the published package needs a changeset. Run
`npx changeset`, pick patch, minor or major, and write one line for the
changelog. Pull requests that only touch tests, CI or docs outside the package
need none. See PUBLISHING.md for how a changeset becomes a release.
