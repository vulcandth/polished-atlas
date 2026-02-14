import MapSearch, { type SearchResult } from "@/components/MapSearch";
import type { MapPlacement, NeighborhoodSummary } from "@/types";

const TIME_OF_DAY_OPTIONS = [
  { value: "morn", label: "Morning" },
  { value: "day", label: "Day" },
  { value: "nite", label: "Night" },
  { value: "eve", label: "Evening" },
] as const;

export type TimeOfDaySlug = (typeof TIME_OF_DAY_OPTIONS)[number]["value"];

interface HeaderNavProps {
  subtitle: string;
  version: string;
  placements: MapPlacement[];
  neighborhoods: NeighborhoodSummary[];
  onSearchSelect: (result: SearchResult) => void;
  isLoading: boolean;
  timeOfDay: TimeOfDaySlug;
  onTimeOfDayChange: (value: string) => void;
  timeSelectDisabled: boolean;
  timeSelectTitle: string;
  disableMapAnimations: boolean;
  onDisableMapAnimationsChange: (value: boolean) => void;
  disableObjectAnimations: boolean;
  onDisableObjectAnimationsChange: (value: boolean) => void;
  onReload: () => void;
  canEdit: boolean;
  editing: boolean;
  onToggleEditing: () => void;
  saveStatus: "idle" | "saving" | "success" | "error";
}

export default function HeaderNav({
  subtitle,
  version,
  placements,
  neighborhoods,
  onSearchSelect,
  isLoading,
  timeOfDay,
  onTimeOfDayChange,
  timeSelectDisabled,
  timeSelectTitle,
  disableMapAnimations,
  onDisableMapAnimationsChange,
  disableObjectAnimations,
  onDisableObjectAnimationsChange,
  onReload,
  canEdit,
  editing,
  onToggleEditing,
  saveStatus,
}: HeaderNavProps) {
  return (
    <header className="app-header">
      <div className="brand">
        <h1>Polished Atlas</h1>
        <span className="subtitle">{subtitle}</span>
        <span className="version">polishedcrystal {version}</span>
      </div>
      <MapSearch
        placements={placements}
        neighborhoods={neighborhoods}
        onSelect={onSearchSelect}
        disabled={isLoading}
      />
      <div className="actions">
        <div className="time-picker">
          <label htmlFor="time-of-day-select">Time</label>
          <select
            id="time-of-day-select"
            value={timeOfDay}
            onChange={(event) => onTimeOfDayChange(event.target.value)}
            disabled={timeSelectDisabled}
            title={timeSelectTitle}
          >
            {TIME_OF_DAY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="perf-toggles" title="Rendering performance options">
          <label>
            <input
              type="checkbox"
              checked={disableMapAnimations}
              onChange={(e) => onDisableMapAnimationsChange(e.target.checked)}
            />
            <span>Disable map animations</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={disableObjectAnimations}
              onChange={(e) => onDisableObjectAnimationsChange(e.target.checked)}
            />
            <span>Disable NPC animations</span>
          </label>
        </div>
        <button type="button" onClick={onReload} disabled={isLoading}>
          {isLoading ? "Loading…" : "Reload"}
        </button>
        {canEdit && (
          <button
            type="button"
            onClick={onToggleEditing}
            disabled={isLoading || saveStatus === "saving"}
          >
            {!editing ? "Edit Layout" : saveStatus === "saving" ? "Saving…" : "Finish Editing"}
          </button>
        )}
      </div>
    </header>
  );
}

export { TIME_OF_DAY_OPTIONS };
