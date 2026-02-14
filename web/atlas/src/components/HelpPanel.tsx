import { useState } from "react";

interface HelpPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ShortcutInfo {
  keys: string[];
  description: string;
}

const KEYBOARD_SHORTCUTS: ShortcutInfo[] = [
  { keys: ["Scroll"], description: "Zoom in/out" },
  { keys: ["Drag"], description: "Pan the map" },
  { keys: ["+", "="], description: "Zoom in" },
  { keys: ["-"], description: "Zoom out" },
  { keys: ["0"], description: "Reset zoom" },
  { keys: ["F"], description: "Toggle fullscreen" },
  { keys: ["/", "Ctrl+K"], description: "Focus search" },
  { keys: ["Esc"], description: "Close panels" },
];

interface LegendItem {
  icon: string;
  color: string;
  label: string;
}

const MAP_LEGEND: LegendItem[] = [
  { icon: "●", color: "#4CAF50", label: "Grass / Wild encounters" },
  { icon: "●", color: "#2196F3", label: "Water / Surf encounters" },
  { icon: "●", color: "#9C27B0", label: "Cave / Rock Smash" },
  { icon: "↔", color: "#FF9800", label: "Map connection" },
  { icon: "◆", color: "#F44336", label: "Warp point" },
  { icon: "○", color: "#FFEB3B", label: "NPC / Trainer" },
];

export default function HelpPanel({ isOpen, onClose }: HelpPanelProps) {
  const [activeTab, setActiveTab] = useState<"shortcuts" | "legend">("shortcuts");

  if (!isOpen) return null;

  return (
    <div className="help-panel-overlay" onClick={onClose}>
      <div className="help-panel" onClick={(e) => e.stopPropagation()}>
        <header className="help-panel-header">
          <h2>Help</h2>
          <button
            className="help-panel-close"
            onClick={onClose}
            aria-label="Close help panel"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>
        
        <nav className="help-panel-tabs">
          <button
            className={activeTab === "shortcuts" ? "active" : ""}
            onClick={() => setActiveTab("shortcuts")}
          >
            Keyboard Shortcuts
          </button>
          <button
            className={activeTab === "legend" ? "active" : ""}
            onClick={() => setActiveTab("legend")}
          >
            Map Legend
          </button>
        </nav>
        
        <div className="help-panel-content">
          {activeTab === "shortcuts" && (
            <table className="shortcuts-table">
              <tbody>
                {KEYBOARD_SHORTCUTS.map((shortcut, index) => (
                  <tr key={index}>
                    <td className="shortcut-keys">
                      {shortcut.keys.map((key, i) => (
                        <span key={i}>
                          {i > 0 && <span className="key-separator"> / </span>}
                          <kbd>{key}</kbd>
                        </span>
                      ))}
                    </td>
                    <td className="shortcut-desc">{shortcut.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          
          {activeTab === "legend" && (
            <ul className="legend-list">
              {MAP_LEGEND.map((item, index) => (
                <li key={index} className="legend-item">
                  <span className="legend-icon" style={{ color: item.color }}>
                    {item.icon}
                  </span>
                  <span className="legend-label">{item.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        
        <footer className="help-panel-footer">
          <p>
            Polished Atlas — Map viewer for Polished Crystal ROM hack
          </p>
        </footer>
      </div>
    </div>
  );
}
