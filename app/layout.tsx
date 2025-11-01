import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Film RAG Assistant",
  description: "Retrieval-augmented assistant for film knowledge.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="hu">
      <body className="bg-slate-50 text-slate-900">{children}</body>
    </html>
  );
}
