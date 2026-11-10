'use client';

/** Prints the letter (or saves it as a PDF from the print window). */
export function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className="mt-3 rounded-full bg-black px-4 py-2 text-sm font-semibold text-white">
      Print or save as PDF
    </button>
  );
}
