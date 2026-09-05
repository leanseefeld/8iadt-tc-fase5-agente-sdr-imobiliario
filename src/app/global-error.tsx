"use client";

/**
 * Next prerenders a global error boundary at build time. Providing our own
 * keeps that page under our control — and in pt-BR, like every other string
 * a user can see.
 */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="pt-BR">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
        <h1>Algo deu errado</h1>
        <p>Não foi possível carregar esta página.</p>
        <button type="button" onClick={() => reset()}>
          Tentar novamente
        </button>
      </body>
    </html>
  );
}
