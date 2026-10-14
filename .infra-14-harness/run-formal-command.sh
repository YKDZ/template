#!/usr/bin/env bash
set -uo pipefail

mode=${1:?mode required: full-cold, full-warm, light, restored, or probe}
records="$MEASURE_ROOT/records"
pnpm_executable=$(command -v pnpm)
PNPM_CONFIG_STORE_DIR=${PNPM_CONFIG_STORE_DIR:?pnpm store directory was not configured}
overall_status=0
last_status=0
unset TURBO_TEAM TURBO_TOKEN TURBO_REMOTE_CACHE_SIGNATURE_KEY \
  TEMPLATE_FIXTURE_TURBO_TEAM TEMPLATE_FIXTURE_TURBO_TOKEN \
  TEMPLATE_FIXTURE_TURBO_REMOTE_CACHE_SIGNATURE_KEY TEMPLATE_FIXTURE_TURBO_REMOTE_CACHE_READ_ONLY
export GITHUB_SHA="$SOURCE_SHA"

record_cache_state() {
  local scope=$1 phase=$2 point=$3 target
  target="$records/$scope/$phase/cache-$point.txt"
  {
    date -u '+captured_utc=%Y-%m-%dT%H:%M:%SZ'
    printf 'loadavg='; cat /proc/loadavg
    grep '^Cpus_allowed_list:' /proc/self/status
    free -h
    df -h "$GITHUB_WORKSPACE" "$RUNNER_TEMP"
    for path in \
      "$GITHUB_WORKSPACE/.turbo" \
      "$TEMPLATE_FIXTURE_EVIDENCE_DIR" \
      "$GITHUB_WORKSPACE/.fixture-native-cache" \
      "$PNPM_CONFIG_STORE_DIR" "$HOME/.cache/ms-playwright"; do
      if [[ -e "$path" ]]; then
        printf '\npath=%s\n' "$path"
        du -sh "$path" 2>&1 || true
        printf 'files=%s\n' "$(find "$path" -type f -printf . 2>/dev/null | wc -c)"
      else
        printf 'path=%s\tstate=absent\n' "$path"
      fi
    done
  } > "$target"
  timeout --signal=TERM --kill-after=3s 30s docker buildx du --builder infra-14-performance \
    > "$records/$scope/$phase/buildx-du-$point.txt" 2>&1 || true
}

run_command() {
  local scope=$1 phase=$2 command_name=$3
  shift 3
  local command_dir="$records/$scope/$phase"
  local activity_dir="$GITHUB_WORKSPACE/.fixture-evidence-activity/$scope-$phase"
    local started ended started_ms ended_ms elapsed command_text install_count
    local capture_dir stdout_fifo stderr_fifo stdout_pid stderr_pid capture_prefix combined_log
  mkdir -p "$command_dir" "$activity_dir"
  export TEMPLATE_FIXTURE_EVIDENCE_ACTIVITY_DIR="$activity_dir"
  export TEMPLATE_FIXTURE_EVIDENCE_RUN_ID="infra-14-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${scope}-${phase}"
  export TEMPLATE_FIXTURE_EVIDENCE_RUN_ATTEMPT="$GITHUB_RUN_ATTEMPT"
  started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  started_ms=$(date +%s%3N)
  command_text=$(printf '%q ' "$@")
    combined_log="$command_dir/$command_name.log"
    capture_dir=$(mktemp -d "$command_dir/.capture-${command_name}.XXXXXX")
    stdout_fifo="$capture_dir/stdout"
    stderr_fifo="$capture_dir/stderr"
    capture_prefix="票14 $scope/$phase/$command_name"
    mkfifo "$stdout_fifo" "$stderr_fifo"
    : > "$combined_log"
    tee "$command_dir/$command_name.stdout.log" < "$stdout_fifo" \
      | tee -a "$combined_log" \
      | sed -u "s|^|[$capture_prefix stdout] |" &
    stdout_pid=$!
    tee "$command_dir/$command_name.stderr.log" < "$stderr_fifo" \
      | tee -a "$combined_log" \
      | sed -u "s|^|[$capture_prefix stderr] |" >&2 &
    stderr_pid=$!
    printf '正式命令开始 scope=%s phase=%s command=%s run_id=%s\n' \
      "$scope" "$phase" "$command_name" "$TEMPLATE_FIXTURE_EVIDENCE_RUN_ID" >&2
  if /usr/bin/time -f 'observer_wrapper_wall_seconds=%e observer_wrapper_user_seconds=%U observer_wrapper_sys_seconds=%S max_rss_kb=%M exit=%x' \
    -o "$command_dir/$command_name.time" \
    strace -f --seccomp-bpf -qq -e trace=execve -P "$pnpm_executable" \
        -o "$command_dir/$command_name.execve.log" -- "$@" \
        > "$stdout_fifo" 2> "$stderr_fifo"; then
    last_status=0
  else
    last_status=$?
    overall_status=1
  fi
    wait "$stdout_pid" || true
    wait "$stderr_pid" || true
    unlink "$stdout_fifo"
    unlink "$stderr_fifo"
    rmdir "$capture_dir"
  install_count=$(awk \
    '/execve\(/ && /\["[^"]*", "(install|i|add)"(,|\])/ && /= 0$/ { count++ } END { print count + 0 }' \
    "$command_dir/$command_name.execve.log" 2>/dev/null || printf '0')
  printf 'host_pnpm_dependency_install_execve_successes=%s\npnpm_executable=%s\n' \
    "$install_count" "$pnpm_executable" > "$command_dir/$command_name.pnpm-dependency-install-count.txt"
  ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  ended_ms=$(date +%s%3N)
  elapsed=$((ended_ms - started_ms))
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$scope-$phase" "$command_name" "$last_status" "$started" "$ended" "$elapsed" "$command_text" \
    >> "$records/steps.tsv"
  printf 'scope=%s phase=%s command=%s exit=%s elapsed_ms=%s run_id=%s\n' \
    "$scope" "$phase" "$command_name" "$last_status" "$elapsed" "$TEMPLATE_FIXTURE_EVIDENCE_RUN_ID" \
    >> "$command_dir/progress.log"
  command_exit=$last_status
  printf '%s\n' "$command_exit" > "$command_dir/$command_name.exit"
    printf '正式命令结束 scope=%s phase=%s command=%s exit=%s elapsed_ms=%s run_id=%s\n' \
      "$scope" "$phase" "$command_name" "$command_exit" "$elapsed" \
      "$TEMPLATE_FIXTURE_EVIDENCE_RUN_ID" >&2
  if [[ "$command_name" == full || "$command_name" == restored-full ]]; then
    activity_file="$activity_dir/activity.jsonl"
    if [[ ! -s "$activity_file" ]] || ! grep -Fq "$TEMPLATE_FIXTURE_EVIDENCE_RUN_ID" "$activity_file"; then
      printf '缺少本次正式 full 调用的 Fixture activity: %s\n' "$TEMPLATE_FIXTURE_EVIDENCE_RUN_ID" \
        >> "$command_dir/activity-check.log"
      last_status=1
      overall_status=1
    else
      grep -F "$TEMPLATE_FIXTURE_EVIDENCE_RUN_ID" "$activity_file" \
        > "$command_dir/current-run-activity.jsonl"
      wc -l < "$command_dir/current-run-activity.jsonl" \
        > "$command_dir/current-run-activity-count.txt"
    fi
  fi
            printf '活动检查结束 scope=%s phase=%s command=%s effective_exit=%s\n' \
              "$scope" "$phase" "$command_name" "$last_status" >&2
  return 0
}

run_phase() {
  local scope=$1 phase=$2 summary_copy_status=0
  local phase_dir="$records/$scope/$phase"
  mkdir -p "$phase_dir"
    printf '阶段开始 scope=%s phase=%s\n' "$scope" "$phase" >&2
  record_cache_state "$scope" "$phase" before
  docker ps -a --no-trunc > "$phase_dir/docker-ps-before.txt" 2>&1 || true
  (
    while [[ ! -e "$phase_dir/stop-docker-stats" ]]; do
      captured=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      snapshot=$(timeout --signal=TERM --kill-after=2s 10s docker stats --no-stream --format '{{json .}}' \
        2>> "$phase_dir/docker-stats-errors.log")
      result=$?
      if [[ "$result" -eq 0 ]]; then
        while IFS= read -r row; do
          [[ -n "$row" ]] && printf '%s\t%s\n' "$captured" "$row" >> "$phase_dir/docker-stats.jsonl"
        done <<< "$snapshot"
      else
        printf '%s\texit=%s\n' "$captured" "$result" >> "$phase_dir/docker-stats-errors.log"
      fi
      sleep 5
    done
  ) &
  stats_pid=$!

  if [[ "$scope" == full ]]; then
    run_command "$scope" "$phase" full pnpm run check:full
    full_status=$last_status
    run_command "$scope" "$phase" evidence-health pnpm --filter @ykdz/template-checks run check:evidence-health
    health_status=$last_status
    printf 'full_exit=%s\nevidence_health_exit=%s\n' "$full_status" "$health_status" \
      > "$phase_dir/phase-results.txt"
      printf '阶段命令结果 scope=%s phase=%s full_exit=%s evidence_health_exit=%s\n' \
        "$scope" "$phase" "$full_status" "$health_status" >&2
    if [[ "$full_status" -ne 0 || "$health_status" -ne 0 ]]; then overall_status=1; fi
  elif [[ "$scope" == light ]]; then
    run_command "$scope" "$phase" check pnpm run check
    printf 'check_exit=%s\n' "$last_status" > "$phase_dir/phase-results.txt"
      printf '阶段命令结果 scope=%s phase=%s check_exit=%s\n' \
        "$scope" "$phase" "$last_status" >&2
  else
    run_command "$scope" "$phase" restored-full pnpm run check:full
    full_status=$last_status
    run_command "$scope" "$phase" evidence-health pnpm --filter @ykdz/template-checks run check:evidence-health
    health_status=$last_status
    printf 'full_exit=%s\nevidence_health_exit=%s\n' "$full_status" "$health_status" \
      > "$phase_dir/phase-results.txt"
      printf '阶段命令结果 scope=%s phase=%s full_exit=%s evidence_health_exit=%s\n' \
        "$scope" "$phase" "$full_status" "$health_status" >&2
    if [[ "$full_status" -ne 0 || "$health_status" -ne 0 ]]; then overall_status=1; fi
  fi

  : > "$phase_dir/stop-docker-stats"
  wait "$stats_pid" 2>/dev/null || true
  docker ps -a --no-trunc > "$phase_dir/docker-ps-after.txt" 2>&1 || true
  docker buildx inspect infra-14-performance > "$phase_dir/buildx-inspect-after.txt" 2>&1 || true
  record_cache_state "$scope" "$phase" after
  fixture_ids=$(docker ps -aq --filter label=com.ykdz.template.fixture.project)
  list_status=$?
  if [[ "$list_status" -ne 0 ]]; then
    printf 'fixture_container_cleanup_exit=%s\n' "$list_status" > "$phase_dir/fixture-cleanup.txt"
    overall_status=1
  elif [[ -n "$fixture_ids" ]]; then
    mapfile -t fixture_containers <<< "$fixture_ids"
    if docker rm -f "${fixture_containers[@]}" > "$phase_dir/fixture-cleanup.log" 2>&1; then
      printf 'fixture_container_cleanup_exit=0\nfixture_containers_removed=%s\n' \
        "${#fixture_containers[@]}" > "$phase_dir/fixture-cleanup.txt"
    else
      cleanup_status=$?
      printf 'fixture_container_cleanup_exit=%s\n' "$cleanup_status" > "$phase_dir/fixture-cleanup.txt"
      overall_status=1
    fi
  else
    printf 'fixture_container_cleanup_exit=0\nfixture_containers_removed=0\n' > "$phase_dir/fixture-cleanup.txt"
  fi
  docker ps -a --no-trunc > "$phase_dir/docker-ps-after-cleanup.txt" 2>&1 || true
  if [[ -d .turbo/runs ]]; then
    if ! cp -a .turbo/runs "$records/turbo/$scope-$phase-runs"; then
      printf '无法保存此阶段的 Turbo 原生运行摘要。\n' > "$phase_dir/turbo-summary-copy-error.txt"
      summary_copy_status=1
      overall_status=1
    fi
  else
    printf '此阶段没有生成 .turbo/runs。\n' > "$phase_dir/turbo-summary-absent.txt"
  fi
  printf 'turbo_summary_copy_exit=%s\n' "$summary_copy_status" \
    >> "$phase_dir/phase-results.txt"
  date -u '+phase_completed_utc=%Y-%m-%dT%H:%M:%SZ' > "$phase_dir/phase-complete.txt"
    printf '阶段完成 scope=%s phase=%s overall_exit=%s summary_copy_exit=%s\n' \
      "$scope" "$phase" "$overall_status" "$summary_copy_status" >&2
}

if [[ ! -e "$records/steps.tsv" ]]; then
  printf 'scope\tstep\texit_code\tstarted_utc\tended_utc\telapsed_ms\tcommand\n' > "$records/steps.tsv"
fi

case "$mode" in
  full-cold)
    run_phase full cold
    cold_success=false
    [[ "$overall_status" -eq 0 ]] && cold_success=true
    printf 'cold_success=%s\n' "$cold_success" >> "$GITHUB_OUTPUT"
    ;;
  full-warm)
    run_phase full warm
    full_health_success=false
    [[ "$overall_status" -eq 0 ]] && full_health_success=true
    printf 'full_health_success=%s\n' "$full_health_success" >> "$GITHUB_OUTPUT"
    ;;
  light)
    mkdir -p "$MEASURE_ROOT/records/light"
    if ! rm -rf .turbo || ! mkdir -p .turbo; then
      printf '无法清空 Turbo 缓存目录，日常 light 冷测无效。\n' >&2
      exit 1
    fi
    printf 'cold_cache_boundary=Turbo 本地结果缓存已清空；full 阶段生成的 dist 构建产物保留，因此此阶段属于结果缓存冷、构建产物暖。\n' \
      > "$MEASURE_ROOT/records/light/cold-boundary.txt"
    run_phase light cold
    run_phase light warm
    ;;
  restored)
    run_phase restored cross-job
    ;;
  source-diagnostics)
    source_records="$records/final-diagnostics-source"
    mkdir -p "$source_records"
    if ! node --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';

const sourceSha = process.env.SOURCE_SHA;
const checkedOutSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (checkedOutSha !== sourceSha) throw new Error(`源提交不匹配：${checkedOutSha}`);

const workflowPath = resolve(process.env.GITHUB_WORKSPACE, '.github/workflows/check.yml');
const workflowBytes = readFileSync(workflowPath);
const workflow = parse(workflowBytes.toString('utf8'));
const steps = workflow?.jobs?.check?.steps;
if (!Array.isArray(steps)) throw new Error('固定源没有 jobs.check.steps');
const positions = new Map(steps.map((step, index) => [step.name, index]));
const stepByName = new Map(steps.map((step) => [step.name, step]));
const cleanup = stepByName.get('清理测试容器');
const owner = stepByName.get('恢复 Fixture 诊断属主');
const diagnostics = [
  stepByName.get('Upload Fixture Failure Diagnostics'),
  stepByName.get('Upload CLI Journey Diagnostics'),
  stepByName.get('Upload Preset Behavior Diagnostics'),
];
if (!cleanup || !owner || diagnostics.some((step) => !step)) {
  throw new Error('固定源缺少 Fixture 清理、属主恢复或诊断上传步骤');
}
if (!(positions.get(cleanup.name) < positions.get(owner.name)
  && diagnostics.every((step) => positions.get(owner.name) < positions.get(step.name)))) {
  throw new Error('固定源没有按清理、属主恢复、诊断上传顺序编排');
}
const expectedFixtureGuard = "always() && steps.fixture-prerequisites.outcome == 'success'";
if (cleanup.if !== expectedFixtureGuard || owner.if !== expectedFixtureGuard) {
  throw new Error('固定源 Fixture 清理或属主恢复条件已变化');
}
for (const step of diagnostics) {
  if (step.uses !== 'actions/upload-artifact@v7') throw new Error(`诊断 action 已变化：${step.name}`);
  if (step.with?.['include-hidden-files'] !== true || step.with?.['if-no-files-found'] !== 'ignore') {
    throw new Error(`诊断上传选项已变化：${step.name}`);
  }
}
const [fixtureDiagnostics, cliDiagnostics, presetDiagnostics] = diagnostics;
if (!String(fixtureDiagnostics.with.path).includes('.fixture-workspace/**')) {
  throw new Error('Fixture 诊断路径没有包含 .fixture-workspace');
}
if (new Set(diagnostics.map((step) => step.with['retention-days'])).size !== 1) {
  throw new Error('诊断上传的保留天数不一致，不能合并为同一制品');
}

const recordsDir = resolve(process.env.MEASURE_ROOT, 'records/final-diagnostics-source');
mkdirSync(recordsDir, { recursive: true });
const cleanupPath = resolve(recordsDir, 'cleanup-test-containers.sh');
const ownerPath = resolve(recordsDir, 'restore-diagnostics-owner.sh');
writeFileSync(cleanupPath, cleanup.run, 'utf8');
writeFileSync(ownerPath, owner.run, 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const metadata = {
  source_sha: sourceSha,
  check_workflow_sha256: sha256(workflowBytes),
  cleanup_step: { name: cleanup.name, index: positions.get(cleanup.name), run_sha256: sha256(cleanup.run) },
  owner_step: { name: owner.name, index: positions.get(owner.name), run_sha256: sha256(owner.run) },
  diagnostic_steps: diagnostics.map((step) => ({
    name: step.name,
    index: positions.get(step.name),
    action: step.uses,
    path_sha256: sha256(step.with.path),
    include_hidden_files: step.with['include-hidden-files'],
    if_no_files_found: step.with['if-no-files-found'],
    retention_days: step.with['retention-days'],
  })),
};
writeFileSync(resolve(recordsDir, 'source-step-contract.json'), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(JSON.stringify(metadata));

const artifactPath = [
  resolve(recordsDir, '**'),
  '.fixture-evidence/**',
  '.fixture-evidence-activity/**',
  fixtureDiagnostics.with.path.trimEnd(),
  cliDiagnostics.with.path.trimEnd(),
  presetDiagnostics.with.path.trimEnd(),
].join('\n');
const delimiter = 'INFRA14_FINAL_DIAGNOSTICS_PATH';
if (artifactPath.includes(delimiter)) throw new Error('诊断路径包含 GitHub 输出分隔符');
appendFileSync(process.env.GITHUB_OUTPUT,
  `artifact_path<<${delimiter}\n${artifactPath}\n${delimiter}\n`
  + `include_hidden_files=true\nif_no_files_found=ignore\nretention_days=${fixtureDiagnostics.with['retention-days']}\n`);
NODE
    then
      printf '源诊断步骤提取失败。\n' > "$source_records/extraction-failed.txt"
      exit 1
    fi

    if bash --noprofile --norc -e -o pipefail "$source_records/cleanup-test-containers.sh" \
      > "$source_records/cleanup.stdout.log" 2> "$source_records/cleanup.stderr.log"; then
      cleanup_status=0
    else
      cleanup_status=$?
    fi
    if bash --noprofile --norc -e -o pipefail "$source_records/restore-diagnostics-owner.sh" \
      > "$source_records/owner-restore.stdout.log" 2> "$source_records/owner-restore.stderr.log"; then
      owner_status=0
    else
      owner_status=$?
    fi
    printf 'cleanup_exit=%s\nowner_restore_exit=%s\n' "$cleanup_status" "$owner_status" \
      > "$source_records/source-step-results.txt"
    printf '固定源的容器清理与诊断属主恢复结果：cleanup=%s owner_restore=%s\n' \
      "$cleanup_status" "$owner_status" >&2
    if [[ "$cleanup_status" -ne 0 || "$owner_status" -ne 0 ]]; then overall_status=1; fi
    ;;
  probe)
    probe_command_cwd="$RUNNER_TEMP/infra-14-observability-command"
    mkdir -p "$GITHUB_WORKSPACE/.fixture-workspace/permission-probe"
    mkdir -p "$probe_command_cwd"
    mkdir -p "$records/probe/controlled"
    printf '{"name":"infra-14-empty-command-project","private":true}\n' \
      > "$probe_command_cwd/package.json"
    cp "$probe_command_cwd/package.json" "$records/probe/controlled/command-cwd-package.json"
    printf 'probe_command_cwd=%s\n' "$probe_command_cwd" \
      > "$records/probe/controlled/command-cwd.txt"
    printf 'controlled diagnostic payload\n' \
      > "$records/probe/controlled/expected-diagnostic.txt"
    printf 'lockfileVersion: "9.0"\nsettings:\n  autoInstallPeers: true\n' \
      > "$records/probe/controlled/expected-pnpm-lock.yaml"
    sudo install -o root -g root -m 0600 \
      "$records/probe/controlled/expected-pnpm-lock.yaml" \
      "$GITHUB_WORKSPACE/.fixture-workspace/permission-probe/pnpm-lock.yaml"
    stat -c 'uid=%u gid=%g mode=%a' \
      "$GITHUB_WORKSPACE/.fixture-workspace/permission-probe/pnpm-lock.yaml" \
      > "$records/probe/controlled/diagnostics-permission-target.stat"
    printf 'diagnostic_target=%s\n' \
      "$GITHUB_WORKSPACE/.fixture-workspace/permission-probe/pnpm-lock.yaml" \
      > "$records/probe/controlled/diagnostics-permission-target.txt"
    run_command probe controlled intentional-exit pnpm --dir "$probe_command_cwd" exec node -e \
      'process.stdout.write("controlled stdout\n"); process.stderr.write("controlled stderr\n"); process.exitCode = 17'
    printf 'expected_command_exit=17\nactual_command_exit=%s\n' "$last_status" \
      > "$records/probe/controlled/phase-results.txt"
    printf '短探针命令退出码：%s（预期 17）\n' "$last_status" >&2
    exit "$last_status"
    ;;
  *)
    printf '未知测量模式：%s\n' "$mode" >&2
    exit 2
    ;;
esac
exit "$overall_status"
