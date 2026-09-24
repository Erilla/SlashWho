import { Suspense } from "react";
import { AccountForm } from "../account-form";
export default function Page() {
  return (
    <Suspense>
      <AccountForm flow="change-email" />
    </Suspense>
  );
}
