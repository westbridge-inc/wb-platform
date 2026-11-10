import type { Metadata } from 'next';
import { SignLetterClient } from './sign-letter-client';

// [COMPANY-DOCS PART 2 · owner 10 Nov 2026 ~07:5xZ] The letter of authority a company's director (or a business's
// owner) signs on their own phone: Swift texts /sign-letter#<secret>. The secret sits after the '#', so it never
// reaches a server or a log; this page sends it to the API only in a request body, and only for that one letter.

export const metadata: Metadata = {
  title: 'Sign a letter of authority',
  robots: { index: false, follow: false }, // a bearer link: never indexed
};

export default function SignLetterPage() {
  return <SignLetterClient />;
}
