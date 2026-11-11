# Publishing

Releases are created only by `.github/workflows/release.yml` with
[Changesets](https://github.com/changesets/changesets).

1. Add a changeset to each pull request that changes the published package:
   `npx changeset`, then commit the file it writes under `.changeset/`.
2. When changesets reach `main`, the `version` job opens or updates the "chore:
   version packages" PR. It bumps `package.json` and `package-lock.json`, writes
   `CHANGELOG.md` and removes the changesets.
3. Review and merge that PR.
4. The next run sees a version npm does not have and releases it. The `build`
   job installs from `package-lock.json`, performs a clean build, verifies every
   package export, checks formatting, runs tests, typechecking, and linting,
   then packs the tarball. It has no publish rights. The `publish` job holds the
   OIDC token, checks out no code and installs no dependencies. It checks the
   tarball's version and publishes that tarball through npm trusted publishing
   with provenance. The `release` job then creates the tag, such as `v0.2.1`,
   and the GitHub release with that version's changelog section.

Do not run `npm version`, `npm publish`, or create release tags manually.

## Earlier releases

Versions up to 0.6.1 were released by Release Please before the switch to
Changesets.

## Publish recovery

The tag and the GitHub release are created only after npm has the version, so a
failed publish leaves nothing to clean up. Rerun the failed jobs first. If that
rerun is no longer available, manually dispatch the `Release` workflow with
`dry_run` unchecked. It publishes the version in `main`'s `package.json` when
npm does not have it yet, and otherwise does nothing.

The npm package's trusted-publisher configuration must name this repository and
the workflow file `release.yml` exactly. To check it without publishing,
dispatch the `Release` workflow with `dry_run` checked. The publish job then
runs `npm publish --dry-run` on `main`'s version and fails unless npm accepted
the OIDC token exchange.

The `version` job writes with a GitHub App token, not `GITHUB_TOKEN`. GitHub
holds the checks of a pull request that `github-actions[bot]` opens until a
maintainer approves them, and a Version Packages PR opened by the App runs its
checks at once. The App needs contents and pull requests write access, and it
must be installed on this repository. The repository variable
`RELEASE_APP_CLIENT_ID` holds its client ID and the secret
`RELEASE_APP_PRIVATE_KEY` holds a private key. If the key leaks or the App is
deleted, generate a new key in the App's settings and replace the secret.

## Local verification

```sh
npm ci
npm run build:clean
npm run verify:package
npm run test
npm run typecheck
npm run lint
npm run format:check
npm pack --dry-run
```

`build:clean` uses the committed Convex generated files and therefore works in
clean CI without a deployment. Maintainers who intentionally change the
component API should regenerate those files separately with
`npm run build:codegen` while connected to a development deployment.
