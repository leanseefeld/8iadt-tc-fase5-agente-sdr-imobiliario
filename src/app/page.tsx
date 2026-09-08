export default function Home() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "#0f172a",
        color: "#e2e8f0",
      }}
    >
      <main style={{ textAlign: "center", padding: "2rem", maxWidth: "34rem" }}>
        <h1 style={{ fontSize: "1.5rem", marginBottom: "0.75rem" }}>SDR Imobiliário</h1>
        <p style={{ color: "#94a3b8", lineHeight: 1.6 }}>
          Estrutura no ar. O atendimento conversacional e o painel do corretor chegam
          nas próximas entregas. O{" "}
          <a href="/catalogo" style={{ color: "#e2e8f0" }}>
            catálogo de imóveis
          </a>{" "}
          já está no ar.
        </p>
      </main>
    </div>
  );
}
