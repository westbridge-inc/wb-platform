/**
 * [COMPANY-DOCS PART 2] The finger (or mouse) signature the signing page sends: a PNG from a canvas, as a data URL or
 * base64. It is a file a stranger sent, so it is checked like one before it goes anywhere: a PNG by its own bytes,
 * bounded in size and pixels, decoded by the real decoder, never blank, and re-encoded (nothing the sender wrote rides
 * along: no metadata, no extra chunks). The stored letter is then scanned like every uploaded document (the route).
 */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { AppError } from '../../../utils/errors';

export const MAX_SIGNATURE_BYTES = 400_000;
const MAX_SIDE = 2400;
const MIN_SIDE = 40;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const refused = (message: string) => new AppError(400, 'SIGNATURE_NOT_VALID', message);

/** The PNG bytes of `data:image/png;base64,...` or bare base64; null when it is neither. */
export function signatureBytes(value: string): Buffer | null {
  const m = /^(?:data:image\/png;base64,)?([A-Za-z0-9+/]+={0,2})$/.exec(value.trim());
  if (!m) return null;
  const bytes = Buffer.from(m[1]!, 'base64');
  return bytes.length > 0 ? bytes : null;
}

/** The cleaned signature (a fresh PNG on white) and the SHA-256 of what was sent. */
export async function cleanSignature(value: string): Promise<{ png: Buffer; sha256: string }> {
  const sent = signatureBytes(value);
  if (!sent || sent.length > MAX_SIGNATURE_BYTES || !sent.subarray(0, 8).equals(PNG_MAGIC)) {
    throw refused('Draw your signature in the box, then send it again.');
  }
  let png: Buffer;
  try {
    const image = sharp(sent, { limitInputPixels: MAX_SIDE * MAX_SIDE, failOn: 'error' }).timeout({ seconds: 10 });
    const meta = await image.metadata();
    if (meta.format !== 'png' || !meta.width || !meta.height || meta.width < MIN_SIDE || meta.height < MIN_SIDE
      || meta.width > MAX_SIDE || meta.height > MAX_SIDE) throw new Error('shape');
    const flat = sharp(sent, { limitInputPixels: MAX_SIDE * MAX_SIDE, failOn: 'error' }).flatten({ background: '#ffffff' });
    const stats = await flat.clone().stats();
    // A blank pad is one colour everywhere: nothing was drawn.
    if (stats.channels.every((c) => c.min === c.max)) throw refused('The signature box is empty. Draw your signature with your finger.');
    png = await flat.resize({ width: 1200, height: 600, fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw refused('Draw your signature in the box, then send it again.');
  }
  return { png, sha256: createHash('sha256').update(sent).digest('hex') };
}
