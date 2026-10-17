import type { FinanceMapping } from "./import";

/**
 * Well-known export formats (ADR-075), layered over the generic inference: a format only makes
 * a mapping more certain (which amount is the movement, that the sign gives the direction, which
 * account the whole file is), and a file that matches none is inferred as before. A format never
 * turns a provider's own taxonomy (payment method, settlement event) into ELISE's income/expense.
 */
export interface ProviderFormat {
  id: string;
  /** Shown as "Reconocí un reporte de Mercado Pago". */
  label: string;
  columns: FinanceMapping["columns"];
  /** The direction comes from the amount's sign. */
  defaultType: "sign";
  /** Every row of the file belongs to this account (resolved like any account name). */
  account: string | null;
}

const header = (h: string) => h.trim().toUpperCase();

/**
 * Mercado Pago's settlement / account-money report: one row per money event of the wallet.
 * TRANSACTION_AMOUNT is the signed movement (fees and taxes are separate columns of the same
 * row and stay as provenance, never added again); PAYMENT_METHOD_TYPE is how it was paid, not
 * whether it is income; SOURCE_ID is kept as the reference (it may repeat across events).
 */
function mercadoPagoSettlement(headers: string[]): ProviderFormat | null {
  const at = new Map(headers.map((h, i) => [header(h), i]));
  const need = ["SOURCE_ID", "TRANSACTION_TYPE", "TRANSACTION_AMOUNT", "TRANSACTION_DATE"];
  if (!need.every((h) => at.has(h))) return null;
  if (!["SETTLEMENT_DATE", "REAL_AMOUNT", "MONEY_RELEASE_DATE"].some((h) => at.has(h))) return null;
  return {
    id: "mercadopago_settlement",
    label: "Mercado Pago",
    columns: {
      date: at.get("TRANSACTION_DATE")!,
      amount: at.get("TRANSACTION_AMOUNT")!,
      description: at.get("TRANSACTION_TYPE")!,
      reference: at.get("SOURCE_ID")!,
      ...(at.has("PAYMENT_METHOD_TYPE") ? { paymentMethod: at.get("PAYMENT_METHOD_TYPE")! } : {}),
    },
    defaultType: "sign",
    account: "Mercado Pago",
  };
}

const FORMATS = [mercadoPagoSettlement];

export function detectProviderFormat(headers: string[]): ProviderFormat | null {
  for (const detect of FORMATS) {
    const format = detect(headers);
    if (format) return format;
  }
  return null;
}
