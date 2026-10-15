import { NativeModuleGuard } from "@/features/modules/module-guard";

/** Every notes page is behind the Mi ELISE guard (ADR-064). */
export default function NotesLayout({ children }: LayoutProps<"/my-elise/notes">) {
  return <NativeModuleGuard module="notes">{children}</NativeModuleGuard>;
}
