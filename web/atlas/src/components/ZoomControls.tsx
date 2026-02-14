import { useCallback } from "react";

interface ZoomControlsProps {
  scale: number;
  minScale: number;
  maxScale: number;
  onZoom: (newScale: number) => void;
  onResetView?: () => void;
  disabled?: boolean;
}

/**
 * Zoom controls overlay with +/- buttons and level indicator
 */
export default function ZoomControls({
  scale,
  minScale,
  maxScale,
  onZoom,
  onResetView,
  disabled = false,
}: ZoomControlsProps) {
  const zoomIn = useCallback(() => {
    const newScale = Math.min(scale * 1.5, maxScale);
    onZoom(newScale);
  }, [scale, maxScale, onZoom]);

  const zoomOut = useCallback(() => {
    const newScale = Math.max(scale / 1.5, minScale);
    onZoom(newScale);
  }, [scale, minScale, onZoom]);

  const resetZoom = useCallback(() => {
    onZoom(1);
  }, [onZoom]);

  // Display zoom as percentage
  const zoomPercent = Math.round(scale * 100);

  const canZoomIn = scale < maxScale;
  const canZoomOut = scale > minScale;

  return (
    <div className="zoom-controls" aria-label="Zoom controls">
      <button
        className="zoom-btn zoom-in"
        onClick={zoomIn}
        disabled={disabled || !canZoomIn}
        aria-label="Zoom in"
        title="Zoom in"
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
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="16" />
          <line x1="8" y1="12" x2="16" y2="12" />
        </svg>
      </button>

      <button
        className="zoom-level"
        onClick={resetZoom}
        disabled={disabled}
        aria-label={`Current zoom: ${zoomPercent}%. Click to reset to 100%`}
        title="Reset zoom"
      >
        {zoomPercent}%
      </button>

      <button
        className="zoom-btn zoom-out"
        onClick={zoomOut}
        disabled={disabled || !canZoomOut}
        aria-label="Zoom out"
        title="Zoom out"
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
          <circle cx="12" cy="12" r="10" />
          <line x1="8" y1="12" x2="16" y2="12" />
        </svg>
      </button>

      {onResetView && (
        <button
          className="zoom-btn zoom-reset"
          onClick={onResetView}
          disabled={disabled}
          aria-label="Fit entire map"
          title="Fit entire map"
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
            <path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" />
          </svg>
        </button>
      )}
    </div>
  );
}
