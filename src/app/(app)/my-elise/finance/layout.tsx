import { NativeModuleGuard } from "@/features/modules/module-guard";

/** Every finance page is behind the Mi ELISE guard (ADR-064). */
export default function FinanceLayout({ children }: LayoutProps<"/my-elise/finance">) {
  return <NativeModuleGuard module="finance">{children}</NativeModuleGuard>;
}
