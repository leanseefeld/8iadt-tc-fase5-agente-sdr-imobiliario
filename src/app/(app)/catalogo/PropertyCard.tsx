import type { Property } from "@/services/properties";
import styles from "./catalogo.module.css";

const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });

const TRANSACTION_LABEL: Record<Property["transaction"], string> = {
  sale: "Venda",
  rent: "Aluguel",
};

/**
 * One property. `code` is the most prominent thing on the card, alongside
 * price — the broker's task here is confirming a suggested property is
 * real, not browsing casually (constitution X).
 */
export function PropertyCard({ property }: { property: Property }) {
  const priceLabel =
    property.transaction === "rent" ? `${currency.format(property.price)}/mês` : currency.format(property.price);

  return (
    <article className={styles.card}>
      <div className={styles.imageWrap}>
        {/* Plain <img>: external placeholder host, no next/image domain config needed for a demo. */}
        <img
          className={styles.image}
          src={property.imageUrl}
          alt={`Foto do imóvel ${property.code}`}
          loading="lazy"
        />
        <span className={styles.codeBadge}>{property.code}</span>
        <span className={styles.transactionBadge}>{TRANSACTION_LABEL[property.transaction]}</span>
        {!property.isActive && <span className={styles.inactiveBadge}>Inativo</span>}
      </div>
      <div className={styles.cardBody}>
        <p className={styles.price}>{priceLabel}</p>
        <p className={styles.cardTitle}>{property.title}</p>
        <p className={styles.meta}>
          <span className={styles.neighborhood}>{property.neighborhood}</span>
          <span>{property.bedrooms} quarto{property.bedrooms === 1 ? "" : "s"}</span>
          <span>{property.areaM2} m²</span>
        </p>
      </div>
    </article>
  );
}
