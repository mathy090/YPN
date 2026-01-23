import { Tabs } from 'expo-router';

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="chats" />
      <Tabs.Screen name="community" />
      <Tabs.Screen name="calls" />
      <Tabs.Screen name="settings" />
    </Tabs>
  );
}
