/**
 * [COMPANY-DOCS PART 2] The signed letter as ONE A4 page: the exact words the signer read, their finger signature, their
 * name, and the signing record (how and when it was signed, the code check, the number the code went to, the network
 * address as a keyed digest, the browser, and the SHA-256 of the words). pdfkit, as every other PDF Swift writes.
 * A person at Swift reads this page when they check the letter.
 */
import PDFDocument from 'pdfkit';
import { formatGuyanaTime } from '../../../utils/guyana-day';

export interface SignedLetterFacts {
  title: string;
  lines: string[];
  /** The signature, a cleaned PNG (letter-signature.ts). */
  signaturePng: Buffer;
  signerName: string;
  signerKind: 'director' | 'owner';
  signerPhone: string;
  /** Who asked for the letter (and typed the signer's number). */
  requesterName: string;
  codeVerifiedAt: Date;
  signedAt: Date;
  letterSha256: string;
  requestId: string;
  /** HMAC of the network address (consent-ledger pepper); null when the pepper is not set. */
  ipDigest: string | null;
  userAgent: string | null;
}

const when = (at: Date) => `${formatGuyanaTime(at, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })} Guyana time (${at.toISOString()})`;

/**
 * [review F2] What the signature does NOT prove, in bold for the reviewer: the number was typed by the person who asked;
 * Swift never checked that it is the director's (or the owner's) or the company's. A person confirms the signer.
 */
export function unverifiedNumberLine(f: Pick<SignedLetterFacts, 'signerPhone' | 'requesterName' | 'signerKind'>): string {
  const role = f.signerKind === 'director' ? 'a director of the company' : 'the business’s owner';
  const who = f.signerKind === 'director' ? 'the company' : 'the business';
  return `NOT CHECKED BY SWIFT: the number ${f.signerPhone} and the name were typed by ${f.requesterName}, the person who asked for this letter. `
    + 'Swift checked only that someone holding that number confirmed a code and signed. This signature alone does not prove '
    + `who signed, nor that the signer is ${role}: a person at Swift confirms the authority separately, by calling ${who} on a number Swift found itself.`;
}

/** The record printed under the signature, one fact a line. */
export function signingRecordLines(f: SignedLetterFacts): string[] {
  return [
    `Signed electronically on Swift by whoever held the phone number ${f.signerPhone}, as “${f.signerName}” (the name ${f.requesterName} typed), on ${when(f.signedAt)}.`,
    `A code Swift texted to ${f.signerPhone} was confirmed on ${when(f.codeVerifiedAt)}.`,
    `Network address (keyed digest): ${f.ipDigest ?? 'not recorded'}. Browser: ${(f.userAgent ?? 'not recorded').slice(0, 200)}.`,
    `SHA-256 of the letter's words: ${f.letterSha256}. Swift request: ${f.requestId}.`,
    'A person at Swift confirms the authority separately before the store can go live.',
  ];
}

export function renderSignedLetterPdf(f: SignedLetterFacts): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: f.title, Author: 'Swift' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.font('Helvetica-Bold').fontSize(13).text(f.title);
    doc.moveDown(0.8);
    doc.font('Helvetica').fontSize(10.5);
    for (const line of f.lines) doc.text(line, { lineGap: 2 }).moveDown(0.5);
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(10).text(`Signature (signed as “${f.signerName}”):`);
    const top = doc.y + 4;
    doc.image(f.signaturePng, doc.page.margins.left, top, { fit: [240, 90] });
    doc.y = top + 96;
    doc.font('Helvetica').fontSize(10.5).text(`Name as typed by ${f.requesterName}: ${f.signerName}`);
    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#9a1b1b').text(unverifiedNumberLine(f), { lineGap: 1 });
    doc.fillColor('#000000').moveDown(0.6);
    doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).lineWidth(0.5).stroke('#888888');
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#333333').text('Signing record');
    doc.font('Helvetica').fontSize(8);
    for (const line of signingRecordLines(f)) doc.text(line, { lineGap: 1 });
    doc.end();
  });
}
