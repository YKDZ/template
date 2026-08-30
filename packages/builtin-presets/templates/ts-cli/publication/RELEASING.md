# Releasing

Prepare a normal pull request that changes the public package version and its
curated `CHANGELOG.md` entry. After that PR is reviewed and merged to the
protected default branch, run the `release.yml` workflow manually without
inputs. The workflow verifies and publishes the accepted artifact, then creates
the matching GitHub Release.

If a release stops after an external write, preserve the observed npm, tag, and
GitHub Release facts. Use GitHub's failed-job rerun only when it retains the
accepted artifact; otherwise stop and investigate the incident rather than
repacking, overwriting, or repairing remote release state.

After the first successful natural OIDC release, open npm account security and
enable **Require 2FA and disallow tokens**. Revoke each no-longer-needed write
token individually. This is an account-hardening action; it is not part of the
daily workflow and should not block ordinary release preparation.
