// src/screens/settings.tsx
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../store/authStore";
import {
  CACHE_KEYS,
  clearSecureCache,
  getCachedProfile,
  saveProfileToCache,
  UserProfileCache,
} from "../utils/cache";
import {
  getBackendToken,
  OfflineError,
  refreshTokens,
  saveTokens,
} from "../utils/tokenManager";

// ✅ HARDCODED THEME COLORS (Spotify-like Dark Theme)
const COLORS = {
  background: "#121212",
  surface: "#181818",
  card: "#212121",
  primary: "#1DB954",
  primaryDark: "#18a64a",
  text: "#FFFFFF",
  textSecondary: "#B3B3B3",
  border: "#333333",
  error: "#ef4444",
} as const;

const API_URL = process.env.EXPO_PUBLIC_API_URL || "";

export default function SettingsScreen() {
  const router = useRouter();
  const { requestSignOut, confirmSignOut, cancelSignOut } = useAuth();

  // UI State
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [modalError, setModalError] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Profile State from MongoDB (username, email, avatarUrl)
  const [profile, setProfile] = useState<{
    username: string;
    email: string;
    avatarUrl?: string | null;
  } | null>(null);

  const [isLoadingProfile, setIsLoadingProfile] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);

  // Avatar Upload State
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // ✅ Load profile from MongoDB on mount
  useEffect(() => {
    let isMounted = true;

    const loadProfile = async () => {
      try {
        setIsLoadingProfile(true);

        // 1. Load cached profile FIRST for instant display
        const cached = await getCachedProfile();
        if (isMounted && cached?.username && cached?.email) {
          setProfile({
            username: cached.username,
            email: cached.email,
            avatarUrl: cached.avatarUrl,
          });
        }

        // 2. Fetch fresh profile from MongoDB via backend
        const token = await getValidToken();
        if (!token) throw new Error("No auth token");

        const response = await fetch(`${API_URL}/api/users/profile`, {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          throw new Error(err.message || "Failed to fetch profile");
        }

        const freshProfile = await response.json();

        // 3. Update cache with fresh MongoDB data
        await saveProfileToCache({
          uid: freshProfile.uid,
          username: freshProfile.username,
          email: freshProfile.email,
          avatarUrl: freshProfile.avatarUrl,
          hasProfile: freshProfile.hasProfile,
        });

        // 4. Update state if still mounted
        if (isMounted) {
          setProfile({
            username: freshProfile.username,
            email: freshProfile.email,
            avatarUrl: freshProfile.avatarUrl,
          });
          setProfileError(null);
        }
      } catch (error: any) {
        console.warn("[Settings] Profile fetch error:", error.message);
        if (isMounted) {
          setProfileError(
            "Could not load latest profile. Showing cached data.",
          );
        }
      } finally {
        if (isMounted) {
          setIsLoadingProfile(false);
        }
      }
    };

    loadProfile();

    return () => {
      isMounted = false;
    };
  }, []);

  // ✅ Pull-to-refresh handler
  const onRefresh = useCallback(async () => {
    setIsRefreshing(true);
    setProfileError(null);

    try {
      const token = await getValidToken();
      if (!token) throw new Error("No auth token");

      const response = await fetch(`${API_URL}/api/users/profile`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) throw new Error("Failed to refresh profile");

      const freshProfile = await response.json();
      await saveProfileToCache({
        uid: freshProfile.uid,
        username: freshProfile.username,
        email: freshProfile.email,
        avatarUrl: freshProfile.avatarUrl,
        hasProfile: freshProfile.hasProfile,
      });

      setProfile({
        username: freshProfile.username,
        email: freshProfile.email,
        avatarUrl: freshProfile.avatarUrl,
      });
    } catch (error: any) {
      console.warn("[Settings] Refresh error:", error.message);
      setProfileError("Failed to refresh. Showing cached data.");
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  // ✅ Get valid token with auto-refresh if expired
  const getValidToken = async (): Promise<string | null> => {
    let token = await getBackendToken();

    if (!token) {
      try {
        const refreshedData = await refreshTokens();
        await saveTokens(refreshedData);
        token = refreshedData.backend_jwt;
      } catch (refreshError) {
        if (refreshError instanceof OfflineError) {
          return await getBackendToken();
        }
        console.warn("[Settings] Token refresh failed:", refreshError.message);
        return null;
      }
    }

    return token;
  };

  // ✅ Handle avatar selection and instant upload
  const handlePickAndUploadAvatar = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert(
        "Permission Required",
        "Please allow access to your photos to change your profile picture.",
        [{ text: "OK" }],
      );
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      // ✅ FIX: Use correct enum value for Expo ImagePicker
      mediaTypes: ImagePicker.MediaType.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });

    if (result.canceled) return;

    setIsUploadingAvatar(true);
    setUploadError(null);

    try {
      const token = await getValidToken();
      if (!token)
        throw new Error("Authentication required. Please sign in again.");

      // ✅ DEBUG: Decode JWT to verify it contains uid (sub field)
      try {
        const tokenPayload = JSON.parse(atob(token.split(".")[1]));
        console.log("[Settings] Avatar upload token payload:", {
          sub: tokenPayload.sub, // ✅ This is the Firebase UID
          email: tokenPayload.email,
          hasTokenVersion: "tokenVersion" in tokenPayload,
        });
      } catch (e) {
        console.warn("[Settings] Could not decode token payload:", e);
      }

      const imageUri = result.assets[0].uri;
      const mimeType = result.assets[0].mimeType || "image/jpeg";

      const response = await fetch(imageUri);
      const blob = await response.blob();

      console.log("[Settings] Uploading avatar to backend...");

      const uploadResponse = await fetch(`${API_URL}/api/avatar`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": mimeType,
        },
        body: blob,
      });

      const uploadData = await uploadResponse.json().catch(() => ({}));

      console.log("[Settings] Avatar upload response:", {
        status: uploadResponse.status,
        ok: uploadResponse.ok,
        avatarUrl: uploadData.avatarUrl,
        uid: uploadData.uid,
        error: uploadData.message,
        code: uploadData.code,
      });

      if (!uploadResponse.ok) {
        if (uploadResponse.status === 401) {
          throw new Error("Session expired. Please sign in again.");
        }
        if (uploadResponse.status === 429) {
          throw new Error("Too many uploads. Please wait a few minutes.");
        }
        throw new Error(uploadData.message || "Failed to upload avatar");
      }

      const { avatarUrl, uid } = uploadData;

      if (!avatarUrl) {
        throw new Error("Backend did not return avatar URL");
      }

      // ✅ Update local state and cache with new avatar
      setProfile((prev) => (prev ? { ...prev, avatarUrl } : null));

      // Update cache with full profile structure
      const cachedProfile = await getCachedProfile();
      await saveProfileToCache({
        ...(cachedProfile || {}),
        avatarUrl,
        uid: uid || cachedProfile?.uid,
      } as UserProfileCache);

      console.log("[Settings] ✅ Avatar uploaded and cached:", avatarUrl);
    } catch (error: any) {
      console.error("[Settings] Avatar upload error:", {
        message: error.message,
        name: error.name,
      });
      setUploadError("Failed to upload photo. Please try again.");

      Alert.alert(
        "Upload Failed",
        error.message.includes("sign in")
          ? "Your session expired. Please sign in again to continue."
          : error.message.includes("Too many")
            ? "Too many uploads. Please wait a few minutes."
            : "Could not upload your photo. Please try again.",
        [{ text: "OK" }],
      );
    } finally {
      setIsUploadingAvatar(false);
    }
  };

  // ✅ Handle "Sign Out" button tap
  const handleSignOutRequest = () => {
    requestSignOut();
    setShowPasswordModal(true);
    setConfirmEmail(profile?.email || "");
    setConfirmPassword("");
    setModalError("");
  };

  // ✅ Handle password confirmation for sign out
  const handleConfirmSignOut = async () => {
    if (!confirmEmail.includes("@") || confirmPassword.length < 6) {
      setModalError("Please enter valid credentials");
      return;
    }

    setIsLoggingOut(true);
    setModalError("");

    try {
      await confirmSignOut(confirmEmail, confirmPassword, async () => {
        console.log("[Settings] Clearing local cache...");
        await clearSecureCache();

        const allKeys = Object.values(CACHE_KEYS);
        await Promise.all(
          allKeys.map((key) =>
            import("expo-secure-store").then((SecureStore) =>
              SecureStore.deleteItemAsync(key).catch(() => {}),
            ),
          ),
        );
        console.log("[Settings] ✅ Cache wiped");
      });
    } catch (error: any) {
      console.error("Sign out verification failed:", error.message);
      setModalError(error.message || "Verification failed. Please try again.");
    } finally {
      setIsLoggingOut(false);
    }
  };

  // ✅ Cancel sign out
  const handleCancelSignOut = () => {
    cancelSignOut();
    setShowPasswordModal(false);
    setModalError("");
  };

  const SettingItem = ({
    icon,
    title,
    subtitle,
    rightElement,
    onPress,
    isDanger = false,
  }: {
    icon: keyof typeof Ionicons.glyphMap;
    title: string;
    subtitle?: string;
    rightElement?: React.ReactNode;
    onPress?: () => void;
    isDanger?: boolean;
  }) => (
    <TouchableOpacity
      style={[styles.settingItem, isDanger && styles.dangerItem]}
      onPress={onPress}
      disabled={!onPress}
      activeOpacity={0.7}
    >
      <View style={styles.settingLeft}>
        <View
          style={[
            styles.iconContainer,
            isDanger
              ? { backgroundColor: "rgba(239, 68, 68, 0.1)" }
              : { backgroundColor: "rgba(29, 185, 84, 0.1)" },
          ]}
        >
          <Ionicons
            name={icon}
            size={22}
            color={isDanger ? COLORS.error : COLORS.primary}
          />
        </View>
        <View style={styles.settingTextContainer}>
          <Text
            style={[
              styles.settingTitle,
              { color: isDanger ? COLORS.error : COLORS.text },
            ]}
          >
            {title}
          </Text>
          {subtitle && (
            <Text
              style={[styles.settingSubtitle, { color: COLORS.textSecondary }]}
            >
              {subtitle}
            </Text>
          )}
        </View>
      </View>
      <View style={styles.settingRight}>
        {rightElement || (
          <Ionicons
            name="chevron-forward"
            size={20}
            color={COLORS.textSecondary}
          />
        )}
      </View>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: COLORS.background }]}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={onRefresh}
            colors={[COLORS.primary]}
            tintColor={COLORS.primary}
            title="Refreshing..."
            titleColor={COLORS.textSecondary}
          />
        }
      >
        {/* ✅ Profile Header - Data from MongoDB */}
        <View style={[styles.profileCard, { backgroundColor: COLORS.card }]}>
          {/* Avatar: from MongoDB avatarUrl, or placeholder if null */}
          <View style={styles.avatarSection}>
            <View style={styles.avatarContainer}>
              {isUploadingAvatar ? (
                <View style={[styles.avatar, styles.avatarPlaceholder]}>
                  <ActivityIndicator color={COLORS.primary} size="large" />
                </View>
              ) : profile?.avatarUrl ? (
                // ✅ Show avatar from MongoDB with error handling
                <Image
                  source={{ uri: profile.avatarUrl }}
                  style={styles.avatar}
                  resizeMode="cover"
                  onError={(e) => {
                    console.warn("[Settings] Avatar load failed:", {
                      uri: profile.avatarUrl,
                      error: e.nativeEvent?.error,
                    });
                  }}
                  onLoad={() => {
                    console.log("[Settings] ✅ Avatar loaded successfully");
                  }}
                />
              ) : (
                // ✅ Show placeholder if avatarUrl is null/undefined in MongoDB
                <View style={[styles.avatar, styles.avatarPlaceholder]}>
                  <Ionicons name="person" size={40} color={COLORS.primary} />
                </View>
              )}

              <View style={styles.onlineIndicator} />

              {/* Change Photo Button */}
              <TouchableOpacity
                style={styles.changeAvatarButton}
                onPress={handlePickAndUploadAvatar}
                disabled={isUploadingAvatar}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={isUploadingAvatar ? "hourglass" : "camera"}
                  size={18}
                  color="#000"
                />
              </TouchableOpacity>
            </View>

            {isUploadingAvatar && (
              <Text style={[styles.uploadStatus, { color: COLORS.primary }]}>
                Uploading...
              </Text>
            )}
            {uploadError && (
              <Text style={[styles.uploadStatus, { color: COLORS.error }]}>
                {uploadError}
              </Text>
            )}
          </View>

          {/* User Info - Username & Email from MongoDB, READ ONLY */}
          <View style={styles.userInfo}>
            {isLoadingProfile ? (
              <ActivityIndicator color={COLORS.primary} size="small" />
            ) : profile ? (
              <>
                {/* ✅ USERNAME from MongoDB - displayed prominently */}
                <Text
                  style={[styles.username, { color: COLORS.text }]}
                  numberOfLines={1}
                >
                  {profile.username}
                </Text>

                {/* ✅ EMAIL from MongoDB - displayed below username */}
                <Text
                  style={[styles.userEmail, { color: COLORS.textSecondary }]}
                  numberOfLines={1}
                >
                  {profile.email}
                </Text>
              </>
            ) : (
              <Text style={[styles.userEmail, { color: COLORS.textSecondary }]}>
                Loading...
              </Text>
            )}
          </View>
        </View>

        {/* Show error if profile fetch failed */}
        {profileError && (
          <View
            style={[
              styles.warningBanner,
              { backgroundColor: "rgba(255, 193, 7, 0.1)" },
            ]}
          >
            <Ionicons
              name="warning"
              size={16}
              color="#ffc107"
              style={{ marginRight: 8 }}
            />
            <Text style={[styles.warningText, { color: "#ffc107" }]}>
              {profileError}
            </Text>
          </View>
        )}

        {/* ✅ Support Section */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: COLORS.textSecondary }]}>
            Support
          </Text>
          <View style={[styles.card, { backgroundColor: COLORS.card }]}>
            <SettingItem
              icon="help-circle"
              title="Help Center"
              onPress={() => router.push("/support" as any)}
            />
            <View
              style={[styles.divider, { backgroundColor: COLORS.border }]}
            />
            <SettingItem
              icon="document-text"
              title="Privacy Policy"
              onPress={() => router.push("/privacy" as any)}
            />
            <View
              style={[styles.divider, { backgroundColor: COLORS.border }]}
            />
            <SettingItem
              icon="shield-checkmark"
              title="Terms of Service"
              onPress={() => router.push("/terms" as any)}
            />
          </View>
        </View>

        {/* Danger Zone */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: COLORS.error }]}>
            Danger Zone
          </Text>
          <View style={[styles.card, { backgroundColor: COLORS.card }]}>
            <SettingItem
              icon="log-out"
              title="Sign Out & Clear Data"
              subtitle="Requires password confirmation"
              onPress={handleSignOutRequest}
              isDanger={true}
              rightElement={
                <Ionicons
                  name="chevron-forward"
                  size={20}
                  color={COLORS.error}
                />
              }
            />
          </View>
        </View>

        {/* App Version */}
        <View style={styles.versionContainer}>
          <Text style={[styles.versionText, { color: COLORS.textSecondary }]}>
            Cheziya School App v1.0.0
          </Text>
          <Text
            style={[styles.versionSubText, { color: COLORS.textSecondary }]}
          >
            Built for YPN Initiative
          </Text>
        </View>
      </ScrollView>

      {/* ✅ Password Confirmation Modal for Sign Out */}
      <Modal visible={showPasswordModal} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: COLORS.card }]}>
            <Text style={[styles.modalTitle, { color: COLORS.text }]}>
              Confirm Sign Out
            </Text>
            <Text
              style={[styles.modalSubtitle, { color: COLORS.textSecondary }]}
            >
              Enter your password to verify your identity before clearing all
              data.
            </Text>

            <View style={styles.inputGroup}>
              <Text
                style={[styles.inputLabel, { color: COLORS.textSecondary }]}
              >
                EMAIL
              </Text>
              <View
                style={[
                  styles.inputRow,
                  {
                    borderColor: confirmEmail.includes("@")
                      ? COLORS.primary
                      : COLORS.border,
                  },
                ]}
              >
                <Ionicons
                  name="mail-outline"
                  size={18}
                  color={
                    confirmEmail.includes("@")
                      ? COLORS.primary
                      : COLORS.textSecondary
                  }
                />
                <TextInput
                  value={confirmEmail}
                  onChangeText={setConfirmEmail}
                  placeholder="your@email.com"
                  placeholderTextColor={COLORS.textSecondary}
                  style={[styles.input, { color: COLORS.text }]}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  editable={!isLoggingOut}
                />
              </View>
            </View>

            <View style={styles.inputGroup}>
              <Text
                style={[styles.inputLabel, { color: COLORS.textSecondary }]}
              >
                PASSWORD
              </Text>
              <View
                style={[
                  styles.inputRow,
                  {
                    borderColor:
                      confirmPassword.length >= 6
                        ? COLORS.primary
                        : COLORS.border,
                  },
                ]}
              >
                <Ionicons
                  name="lock-closed-outline"
                  size={18}
                  color={
                    confirmPassword.length >= 6
                      ? COLORS.primary
                      : COLORS.textSecondary
                  }
                />
                <TextInput
                  value={confirmPassword}
                  onChangeText={setConfirmPassword}
                  placeholder="••••••••"
                  placeholderTextColor={COLORS.textSecondary}
                  style={[styles.input, { color: COLORS.text }]}
                  secureTextEntry
                  editable={!isLoggingOut}
                  onSubmitEditing={handleConfirmSignOut}
                />
              </View>
            </View>

            {modalError ? (
              <Text style={[styles.modalError, { color: COLORS.error }]}>
                {modalError}
              </Text>
            ) : null}

            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalButton, styles.cancelButton]}
                onPress={handleCancelSignOut}
                disabled={isLoggingOut}
              >
                <Text
                  style={[
                    styles.modalButtonText,
                    { color: COLORS.textSecondary },
                  ]}
                >
                  Cancel
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.modalButton,
                  styles.confirmButton,
                  (!confirmEmail.includes("@") ||
                    confirmPassword.length < 6 ||
                    isLoggingOut) &&
                    styles.confirmButtonDisabled,
                ]}
                onPress={handleConfirmSignOut}
                disabled={
                  !confirmEmail.includes("@") ||
                  confirmPassword.length < 6 ||
                  isLoggingOut
                }
              >
                {isLoggingOut ? (
                  <ActivityIndicator color="#000" size="small" />
                ) : (
                  <Text style={[styles.modalButtonText, { color: "#000" }]}>
                    Confirm Sign Out
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: { padding: 20, paddingBottom: 40 },

  // Profile Card
  profileCard: {
    borderRadius: 20,
    padding: 24,
    marginBottom: 24,
    alignItems: "center",
    elevation: 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },

  // Avatar Section
  avatarSection: { alignItems: "center", marginBottom: 16 },
  avatarContainer: { position: "relative", marginBottom: 8 },
  avatar: { width: 100, height: 100, borderRadius: 50 },
  avatarPlaceholder: {
    backgroundColor: "rgba(29, 185, 84, 0.1)",
    justifyContent: "center",
    alignItems: "center",
  },
  onlineIndicator: {
    position: "absolute",
    bottom: 8,
    right: 8,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: COLORS.primary,
    borderWidth: 3,
    borderColor: COLORS.card,
  },
  changeAvatarButton: {
    position: "absolute",
    bottom: 4,
    right: 4,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.primary,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 2,
    borderColor: COLORS.card,
  },
  uploadStatus: { fontSize: 12, marginTop: 4, fontWeight: "500" },

  // User Info
  userInfo: { alignItems: "center", marginBottom: 16 },
  username: {
    fontSize: 20,
    fontWeight: "bold",
    marginBottom: 4,
    textAlign: "center",
  },
  userEmail: {
    fontSize: 14,
    textAlign: "center",
  },

  // Warning Banner
  warningBanner: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderRadius: 12,
    marginBottom: 16,
  },
  warningText: { fontSize: 13, flex: 1 },

  // Section Styles
  section: { marginBottom: 24 },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 12,
    marginLeft: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  card: {
    borderRadius: 16,
    overflow: "hidden",
    elevation: 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },

  // Setting Item
  settingItem: { flexDirection: "row", alignItems: "center", padding: 16 },
  dangerItem: {},
  settingLeft: { flexDirection: "row", alignItems: "center", flex: 1 },
  iconContainer: {
    width: 36,
    height: 36,
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
  settingTextContainer: { flex: 1 },
  settingTitle: { fontSize: 16, fontWeight: "600" },
  settingSubtitle: { fontSize: 13, marginTop: 2 },
  settingRight: { alignItems: "center" },
  divider: { height: 1, marginLeft: 60 },

  // Version
  versionContainer: { alignItems: "center", marginTop: 20, marginBottom: 20 },
  versionText: { fontSize: 12, fontWeight: "500" },
  versionSubText: { fontSize: 11, opacity: 0.7, marginTop: 4 },

  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.7)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  modalContent: { width: "100%", maxWidth: 400, borderRadius: 20, padding: 24 },
  modalTitle: {
    fontSize: 20,
    fontWeight: "bold",
    marginBottom: 8,
    textAlign: "center",
  },
  modalSubtitle: {
    fontSize: 14,
    marginBottom: 24,
    textAlign: "center",
    lineHeight: 20,
  },
  inputGroup: { marginBottom: 16 },
  inputLabel: {
    fontSize: 11,
    letterSpacing: 1.2,
    fontWeight: "600",
    marginBottom: 6,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    height: 50,
  },
  input: { flex: 1, fontSize: 15, marginLeft: 10 },
  modalError: { fontSize: 12, marginBottom: 16, textAlign: "center" },
  modalButtons: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 8,
  },
  modalButton: {
    flex: 1,
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
    marginHorizontal: 4,
  },
  cancelButton: { backgroundColor: "rgba(255,255,255,0.1)" },
  confirmButton: { backgroundColor: COLORS.primary },
  confirmButtonDisabled: { backgroundColor: COLORS.border, opacity: 0.6 },
  modalButtonText: { fontWeight: "600", fontSize: 14 },
});
