// app/auth/device.tsx

import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { getAuth, updateProfile } from 'firebase/auth';
import { useEffect, useState } from 'react';
import {
  Alert,
  BackHandler,
  Image,
  Platform,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { useAuth } from '../../src/store/authStore';
import { colors } from '../../src/theme/colors';
import Screen from '../../src/ui/Screen';

export default function Device() {
  const router = useRouter();
  const { login } = useAuth();

  const [name, setName] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  /* Android back = exit */
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      BackHandler.exitApp();
      return true;
    });
    return () => sub.remove();
  }, []);

  /* Permissions */
  useEffect(() => {
    ImagePicker.requestMediaLibraryPermissionsAsync();
  }, []);

  /* Pick image */
  const pickImage = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });

    if (!result.canceled && result.assets?.length) {
      setPhoto(result.assets[0].uri);
    }
  };

  /* Save to MongoDB */
  const saveToMongoDB = async (uid: string, name: string, photoUri: string | null) => {
    const formData = new FormData();
    formData.append('uid', uid);
    formData.append('name', name);
    formData.append('email', getAuth().currentUser?.email || '');
    
    if (photoUri) {
      formData.append('photo', {
        uri: photoUri,
        type: 'image/jpeg',
        name: 'profile.jpg'
      });
    }

    try {
      const response = await fetch('YOUR_RENDER_URL/api/users', {
        method: 'POST',
        body: formData,
        headers: { 'Accept': 'application/json' }
      });
      return await response.json();
    } catch (error) {
      console.error('MongoDB save error:', error);
      throw error;
    }
  };

  /* Finish setup */
  const finishSetup = async () => {
    if (!name.trim() || loading) return;

    setLoading(true);

    try {
      const auth = getAuth();
      const user = auth.currentUser;
      if (!user) throw new Error('No user');

      // Update Auth profile
      await updateProfile(user, {
        displayName: name.trim(),
        photoURL: photo ? photo : undefined,
      });

      // Save to MongoDB
      await saveToMongoDB(user.uid, name.trim(), photo || null);

      login(); // local auth store
      router.replace('/tabs/chats'); // Navigate to main app
    } catch (e) {
      console.error(e);
      Alert.alert('Error', 'Failed to save profile. Please try again.');
      setLoading(false);
    }
  };

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', paddingTop: 60 }}>
        <Text style={{ color: colors.text, fontSize: 22, textAlign: 'center' }}>
          Profile info
        </Text>

        <TouchableOpacity
          onPress={pickImage}
          style={{ alignSelf: 'center', marginVertical: 20 }}
        >
          {photo ? (
            <Image
              source={{ uri: photo }}
              style={{ width: 120, height: 120, borderRadius: 60 }}
            />
          ) : (
            <View
              style={{
                width: 120,
                height: 120,
                borderRadius: 60,
                backgroundColor: '#2a2a2a',
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Text style={{ color: colors.muted }}>Add photo</Text>
            </View>
          )}
        </TouchableOpacity>

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
            <Text style={{ color: '#000', fontWeight: 'bold' }}>Saving...</Text>
          ) : (
            <Text style={{ color: '#000', fontWeight: 'bold' }}>Next</Text>
          )}
        </TouchableOpacity>
      </View>
    </Screen>
  );
}