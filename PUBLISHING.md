# Publishing

Releases are created only by `.github/workflows/release-please.yml`.

1. Merge conventional `feat`, `fix`, or breaking commits into `main`.
2. Release Please opens or updates a release PR containing the version bump and
   changelog.
3. Review and merge that PR.
4. The workflow creates the immutable GitHub tag and release, installs from
   `package-lock.json`, performs a clean build, verifies every package export,
   runs tests, typechecking, and linting, then publishes through npm trusted
   publishing with provenance.

Do not run `npm version`, `npm publish`, or create release tags manually.

## Publish recovery

If the publish job fails after the tag was created, rerun the failed GitHub
Actions job first. If that rerun is no longer available, manually dispatch the
`Release` workflow and provide the existing tag, such as `v0.2.1`. Recovery
checks out that tag and refuses to publish unless it exactly matches the version
in `package.json`.

The npm package's trusted-publisher configuration must name this repository and
the workflow file `release-please.yml` exactly.

Release Please writes with a GitHub App token, not `GITHUB_TOKEN`. GitHub holds
the checks of a pull request that `github-actions[bot]` opens until a maintainer
approves them, and a release PR opened by the App runs its checks at once. The
App needs contents, pull requests, and issues write access, and it must be
installed on this repository. The repository variable `RELEASE_APP_CLIENT_ID`
holds its client ID and the secret `RELEASE_APP_PRIVATE_KEY` holds a private
key. If the key leaks or the App is deleted, generate a new key in the App's
settings and replace the secret.

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
