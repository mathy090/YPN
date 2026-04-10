// app/index.tsx
// _layout.tsx now owns all auth routing.
// This file only exists because Expo Router requires a root index route.
// The black splash overlay in _layout.tsx covers it until navigation fires.
import { View } from "react-native";

export default function Index() {
  return <View style={{ flex: 1, backgroundColor: "#000" }} />;
}
