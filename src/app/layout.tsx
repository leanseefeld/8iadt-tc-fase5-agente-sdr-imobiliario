import type { ReactNode } from "react";

export const metadata = {
  title: "SDR Imobiliário",
  description: "Agente de pré-atendimento para o mercado imobiliário",
};

/**
 * A neutral shell — no centering, no fixed background. Each route owns its
 * own layout (the home placeholder centers itself in `page.tsx`; `/catalogo`
 * is a normal full-width page).
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, minHeight: "100vh" }}>{children}</body>
    </html>
  );
}
