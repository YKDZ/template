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
  local kind=$1 code=$2 observed expected next
  observed=$(sanitize "$3")
  expected=$(sanitize "$4")
  next=$(sanitize "$5")
  printf '%s %s\nObserved: %s\nExpected: %s\nNext action: %s\n' "$kind" "$code" "$observed" "$expected" "$next" >&2
}

fail() { diagnostic "$1" "$2" "$3" "$4" "$5"; exit "$6"; }

redact() {
  sed -E 's#(https?://)[^/@[:space:]]+@#\1[REDACTED]@#g; s#(token|password|otp|session|authorization|auth|config)[=:][^[:space:]]+#\1=[REDACTED]#gI; s#(bearer|basic)[[:space:]]+[^[:space:]]+#\1 [REDACTED]#gI'
}

sanitize() {
  printf '%s' "$1" | LC_ALL=C tr -d '\000-\037\177-\237' | redact
}

prompt_public_fact() {
  local label=$1 variable=$2
  printf '%s: ' "$label"
  # shellcheck disable=SC2229
  if ! IFS= read -r "$variable"; then
    fail "ACTION REQUIRED" public-fact-required "end of input" "a complete public package fact" "Run with all public flags or enter the remaining facts interactively." 3
  fi
}

require_value() {
  [ "$#" -eq 2 ] || fail ERROR publication-setup-usage "missing flag value" "a value for $1" "Run --help and provide public facts." 2
}

status_json_intent=false
status_flag_seen=false
json_flag_seen=false
for argument in "$@"; do
  [ "$argument" = "--status" ] && status_flag_seen=true
  [ "$argument" = "--json" ] && json_flag_seen=true
done
[ "$status_flag_seen" = true ] && [ "$json_flag_seen" = true ] && status_json_intent=true

status_usage_json() {
  printf '%s\n' '{"schemaVersion":1,"currentStage":{"id":"check-prerequisites","number":1,"name":"Check prerequisites"},"observations":{"packagePath":null,"packageName":null,"commandName":null,"version":null,"repository":null,"readiness":"unavailable","git":{"workingTree":null,"currentBranch":null,"defaultBranch":null,"headMatchesRemoteDefault":null}},"blockers":[{"code":"publication-setup-usage","observed":"invalid status arguments","expected":"--status --json only","nextAction":"Run ./scripts/npm-publication-setup/setup.sh --status --json."}],"nextAction":{"kind":"run","command":"./scripts/npm-publication-setup/setup.sh"}}'
  exit 2
}

usage_fail() {
  if [ "$status_json_intent" = true ]; then status_usage_json; fi
  fail "$@"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --help) [ "$#" -eq 1 ] || usage_fail ERROR publication-setup-usage "--help with other arguments" "--help alone" "Run --help by itself." 2; usage; exit 0 ;;
    --status) mode="status"; status_requested=true ;;
    --json) json_requested=true ;;
    --non-interactive) non_interactive=true ;;
    --debug) debug=true ;;
    --package-name|--bin|--description|--license|--copyright-holder|--repository)
      flag=$1; shift; [ "$#" -gt 0 ] || usage_fail ERROR publication-setup-usage "missing value" "a value for $flag" "Run --help and provide public facts." 2
      case "$flag" in
        --package-name) package_name=$1 ;; --bin) command_name=$1 ;; --description) description=$1 ;;
        --license) license=$1 ;; --copyright-holder) copyright_holder=$1 ;; --repository) repository=$1 ;;
      esac ;;
    --yes|--password|--otp|--token|--secret|--session|--release-date|--*)
      usage_fail ERROR publication-setup-usage "$1" "a supported public option" "Run --help; credentials and automatic acceptance are unsupported." 2 ;;
    *) usage_fail ERROR publication-setup-usage "$1" "no positional arguments" "Run --help." 2 ;;
  esac
  shift
done

if [ "$status_requested" != "$json_requested" ]; then
  usage_fail ERROR publication-setup-usage "--status and --json must be paired" "--status --json" "Run --status --json." 2
fi
if [ "$json_requested" = true ] && [ "$mode" != "status" ]; then
  usage_fail ERROR publication-setup-usage "--json without --status" "--status --json" "Run --status --json." 2
fi

if [ "$mode" = "status" ]; then
  if [ "$non_interactive" != false ] || [ "$debug" != false ] || [ -n "$package_name$command_name$description$license$copyright_holder$repository" ]; then
    printf '%s\n' '{"schemaVersion":1,"currentStage":{"id":"check-prerequisites","number":1,"name":"Check prerequisites"},"observations":{"packagePath":null,"packageName":null,"commandName":null,"version":null,"repository":null,"readiness":"unavailable","git":{"workingTree":null,"currentBranch":null,"defaultBranch":null,"headMatchesRemoteDefault":null}},"blockers":[{"code":"publication-setup-usage","observed":"invalid status arguments","expected":"--status --json only","nextAction":"Run ./scripts/npm-publication-setup/setup.sh --status --json."}],"nextAction":{"kind":"run","command":"./scripts/npm-publication-setup/setup.sh"}}'
    exit 2
  fi
  REPOSITORY_ROOT="$repository_root" node --conditions=source "$script_dir/bridge.ts" status
  exit $?
fi

cd "$repository_root" || fail ERROR repository-root "unreadable repository root" "the generated repository root" "Run setup from its generated directory." 5
printf 'STAGE 1/9 Check prerequisites\nCHECK local-toolchain\n'
for command in bash node pnpm git gh; do command -v "$command" >/dev/null 2>&1 || fail ERROR prerequisite-command "$command is unavailable" "required local command $command" "Install the generated repository toolchain and retry." 5; done
REPOSITORY_ROOT="$repository_root" node --conditions=source "$script_dir/bridge.ts" preflight
preflight_status=$?
[ "$preflight_status" -eq 0 ] || exit "$preflight_status"
printf 'OK prerequisites\n'

existing_public=false
if node --input-type=module - "$repository_root/$package_path/package.json" <<'NODE' >/dev/null 2>&1
import { readFileSync } from "node:fs"; const manifest = JSON.parse(readFileSync(process.argv[2], "utf8")); process.exit(manifest.private || manifest.version !== "1.0.0" ? 1 : 0);
NODE
then
  existing_public=true
fi
if [ "$non_interactive" = false ] && [ "$existing_public" = false ]; then
  [ -n "$package_name" ] || prompt_public_fact "Package name" package_name
  [ -n "$command_name" ] || prompt_public_fact "Command name" command_name
  [ -n "$description" ] || prompt_public_fact "Public description" description
  [ -n "$license" ] || prompt_public_fact "SPDX license" license
  [ -n "$copyright_holder" ] || prompt_public_fact "Copyright holder" copyright_holder
  [ -n "$repository" ] || prompt_public_fact "Public GitHub repository" repository
fi

printf 'STAGE 2/9 Configure the public package\n'
PACKAGE_NAME="$package_name" COMMAND_NAME="$command_name" DESCRIPTION="$description" LICENSE_NAME="$license" COPYRIGHT_HOLDER="$copyright_holder" REPOSITORY_URL="$repository" REPOSITORY_ROOT="$repository_root" SETUP_DIR="$script_dir" node --conditions=source "$script_dir/bridge.ts" configure
configuration_status=$?
[ "$configuration_status" -eq 0 ] || exit "$configuration_status"
printf 'OK public-package-configured\nSTAGE 3/9 Commit the publication configuration\n'
if ! working_tree=$(git status --porcelain 2>/dev/null); then
  fail ERROR git-read-unavailable "working tree could not be read" "readable local Git facts" "Correct the Git or platform failure and retry." 5
fi
if [ -n "$working_tree" ]; then fail "ACTION REQUIRED" git-handoff-required "publication configuration needs normal Git review" "a clean synchronized public default branch" "Use the normal review, commit, PR, and merge flow; then rerun setup." 3; fi
branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null)
branch_status=$?
if [ "$branch_status" -eq 1 ]; then
  fail "ACTION REQUIRED" git-handoff-required "HEAD is detached" "a checked-out public default branch" "Complete the normal Git handoff and rerun setup." 3
fi
if [ "$branch_status" -ne 0 ]; then
  fail ERROR git-read-unavailable "current branch could not be read" "readable local Git facts" "Correct the Git or platform failure and retry." 5
fi
if ! remote=$(git remote get-url origin 2>/dev/null); then
  fail ERROR git-read-unavailable "origin could not be read" "a readable public origin" "Correct the Git or platform failure and retry." 5
fi
if ! remote_listing=$(git ls-remote --symref origin HEAD 2>/dev/null); then
  fail ERROR git-read-unavailable "remote default branch could not be read" "a reachable public origin" "Correct the Git or network failure and retry." 5
fi
remote_default=$(printf '%s\n' "$remote_listing" | sed -n 's#ref: refs/heads/\([^[:space:]]*\).*#\1#p' | head -n 1)
if [ -z "$remote_default" ]; then
  fail "ACTION REQUIRED" git-handoff-required "remote default branch is unavailable" "a public default branch" "Complete the normal Git handoff and rerun setup." 3
fi
if ! remote_head=$(git ls-remote origin "refs/heads/$remote_default" 2>/dev/null); then
  fail ERROR git-read-unavailable "remote default HEAD could not be read" "a reachable public origin" "Correct the Git or network failure and retry." 5
fi
remote_head=$(printf '%s\n' "$remote_head" | awk 'NR==1 {print $1}')
if ! local_head=$(git rev-parse HEAD 2>/dev/null); then
  fail ERROR git-read-unavailable "local HEAD could not be read" "a readable local HEAD" "Correct the Git or platform failure and retry." 5
fi
if [ "$branch" != "$remote_default" ] || [ -z "$remote_head" ] || [ "$local_head" != "$remote_head" ]; then
  fail "ACTION REQUIRED" git-handoff-required "branch or remote is not synchronized" "clean public default branch at its remote HEAD" "Complete the normal Git handoff and rerun setup." 3
fi
if ! REMOTE_URL="$remote" REPOSITORY_ROOT="$repository_root" node --conditions=source "$script_dir/bridge.ts" remote-matches-owner; then
  fail ERROR repository-remote-conflict "$(printf '%s' "$remote" | redact)" "the public package owner GitHub repository" "Correct the normal Git remote and retry." 4
fi
printf 'OK git-handoff-complete\nSTAGE 4/9 Verify the first release artifact\n'
artifact_parent_input=${TMPDIR:-/tmp}
if ! artifact_parent=$(CDPATH='' cd -- "$artifact_parent_input" && pwd -P); then
  fail ERROR artifact-temporary-output "temporary parent is unreadable" "a readable local temporary directory" "Correct TMPDIR permissions and retry." 5
fi
artifact_root=$(mktemp -d "$artifact_parent/npm-publication-setup-artifact.XXXXXX") || fail ERROR artifact-temporary-output "unable to create temporary output" "an empty local temporary directory" "Correct temporary directory permissions and retry." 5
artifact_cleaned=false
cleanup_artifact_root() {
  [ "$artifact_cleaned" = true ] && return 0
  case "$artifact_root" in
    "$artifact_parent"/npm-publication-setup-artifact.*) ;;
    *) return 1 ;;
  esac
  [ "$(dirname -- "$artifact_root")" = "$artifact_parent" ] || return 1
  [ ! -e "$artifact_root" ] && [ ! -L "$artifact_root" ] || {
    [ -d "$artifact_root" ] && [ ! -L "$artifact_root" ] || return 1
    rm -rf -- "$artifact_root" || return 1
  }
  artifact_cleaned=true
}
cleanup_artifact_best_effort() {
  cleanup_artifact_root >/dev/null 2>&1 || :
}
trap cleanup_artifact_best_effort EXIT HUP INT TERM
if [ "$debug" = true ]; then printf 'COMMAND %s\n' "verifyNpmPublicationArtifact [temporary output]"; fi
artifact_result=$(REPOSITORY_ROOT="$repository_root" ARTIFACT_OUTPUT_DIRECTORY="$artifact_root" node --conditions=source "$script_dir/bridge.ts" artifact)
artifact_status=$?
if [ "$artifact_status" -ne 0 ]; then
  printf '%s\n' "$artifact_result" >&2
  exit "$artifact_status"
fi
printf '%s\n' "$artifact_result" | sed '$d'
acceptance=$(printf '%s\n' "$artifact_result" | tail -n 1)
if [ "$non_interactive" = true ]; then fail "ACTION REQUIRED" artifact-acceptance-required "non-interactive mode cannot accept an artifact" "$acceptance" "Review the receipt and enter the exact acceptance interactively." 3; fi
printf '%s\n' "$acceptance"; printf 'Acceptance: '; read -r entered || fail "ACTION REQUIRED" artifact-acceptance-required "end of input" "$acceptance" "Review the receipt and enter the exact acceptance." 3
[ "$entered" = "$acceptance" ] || fail "ACTION REQUIRED" artifact-acceptance-required "acceptance did not match this receipt" "$acceptance" "Review the receipt and enter the exact acceptance." 3
# A successful exec is the ownership boundary: before it, this shell owns the
# accepted artifact; after it, the private bridge owns the artifact, session,
# signal handling, logout, and cleanup as one linear lifecycle.
REPOSITORY_ROOT="$repository_root" ARTIFACT_ROOT="$artifact_root" DEBUG="$debug" \
  exec node --conditions=source "$script_dir/bridge.ts" external
exec_status=$?
fail ERROR external-bridge-unavailable "could not transfer the accepted artifact to the private setup bridge" "a runnable private setup bridge" "Correct the generated setup files and retry." "$exec_status"
