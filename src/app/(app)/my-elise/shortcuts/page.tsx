import { load } from "./load";
import { View } from "./view";

export default async function ShortcutsMoved() {
  await load();
  return <View />;
}
