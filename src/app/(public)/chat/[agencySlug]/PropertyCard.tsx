import type { WireProperty } from "@/app/api/chat/wire";
import styles from "./chat.module.css";

const currency = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 0,
});

/**
 * One property inline under an agent bubble (FR-021, `contracts/chat-api.md`
 * §5). The payload is already the projection the wire trusts — no formatting
 * happens upstream, so this is the one place `680000` becomes `R$ 680.000`
 * and a rent listing gets its `/mês`. No state of its own: the one action,
 * "Interessado" (spec 006 FR-004c), is the widget's send path handed down, and
 * a card rendered without it (a closed conversation) simply has no button.
 */
export default function PropertyCard({
  property,
  onInterested,
}: {
  property: WireProperty;
  onInterested?: (code: string) => void;
}) {
  const priceLabel =
    property.transaction === "rent" ? `${currency.format(property.price)}/mês` : currency.format(property.price);

  return (
    <article className={styles.propertyCard}>
      <div className={styles.propertyImageWrap}>
        {/* Server component: no onError handler to swap the src. The wrap's
            background plus `color: transparent` on the <img> is what stands in
            for a broken seed URL — a quiet colour block, not the browser's
            broken-image glyph and alt text. */}
        <img
          className={styles.propertyImage}
          src={property.imageUrl}
          alt={`Foto do imóvel ${property.code}`}
          loading="lazy"
        />
      </div>
      <div className={styles.propertyBody}>
        <p className={styles.propertyTitle}>{property.title}</p>
        <p className={styles.propertyPrice}>{priceLabel}</p>
        <p className={styles.propertyMeta}>
          {property.bedrooms} {property.bedrooms === 1 ? "quarto" : "quartos"} · {property.areaM2} m²
        </p>
        <p className={styles.propertyLocation}>
          {property.neighborhood}, {property.city}
        </p>
        <p className={styles.propertyCode}>Cód. {property.code}</p>
      </div>
      {onInterested === undefined ? null : (
        <button
          type="button"
          className={styles.interested}
          onClick={() => onInterested(property.code)}
          aria-label={`Tenho interesse no imóvel ${property.code}`}
        >
          Interessado
        </button>
      )}
    </article>
  );
}
