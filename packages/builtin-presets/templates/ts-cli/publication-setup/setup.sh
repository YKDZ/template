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
  REPOSITORY_ROOT="$repository_root" PACKAGE_PATH="$package_path" node --conditions=source --input-type=module <<'NODE'
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inspectNpmPublicationReadiness } from "./scripts/npm-publication/readiness.ts";
const root = process.env.REPOSITORY_ROOT;
const packagePath = process.env.PACKAGE_PATH;
const one = (value) => String(value ?? "").replaceAll(/[\r\n]+/gu, " ");
let readiness = "unavailable";
let blockers = [];
let publication;
try {
  const result = await inspectNpmPublicationReadiness({ repositoryRoot: root, packagePath });
  if (result.kind === "ready") { readiness = "ready"; publication = result.publication; }
  else { readiness = result.mode === "safe" ? "safe-unconfigured" : "public-intent-blocked"; blockers = result.blockers.map((item) => ({ code: item.code, observed: one(item.observed), expected: one(item.expected), nextAction: one(item.nextAction) })); }
} catch (error) { blockers = [{ code: "readiness-unavailable", observed: one(error), expected: "Readable local publication facts", nextAction: "Correct the repository facts and retry." }]; }
let git = { workingTree: null, currentBranch: null, defaultBranch: null, headMatchesRemoteDefault: null };
try {
  const run = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  git.workingTree = run("status", "--porcelain") === "" ? "clean" : "dirty";
  git.currentBranch = run("symbolic-ref", "--quiet", "--short", "HEAD") || null;
  const remote = run("ls-remote", "--symref", "origin", "HEAD").split("\n");
  const ref = remote.find((line) => line.startsWith("ref: "));
  git.defaultBranch = ref?.match(/refs\/heads\/([^\t]+)/u)?.[1] ?? null;
  const oid = remote.find((line) => /^[0-9a-f]{40}\s+HEAD$/u.test(line))?.split(/\s+/u)[0];
  git.headMatchesRemoteDefault = oid === undefined ? null : run("rev-parse", "HEAD") === oid;
} catch {}
const currentStage = readiness === "ready" && git.workingTree === "clean" && git.currentBranch !== null && git.currentBranch === git.defaultBranch && git.headMatchesRemoteDefault ? { id: "verify-first-release-artifact", number: 4, name: "Verify the first release artifact" } : readiness === "ready" ? { id: "commit-publication-configuration", number: 3, name: "Commit the publication configuration" } : { id: "configure-public-package", number: 2, name: "Configure the public package" };
if (blockers.length === 0 && currentStage.number === 3) blockers = [{ code: "git-handoff-required", observed: one(git.workingTree), expected: "A clean synchronized public default branch", nextAction: "Use the normal Git review and merge flow, then rerun setup." }];
console.log(JSON.stringify({ schemaVersion: 1, currentStage, observations: { packagePath, packageName: publication?.packageName ?? null, commandName: publication?.commandName ?? null, version: publication?.version ?? null, repository: publication?.repository ?? null, readiness, git }, blockers, nextAction: { kind: currentStage.number === 2 ? "provide-public-facts" : currentStage.number === 3 ? "normal-git-handoff" : "verify-artifact", command: "./scripts/npm-publication-setup/setup.sh" } }));
NODE
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
if [ -z "$package_name$command_name$description$license$copyright_holder$repository" ] && [ "$non_interactive" = false ] && [ "$existing_public" = false ]; then
  printf 'Package name: '; read -r package_name || exit 3
  printf 'Command name: '; read -r command_name || exit 3
  printf 'Public description: '; read -r description || exit 3
  printf 'SPDX license: '; read -r license || exit 3
  printf 'Copyright holder: '; read -r copyright_holder || exit 3
  printf 'Public GitHub repository: '; read -r repository || exit 3
fi

printf 'STAGE 2/4 Configure the public package\n'
PACKAGE_NAME="$package_name" COMMAND_NAME="$command_name" DESCRIPTION="$description" LICENSE_NAME="$license" COPYRIGHT_HOLDER="$copyright_holder" REPOSITORY_URL="$repository" REPOSITORY_ROOT="$repository_root" PACKAGE_PATH="$package_path" SETUP_DIR="$script_dir" node --conditions=source --input-type=module <<'NODE'
import { cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectNpmPublicationReadiness } from "./scripts/npm-publication/readiness.ts";
const env = process.env, root = env.REPOSITORY_ROOT, packagePath = env.PACKAGE_PATH, packageRoot = path.join(root, packagePath);
const fail = (code, observed, expected, next, status = 4) => { console.error(`ERROR ${code}\nObserved: ${observed}\nExpected: ${expected}\nNext action: ${next}`); process.exit(status); };
const files = [path.join(packageRoot, "package.json"), path.join(root, ".template/blueprint.json"), path.join(root, "LICENSE"), path.join(packageRoot, "LICENSE"), path.join(packageRoot, "README.md"), path.join(packageRoot, "CHANGELOG.md")];
let name = env.PACKAGE_NAME, command = env.COMMAND_NAME, description = env.DESCRIPTION, license = env.LICENSE_NAME, holder = env.COPYRIGHT_HOLDER, repository = env.REPOSITORY_URL;
let manifest, blueprint;
try { manifest = JSON.parse(readFileSync(files[0], "utf8")); blueprint = JSON.parse(readFileSync(files[1], "utf8")); } catch (error) { fail("owner-fact-invalid", String(error), "readable owner JSON", "Repair the owner file and retry."); }
const manifestRepository = typeof manifest.repository === "object" && manifest.repository !== null ? manifest.repository.url : undefined;
name ||= manifest.name;
command ||= Object.keys(manifest.bin ?? {})[0];
description ||= manifest.description;
license ||= manifest.license;
repository ||= typeof manifestRepository === "string" ? manifestRepository.replace(/^git\+/u, "").replace(/\.git$/u, "") : undefined;
if (!holder && existsSync(files[2])) holder = readFileSync(files[2], "utf8").match(/^Copyright(?: \(c\))?\s+(.+)$/mu)?.[1];
if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name) || !/^[a-z0-9][a-z0-9-]*$/u.test(command) || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) || !description.trim() || !license.trim() || !holder.trim()) fail("public-fact-invalid", "invalid public configuration", "valid npm, command, SPDX, holder, and public GitHub facts", "Correct the public flags and retry.", 2);
const date = new Date().toISOString().slice(0, 10);
const before = new Map(files.map((file) => [file, existsSync(file) ? readFileSync(file) : null]));
if (manifest.name !== undefined && !manifest.private && manifest.name !== name) fail("owner-fact-conflict", manifest.name, name, "Use the already configured public identity or resolve it through normal review.");
const asset = (file) => readFileSync(path.join(env.SETUP_DIR, "assets", file), "utf8");
let licenseBytes;
const placeholder = (key) => `{${"{"}${key}}}`;
if (license === "MIT") licenseBytes = asset("LICENSE-MIT.txt").replaceAll(placeholder("COPYRIGHT_HOLDER"), holder);
else if (license === "Apache-2.0") licenseBytes = asset("LICENSE-APACHE-2.0.txt").replaceAll(placeholder("COPYRIGHT_HOLDER"), holder);
else { if (!before.get(files[2])) fail("license-owner-required", "missing root LICENSE", "existing non-placeholder LICENSE for a custom SPDX expression", "Add the license through normal review and retry."); licenseBytes = before.get(files[2]).toString(); }
const markdown = (file, values) => Object.entries(values).reduce((text, [key, value]) => text.replaceAll(placeholder(key), value), asset(file));
const target = new Map();
target.set(files[0], Buffer.from(`${JSON.stringify({ ...manifest, name, version: "1.0.0", description, license, homepage: `${repository}#readme`, bugs: { url: `${repository}/issues` }, repository: { type: "git", url: `git+${repository}.git`, directory: packagePath }, bin: { [command]: "./dist/cli.js" }, files: ["dist", "README.md", "LICENSE", "CHANGELOG.md"], publishConfig: { access: "public", registry: "https://registry.npmjs.org/" }, private: undefined }, null, 2).replace(/\n  "private": undefined,?/u, "")}\n`));
const nextManifest = JSON.parse(target.get(files[0]).toString()); delete nextManifest.private; target.set(files[0], Buffer.from(`${JSON.stringify(nextManifest, null, 2)}\n`));
target.set(files[1], Buffer.from(`${JSON.stringify({ ...blueprint, packages: blueprint.packages.map((item) => item.path === packagePath ? { ...item, name } : item) }, null, 2)}\n`));
target.set(files[2], Buffer.from(licenseBytes)); target.set(files[3], Buffer.from(licenseBytes));
target.set(files[4], Buffer.from(markdown("README.md.template", { PACKAGE_NAME: name, DESCRIPTION: description, COMMAND_NAME: command })));
const oldChangelog = before.get(files[5])?.toString(); const oldDate = oldChangelog?.match(/^## \[1\.0\.0\] - (\d{4}-\d{2}-\d{2})$/mu)?.[1];
target.set(files[5], Buffer.from(markdown("CHANGELOG.md.template", { RELEASE_DATE: oldDate ?? date, REPOSITORY_URL: repository })));
const overlay = mkdtempSync(path.join(tmpdir(), "npm-publication-setup-overlay-"));
try {
  rmSync(overlay, { recursive: true, force: true });
  cpSync(root, overlay, { recursive: true, filter: (source) => !source.endsWith("/.git") && !source.includes("/node_modules") });
  for (const [file, bytes] of target) writeFileSync(path.join(overlay, path.relative(root, file)), bytes);
  const readiness = await inspectNpmPublicationReadiness({ repositoryRoot: overlay, packagePath });
  if (readiness.kind !== "ready") fail("configuration-plan-blocked", readiness.blockers[0]?.code ?? "blocked", "Ticket 08 readiness", "Correct the public facts and retry.");
  for (const [file, bytes] of before) { const current = existsSync(file) ? readFileSync(file) : null; if (String(current) !== String(bytes)) fail("configuration-preimage-changed", path.relative(root, file), "unchanged owner preimages", "Retry from a stable working tree."); }
  for (const [file, bytes] of target) { if (Buffer.compare(before.get(file) ?? Buffer.alloc(0), bytes) === 0) continue; const temporary = `${file}.npm-publication-setup-${process.pid}`; writeFileSync(temporary, bytes); renameSync(temporary, file); }
} finally { rmSync(overlay, { recursive: true, force: true }); }
NODE
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
case "$remote" in *"github.com"*) ;; *) fail ERROR repository-remote-conflict "$(printf '%s' "$remote" | redact)" "public GitHub origin" "Correct the normal Git remote and retry." 4 ;; esac
printf 'OK git-handoff-complete\nSTAGE 4/4 Verify the first release artifact\n'
artifact_root=$(mktemp -d "${TMPDIR:-/tmp}/npm-publication-setup-artifact.XXXXXX") || fail ERROR artifact-temporary-output "unable to create temporary output" "an empty local temporary directory" "Correct temporary directory permissions and retry." 5
trap 'rm -rf "$artifact_root"' EXIT HUP INT TERM
if [ "$debug" = true ]; then printf 'COMMAND %s\n' "pnpm run publication:artifact -- --output-directory [temporary]"; fi
pnpm run publication:artifact -- --output-directory "$artifact_root" || fail ERROR artifact-verification-failed "publication artifact caller failed" "a verified Ticket 09 artifact" "Correct the reported artifact failure and retry." 5
receipt=$(find "$artifact_root" -name verified-publication-artifact.json -type f -print -quit)
[ -n "$receipt" ] || fail ERROR artifact-receipt-missing "no receipt" "verified artifact receipt" "Retry artifact verification." 5
acceptance=$(node --input-type=module - "$receipt" <<'NODE'
import { readFileSync } from "node:fs"; const receipt = JSON.parse(readFileSync(process.argv[2], "utf8")); console.log(`ACCEPT ${receipt.publication.packageName}@${receipt.publication.version} ${receipt.artifact.integrity}`);
NODE
)
if [ "$non_interactive" = true ]; then fail "ACTION REQUIRED" artifact-acceptance-required "non-interactive mode cannot accept an artifact" "$acceptance" "Review the receipt and enter the exact acceptance interactively." 3; fi
printf '%s\n' "$acceptance"; printf 'Acceptance: '; read -r entered || fail "ACTION REQUIRED" artifact-acceptance-required "end of input" "$acceptance" "Review the receipt and enter the exact acceptance." 3
[ "$entered" = "$acceptance" ] || fail "ACTION REQUIRED" artifact-acceptance-required "acceptance did not match this receipt" "$acceptance" "Review the receipt and enter the exact acceptance." 3
printf 'OK local-preparation-complete\nLocal preparation complete.\nNext action: Continue with npm authentication and the first manual publish in the next setup phase.\n'
