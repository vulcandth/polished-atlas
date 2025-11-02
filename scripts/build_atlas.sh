#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POLISHED_REPO_URL="${POLISHED_REPO_URL:-https://github.com/Rangi42/polishedcrystal.git}"
POLISHED_REF="${POLISHED_REF:-v3.2.0}"
POLISHED_DIR="${POLISHED_DIR:-${ROOT_DIR}/external/polishedcrystal}"
POLISHED_UPDATE="${POLISHED_UPDATE:-false}"
TIME_OF_DAY_LIST_ENV="${TIME_OF_DAY_SET:-}"
if [[ -z "${TIME_OF_DAY_LIST_ENV}" && -n "${TIME_OF_DAY:-}" ]]; then
  TIME_OF_DAY_LIST_ENV="${TIME_OF_DAY}"
fi
TIME_OF_DAY_LIST="${TIME_OF_DAY_LIST_ENV:-day,morn,nite,eve}"
WEEKDAY="${WEEKDAY:-1}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
NODE_BIN="${NODE_BIN:-npm}"
VITE_POLISHED_VERSION="${VITE_POLISHED_VERSION:-v3.2.0}"

log() {
  printf '[build-atlas] %s\n' "$1"
}

ensure_polished_repo() {
  if [[ -d "${POLISHED_DIR}/.git" ]]; then
    if [[ "${POLISHED_UPDATE}" == "true" ]]; then
      log "Updating polishedcrystal from ${POLISHED_REPO_URL} (${POLISHED_REF})"
      git -C "${POLISHED_DIR}" fetch --force --prune --tags origin
      git -C "${POLISHED_DIR}" checkout --force "${POLISHED_REF}"
    else
      log "Using existing polishedcrystal clone at ${POLISHED_DIR}"
    fi
    return
  fi
  if [[ -d "${POLISHED_DIR}" ]]; then
    local existing
    existing=$(ls -A "${POLISHED_DIR}" 2>/dev/null || true)
    if [[ -n "${existing}" ]]; then
      log "Using existing polishedcrystal assets at ${POLISHED_DIR}"
      return
    fi
  fi
  log "Cloning polishedcrystal from ${POLISHED_REPO_URL} (${POLISHED_REF})"
  mkdir -p "${POLISHED_DIR}"
    git clone --depth 1 --branch "${POLISHED_REF}" --single-branch "${POLISHED_REPO_URL}" "${POLISHED_DIR}"
    git -C "${POLISHED_DIR}" checkout --force "${POLISHED_REF}"
}

run_generators() {
  local raw_time_slugs=()
  IFS=',' read -r -a raw_time_slugs <<< "${TIME_OF_DAY_LIST}"
  declare -A seen_slugs=()
  local canonical_slugs=()
  for raw_slug in "${raw_time_slugs[@]}"; do
    local trimmed
    trimmed="${raw_slug//[[:space:]]/}"
    if [[ -z "${trimmed}" ]]; then
      continue
    fi
    local lower
    lower="${trimmed,,}"
    local canonical
    case "${lower}" in
      0|morn|morning) canonical="morn" ;;
      1|day|daytime) canonical="day" ;;
      2|nite|night|nighttime) canonical="nite" ;;
      3|eve|evening) canonical="eve" ;;
      *)
        log "Unsupported time of day value '${raw_slug}'"
        exit 1
        ;;
    esac
    if [[ -z "${seen_slugs[${canonical}]:-}" ]]; then
      canonical_slugs+=("${canonical}")
      seen_slugs["${canonical}"]=1
    fi
  done

  if [[ ${#canonical_slugs[@]} -eq 0 ]]; then
    log "No time of day values resolved from '${TIME_OF_DAY_LIST}'"
    exit 1
  fi

  # Prefer to render the day palette first so manifests exist for other palettes.
  if [[ -n "${seen_slugs[day]:-}" ]]; then
    local reordered=("day")
    for slug in "${canonical_slugs[@]}"; do
      if [[ "${slug}" != "day" ]]; then
        reordered+=("${slug}")
      fi
    done
    canonical_slugs=("${reordered[@]}")
  fi

  for time_slug in "${canonical_slugs[@]}"; do
    log "Rendering polishedcrystal maps (${time_slug})"
  "${PYTHON_BIN}" "${ROOT_DIR}/scripts/render_maps.py" \
      --polishedcrystal "${POLISHED_DIR}" \
      --time-of-day "${time_slug}" \
      --weekday "${WEEKDAY}" \
      --format sheet

    log "Generating atlas connection layouts (${time_slug})"
  "${PYTHON_BIN}" "${ROOT_DIR}/scripts/generate_map_neighborhoods.py" \
      --polishedcrystal "${POLISHED_DIR}" \
      --time-of-day "${time_slug}" \
      --overlay-rules "${ROOT_DIR}/scripts/overlay_rules.json" \
      --overworld-exclude-file "${ROOT_DIR}/scripts/overworld_exclude.json"
  done

  log "Extracting warp metadata"
  "${PYTHON_BIN}" "${ROOT_DIR}/scripts/generate_warp_metadata.py" \
    --polishedcrystal "${POLISHED_DIR}" \
    --overworld-exclude-file "${ROOT_DIR}/scripts/overworld_exclude.json"

  log "Generating overworld object metadata"
  "${PYTHON_BIN}" "${ROOT_DIR}/scripts/generate_object_metadata.py" \
    --polishedcrystal "${POLISHED_DIR}" \
    --event-overrides "${ROOT_DIR}/scripts/event_overrides.json"

  log "Generating weather metadata"
  "${PYTHON_BIN}" "${ROOT_DIR}/scripts/generate_weather_metadata.py" \
    --polishedcrystal "${POLISHED_DIR}"

  log "Computing per-map weather state"
  "${PYTHON_BIN}" "${ROOT_DIR}/scripts/generate_weather_state.py" \
    --polishedcrystal "${POLISHED_DIR}" \
    --weekday "${WEEKDAY}" \
    --time-of-day "${canonical_slugs[0]}" \
    --event-overrides "${ROOT_DIR}/scripts/event_overrides.json"
}

build_web_bundle() {
  export VITE_POLISHED_VERSION
  log "Installing web dependencies"
  "${NODE_BIN}" --prefix "${ROOT_DIR}/web/atlas" ci
  log "Building web bundle (polishedcrystal ${VITE_POLISHED_VERSION})"
  "${NODE_BIN}" --prefix "${ROOT_DIR}/web/atlas" run build

  local dist_dir="${ROOT_DIR}/web/atlas/dist"
  local maps_source="${ROOT_DIR}/maps"
  local maps_destination="${dist_dir}/maps"
  if [[ -d "${maps_source}" ]]; then
    log "Copying generated map assets into web bundle"
    rm -rf "${maps_destination}"
    mkdir -p "${maps_destination}"
    cp -a "${maps_source}/." "${maps_destination}/"
  else
    log "No generated maps found at ${maps_source}"
  fi
}

ensure_polished_repo
run_generators
build_web_bundle

log "Build pipeline completed"
