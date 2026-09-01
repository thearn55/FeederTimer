import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Latch — Simple Breastfeeding Timer',
  description: 'A free, private breastfeeding timer for tracking left and right side feeds.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
