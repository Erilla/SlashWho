import type { Metadata } from "next";
import type { ReactNode } from "react";

import { SiteHeader } from "../components/site-header";
import "./globals.css";

type RootLayoutProps = Readonly<{
  children: ReactNode;
}>;

export const metadata: Metadata = {
  title: {
    default: "Who — find connected World of Warcraft characters",
    template: "%s · Who"
  },
  description:
    "Find publicly connected World of Warcraft characters from a Raider.IO character URL."
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en">
      <body>
        <SiteHeader />
        {children}
      </body>
    </html>
  );
}
