#!/usr/bin/env bash
set -uo pipefail
: "${RUNNER_TEMP:?}" "${GITHUB_WORKSPACE:?}" "${BUILDER:?}"
root="$(mktemp -d "${RUNNER_TEMP}/infra12-buildkit-repro.XXXXXX")"
results="$GITHUB_WORKSPACE/.tmp/infra12-buildkit-local-cache-repro/results"
mkdir -p "$results" "$root/context-a" "$root/context-b" "$root/cache" "$root/out" "$root/gates"
docker buildx inspect "$BUILDER" > "$results/builder.log" 2>&1
trap 'rm -rf -- "$root"' EXIT
printf 'FROM scratch\nCOPY payload /payload\n' > "$root/context-a/Dockerfile"
cp "$root/context-a/Dockerfile" "$root/context-b/Dockerfile"
dd if=/dev/urandom of="$root/context-a/payload" bs=1024 count=1024 status=none
cp "$root/context-a/payload" "$root/context-b/payload"
cmp "$root/context-a/Dockerfile" "$root/context-b/Dockerfile"
cmp "$root/context-a/payload" "$root/context-b/payload"
printf 'builder=%s\npayload-sha256=%s\ncontexts=two-distinct-roots-with-byte-identical-Dockerfile-and-payload\ncache-boundaries=seed-empty-destination; serial-reuse; shared-destination-concurrent; separate-destinations-concurrent\nparallel-start=two-worker-FIFO-readiness-and-release-barrier\n' "$BUILDER" "$(sha256sum "$root/context-a/payload" | cut -d' ' -f1)" > "$results/summary.txt"
build() {
  local id="$1" context="$2" tag="$3" source="$4" destination="$5" code
  local -a args=(build --builder "$BUILDER" --progress plain --file "$context/Dockerfile" --tag "$tag" --output "type=local,dest=$root/out/$id" --cache-to "type=local,dest=$destination,mode=max")
  [[ -z "$source" ]] || args+=(--cache-from "type=local,src=$source")
  if docker buildx "${args[@]}" "$context" > "$results/$id.log" 2>&1; then code=0; else code=$?; fi
  printf '%s\n' "$code" > "$results/$id.exit"
  if (( code == 0 )) && cmp -s "$context/payload" "$root/out/$id/payload"; then printf 'readable-and-matches\n' > "$results/$id.output"; else printf 'missing-or-mismatch\n' > "$results/$id.output"; fi
  printf '%s-output=%s\n' "$id" "$(cat "$results/$id.output")" >> "$results/summary.txt"
}
gated_build() {
  local phase="$1" side="$2" context="$3" tag="$4" source="$5" destination="$6"
  printf 'ready\n' > "$root/gates/$phase-$side.ready"
  IFS= read -r _ < "$root/gates/$phase-$side.go"
  build "$phase-$side" "$context" "$tag" "$source" "$destination"
}
pair() {
  local phase="$1" source="$2" dest_a="$3" dest_b="$4" pa pb ra rb
  mkfifo "$root/gates/$phase-a.ready" "$root/gates/$phase-b.ready" "$root/gates/$phase-a.go" "$root/gates/$phase-b.go"
  gated_build "$phase" a "$root/context-a" "infra12:$phase-a" "$source" "$dest_a" & pa=$!
  gated_build "$phase" b "$root/context-b" "infra12:$phase-b" "$source" "$dest_b" & pb=$!
  cat "$root/gates/$phase-a.ready" >/dev/null & ra=$!
  cat "$root/gates/$phase-b.ready" >/dev/null & rb=$!
  wait "$ra"; wait "$rb"
  exec 7>"$root/gates/$phase-a.go"; exec 8>"$root/gates/$phase-b.go"
  printf 'go\n' >&7; printf 'go\n' >&8
  exec 7>&-; exec 8>&-
  wait "$pa"; wait "$pb"
}
build serial-seed "$root/context-a" infra12:serial-seed "" "$root/cache/serial"
build serial-reuse "$root/context-b" infra12:serial-reuse "$root/cache/serial" "$root/cache/serial"
build race-seed "$root/context-a" infra12:race-seed "" "$root/cache/race"
pair same-destination "$root/cache/race" "$root/cache/race" "$root/cache/race"
build after-race "$root/context-a" infra12:after-race "$root/cache/race" "$root/cache/after-race"
build split-seed "$root/context-a" infra12:split-seed "" "$root/cache/split-seed"
pair separate-destinations "$root/cache/split-seed" "$root/cache/split-a" "$root/cache/split-b"
printf '\nstatuses:\n' >> "$results/summary.txt"
for id in serial-seed serial-reuse race-seed same-destination-a same-destination-b after-race split-seed separate-destinations-a separate-destinations-b; do printf '%s=%s\n' "$id" "$(cat "$results/$id.exit")" >> "$results/summary.txt"; done
if rg -li 'ingest/.*(ENOENT|no such file)|ENOENT' "$results/same-destination-a.log" "$results/same-destination-b.log" > "$results/shared-destination-enoent.matches"; then printf 'shared-destination=ENOENT-observed\n' >> "$results/summary.txt"; else printf 'shared-destination=no-ENOENT-observed\n' >> "$results/summary.txt"; fi
cat "$results/summary.txt"
require_readable_green() {
  [[ "$(cat "$results/$1.exit")" == 0 && "$(cat "$results/$1.output")" == readable-and-matches ]]
}
for id in serial-seed serial-reuse race-seed after-race split-seed separate-destinations-a separate-destinations-b; do require_readable_green "$id" || exit 1; done
for id in same-destination-a same-destination-b; do
  if [[ "$(cat "$results/$id.exit")" == 0 ]]; then require_readable_green "$id" || exit 1; fi
done
