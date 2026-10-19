import { financeGoogleAccounts } from "@/application/finance-sources";

import type { RouteLoader } from "../../../route-contract";

export const load = (async (auth, { search }) => ({
  accounts: await financeGoogleAccounts(auth),
  initialMode: search.mode === "import" ? ("import" as const) : ("connect" as const),
})) satisfies RouteLoader<unknown>;

export type FinanceConnectProps = Awaited<ReturnType<typeof load>>;
