# Dados de referência — Florianópolis

> **Status (08/10/2026): não implementado.** A spec 011 e a segunda agência "Imóveis da Ilha" foram cortadas da entrega; estes dados não estão na seed nem no código. Ficam como insumo para quem retomar a 011.

> **Não normativo.** Insumo para a spec 011 (segunda agência, "Imóveis da Ilha"),
> levantado por pesquisa em 27/09/2026. Valores **indicativos**, de portais e
> imobiliárias locais — o FipeZap publica só o índice da cidade, não por bairro.

**Âncora da cidade:** FipeZap Florianópolis, venda, **R$ 12.773/m²** (dez/2025),
vindo de R$ 11.845 em jan/2025.

| Bairro | Perto da praia | Venda (R$/m²) | Aluguel (R$/m²) | Fonte |
|---|---|---|---|---|
| Centro | não | acima da média | 58,30 | Regente Imóveis |
| Trindade | não (UFSC) | acima da média | 59,00 (o mais caro) | FipeZap; Regente |
| Itacorubi | não | — | 52,60 | Regente |
| Córrego Grande | não | — | 51,60 | Regente |
| Estreito | não (continente) | — | 45,10 | Regente |
| Coqueiros | não (continente, baía) | ~11.483 | 40,50 | ND+/imovelguide; Regente |
| Lagoa da Conceição | sim | > 20.000 (lançamentos — viés alto) | — | Invexo |
| Campeche | sim | > 20.000 (mesma ressalva) | — | Invexo |
| Jurerê / Jurerê Internacional | sim | ~12.474 (casas ~16.313) | — | Agente Imóvel/ND+ |
| Ingleses | sim | ~4.900 | 44,50 | ND+; Regente |
| Canasvieiras | sim | ~7.618 | — | ND+ |
| Santo Antônio de Lisboa | sim | ~9.469 | — | ND+ |

## O que o esquema atual não comporta

`properties` tem `neighborhood`, `city`, `region` (texto livre) e `features`
(`string[]`); não há coluna de proximidade da praia nem geolocalização.

- **Perto da praia** é conhecimento sobre o **bairro**, não sobre o imóvel — e é
  exatamente o exemplo que o desenvolvedor deu para a **base de conhecimento da
  plataforma** (spec 011). Lá ele fica uma vez, válido para qualquer agência.
- **`region`** em São Paulo guarda zonas ("zona sul"). Para Florianópolis os
  valores precisam ser decididos com consistência — algo como *norte da ilha*,
  *sul da ilha*, *leste da ilha*, *centro*, *continente*. **Decisão da spec 011.**
