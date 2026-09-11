import type { Metadata } from "next";
import type { ReactNode } from "react";

import { SiteHeader } from "../components/site-header";
import "./globals.css";

type RootLayoutProps = Readonly<{
  children: ReactNode;
}>;

export const metadata: Metadata = {
  title: {
    default: "Who — applicant research dossiers",
    template: "%s · Who"
  },
  description:
    "Research World of Warcraft applicants from Raider.IO or Warcraft Logs character URLs."
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
