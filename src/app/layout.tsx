import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "SDR Imobiliário",
  description: "Agente de pré-atendimento para o mercado imobiliário",
};

/**
 * A neutral shell — no centering, no fixed background. Each route owns its
 * own layout (the home placeholder centers itself in `page.tsx`; `/catalogo`
 * is a normal full-width page). Base font/background/colour now live in
 * `globals.css`, shared with `/login` and the `(app)` shell.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body style={{ minHeight: "100vh" }}>{children}</body>
    </html>
  );
}
