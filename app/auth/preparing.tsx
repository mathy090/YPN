// app/auth/preparing.tsx

import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, Image, Text, View } from 'react-native';

export default function Preparing() {
  const router = useRouter();

  useEffect(() => {
    const timer = setTimeout(() => {
      router.replace('/tabs/chats');
    }, 2000);
    
    return () => clearTimeout(timer);
  }, [router]);

  return (
    <View
      style={{
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: '#000',
      }}
    >
      <Image
        source={require('../../assets/images/YPN.png')}
        style={{ width: 120, height: 120, marginBottom: 20 }}
        resizeMode="contain"
      />

      <Text style={{ color: '#fff', marginBottom: 16 }}>
        Just getting ready for your mental health
      </Text>

      <ActivityIndicator color="#fff" />
    </View>
  );
}