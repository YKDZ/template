# One-time npm publication setup

Run `./scripts/npm-publication-setup/setup.sh` from the generated repository
root. It is a one-time, direct setup interface with seven English line-oriented
stages:

1. Check prerequisites
2. Configure the public package
3. Commit the publication configuration
4. Verify the first release artifact
5. Authenticate with npm
6. Publish version 1.0.0
7. Configure trusted publishing

Stages 1–4 prepare reviewed public package facts and verify one receipt-bound
tgz on the clean, synchronized public default branch. After the exact Stage 4
acceptance, the private setup bridge creates an isolated temporary npm session.
It rejects ambient npm credentials and any repository `.npmrc`, uses the locked
`npm@11.19.1` CLI, and performs web authentication directly in your terminal.
The wizard never asks for or stores a password, OTP, recovery code, token, or
generic `--yes` acceptance.

Stage 6 either publishes the accepted absolute `1.0.0` tgz with public/latest
settings, or resumes only when npm registry metadata and downloaded bytes are
an exact match. Stage 7 creates or reads back exactly one GitHub trusted
publisher for this repository's `release.yml`, with publish permission only.
It does not configure an Environment or staged publishing. npm-owned
interactive prompts are bracketed by stable `INTERACTIVE … BEGIN/END` lines.

The setup directory keeps no progress state. Every rerun verifies Stage 4,
logs in again, and derives resume facts from npm. On every normal failure or
interrupt after session creation it attempts same-session logout before removing
only its owned temporary files; it never deletes this directory or the
repository. `--status --json` remains a read-only local status query ending at
Stage 4. After success, continue with Ticket 14 release completion work, then
delete this one-time setup directory manually when it is no longer needed.
