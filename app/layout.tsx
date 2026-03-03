import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Grad Planner Agent",
  description: "An AI assistant that helps university students plan their graduation requirements.",
  icons: {
    icon: [{ url: "/favicon-96x96.png", sizes: "96x96", type: "image/png" }],
    shortcut: "/favicon-96x96.png",
    apple: "/favicon-96x96.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
