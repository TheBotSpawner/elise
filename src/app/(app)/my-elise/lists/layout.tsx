import { NativeModuleGuard } from "@/features/modules/module-guard";

/** Every lists page is behind the Mi ELISE guard (ADR-064). */
export default function ListsLayout({ children }: LayoutProps<"/my-elise/lists">) {
  return <NativeModuleGuard module="lists">{children}</NativeModuleGuard>;
}
