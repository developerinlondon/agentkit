import { exportToSvg } from "@excalidraw/excalidraw";

declare global {
  interface Window {
    renderExcalidrawToSvg: (scene: {
      elements: unknown[];
      appState?: Record<string, unknown>;
      files?: Record<string, unknown> | null;
    }) => Promise<string>;
  }
}

window.renderExcalidrawToSvg = async (scene) => {
  const svg = await exportToSvg({
    elements: scene.elements as never,
    appState: { exportBackground: false, exportEmbedScene: false, ...scene.appState } as never,
    files: (scene.files ?? null) as never,
  });
  return svg.outerHTML;
};
