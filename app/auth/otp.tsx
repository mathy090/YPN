// app/auth/otp.tsx

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { signInWithEmailAndPassword } from 'firebase/auth'; // Import function separately
import { useEffect, useRef, useState } from 'react';
import { BackHandler, Image, KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import YPNLogo from '../../assets/images/YPN.png';
import { auth } from '../../src/firebase/auth'; // Import auth instance only
import { colors } from '../../src/theme/colors';
import Screen from '../../src/ui/Screen';

export default function OTP() {
  const router = useRouter();
  const inputRef = useRef<TextInput>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const backAction = () => {
      BackHandler.exitApp();
      return true;
    };

    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      backAction
    );

    return () => subscription.remove();
  }, []);

  const login = async () => {
    if (!email.includes('@')) {
      setError('Please enter a valid email');
      return;
    }
    
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    try {
      await signInWithEmailAndPassword(auth, email, password);
      
      // Cache user session data
      await AsyncStorage.setItem('userSession', JSON.stringify({
        uid: auth.currentUser?.uid,
        email: auth.currentUser?.email,
        timestamp: Date.now()
      }));
      
      router.replace('/auth/device');
    } catch (err: any) {
      // Handle network error specifically
      if (err.code === 'auth/network-request-failed') {
        setError('No internet connection. Please check your network and try again.');
      } else {
        // Hide other server error messages - only show generic message
        setError('Invalid email or password');
      }
      console.error('Login error:', err); // Log for debugging but don't show to user
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <TouchableOpacity 
        style={{ position: 'absolute', top: 40, left: 16, zIndex: 10 }} 
        onPress={() => BackHandler.exitApp()}
      >
        <Text style={{ color: colors.primary, fontSize: 16, fontWeight: '600' }}>
          Back
        </Text>
      </TouchableOpacity>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView 
          contentContainerStyle={{ flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
        >
          <Screen>
            <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 20, paddingTop: 40 }}>
              <View style={{ alignItems: 'center', marginBottom: 30 }}>
                <Image 
                  source={YPNLogo} 
                  style={{ width: 80, height: 80, borderRadius: 40 }} 
                />
              </View>
              
              <Text style={{ color: colors.text, fontSize: 22, marginBottom: 10, textAlign: 'center' }}>
                Enter your account details
              </Text>

              <Text style={{ color: colors.muted, marginBottom: 30, textAlign: 'center' }}>
                Sign in to continue to YPN
              </Text>

              <TextInput
                placeholder="Email"
                placeholderTextColor={colors.muted}
                value={email}
                onChangeText={text => {
                  setEmail(text);
                  setError('');
                }}
                style={{
                  fontSize: 18,
                  color: colors.text,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.muted,
                  paddingVertical: 10,
                  marginBottom: 20,
                }}
                keyboardType="email-address"
                autoCapitalize="none"
              />

              <TextInput
                ref={inputRef}
                placeholder="Password"
                placeholderTextColor={colors.muted}
                secureTextEntry
                value={password}
                onChangeText={text => {
                  setPassword(text);
                  setError('');
                }}
                style={{
                  fontSize: 18,
                  color: colors.text,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.muted,
                  paddingVertical: 10,
                  marginBottom: 20,
                }}
              />

              {error && (
                <Text style={{ color: colors.error, marginBottom: 20, textAlign: 'center' }}>
                  {error}
                </Text>
              )}
            </View>

            <View style={{ marginBottom: 30, marginHorizontal: 20 }}>
              <TouchableOpacity
                onPress={login}
                style={{
                  backgroundColor: colors.primary,
                  padding: 14,
                  borderRadius: 30,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: '#000', fontWeight: 'bold' }}>
                  Login
                </Text>
              </TouchableOpacity>
            </View>
          </Screen>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}