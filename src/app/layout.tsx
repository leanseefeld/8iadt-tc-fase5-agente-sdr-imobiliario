import type { ReactNode } from "react";

export const metadata = {
  title: "SDR Imobiliário",
  description: "Agente de pré-atendimento para o mercado imobiliário",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#0f172a",
          color: "#e2e8f0",
        }}
      >
        {children}
      </body>
    </html>
  );
}
