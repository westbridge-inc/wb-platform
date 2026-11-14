import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from '../../lib/zod';
import { parseCsvWithHeader } from '../../utils/csv';
import {
  applyMapping, toImportCsv, planColumns, unknownOverrideHeaders, missingForSync,
  TillStoreChoiceError, REQUIRED_FIELDS, MAPPABLE_FIELDS, type ColumnMapping,
} from '../../utils/catalogue-map';
import { scanXlsxZip, XlsxZipGuardError, XLSX_IMPORT_ZIP_BUDGET } from '../../utils/xlsx-zip-guard';
import { IMPORT_PHOTO_ADDRESS_NOTE } from '../../utils/photo-address';
import { AppError } from '../../utils/errors';
import { skuKey } from '../inventory/pos-sync';
import { recordOpeningBalance } from '../inventory/stock';
import { reconcileVatPricing, typedItemPrice } from '../store-vat/vat-pricing';
import { catalogueChecksFor } from '../compliance/prohibited-gate';
import { certainGoods, notAllowedMessage } from '../compliance/prohibited-items';

/**
 * [ASSISTED SETUP · owner 12 Nov 2026] A store's menu file, read and imported by ONE set of rules, whoever presses the
 * button: the store on its dashboard (vendor.routes POST /items/import, /items/import/automap, /items/import/xlsx) or a
 * Swift admin setting the store up from the console with its consent (admin assisted setup). Moved here from
 * vendor.routes.ts unchanged, so the admin's preview shows the very row errors the store would see, and an import from
 * the console can never add what the store itself could not (the listing gate stays the caller's: listingAllowed).
 */

export const MAX_IMPORT_ROWS = 5000;
// Excel-import guards (audit DS107 High #5): the zip-bomb budget lives in
// utils/xlsx-zip-guard; these bound the workbook shape once exceljs has parsed
// it. 1 MB compressed is generous for a catalogue workbook (text compresses
// ~10:1, and the confirm step already caps 5000 rows).
export const XLSX_MAX_COMPRESSED_BYTES = 1 * 1024 * 1024;
export const MAX_XLSX_COLUMNS = 100;
export const MAX_XLSX_CELL_TEXT = 2000;

export const importCsvSchema = z.object({
  csv: z.string().min(1).max(2_000_000),
});

/** [POS-SYNC] How the columns are read: 'sync' (a till re-upload, matched by
 *  SKU) or the default add-new import; a multi-store Loyverse export's store;
 *  and any column the store chose itself in the preview ('' = not used). */
export const columnChoiceSchema = z.object({
  mode: z.enum(['add', 'sync']).optional(),
  tillStore: z.string().trim().min(1).max(100).optional(),
  // (partialRecord: a store chooses only the columns it changes.)
  mapping: z.partialRecord(z.enum(MAPPABLE_FIELDS as unknown as [string, ...string[]]), z.string().max(200)).optional(),
});
export const automapBodySchema = importCsvSchema.merge(columnChoiceSchema);

/** One CSV row of the import template. Coercions keep messy files importable. */
export const csvRowSchema = z.object({
  category: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(150),
  description: z.string().max(2000).optional().default(''),
  // [POS-SYNC] A blank price used to coerce to 0 and import a free item. A
  // price is required; it is never invented.
  // [AUDIT A-4] Whole Guyana dollars, as every other price a store types.
  basePrice: z.string().trim().min(1, 'A price is required').pipe(z.coerce.number<string>().int('Prices are whole Guyana dollars').min(0).max(10_000_000)),
  sku: z.string().max(64).optional().default(''),
  unit: z.string().max(30).optional().default(''),
  stockQuantity: z
    .union([z.literal(''), z.coerce.number().int().min(0)])
    .optional()
    .default(''),
  isAvailable: z.enum(['true', 'false', '']).optional().default(''),
  fulfillment: z.enum(['DELIVERY', 'PICKUP', 'APPOINTMENT', '']).optional().default(''),
  imageUrl: z.string().max(2048).optional().default(''),
});

/** Shared automap core: raw header->value rows in, confirm-ready preview out.
 *  Never imports; only relabels columns, never invents prices (spec §4.5).
 *  [POS-SYNC] A recognised till export is read by its exact profile; the
 *  store's own column choices go on top; `mode: 'sync'` asks only for what a
 *  re-upload needs (a SKU, and a price or a count). `sourceCsv` (a workbook's
 *  own columns) rides along so the store can re-map an Excel file. */
export async function automapRows(
  rows: Record<string, string>[],
  choice: z.infer<typeof columnChoiceSchema>,
  sourceCsv?: string | null,
) {
  if (rows.length === 0) {
    throw new AppError(400, 'EMPTY_CSV', 'No data rows found');
  }
  const headers = Object.keys(rows[0]!);
  const extra = sourceCsv !== undefined ? { sourceCsv } : {};
  const unknown = unknownOverrideHeaders(headers, choice.mapping as ColumnMapping | undefined);
  if (unknown.length > 0) {
    throw new AppError(400, 'UNKNOWN_COLUMN', `This file has no column called "${unknown[0]}".`, { headers, ...extra });
  }

  // [NO-AI] The synonym table and the till-export profiles in
  // `utils/catalogue-map.ts` are the whole mapper. When a required column is
  // not recognised the honest answer is to say WHICH, and let the vendor pick
  // the column or use the template — the 422 below. Nothing is guessed.
  let plan: ReturnType<typeof planColumns>;
  try {
    plan = planColumns(headers, { tillStore: choice.tillStore, override: choice.mapping as ColumnMapping | undefined });
  } catch (err) {
    if (err instanceof TillStoreChoiceError) {
      throw new AppError(422, 'CHOOSE_TILL_STORE',
        err.asked
          ? `"${err.asked}" is not one of the till stores in this file. Choose one of: ${err.stores.join(', ')}.`
          : 'This file has columns for more than one till store. Choose which one is this Swift store.',
        { stores: err.stores, headers, ...extra });
    }
    throw err;
  }
  const mapping: ColumnMapping = plan.mapping;

  const missing = choice.mode === 'sync' ? missingForSync(mapping) : REQUIRED_FIELDS.filter((f) => !mapping[f]);
  if (missing.length > 0) {
    throw new AppError(422, 'UNMAPPED_COLUMNS',
      `Could not map required columns (${missing.join(', ')}). Rename them or use the template.`,
      { mapping, headers, profile: plan.profile, ...extra });
  }

  const normalized = applyMapping(rows, mapping);
  return {
    mapping,
    profile: plan.profile,
    headers,
    tillStores: plan.tillStores,
    tillStore: plan.tillStore,
    rowCount: normalized.length,
    preview: normalized.slice(0, 10),
    normalizedCsv: toImportCsv(normalized),
    ...extra,
  };
}

/** An Excel workbook's first worksheet as header->value rows (first row = headers), with every guard the store's
 *  POST /items/import/xlsx has always had: the ZIP central directory measured BEFORE exceljs inflates anything, then
 *  the row, column and cell caps. */
export async function readXlsxRows(buffer: Buffer): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  // Zip-bomb guard: refuse by the ZIP central directory's ADVERTISED sizes
  // BEFORE exceljs inflates anything. A tiny .xlsx can legally declare a
  // multi-GB sharedStrings.xml; exceljs would try to inflate it and OOM the
  // process before any header validation could refuse it.
  // [SEC-DOS F3] exceljs gets the guard's rebuilt archive of exactly the bytes it measured, never the upload.
  let measured: Buffer;
  try {
    measured = scanXlsxZip(buffer, XLSX_IMPORT_ZIP_BUDGET).archive;
  } catch (err) {
    if (err instanceof XlsxZipGuardError) {
      throw new AppError(400, 'BAD_XLSX', `That workbook is not importable: ${err.message}`);
    }
    throw err;
  }

  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(measured as unknown as ArrayBuffer);
  } catch {
    throw new AppError(400, 'BAD_XLSX', 'That file is not a readable Excel workbook (.xlsx)');
  }
  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount < 2) {
    throw new AppError(400, 'EMPTY_CSV', 'No data rows found in the first worksheet');
  }
  // Post-load shape caps: the central-directory guard bounds what exceljs
  // can inflate; these bound what the row loop below can build. Keep the
  // row cap in lock-step with the CSV confirm step's MAX_IMPORT_ROWS.
  if (sheet.rowCount - 1 > MAX_IMPORT_ROWS) {
    throw new AppError(400, 'TOO_MANY_ROWS', `Import is limited to ${MAX_IMPORT_ROWS} rows per file (got ${sheet.rowCount - 1})`);
  }
  if (sheet.columnCount > MAX_XLSX_COLUMNS) {
    throw new AppError(400, 'BAD_XLSX', `Import is limited to ${MAX_XLSX_COLUMNS} columns per file (got ${sheet.columnCount})`);
  }

  const cellText = (v: unknown, where: string): string => {
    let text: string;
    if (v === null || v === undefined) {
      text = '';
    } else if (typeof v === 'object') {
      const rich = v as { richText?: Array<{ text: string }>; text?: string; result?: unknown };
      if (rich.richText) text = rich.richText.map((t) => t.text).join('');
      else if (rich.text) text = rich.text;
      else if (rich.result !== undefined) text = String(rich.result);
      else text = '';
    } else {
      text = String(v);
    }
    if (text.length > MAX_XLSX_CELL_TEXT) {
      throw new AppError(400, 'BAD_XLSX', `Cell text at ${where} exceeds ${MAX_XLSX_CELL_TEXT} characters.`);
    }
    return text;
  };

  // [POS-SYNC] A code typed as a number in a zero-padded format ("00123",
  // a barcode) is stored as 123 and shown as 00123. Read such a cell as the
  // digits the store sees, or the SKU loses its leading zeros and never matches.
  const readCell = (cell: { value: unknown; numFmt?: string }): unknown => {
    const fmt = cell.numFmt ?? '';
    return typeof cell.value === 'number' && /^0+$/.test(fmt) && Number.isSafeInteger(cell.value) && cell.value >= 0
      ? String(cell.value).padStart(fmt.length, '0')
      : cell.value;
  };

  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, col) => { headers[col - 1] = cellText(cell.value, `header column ${col}`).trim(); });

  const rows: Record<string, string>[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const record: Record<string, string> = {};
    let hasValue = false;
    headers.forEach((h, i) => {
      if (!h) return;
      const value = cellText(readCell(row.getCell(i + 1)), `row ${rowNumber}, column ${i + 1}`).trim();
      record[h] = value;
      if (value) hasValue = true;
    });
    if (hasValue) rows.push(record);
  });
  return { headers, rows };
}

/** One row the import would add (the preview's table) or added. */
export interface MenuImportRow { row: number; name: string; category: string; basePrice: number }

export interface MenuImportOutcome {
  imported: number;
  waitingForCheck: Array<{ row: number; name: string }>;
  waitingForCheckCount: number;
  failedCount: number;
  failures: Array<{ row: number; errors: string[] }>;
  notes: Array<{ row: number; note: string }>;
  notesCount: number;
}

/**
 * POST /items/import's rows, judged and (unless `dryRun`) added: bad rows reported, good rows imported. A dry run writes
 * nothing and reports, row by row, exactly what the import would refuse (the same schema, banned-goods rule and SKU rule),
 * and what it would add (`rows`). `onCreated` runs inside each added item's own transaction (the assisted setup's record
 * of what Swift added for the store), so an item is never added without it.
 * The caller has already passed the listing gate and the banned-store check.
 */
export async function runMenuImport(
  prisma: PrismaClient,
  input: {
    vendorId: string;
    csv: string;
    actorId: string;
    dryRun?: boolean;
    onCreated?: (tx: Prisma.TransactionClient, item: { id: string; row: number; name: string }) => Promise<void>;
  },
): Promise<MenuImportOutcome & { rows: MenuImportRow[] }> {
  const { vendorId, csv, dryRun = false } = input;
  const rows = parseCsvWithHeader(csv);

  if (rows.length === 0) {
    throw new AppError(400, 'EMPTY_CSV', 'No data rows found — download the template to see the format');
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new AppError(400, 'TOO_MANY_ROWS', `Import is limited to ${MAX_IMPORT_ROWS} rows per file (got ${rows.length})`);
  }

  const failures: Array<{ row: number; errors: string[] }> = [];
  // [IMAGES-E2E PR4 · COORD ruling 19 Oct (a)] A row that names a photo address is imported
  // WITHOUT it (photos are uploaded), and the answer says so for that row.
  const notes: Array<{ row: number; note: string }> = [];
  const valid: Array<{ rowNumber: number; data: z.infer<typeof csvRowSchema> }> = [];

  rows.forEach((raw, index) => {
    const parsed = csvRowSchema.safeParse(raw);
    if (parsed.success) {
      valid.push({ rowNumber: index + 2, data: parsed.data }); // +2: 1-based + header
    } else {
      failures.push({
        row: index + 2,
        errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      });
    }
  });

  // Categories resolve by name (case-insensitive), created on demand
  // [owner 11 Oct] An archived category never takes new rows: a row naming
  // it files into a new live category of the same name.
  const categories = await prisma.category.findMany({ where: { vendorId, archivedAt: null } });
  const categoryIds = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));

  // [POS-SYNC] This route only ADDS. A row whose SKU the store already has
  // (trimmed, any case) used to become a second copy of that item on every
  // re-upload; it is refused now and pointed at the update flow. Rows
  // without a SKU cannot be checked and import as before.
  const knownSkus = new Set(
    (await prisma.item.findMany({ where: { vendorId, sku: { not: null }, archivedAt: null }, select: { sku: true } }))
      .map((i) => skuKey(i.sku)).filter(Boolean),
  );

  let imported = 0;
  const added: MenuImportRow[] = [];
  const importedIds: Array<{ id: string; row: number; name: string }> = [];
  for (const { rowNumber, data } of valid) {
    // [GUARDRAILS §8 · #55] A row whose name IS banned goods is refused and listed; the rest import.
    const bannedGoods = certainGoods(data.name);
    if (bannedGoods) {
      failures.push({ row: rowNumber, errors: [notAllowedMessage(bannedGoods.prohibitedClass)] });
      continue;
    }
    const sku = skuKey(data.sku);
    if (sku && knownSkus.has(sku)) {
      failures.push({ row: rowNumber, errors: ['This SKU is already in your store, so it was not added again. To update items from a file, use "Import or update your items" on the web dashboard.'] });
      continue;
    }
    if (dryRun) {
      if (sku) knownSkus.add(sku);
      imported += 1;
      added.push({ row: rowNumber, name: data.name, category: data.category, basePrice: data.basePrice });
      if (data.imageUrl.trim() !== '') notes.push({ row: rowNumber, note: IMPORT_PHOTO_ADDRESS_NOTE });
      continue;
    }
    const key = data.category.toLowerCase();
    let categoryId = categoryIds.get(key);
    if (!categoryId) {
      const created = await prisma.category.create({
        data: { vendorId, name: data.category, sortOrder: categoryIds.size },
      });
      categoryId = created.id;
      categoryIds.set(key, categoryId);
    }

    try {
      // [MKT-2 · POS-SYNC F2] The count an item is born with is written by
      // the ledger's opening balance, in the same transaction as the item —
      // never assigned here — so the ledger explains it from day one.
      const createdId = await prisma.$transaction(async (tx) => {
        const created = await tx.item.create({
          data: {
            vendorId,
            categoryId,
            name: data.name,
            description: data.description || undefined,
            // [VAT-DOCS] A file's price is the price the store typed (before VAT for a store that adds it).
            ...typedItemPrice(data.basePrice),
            sku: data.sku || undefined,
            unit: data.unit || undefined,
            isAvailable: data.isAvailable === '' ? true : data.isAvailable === 'true',
            fulfillment: data.fulfillment === '' ? 'DELIVERY' : data.fulfillment,
            dietaryTags: [],
            allergens: [],
          },
          select: { id: true },
        });
        await recordOpeningBalance(tx, created.id, data.stockQuantity === '' ? null : data.stockQuantity, input.actorId);
        await reconcileVatPricing(tx, vendorId, { itemIds: [created.id] });
        if (input.onCreated) await input.onCreated(tx, { id: created.id, row: rowNumber, name: data.name });
        return created.id;
      });
      importedIds.push({ id: createdId, row: rowNumber, name: data.name });
      added.push({ row: rowNumber, name: data.name, category: data.category, basePrice: data.basePrice });
      if (sku) knownSkus.add(sku);
      imported += 1;
      if (data.imageUrl.trim() !== '') notes.push({ row: rowNumber, note: IMPORT_PHOTO_ADDRESS_NOTE });
    } catch {
      failures.push({ row: rowNumber, errors: ['Database rejected this row'] });
    }
  }

  // [GUARDRAILS §8] Imported rows a banned word is holding for a quick check, by row.
  const importChecks = await catalogueChecksFor(prisma, importedIds.map((i) => i.id));
  const waitingForCheck = importedIds
    .filter((i) => importChecks.get(i.id)?.state === 'WAITING')
    .map((i) => ({ row: i.row, name: i.name }));

  return {
    imported,
    waitingForCheck: waitingForCheck.slice(0, 100),
    waitingForCheckCount: waitingForCheck.length,
    failedCount: failures.length,
    // Cap the detail list so a fully-broken huge file stays readable
    failures: failures.slice(0, 100),
    notes: notes.slice(0, 100),
    notesCount: notes.length,
    rows: added.slice(0, 100),
  };
}
