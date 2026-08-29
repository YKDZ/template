# One-time npm publication setup

Run `./scripts/npm-publication-setup/setup.sh` from the generated repository
root. The script prepares public package facts for ordinary Git review, then
verifies the first release artifact only after the reviewed configuration is on
the clean, synchronized public default branch.

It never signs in to npm, publishes, changes Git state, opens a browser, or
stores credentials. `--status --json` is a read-only status query.
