import { useState, useEffect } from "react";
import {
  CameraIcon,
  HelpCircleIcon,
  RefreshCwIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
  MoonIcon,
  SunriseIcon,
  SunsetIcon,
  MonitorIcon,
  WrenchIcon,
  CloudIcon,
  ActivityIcon,
  EyeIcon,
  RotateCcwIcon,
  PencilIcon,
  CheckIcon,
  SquareIcon,
} from "lucide-react";
import MapSearch, { type SearchResult } from "@/components/MapSearch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { MapPlacement, NeighborhoodSummary } from "@/types";
import { Badge } from "./ui/badge";

const TIME_OF_DAY_OPTIONS = [
  { value: "morn", label: "Morning", icon: SunriseIcon },
  { value: "day", label: "Day", icon: SunIcon },
  { value: "eve", label: "Evening", icon: SunsetIcon },
  { value: "nite", label: "Night", icon: MoonIcon },
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
  weatherEnabled: boolean;
  onWeatherEnabledChange: (value: boolean) => void;
  spriteLimitEnabled: boolean;
  onSpriteLimitEnabledChange: (value: boolean) => void;
  mapBordersEnabled: boolean;
  onMapBordersEnabledChange: (value: boolean) => void;
  onReload: () => void;
  onResetView: () => void;
  onScreenshot: () => void;
  onOpenHelp: () => void;
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
  disableMapAnimations,
  onDisableMapAnimationsChange,
  disableObjectAnimations,
  onDisableObjectAnimationsChange,
  weatherEnabled,
  onWeatherEnabledChange,
  spriteLimitEnabled,
  onSpriteLimitEnabledChange,
  mapBordersEnabled,
  onMapBordersEnabledChange,
  onReload,
  onResetView,
  onScreenshot,
  onOpenHelp,
  canEdit,
  editing,
  onToggleEditing,
  saveStatus,
}: HeaderNavProps) {
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      
      // Handle Ctrl+K / Cmd+K from anywhere (even inputs)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      if (e.key === "/" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const currentTimeOption = TIME_OF_DAY_OPTIONS.find((opt) => opt.value === timeOfDay);
  const TimeIcon = currentTimeOption?.icon ?? SunIcon;

  return (
    <header className="flex items-center justify-between gap-3 py-2 px-4 sm:px-6 border-b bg-background z-50">
      {/* Brand */}
      <div className="flex flex-col gap-0 min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="text-base font-semibold tracking-tight whitespace-nowrap">Polished Atlas</h1>
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{version}</Badge>
        </div>
        <span className="text-xs text-muted-foreground truncate">{subtitle}</span>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        {/* Search */}
        <button
          onClick={() => setSearchOpen(true)}
          disabled={isLoading}
          type="button"
          className={cn(
            "inline-flex items-center gap-2 whitespace-nowrap justify-start",
            "h-8 w-[140px] sm:w-[200px]",
            "rounded-md text-sm transition-all px-2.5 py-1.5",
            "border bg-muted/50 text-muted-foreground",
            "hover:bg-muted hover:text-foreground",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          )}
        >
          <SearchIcon className="size-3.5 shrink-0" />
          <span className="truncate flex-1 text-left text-xs">Search...</span>
          <kbd
            className={cn(
              "hidden sm:inline-flex",
              "bg-background text-muted-foreground",
              "h-4 min-w-4 items-center justify-center",
              "rounded px-1 font-mono text-[10px] border",
            )}
          >
            /
          </kbd>
        </button>

        <MapSearch
          placements={placements}
          neighborhoods={neighborhoods}
          onSelect={onSearchSelect}
          disabled={isLoading}
          open={searchOpen}
          onOpenChange={setSearchOpen}
        />

       <div className='[&_[data-radix-popper-content-wrapper]]:bg-red-300'>
   {/* Settings Dropdown */}
          <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8">
              <SettingsIcon className="size-4" />
              <span className="sr-only">Settings</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[var(--radix-popper-anchor-width)] top-14 relative rounded-none">
            {/* Time of Day */}
            <DropdownMenuLabel className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
              <TimeIcon className="size-3.5" />
              Time of Day
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup value={timeOfDay} onValueChange={onTimeOfDayChange}>
              {TIME_OF_DAY_OPTIONS.map((option) => (
                <DropdownMenuRadioItem
                  key={option.value}
                  value={option.value}
                  disabled={timeSelectDisabled}
                  className="text-sm"
                >
                  <option.icon className="size-3.5 mr-2" />
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>

            <DropdownMenuSeparator />

            {/* Display Options */}
            <DropdownMenuLabel className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
              <MonitorIcon className="size-3.5" />
              Display
            </DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={!disableMapAnimations}
              onCheckedChange={(checked) => onDisableMapAnimationsChange(!checked)}
            >
              Map Animations
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={!disableObjectAnimations}
              onCheckedChange={(checked) => onDisableObjectAnimationsChange(!checked)}
            >
              NPC Animations
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={weatherEnabled}
              onCheckedChange={(checked) => onWeatherEnabledChange(checked === true)}
            >
              <CloudIcon className="size-3.5 mr-2" />
              Weather Effects
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={mapBordersEnabled}
              onCheckedChange={(checked) => onMapBordersEnabledChange(checked === true)}
            >
              <SquareIcon className="size-3.5 mr-2" />
              Map Borders
            </DropdownMenuCheckboxItem>

            <DropdownMenuSeparator />

            {/* View Actions */}
            <DropdownMenuLabel className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
              <EyeIcon className="size-3.5" />
              View
            </DropdownMenuLabel>
            <DropdownMenuItem onClick={onResetView}>
              <RotateCcwIcon className="size-3.5" />
              Reset View
              <DropdownMenuShortcut>R</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onScreenshot}>
              <CameraIcon className="size-3.5" />
              Screenshot
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onReload} disabled={isLoading}>
              <RefreshCwIcon className="size-3.5" />
              {isLoading ? "Loading…" : "Reload Data"}
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            {/* Developer Tools */}
            <DropdownMenuLabel className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
              <WrenchIcon className="size-3.5" />
              Developer
            </DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={spriteLimitEnabled}
              onCheckedChange={(checked) => onSpriteLimitEnabledChange(checked === true)}
            >
              <ActivityIcon className="size-3.5 mr-2" />
              Sprite Limit Analysis
            </DropdownMenuCheckboxItem>
            {canEdit && (
              <DropdownMenuItem
                onClick={onToggleEditing}
                disabled={isLoading || saveStatus === "saving"}
              >
                {editing ? <CheckIcon className="size-3.5" /> : <PencilIcon className="size-3.5" />}
                {!editing
                  ? "Edit Layout"
                  : saveStatus === "saving"
                    ? "Saving…"
                    : "Finish Editing"}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        </div>
        {/* Help Button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" onClick={onOpenHelp}>
              <HelpCircleIcon className="size-4" />
              <span className="sr-only">Help</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Keyboard Shortcuts</p>
            <kbd className="text-[10px] text-muted-foreground">?</kbd>
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}

export { TIME_OF_DAY_OPTIONS };
