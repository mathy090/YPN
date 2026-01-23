import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import {
  BackHandler,
  Image,
  Platform,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { colors } from '../src/theme/colors';
import Screen from '../src/ui/Screen';

export default function Welcome() {
  const router = useRouter();

  // Android back = exit app
  useEffect(() => {
    if (Platform.OS !== 'android') return;

    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      BackHandler.exitApp();
      return true;
    });

    return () => sub.remove();
  }, []);

  return (
    <Screen>
      <StatusBar style="light" />

      <View style={{ flex: 1, justifyContent: 'center' }}>
        <View style={{ alignItems: 'center', marginBottom: 30 }}>
          <Image
            source={require('../assets/images/YPN.png')}
            style={{ width: 80, height: 80, borderRadius: 40 }}
          />
        </View>

        <Text
          style={{
            color: colors.text,
            fontSize: 28,
            marginBottom: 20,
            textAlign: 'center',
          }}
        >
          Welcome to YPN Messenger
        </Text>

        <Text
          style={{
            color: colors.muted,
            textAlign: 'center',
            marginBottom: 40,
            paddingHorizontal: 10,
          }}
        >
          Read our Privacy Policy. Tap "Agree and Continue" to accept the Terms.
        </Text>
      </View>

      <View style={{ marginBottom: 30 }}>
        <TouchableOpacity
          onPress={() => router.replace('/auth/phone')}
          style={{
            backgroundColor: colors.primary,
            padding: 16,
            borderRadius: 30,
            alignItems: 'center',
            marginBottom: 10,
          }}
        >
          <Text style={{ color: '#000', fontWeight: 'bold' }}>
            Agree and Continue
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => router.replace('/auth/otp')}
          style={{
            padding: 16,
            borderRadius: 30,
            alignItems: 'center',
            borderWidth: 1,
            borderColor: colors.primary,
          }}
        >
          <Text style={{ color: colors.primary, fontWeight: 'bold' }}>
            Already have an account? Continue
          </Text>
        </TouchableOpacity>

        <Text
          style={{
            color: colors.muted,
            textAlign: 'center',
            fontSize: 12,
            marginTop: 16,
          }}
        >
          © 2026 YPN Messenger
        </Text>
      </View>
    </Screen>
  );
}
