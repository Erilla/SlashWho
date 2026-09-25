import type { Metadata } from "next";

import { AccountOverview } from "./account-overview";

export const metadata: Metadata = {
  title: "Account",
  robots: { index: false, follow: false }
};

export default function Page() {
  return <AccountOverview />;
}
