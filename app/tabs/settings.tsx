import { Link } from 'expo-router';
import { Text, View } from 'react-native';

export default function Settings() {
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <Text>Settings</Text>
      <Link href="/about" style={{ marginTop: 10 }}>
        About YPN
      </Link>
    </View>
  );
}
