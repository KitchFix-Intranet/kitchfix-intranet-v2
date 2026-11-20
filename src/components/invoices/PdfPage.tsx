"use client";

// Lazy pdfjs-dist renderer. Only loaded when a sitting mounts; the
// worker is served same-origin via `new URL(..., import.meta.url)`.
//
// Train 2 ruling (§7): no new dependency besides pdfjs-dist, worker
// NOT from a CDN. Images are drawn without pdfjs.

import { useEffect, useRef, useState } from "react";

type PdfjsModule = typeof import("pdfjs-dist");

async function loadPdfjs(): Promise<PdfjsModule> {
  const pdfjs = await import("pdfjs-dist");
  // Worker from the package itself (same origin after bundling).
  // new URL resolves through the bundler.
  const workerUrl = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  return pdfjs;
}

export function PdfPage({
  url,
  rotation,
}: {
  url: string;
  rotation: 0 | 90 | 180 | 270;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const pdfjs = await loadPdfjs();
        const task = pdfjs.getDocument({ url });
        const doc = await task.promise;
        if (cancelled) return;
        const page = await doc.getPage(1);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: 1.2, rotation });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no canvas context");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : "Could not show the page");
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [url, rotation]);

  if (err) {
    return (
      <div className="kf-inv-sitting__no-file">
        <p>Could not show the page. Open it in a new tab to see it.</p>
      </div>
    );
  }

  return (
    <>
      {loading ? <p className="kf-inv-sitting__hint">Loading the page...</p> : null}
      <canvas ref={canvasRef} role="img" aria-label="Invoice page" />
    </>
  );
}
