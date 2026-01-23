// app/auth/phone.tsx

import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { auth, createUserWithEmailAndPassword, sendEmailVerification } from '../../src/firebase/auth'; // Updated import
import { colors } from '../../src/theme/colors';

export default function Phone() {
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [passwordMatchError, setPasswordMatchError] = useState('');

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const spinAnim = useRef(new Animated.Value(0)).current;

  const isValid = email.includes('@') && password.length >= 8;

  useEffect(() => {
    // Check if passwords match
    if (confirm && password !== confirm) {
      setPasswordMatchError('Passwords do not match');
    } else {
      setPasswordMatchError('');
    }
  }, [password, confirm]);

  useEffect(() => {
    const backAction = () => {
      if (showConfirm) {
        setShowConfirm(false);
        return true;
      }
      router.replace('/welcome');
      return true;
    };

    const sub = BackHandler.addEventListener(
      'hardwareBackPress',
      backAction
    );

    return () => sub.remove();
  }, [showConfirm]);

  const startFlow = async () => {
    if (password !== confirm) {
      setPasswordMatchError('Passwords do not match');
      return;
    }

    Keyboard.dismiss();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    setLoading(true);
    fadeAnim.setValue(0);
    spinAnim.setValue(0);

    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 250,
      useNativeDriver: true,
    }).start();

    Animated.loop(
      Animated.timing(spinAnim, {
        toValue: 1,
        duration: 900,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      })
    ).start();

    try {
      // Create user with email and password
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);
      
      // Send email verification
      await sendEmailVerification(userCredential.user);
      
      setLoading(false);
      setShowConfirm(true);
    } catch (error: any) {
      console.error("Sign up error:", error);
      setLoading(false);
      setPasswordMatchError(error.message || 'Failed to create account');
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <TouchableOpacity style={styles.back} onPress={() => router.replace('/welcome')}>
        <Text style={styles.backText}>Back</Text>
      </TouchableOpacity>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.info}>
            Create your YPN account
          </Text>

          <TextInput
            placeholder="Email"
            placeholderTextColor={colors.muted}
            value={email}
            onChangeText={setEmail}
            style={styles.input}
            keyboardType="email-address"
            autoCapitalize="none"
          />

          <TextInput
            placeholder="Password"
            placeholderTextColor={colors.muted}
            secureTextEntry
            value={password}
            onChangeText={setPassword}
            style={styles.input}
          />

          <TextInput
            placeholder="Confirm password"
            placeholderTextColor={colors.muted}
            secureTextEntry
            value={confirm}
            onChangeText={setConfirm}
            style={styles.input}
          />
          
          {passwordMatchError ? (
            <Text style={styles.errorText}>{passwordMatchError}</Text>
          ) : null}
        </ScrollView>

        <View style={styles.bottom}>
          <TouchableOpacity
            disabled={!isValid || !!passwordMatchError}
            onPress={startFlow}
            style={[
              styles.next,
              { 
                backgroundColor: !isValid || !!passwordMatchError ? '#555' : colors.primary 
              },
            ]}
          >
            <Text style={styles.nextText}>Next</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      {loading && (
        <Animated.View style={[styles.overlay, { opacity: fadeAnim }]}>
          <Animated.View
            style={{
              transform: [
                {
                  rotate: spinAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: ['0deg', '360deg'],
                  }),
                },
              ],
            }}
          >
            <ActivityIndicator size="large" color={colors.primary} />
          </Animated.View>
          <Text style={styles.loadingText}>Creating account</Text>
        </Animated.View>
      )}

      {showConfirm && (
        <BlurView intensity={40} tint="dark" style={styles.modalOverlay}>
          <View style={styles.modal}>
            <Text style={styles.modalText}>
              Please check your email to verify your account.
            </Text>
            <Text style={styles.emailDisplay}>{email}</Text>

            <View style={styles.modalActions}>
              <TouchableOpacity onPress={() => setShowConfirm(false)}>
                <Text style={styles.edit}>Edit</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => router.replace('/auth/otp')}
              >
                <Text style={styles.yes}>Continue</Text>
              </TouchableOpacity>
            </View>
          </View>
        </BlurView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  back: { position: 'absolute', top: 12, left: 16, zIndex: 10 },
  backText: { color: colors.primary, fontSize: 16, fontWeight: '600' },
  content: { paddingTop: 80, paddingHorizontal: 20, paddingBottom: 140 },
  info: { color: colors.text, fontSize: 18, marginBottom: 30 },
  input: {
    borderBottomWidth: 1,
    borderBottomColor: colors.muted,
    color: colors.text,
    fontSize: 16,
    paddingVertical: 12,
    marginBottom: 24,
  },
  errorText: {
    color: '#FF6B6B',
    fontSize: 14,
    marginBottom: 12,
    marginLeft: 2,
  },
  emailDisplay: {
    color: colors.text,
    fontSize: 16,
    fontWeight: 'bold',
    textAlign: 'center',
    marginVertical: 10,
  },
  bottom: { position: 'absolute', bottom: 20, left: 20, right: 20 },
  next: { padding: 14, borderRadius: 30, alignItems: 'center' },
  nextText: { color: '#000', fontSize: 16, fontWeight: 'bold' },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: { color: colors.text, fontSize: 18, marginTop: 16 },
  modalOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modal: {
    backgroundColor: 'rgba(20,20,20,0.95)',
    padding: 24,
    borderRadius: 14,
    width: '80%',
  },
  modalText: { color: colors.text, marginBottom: 10 },
  modalActions: { flexDirection: 'row', justifyContent: 'space-between' },
  edit: { color: colors.muted, fontSize: 16 },
  yes: { color: colors.primary, fontSize: 16, fontWeight: '600' },
});