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
} from "../utils/tokenManager";

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
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export default function SettingsScreen() {
  const router = useRouter();
  const { requestSignOut, confirmSignOut, cancelSignOut } = useAuth();

  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [modalError, setModalError] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showAvatarModal, setShowAvatarModal] = useState(false);

  const [profile, setProfile] = useState<{
    username: string;
    email: string;
    avatarUrl?: string | null;
    uid?: string;
  } | null>(null);

  const [isLoadingProfile, setIsLoadingProfile] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    const loadProfile = async () => {
      try {
        setIsLoadingProfile(true);

        const cached = await getCachedProfile();
        if (isMounted && cached?.username && cached?.email) {
          setProfile({
            username: cached.username,
            email: cached.email,
            avatarUrl: cached.avatarUrl,
            uid: cached.uid,
          });
        }

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

        await saveProfileToCache({
          uid: freshProfile.uid,
          username: freshProfile.username,
          email: freshProfile.email,
          avatarUrl: freshProfile.avatarUrl,
          hasProfile: freshProfile.hasProfile,
        });

        if (isMounted) {
          setProfile({
            username: freshProfile.username,
            email: freshProfile.email,
            avatarUrl: freshProfile.avatarUrl,
            uid: freshProfile.uid,
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
        if (isMounted) setIsLoadingProfile(false);
      }
    };

    loadProfile();
    return () => {
      isMounted = false;
    };
  }, []);

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

      if (!response.ok) throw new Error("Failed to refresh");

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
        uid: freshProfile.uid,
      });
    } catch (error: any) {
      console.warn("[Settings] Refresh error:", error.message);
      setProfileError("Failed to refresh. Showing last updated profile.");
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  const getValidToken = async (): Promise<string | null> => {
    let token = await getBackendToken();

    if (!token) {
      try {
        const refreshedData = await refreshTokens();
        await import("../utils/tokenManager").then(({ saveTokens }) =>
          saveTokens(refreshedData),
        );
        token = refreshedData.backend_jwt;
      } catch (refreshError) {
        if (refreshError instanceof OfflineError) {
          return await getBackendToken();
        }
        console.warn("[Settings] Token refresh failed:", refreshError);
        return null;
      }
    }

    return token;
  };

  const handlePickAndUploadAvatar = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission Required", "Please allow access to your photos.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });

    if (result.canceled) return;

    setIsUploadingAvatar(true);
    setUploadError(null);
    setShowAvatarModal(false);

    try {
      const currentUser = profile || (await getCachedProfile());
      if (!currentUser?.uid || !currentUser?.email) {
        throw new Error("AUTH_REQUIRED");
      }

      const imageUri = result.assets[0].uri;
      const mimeType = result.assets[0].mimeType || "image/jpeg";

      // L1: Validate size client-side before any network call
      const blobRes = await fetch(imageUri);
      const blob = await blobRes.blob();
      if (blob.size > MAX_PHOTO_BYTES) {
        throw new Error("FILE_TOO_LARGE");
      }

      // Step 1: Upload image to Supabase via /api/avatar (uid-based, confirmed working)
      console.log("[Settings] Uploading to Supabase via /api/avatar...");
      const formData = new FormData();
      // @ts-ignore — React Native FormData accepts this format
      formData.append("file", {
        uri: imageUri,
        type: mimeType,
        name: `avatar.${mimeType.split("/")[1] || "jpg"}`,
      });

      const uploadRes = await fetch(
        `${API_URL}/api/avatar?uid=${encodeURIComponent(currentUser.uid)}`,
        {
          method: "POST",
          body: formData,
          headers: { Accept: "application/json" },
        },
      );

      if (!uploadRes.ok) {
        const errBody = await uploadRes.json().catch(() => ({}));
        console.error(
          "[Settings] /api/avatar error:",
          uploadRes.status,
          errBody,
        );
        throw new Error("SERVER_ERROR");
      }

      const uploadData = await uploadRes.json();
      if (!uploadData.avatarUrl) {
        throw new Error("SERVER_ERROR");
      }

      const newAvatarUrl = uploadData.avatarUrl;
      console.log("[Settings] Supabase upload OK:", newAvatarUrl);

      // Step 2: Update MongoDB via /api/users/profile (public endpoint, no auth header needed)
      console.log("[Settings] Updating MongoDB profile...");
      const updateRes = await fetch(`${API_URL}/api/users/profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uid: currentUser.uid,
          email: currentUser.email,
          username: currentUser.username || "",
          avatarUrl: newAvatarUrl,
        }),
      });

      if (!updateRes.ok) {
        const errBody = await updateRes.json().catch(() => ({}));
        console.warn(
          "[Settings] /api/users/profile error:",
          updateRes.status,
          errBody,
        );
        // Non-fatal: avatar uploaded to Supabase, MongoDB update failed — still update cache
      }

      // Step 3: Cache bust + update local state immediately
      const avatarUrlWithBust = `${newAvatarUrl}?v=${Date.now()}`;

      setProfile((prev) =>
        prev ? { ...prev, avatarUrl: avatarUrlWithBust } : null,
      );

      // L2: Persist to cache
      await saveProfileToCache({
        uid: currentUser.uid,
        username: currentUser.username || "",
        email: currentUser.email,
        avatarUrl: avatarUrlWithBust,
        hasProfile: true,
      } as UserProfileCache);

      console.log(
        "[Settings] ✅ Avatar updated: Supabase + MongoDB + Cache + UI",
      );
      Alert.alert("Success", "Profile picture updated!");
    } catch (error: any) {
      console.error("[Settings] Avatar error:", error.message);

      const isNetwork =
        error.message === "network" ||
        error.message?.includes("fetch") ||
        error.message?.includes("Failed to fetch") ||
        error.message?.includes("timeout");

      if (isNetwork) {
        setUploadError("Poor internet connection. Try again.");
      } else if (error.message === "FILE_TOO_LARGE") {
        setUploadError("Photo must be under 5 MB.");
      } else if (error.message === "AUTH_REQUIRED") {
        setUploadError("Please sign in again.");
      } else {
        setUploadError("Something went wrong. Please try again.");
      }
    } finally {
      setIsUploadingAvatar(false);
    }
  };

  const handleChangeAvatar = () => {
    setShowAvatarModal(true);
  };

  const handleSignOutRequest = () => {
    requestSignOut();
    setShowPasswordModal(true);
    setConfirmEmail(profile?.email || "");
    setConfirmPassword("");
    setModalError("");
  };

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
              SecureStore.deleteItemAsync(key as string).catch(() => {}),
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
        {/* Profile Card */}
        <View style={[styles.profileCard, { backgroundColor: COLORS.card }]}>
          <View style={styles.avatarSection}>
            <View style={styles.avatarContainer}>
              {isUploadingAvatar ? (
                <View style={[styles.avatar, styles.avatarPlaceholder]}>
                  <ActivityIndicator color={COLORS.primary} size="large" />
                </View>
              ) : profile?.avatarUrl ? (
                <Image
                  key={profile.avatarUrl}
                  source={{ uri: profile.avatarUrl }}
                  style={styles.avatar}
                  resizeMode="cover"
                  onError={() => console.warn("[Settings] Avatar load failed")}
                />
              ) : (
                <View style={[styles.avatar, styles.avatarPlaceholder]}>
                  <Ionicons name="person" size={40} color={COLORS.primary} />
                </View>
              )}

              <View style={styles.onlineIndicator} />

              <TouchableOpacity
                style={styles.changeAvatarButton}
                onPress={handleChangeAvatar}
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

          <View style={styles.userInfo}>
            {isLoadingProfile ? (
              <ActivityIndicator color={COLORS.primary} size="small" />
            ) : profile ? (
              <>
                <Text
                  style={[styles.username, { color: COLORS.text }]}
                  numberOfLines={1}
                >
                  {profile.username}
                </Text>
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

        {/* Support Section */}
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

        <View style={styles.versionContainer}>
          <Text style={[styles.versionText, { color: COLORS.textSecondary }]}>
            YPN Messenger v2.0.0
          </Text>
          <Text
            style={[styles.versionSubText, { color: COLORS.textSecondary }]}
          >
            Built for YPN Initiative
          </Text>
        </View>
      </ScrollView>

      {/* Avatar Selection Modal */}
      <Modal
        visible={showAvatarModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowAvatarModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: COLORS.card }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: COLORS.text }]}>
                Change Profile Picture
              </Text>
              <TouchableOpacity
                onPress={() => setShowAvatarModal(false)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons name="close" size={24} color={COLORS.textSecondary} />
              </TouchableOpacity>
            </View>

            <Text
              style={[styles.modalSubtitle, { color: COLORS.textSecondary }]}
            >
              Choose a photo from your gallery to update your profile picture.
            </Text>

            <TouchableOpacity
              style={styles.modalOptionButton}
              onPress={handlePickAndUploadAvatar}
              activeOpacity={0.7}
            >
              <View style={styles.modalOptionIcon}>
                <Ionicons name="images" size={24} color={COLORS.primary} />
              </View>
              <View style={styles.modalOptionText}>
                <Text style={[styles.modalOptionTitle, { color: COLORS.text }]}>
                  Choose from Gallery
                </Text>
                <Text
                  style={[
                    styles.modalOptionDesc,
                    { color: COLORS.textSecondary },
                  ]}
                >
                  Select a photo from your device
                </Text>
              </View>
              <Ionicons
                name="chevron-forward"
                size={20}
                color={COLORS.textSecondary}
              />
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.modalButton, styles.modalCancelButton]}
              onPress={() => setShowAvatarModal(false)}
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
          </View>
        </View>
      </Modal>

      {/* Sign Out Confirmation Modal */}
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
    backgroundColor: "#1DB954",
    borderWidth: 3,
    borderColor: "#212121",
  },
  changeAvatarButton: {
    position: "absolute",
    bottom: 4,
    right: 4,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#1DB954",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 2,
    borderColor: "#212121",
  },
  uploadStatus: { fontSize: 12, marginTop: 4, fontWeight: "500" },

  userInfo: { alignItems: "center", marginBottom: 16 },
  username: {
    fontSize: 20,
    fontWeight: "bold",
    marginBottom: 4,
    textAlign: "center",
  },
  userEmail: { fontSize: 14, textAlign: "center" },

  warningBanner: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderRadius: 12,
    marginBottom: 16,
  },
  warningText: { fontSize: 13, flex: 1 },

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

  versionContainer: { alignItems: "center", marginTop: 20, marginBottom: 20 },
  versionText: { fontSize: 12, fontWeight: "500" },
  versionSubText: { fontSize: 11, opacity: 0.7, marginTop: 4 },

  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.7)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  modalContent: {
    width: "100%",
    maxWidth: 400,
    borderRadius: 20,
    padding: 24,
    maxHeight: "85%",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "bold",
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

  modalOptionButton: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.05)",
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#333333",
  },
  modalOptionIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: "rgba(29, 185, 84, 0.1)",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 16,
  },
  modalOptionText: { flex: 1 },
  modalOptionTitle: { fontSize: 16, fontWeight: "600", marginBottom: 2 },
  modalOptionDesc: { fontSize: 13 },

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
  modalCancelButton: { backgroundColor: "rgba(255,255,255,0.1)" },
  cancelButton: { backgroundColor: "rgba(255,255,255,0.1)" },
  confirmButton: { backgroundColor: "#1DB954" },
  confirmButtonDisabled: { backgroundColor: "#333333", opacity: 0.6 },
  modalButtonText: { fontWeight: "600", fontSize: 14 },
});
