import { NativeModuleGuard } from "@/features/modules/module-guard";

/** Every habits page is behind the Mi ELISE guard (ADR-064). */
export default function HabitsLayout({ children }: LayoutProps<"/my-elise/habits">) {
  return <NativeModuleGuard module="habits">{children}</NativeModuleGuard>;
}
