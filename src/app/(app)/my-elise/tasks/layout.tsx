import { NativeModuleGuard } from "@/features/modules/module-guard";

/** Every tasks page is behind the Mi ELISE guard (ADR-064). */
export default function TasksLayout({ children }: LayoutProps<"/my-elise/tasks">) {
  return <NativeModuleGuard module="tasks">{children}</NativeModuleGuard>;
}
