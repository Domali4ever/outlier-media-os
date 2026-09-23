import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Outlier Media OS",
  description: "Operating console for evidence-based affiliate content.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
