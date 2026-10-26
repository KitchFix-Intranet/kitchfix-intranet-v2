import type { Metadata } from "next";
import "./globals.css";
import "./components.css";
import { Toaster } from "@/components/ui/Toaster";

export const metadata: Metadata = {
  title: "KitchFix",
  robots: { index: false, follow: false, nocache: true },
};

// Fonts loaded via a plain <link>. The names (`Barlow Condensed`, `Mulish`)
// are the same tokens.css already references, so no override is needed.
// display=swap matches the step 1 spec.
const GOOGLE_FONTS =
  "https://fonts.googleapis.com/css2?" +
  "family=Barlow+Condensed:wght@600;700;800&" +
  "family=Mulish:wght@400;600;700;800&display=swap";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href={GOOGLE_FONTS} />
      </head>
      <body>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
