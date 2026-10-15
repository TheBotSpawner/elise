import { NativeModuleGuard } from "@/features/modules/module-guard";

/** Every goals page is behind the Mi ELISE guard (ADR-064). */
export default function GoalsLayout({ children }: LayoutProps<"/my-elise/goals">) {
  return <NativeModuleGuard module="goals">{children}</NativeModuleGuard>;
}
