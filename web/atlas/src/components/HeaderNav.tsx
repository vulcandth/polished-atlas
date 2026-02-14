import { useState, useEffect } from "react";
import {
  CameraIcon,
  HelpCircleIcon,
  RefreshCwIcon,
  SearchIcon,
  PencilIcon,
  CheckIcon,
} from "lucide-react";
import MapSearch, { type SearchResult } from "@/components/MapSearch";
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
} from "@/components/ui/menubar";
import { cn } from "@/lib/utils";
import type { MapPlacement, NeighborhoodSummary } from "@/types";
import { Badge } from "./ui/badge";

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
  weatherEnabled: boolean;
  onWeatherEnabledChange: (value: boolean) => void;
  spriteLimitEnabled: boolean;
  onSpriteLimitEnabledChange: (value: boolean) => void;
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
      // Don't trigger if user is typing in an input/textarea
      const target = e.target as HTMLElement;
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

  return (
    <header className="flex flex-col sm:flex-row items-start sm:items-center justify-end gap-4 py-2 px-4 sm:px-6 lg:px-8 border-b-1">
      <div className="brand flex flex-col items-start gap-0 mr-auto">
       <div className="flex flex-row items-center gap-2">
         <h1>Polished Atlas</h1>
         <Badge>{version}</Badge>
       </div>
        <span className="text-xs font-bold">{subtitle}</span>
      </div>

      <button
        onClick={() => setSearchOpen(true)}
        disabled={isLoading}
        type="button"
        className={cn(
          "inline-flex items-center gap-2 whitespace-nowrap justify-start",
          "h-9 w-[180px] sm:w-[240px]",
          "rounded-md text-sm transition-all px-3 py-2",
          "border bg-background text-muted-foreground",
          "hover:border-accent hover:bg-accent/5",
          "disabled:opacity-50 disabled:cursor-not-allowed",
        )}
      >
        <SearchIcon className="size-4 shrink-0" />
        <span className="truncate flex-1 text-left">Search maps...</span>
        <div className="hidden gap-0.5 sm:flex ml-auto shrink-0">
          <kbd
            className={cn(
              "bg-muted text-muted-foreground",
              "pointer-events-none inline-flex h-5 min-w-5 items-center justify-center",
              "rounded-sm px-1 font-sans text-[10px] font-medium select-none border",
            )}
          >
            /
          </kbd>
        </div>
      </button>
      <MapSearch
        placements={placements}
        neighborhoods={neighborhoods}
        onSelect={onSearchSelect}
        disabled={isLoading}
        open={searchOpen}
        onOpenChange={setSearchOpen}
      />
        <Menubar>
        <MenubarMenu>
          <MenubarTrigger>View</MenubarTrigger>
          <MenubarContent>
            <MenubarItem onClick={onResetView}>
              Reset View
              <MenubarShortcut>R</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarRadioGroup value={timeOfDay} onValueChange={onTimeOfDayChange}>
              {TIME_OF_DAY_OPTIONS.map((option) => (
                <MenubarRadioItem
                  key={option.value}
                  value={option.value}
                  disabled={timeSelectDisabled}
                >
                  {option.label}
                </MenubarRadioItem>
              ))}
            </MenubarRadioGroup>
            <MenubarSeparator />
            <MenubarItem onClick={onReload} disabled={isLoading}>
              <RefreshCwIcon className="size-4" />
              {isLoading ? "Loading…" : "Reload Data"}
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger>Performance</MenubarTrigger>
          <MenubarContent>
            <MenubarCheckboxItem
              checked={disableMapAnimations}
              onCheckedChange={(checked) => onDisableMapAnimationsChange(checked === true)}
            >
              Disable Map Animations
            </MenubarCheckboxItem>
            <MenubarCheckboxItem
              checked={disableObjectAnimations}
              onCheckedChange={(checked) => onDisableObjectAnimationsChange(checked === true)}
            >
              Disable NPC Animations
            </MenubarCheckboxItem>
            <MenubarSeparator />
            <MenubarCheckboxItem
              checked={weatherEnabled}
              onCheckedChange={(checked) => onWeatherEnabledChange(checked === true)}
            >
              Weather Effects
            </MenubarCheckboxItem>
            <MenubarCheckboxItem
              checked={spriteLimitEnabled}
              onCheckedChange={(checked) => onSpriteLimitEnabledChange(checked === true)}
            >
              Sprite Limit Analysis
            </MenubarCheckboxItem>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger>Tools</MenubarTrigger>
          <MenubarContent>
            <MenubarItem onClick={() => setSearchOpen(true)}>
              <SearchIcon className="size-4" />
              Search Maps
              <MenubarShortcut>/</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={onScreenshot}>
              <CameraIcon className="size-4" />
              Take Screenshot
            </MenubarItem>
            <MenubarSeparator />
            {canEdit && (
              <MenubarItem
                onClick={onToggleEditing}
                disabled={isLoading || saveStatus === "saving"}
              >
                {editing ? <CheckIcon className="size-4" /> : <PencilIcon className="size-4" />}
                {!editing
                  ? "Edit Layout"
                  : saveStatus === "saving"
                    ? "Saving…"
                    : "Finish Editing"}
              </MenubarItem>
            )}
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger>Help</MenubarTrigger>
          <MenubarContent>
            <MenubarItem onClick={onOpenHelp}>
              <HelpCircleIcon className="size-4" />
              Keyboard Shortcuts
              <MenubarShortcut>?</MenubarShortcut>
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>
      </Menubar>
    </header>
  );
}

export { TIME_OF_DAY_OPTIONS };
