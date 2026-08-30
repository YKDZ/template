# One-time npm publication setup

Run `./scripts/npm-publication-setup/setup.sh` from the generated repository
root. It is a one-time, direct setup interface with nine English line-oriented
stages:

1. Check prerequisites
2. Configure the public package
3. Commit the publication configuration
4. Verify the first release artifact
5. Authenticate with npm
6. Publish version 1.0.0
7. Configure trusted publishing
8. Create the first GitHub release
9. Finish setup

Stages 1–4 prepare reviewed public package facts and verify one receipt-bound
tgz on the clean, synchronized public default branch. After the exact Stage 4
acceptance, the private setup bridge creates an isolated temporary npm session.
It rejects ambient npm credentials and any repository `.npmrc`, uses the locked
npm CLI through the workspace's Corepack pnpm, and performs web authentication
directly in your terminal.
The wizard never asks for or stores a password, OTP, recovery code, token, or
generic `--yes` acceptance.

Stage 6 either publishes the accepted absolute `1.0.0` tgz with public/latest
settings, or resumes only when npm registry metadata and downloaded bytes are
an exact match. Stage 7 creates or reads back exactly one GitHub trusted
publisher for this repository's `release.yml`, with publish permission only.
It does not configure an Environment or staged publishing. npm-owned
interactive prompts are bracketed by stable `INTERACTIVE … BEGIN/END` lines.

Stage 8 uses the current authenticated `gh` session for the reviewed public
repository. It first classifies Immutable Releases, the annotated tag, the
Release, and both asset bytes. Fresh, exact tag-only, exact draft, and exact
immutable public facts are the only resumable states. A single exact phrase
binds the package, accepted artifact, repository, tag, and commit before any
GitHub write. The wizard never reads or stores a GitHub token, requests a
permission refresh, deletes remote state, or repairs a partial Release.

The setup directory keeps no progress state. Every rerun verifies Stage 4,
logs in again, and derives resume facts from npm and GitHub. On every normal failure or
interrupt after session creation it attempts same-session logout before removing
only its owned temporary files; it never deletes this directory or the
repository. `--status --json` remains a read-only local status query ending at
Stage 4. Stage 9 completes only after immutable Release verification, logout,
and owned cleanup; it then says that this one-time directory may be deleted
manually. It never deletes itself.
