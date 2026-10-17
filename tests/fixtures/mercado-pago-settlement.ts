/**
 * A sanitized Mercado Pago settlement report (ADR-075): the real export's structure — `;`
 * delimiter, these 12 columns, ISO timestamps with -03:00, signed amounts, fee/tax/net columns,
 * blank metadata — with made-up ids and amounts. 230 data rows, like the file that failed.
 */
const HEADER = [
  "SOURCE_ID",
  "PAYMENT_METHOD_TYPE",
  "TRANSACTION_TYPE",
  "TRANSACTION_AMOUNT",
  "TRANSACTION_DATE",
  "FEE_AMOUNT",
  "SETTLEMENT_DATE",
  "REAL_AMOUNT",
  "TAXES_AMOUNT",
  "BUSINESS_UNIT",
  "SUB_UNIT",
  "MONEY_RELEASE_DATE",
];

/** The representative rows the regression needs, then ordinary settlements up to 230. */
export function mercadoPagoSettlementCsv(rows = 230): string {
  const at = (day: number, h: number) =>
    `2026-${day > 30 ? "10" : "09"}-${String(day > 30 ? day - 30 : day).padStart(2, "0")}T${String(h).padStart(2, "0")}:23:51.000-03:00`;
  const line = (
    id: number,
    method: string,
    type: string,
    amount: string,
    day: number,
    fee = "0.00",
    real = amount,
    taxes = "0.00",
  ) =>
    [
      String(90_000_000_000 + id),
      method,
      type,
      amount,
      at(day, (id % 20) + 1),
      fee,
      at(day, (id % 20) + 2),
      real,
      taxes,
      id % 3 ? "" : "mp",
      "",
      at(day, (id % 20) + 3),
    ].join(";");
  const special = [
    line(1, "available_money", "SETTLEMENT", "100000.00", 14),
    line(2, "bank_transfer", "SETTLEMENT", "-17200.00", 15),
    line(3, "", "CREDIT", "2500.50", 16),
    line(4, "bank_transfer", "PAYOUTS", "-50000.00", 17),
    // A fee-bearing sale: the movement is the gross amount; fee and tax stay as provenance.
    line(5, "available_money", "SETTLEMENT", "1000.00", 18, "-0.28", "999.72", "-0.05"),
    line(6, "", "SETTLEMENT", "-320.75", 19),
  ];
  const ordinary = Array.from({ length: rows - special.length }, (_, i) => {
    const id = i + 7;
    const negative = i % 3 === 0;
    const amount = `${negative ? "-" : ""}${(1000 + ((i * 137) % 9000)).toFixed(2)}`;
    return line(id, i % 2 ? "available_money" : "", "SETTLEMENT", amount, 14 + (i % 32));
  });
  return [HEADER.join(";"), ...special, ...ordinary].join("\r\n") + "\r\n";
}
