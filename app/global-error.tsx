"use client";

// Next's default client-exception screen ("see the browser console") says
// nothing actionable. This one shows the ACTUAL error, so a screenshot of it
// is a diagnosis — and it offers the fix for the most common cause on this
// app: a tab holding a stale bundle across a redeploy (we ship many times a
// day), whose next lazy chunk load 404s. Inline styles only: global-error
// replaces the root layout, so the app's stylesheet may not be loaded.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const stale = /chunk|loading css|dynamically imported module|import\(\)/i.test(
    error?.message ?? "",
  );
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0a0f16",
          color: "#e6ebf2",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        }}
      >
        <div style={{ maxWidth: 640, padding: 24 }}>
          <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>S2 Signal hit a client-side error</h1>
          <p style={{ fontSize: 14, color: "#9aa7b8", margin: "0 0 16px", lineHeight: 1.5 }}>
            {stale
              ? "This looks like a stale tab from before the latest deploy — the reload button below should fix it."
              : "Reload usually fixes it. If it comes back, screenshot this box — the message below is the actual error."}
          </p>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: "#111a26",
              border: "1px solid #263447",
              borderRadius: 8,
              padding: 14,
              fontSize: 12,
              lineHeight: 1.5,
              color: "#ffb4b4",
              margin: "0 0 16px",
            }}
          >
            {error?.message || "(no message)"}
            {error?.digest ? `\ndigest: ${error.digest}` : ""}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: "#19c37d",
              color: "#08110c",
              border: 0,
              borderRadius: 8,
              padding: "10px 18px",
              fontSize: 14,
              fontWeight: 700,
              cursor: "pointer",
              marginRight: 10,
            }}
          >
            Reload the app
          </button>
          <button
            onClick={() => reset()}
            style={{
              background: "transparent",
              color: "#9aa7b8",
              border: "1px solid #263447",
              borderRadius: 8,
              padding: "10px 18px",
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Try again without reloading
          </button>
        </div>
      </body>
    </html>
  );
}
