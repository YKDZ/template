# npm Trusted Publishing

This package is prepared for public npm publishing as `@ykdz/template`, with the `template` CLI exposed from `dist/cli.js`.

The intended release path is GitHub Actions OIDC through npm Trusted Publishing. Do not add `NPM_TOKEN` or `NODE_AUTH_TOKEN` secrets for the normal publish flow.

## Release workflow

The release workflow lives at `.github/workflows/release.yml`.

It runs when either:

- a GitHub Release is published, or
- a maintainer starts `Release` from the GitHub Actions workflow dispatch UI.

The workflow:

1. checks out the repository,
2. enables Corepack and sets up Node from `package.json`,
3. installs with `pnpm install --frozen-lockfile`,
4. runs `pnpm run check`,
5. publishes with `pnpm publish --access public --provenance`.

Ordinary checks and fixture checks do not publish. Publishing is isolated to the release workflow.

## First publish checklist

These steps are human-owned and must be completed by a maintainer before the first publish.

- [ ] npm account: confirm the publishing maintainer has npm access to the `@ykdz` scope and has 2FA configured according to the organization policy.
- [ ] Package access: confirm `@ykdz/template` is intended to be public and that the first publish should use public scoped package access.
- [ ] Trusted publisher: in npm, configure Trusted Publishing for package `@ykdz/template` with repository `YKDZ/template`, workflow filename `release.yml`, release job environment `npm`, and Allowed actions including `pnpm publish`.
- [ ] GitHub environment: create the `npm` GitHub environment used by the release job and add any required reviewers or deployment branch/tag restrictions.
- [ ] release permission: confirm who is allowed to publish GitHub Releases or manually dispatch the release workflow.
- [ ] Security settings: confirm branch protection, required status checks, tag/release controls, Actions permissions, and environment protections match the maintainer's release policy.
- [ ] Maintainer confirmation: review this checklist with the maintainer and record confirmation that the account-level npm and GitHub setup expectations are understood before treating issue #13 as complete.

## Release procedure

1. Confirm the checklist above is complete.
2. Confirm `pnpm run check` passes on the commit to release.
3. Update the package version in `package.json`.
4. Create and publish the GitHub Release, or run the release workflow manually from GitHub Actions.
5. Verify the npm package page shows provenance for the published version.
