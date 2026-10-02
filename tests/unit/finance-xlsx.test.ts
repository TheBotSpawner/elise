import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  buildFinancePreview,
  financeMappingSchema,
  suggestFinanceMapping,
} from "@/core/finance/import";
import { parseSpreadsheet, spreadsheetKind } from "@/infrastructure/finance/spreadsheet";

/** A minimal but real .xlsx: shared strings inline, a date-formatted cell, float noise. */
function xlsx(rows: string) {
  const files = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Gastos" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    "xl/styles.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="0"/><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
    ),
  };
  return zipSync(files);
}

const s = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
const n = (ref: string, value: string, date = false) =>
  `<c r="${ref}"${date ? ' s="1"' : ""}><v>${value}</v></c>`;

describe("XLSX import", () => {
  it("reads dates, exact numbers and text; maps Spanish headers; totals per currency", async () => {
    const bytes = xlsx(
      `<row r="1">${s("A1", "Fecha")}${s("B1", "Tipo")}${s("C1", "Monto")}${s("D1", "Moneda")}${s("E1", "Proveedor")}</row>` +
        `<row r="2">${n("A2", "46264", true)}${s("B2", "Gasto")}${n("C2", "0.30000000000000004")}${s("D2", "USD")}${s("E2", "OpenAI")}</row>` +
        `<row r="3">${n("A3", "46265", true)}${s("B3", "Ingreso")}${s("C3", "1.500,00")}${s("D3", "ARS")}${s("E3", "Initech")}</row>`,
    );
    expect(spreadsheetKind("Gastos.xlsx")).toBe("xlsx");
    const [sheet] = await parseSpreadsheet(bytes, "xlsx");
    expect(sheet!.name).toBe("Gastos");
    expect(sheet!.rows[1]).toEqual(["2026-08-30", "Gasto", "0.30000000000000004", "USD", "OpenAI"]);
    const mapping = financeMappingSchema.parse({
      columns: suggestFinanceMapping(sheet!.rows[0]!),
      numberFormat: "comma_decimal",
    });
    const preview = buildFinancePreview(sheet!.rows, mapping, new Set());
    expect(preview).toMatchObject({ valid: 2, invalid: 0 });
    expect(preview.byCurrency).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ currency: "USD", expense: "0.3" }),
        expect.objectContaining({ currency: "ARS", income: "1500" }),
      ]),
    );
  });

  it("refuses a file that isn't a spreadsheet", async () => {
    await expect(
      parseSpreadsheet(new TextEncoder().encode("not a zip"), "xlsx"),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});
