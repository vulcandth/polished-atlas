import type { Application } from "pixi.js";

export interface ScreenshotOptions {
  /** Format of the screenshot */
  format?: "png" | "jpeg" | "webp";
  /** Quality for jpeg/webp (0-1) */
  quality?: number;
  /** Filename for download (without extension) */
  filename?: string;
}

/**
 * Take a screenshot of the current canvas state
 */
export async function takeScreenshot(
  app: Application,
  options: ScreenshotOptions = {},
): Promise<void> {
  const { format = "png", quality = 0.92, filename = "polished-atlas-screenshot" } = options;

  try {
    const renderer = app.renderer;
    
    // Extract canvas as image
    const canvas = renderer.extract.canvas(app.stage) as HTMLCanvasElement;
    
    // Convert to blob
    const mimeType = `image/${format}`;
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => {
          if (b) resolve(b);
          else reject(new Error("Failed to create screenshot blob"));
        },
        mimeType,
        quality,
      );
    });

    // Create download link
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${filename}.${format}`;
    
    // Trigger download
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    // Cleanup
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error("Screenshot failed:", error);
    throw error;
  }
}

/**
 * Copy screenshot to clipboard
 */
export async function copyScreenshotToClipboard(app: Application): Promise<void> {
  try {
    const renderer = app.renderer;
    const canvas = renderer.extract.canvas(app.stage) as HTMLCanvasElement;

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => {
          if (b) resolve(b);
          else reject(new Error("Failed to create screenshot blob"));
        },
        "image/png",
      );
    });

    await navigator.clipboard.write([
      new ClipboardItem({
        "image/png": blob,
      }),
    ]);
  } catch (error) {
    console.error("Copy to clipboard failed:", error);
    throw error;
  }
}
