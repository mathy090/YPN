import { useRouter } from 'expo-router';
import { getAuth, updateProfile } from 'firebase/auth';
import { useState } from 'react';
import { ActivityIndicator, Alert, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { useAuth } from '../../src/store/authStore';
import { colors } from '../../src/theme/colors';
import Screen from '../../src/ui/Screen';

export default function Device() {
  const router = useRouter();
  const { login } = useAuth();

  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);

  /* Save username to backend */
  const saveToMongoDB = async (uid: string, name: string) => {
    try {
      const response = await fetch('https://ypn.onrender.com/api/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          uid,
          name,
          email: getAuth().currentUser?.email || '',
        }),
      });

      if (!response.ok) {
        throw new Error('Could not sync. Try again later.');
      }

      return await response.json();
    } catch (error) {
      console.error('MongoDB save error:', error);
      throw new Error('Could not sync. Try again later.');
    }
  };

  /* Finish profile setup */
  const finishSetup = async () => {
    if (!name.trim() || loading) return;

    setLoading(true);

    try {
      const auth = getAuth();
      const user = auth.currentUser;
      if (!user) throw new Error('No authenticated user found');

      // Update Firebase profile
      await updateProfile(user, {
        displayName: name.trim(),
      });

      // Save to backend
      await saveToMongoDB(user.uid, name.trim());

      login(); // update local auth store
      router.replace('/tabs/chats'); // navigate to main app
    } catch (error: any) {
      console.error('Finish setup error:', error);
      Alert.alert('Error', error.message || 'Could not sync. Try again later.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', paddingTop: 60, paddingHorizontal: 20 }}>
        <Text style={{ color: colors.text, fontSize: 22, textAlign: 'center' }}>Enter your name</Text>

        <TextInput
          placeholder="Type your name"
          placeholderTextColor={colors.muted}
          value={name}
          onChangeText={setName}
          style={{
            color: colors.text,
            borderBottomWidth: 1,
            borderBottomColor: colors.muted,
            fontSize: 16,
            paddingVertical: 10,
            marginBottom: 40,
            textAlign: 'center',
          }}
        />

        <TouchableOpacity
          onPress={finishSetup}
          disabled={!name.trim() || loading}
          style={{
            backgroundColor: colors.primary,
            padding: 16,
            borderRadius: 30,
            alignItems: 'center',
          }}
        >
          {loading ? (
            <ActivityIndicator color="#000" size="small" />
          ) : (
            <Text style={{ color: '#000', fontWeight: 'bold' }}>Next</Text>
          )}
        </TouchableOpacity>
      </View>
    </Screen>
  );
}
