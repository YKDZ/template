#!/usr/bin/env bash
# One-time, local-only setup interface. The generated body is checked Template Source.

set -u

package_path="{{PUBLIC_CLI_PACKAGE_PATH}}"
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_dir/../.." && pwd)
mode="run"
status_requested=false
json_requested=false
non_interactive=false
debug=false
package_name=""
command_name=""
description=""
license=""
copyright_holder=""
repository=""

usage() {
  cat <<'USAGE'
Usage: ./scripts/npm-publication-setup/setup.sh [public-fact options] [--non-interactive] [--debug]
       ./scripts/npm-publication-setup/setup.sh --status --json
       ./scripts/npm-publication-setup/setup.sh --help
USAGE
}

diagnostic() {
  local kind=$1 code=$2 observed=$3 expected=$4 next=$5
  printf '%s %s\nObserved: %s\nExpected: %s\nNext action: %s\n' "$kind" "$code" "$observed" "$expected" "$next" >&2
}

fail() { diagnostic "$1" "$2" "$3" "$4" "$5"; exit "$6"; }

redact() {
  sed -E 's#(https?://)[^/@[:space:]]+@#\1[REDACTED]@#g; s#([Tt]oken|[Pp]assword|[Oo][Tt][Pp]|[Ss]ession|[Aa]uthorization)[=:][^[:space:]]+#\1=[REDACTED]#g; s#(Bearer|Basic)[[:space:]]+[^[:space:]]+#\1 [REDACTED]#g'
}

require_value() {
  [ "$#" -eq 2 ] || fail ERROR publication-setup-usage "missing flag value" "a value for $1" "Run --help and provide public facts." 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --help) [ "$#" -eq 1 ] || fail ERROR publication-setup-usage "--help with other arguments" "--help alone" "Run --help by itself." 2; usage; exit 0 ;;
    --status) mode="status"; status_requested=true ;;
    --json) json_requested=true ;;
    --non-interactive) non_interactive=true ;;
    --debug) debug=true ;;
    --package-name|--bin|--description|--license|--copyright-holder|--repository)
      flag=$1; shift; [ "$#" -gt 0 ] || fail ERROR publication-setup-usage "missing value" "a value for $flag" "Run --help and provide public facts." 2
      case "$flag" in
        --package-name) package_name=$1 ;; --bin) command_name=$1 ;; --description) description=$1 ;;
        --license) license=$1 ;; --copyright-holder) copyright_holder=$1 ;; --repository) repository=$1 ;;
      esac ;;
    --yes|--password|--otp|--token|--secret|--session|--release-date|--*)
      fail ERROR publication-setup-usage "$1" "a supported public option" "Run --help; credentials and automatic acceptance are unsupported." 2 ;;
    *) fail ERROR publication-setup-usage "$1" "no positional arguments" "Run --help." 2 ;;
  esac
  shift
done

if [ "$status_requested" != "$json_requested" ]; then
  fail ERROR publication-setup-usage "--status and --json must be paired" "--status --json" "Run --status --json." 2
fi
if [ "$json_requested" = true ] && [ "$mode" != "status" ]; then
  fail ERROR publication-setup-usage "--json without --status" "--status --json" "Run --status --json." 2
fi

if [ "$mode" = "status" ]; then
  if [ "$non_interactive" != false ] || [ "$debug" != false ] || [ -n "$package_name$command_name$description$license$copyright_holder$repository" ]; then
    printf '%s\n' '{"schemaVersion":1,"currentStage":{"id":"check-prerequisites","number":1,"name":"Check prerequisites"},"observations":{"packagePath":null,"packageName":null,"commandName":null,"version":null,"repository":null,"readiness":"unavailable","git":{"workingTree":null,"currentBranch":null,"defaultBranch":null,"headMatchesRemoteDefault":null}},"blockers":[{"code":"publication-setup-usage","observed":"invalid status arguments","expected":"--status --json only","nextAction":"Run ./scripts/npm-publication-setup/setup.sh --status --json."}],"nextAction":{"kind":"run","command":"./scripts/npm-publication-setup/setup.sh"}}'
    exit 2
  fi
  REPOSITORY_ROOT="$repository_root" node --conditions=source "$script_dir/bridge.mjs" status
  exit $?
fi

cd "$repository_root" || fail ERROR repository-root "unreadable repository root" "the generated repository root" "Run setup from its generated directory." 5
for command in bash node pnpm git; do command -v "$command" >/dev/null 2>&1 || fail ERROR prerequisite-command "$command is unavailable" "required local command $command" "Install the generated repository toolchain and retry." 5; done
printf 'STAGE 1/4 Check prerequisites\nCHECK local-toolchain\nOK prerequisites\n'

existing_public=false
if node --input-type=module - "$repository_root/$package_path/package.json" <<'NODE' >/dev/null 2>&1
import { readFileSync } from "node:fs"; const manifest = JSON.parse(readFileSync(process.argv[2], "utf8")); process.exit(manifest.private || manifest.version !== "1.0.0" ? 1 : 0);
NODE
then
  existing_public=true
fi
if [ "$non_interactive" = false ] && [ "$existing_public" = false ]; then
  [ -n "$package_name" ] || { printf 'Package name: '; read -r package_name || exit 3; }
  [ -n "$command_name" ] || { printf 'Command name: '; read -r command_name || exit 3; }
  [ -n "$description" ] || { printf 'Public description: '; read -r description || exit 3; }
  [ -n "$license" ] || { printf 'SPDX license: '; read -r license || exit 3; }
  [ -n "$copyright_holder" ] || { printf 'Copyright holder: '; read -r copyright_holder || exit 3; }
  [ -n "$repository" ] || { printf 'Public GitHub repository: '; read -r repository || exit 3; }
fi

printf 'STAGE 2/4 Configure the public package\n'
PACKAGE_NAME="$package_name" COMMAND_NAME="$command_name" DESCRIPTION="$description" LICENSE_NAME="$license" COPYRIGHT_HOLDER="$copyright_holder" REPOSITORY_URL="$repository" REPOSITORY_ROOT="$repository_root" SETUP_DIR="$script_dir" node --conditions=source "$script_dir/bridge.mjs" configure
configuration_status=$?
[ "$configuration_status" -eq 0 ] || exit "$configuration_status"
printf 'OK public-package-configured\nSTAGE 3/4 Commit the publication configuration\n'
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then fail "ACTION REQUIRED" git-handoff-required "publication configuration needs normal Git review" "a clean synchronized public default branch" "Use the normal review, commit, PR, and merge flow; then rerun setup." 3; fi
branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)
remote=$(git remote get-url origin 2>/dev/null || true)
remote_default=$(git ls-remote --symref origin HEAD 2>/dev/null | sed -n 's#ref: refs/heads/\([^[:space:]]*\).*#\1#p' | head -n 1)
remote_head=$(git ls-remote origin "refs/heads/$remote_default" 2>/dev/null | awk 'NR==1 {print $1}')
if [ "$branch" != "$remote_default" ] || [ -z "$remote_head" ] || [ "$(git rev-parse HEAD 2>/dev/null)" != "$remote_head" ]; then
  fail "ACTION REQUIRED" git-handoff-required "branch or remote is not synchronized" "clean public default branch at its remote HEAD" "Complete the normal Git handoff and rerun setup." 3
fi
if ! REMOTE_URL="$remote" REPOSITORY_ROOT="$repository_root" node --conditions=source "$script_dir/bridge.mjs" remote-matches-owner; then
  fail ERROR repository-remote-conflict "$(printf '%s' "$remote" | redact)" "the public package owner GitHub repository" "Correct the normal Git remote and retry." 4
fi
printf 'OK git-handoff-complete\nSTAGE 4/4 Verify the first release artifact\n'
artifact_root=$(mktemp -d "${TMPDIR:-/tmp}/npm-publication-setup-artifact.XXXXXX") || fail ERROR artifact-temporary-output "unable to create temporary output" "an empty local temporary directory" "Correct temporary directory permissions and retry." 5
cleanup_artifact_root() {
  case "$artifact_root" in
    "${TMPDIR:-/tmp}"/npm-publication-setup-artifact.*)
      [ -d "$artifact_root" ] && rm -rf -- "$artifact_root"
      ;;
  esac
}
trap cleanup_artifact_root EXIT HUP INT TERM
if [ "$debug" = true ]; then printf 'COMMAND %s\n' "pnpm run publication:artifact -- --output-directory [temporary]"; fi
pnpm run publication:artifact -- --output-directory "$artifact_root" || fail ERROR artifact-verification-failed "publication artifact caller failed" "a verified Ticket 09 artifact" "Correct the reported artifact failure and retry." 5
receipt=$(find "$artifact_root" -name verified-publication-artifact.json -type f -print -quit)
[ -n "$receipt" ] || fail ERROR artifact-receipt-missing "no receipt" "verified artifact receipt" "Retry artifact verification." 5
acceptance=$(node --input-type=module - "$receipt" <<'NODE'
import { readFileSync } from "node:fs";
const receipt = JSON.parse(readFileSync(process.argv[2], "utf8"));
console.log(`Package: ${receipt.publication.packageName}@${receipt.publication.version}`);
console.log(`Command: ${receipt.publication.commandName}`);
for (const file of receipt.files) console.log(`File: ${file.path}`);
console.log(`Integrity: ${receipt.artifact.integrity}`);
console.log(`Checksum: ${receipt.artifact.checksumFile}`);
for (const smoke of receipt.smokes) console.log(`Smoke: ${smoke.name}`);
console.log(`ACCEPT ${receipt.publication.packageName}@${receipt.publication.version} ${receipt.artifact.integrity}`);
NODE
)
printf '%s\n' "$acceptance" | sed '$d'
acceptance=$(printf '%s\n' "$acceptance" | tail -n 1)
if [ "$non_interactive" = true ]; then fail "ACTION REQUIRED" artifact-acceptance-required "non-interactive mode cannot accept an artifact" "$acceptance" "Review the receipt and enter the exact acceptance interactively." 3; fi
printf '%s\n' "$acceptance"; printf 'Acceptance: '; read -r entered || fail "ACTION REQUIRED" artifact-acceptance-required "end of input" "$acceptance" "Review the receipt and enter the exact acceptance." 3
[ "$entered" = "$acceptance" ] || fail "ACTION REQUIRED" artifact-acceptance-required "acceptance did not match this receipt" "$acceptance" "Review the receipt and enter the exact acceptance." 3
printf 'OK local-preparation-complete\nLocal preparation complete.\nNext action: Continue with npm authentication and the first manual publish in the next setup phase.\n'
