"use client";

/** Last-resort boundary when the root layout itself fails (no providers available here). */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="es">
      <body
        style={{ fontFamily: "system-ui, sans-serif", background: "#04070c", color: "#e6edf6" }}
      >
        <main
          style={{
            minHeight: "100dvh",
            display: "grid",
            placeItems: "center",
            textAlign: "center",
            padding: 24,
          }}
        >
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600 }}>ELISE</h1>
            <p style={{ opacity: 0.7, marginTop: 8 }}>Algo salió mal · Something went wrong</p>
            {error.digest && (
              <p style={{ fontFamily: "monospace", fontSize: 12, opacity: 0.6 }}>
                Ref: {error.digest}
              </p>
            )}
            <button
              onClick={reset}
              style={{
                marginTop: 16,
                padding: "8px 16px",
                borderRadius: 12,
                background: "#22d3ee",
                color: "#03131a",
                border: 0,
              }}
            >
              Reintentar · Retry
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
