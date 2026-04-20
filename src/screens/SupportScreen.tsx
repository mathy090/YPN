// src/screens/SupportScreen.tsx (or app/support.tsx)
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

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

const SUPPORT_EMAIL = "tafadzwarunowanda@gmail.com";

export default function SupportScreen() {
  const router = useRouter();
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [isSending, setIsSending] = useState(false);

  const handleSendRequest = async () => {
    if (!subject.trim() || !message.trim()) {
      Alert.alert(
        "Missing Information",
        "Please fill in both subject and message.",
      );
      return;
    }

    setIsSending(true);
    Keyboard.dismiss();

    try {
      const mailtoUrl = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
        `[YPN Support] ${subject.trim()}`,
      )}&body=${encodeURIComponent(
        `Hello,\n\n${message.trim()}\n\n---\nSent from YPN Messenger App`,
      )}`;

      const supported = await Linking.canOpenURL(mailtoUrl);

      if (supported) {
        await Linking.openURL(mailtoUrl);
        Alert.alert(
          "Request Sent",
          "Your email app has opened with your request. Please send the email to complete your support request.",
          [{ text: "OK", onPress: () => router.back() }],
        );
      } else {
        Alert.alert(
          "Email Not Available",
          `No email app found. Please contact support directly at ${SUPPORT_EMAIL}`,
          [{ text: "OK" }],
        );
      }
    } catch (error) {
      console.error("[Support] Email error:", error);
      Alert.alert(
        "Error",
        `Could not open email app. Please contact ${SUPPORT_EMAIL} directly.`,
        [{ text: "OK" }],
      );
    } finally {
      setIsSending(false);
    }
  };

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: COLORS.background }]}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <Ionicons name="chevron-back" size={28} color={COLORS.primary} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: COLORS.text }]}>
          Help Center
        </Text>
        <View style={{ width: 28 }} />
      </View>

      <ScrollView
        style={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Info Card */}
        <View style={[styles.infoCard, { backgroundColor: COLORS.card }]}>
          <Ionicons
            name="help-circle"
            size={32}
            color={COLORS.primary}
            style={styles.infoIcon}
          />
          <Text style={[styles.infoTitle, { color: COLORS.text }]}>
            Need Help?
          </Text>
          <Text style={[styles.infoText, { color: COLORS.textSecondary }]}>
            Describe your issue below and we'll get back to you within 24-48
            hours. Your request will be sent directly to our support team.
          </Text>
        </View>

        {/* Form */}
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
        >
          <View style={[styles.formCard, { backgroundColor: COLORS.card }]}>
            {/* Subject Field */}
            <View style={styles.inputGroup}>
              <Text
                style={[styles.inputLabel, { color: COLORS.textSecondary }]}
              >
                SUBJECT *
              </Text>
              <View style={[styles.inputRow, { borderColor: COLORS.border }]}>
                <Ionicons
                  name="chatbubble-ellipses"
                  size={18}
                  color={COLORS.textSecondary}
                />
                <TextInput
                  value={subject}
                  onChangeText={setSubject}
                  placeholder="Brief description of your issue"
                  placeholderTextColor={COLORS.textSecondary}
                  style={[styles.input, { color: COLORS.text }]}
                  maxLength={100}
                  editable={!isSending}
                />
              </View>
            </View>

            {/* Message Field */}
            <View style={styles.inputGroup}>
              <Text
                style={[styles.inputLabel, { color: COLORS.textSecondary }]}
              >
                MESSAGE *
              </Text>
              <View
                style={[styles.textareaRow, { borderColor: COLORS.border }]}
              >
                <Ionicons
                  name="create"
                  size={18}
                  color={COLORS.textSecondary}
                  style={styles.textareaIcon}
                />
                <TextInput
                  value={message}
                  onChangeText={setMessage}
                  placeholder="Please describe your issue in detail..."
                  placeholderTextColor={COLORS.textSecondary}
                  style={[styles.textarea, { color: COLORS.text }]}
                  multiline
                  numberOfLines={6}
                  textAlignVertical="top"
                  maxLength={1000}
                  editable={!isSending}
                />
              </View>
              <Text style={[styles.charCount, { color: COLORS.textSecondary }]}>
                {message.length}/1000
              </Text>
            </View>

            {/* Send Button */}
            <TouchableOpacity
              style={[
                styles.sendButton,
                (!subject.trim() || !message.trim() || isSending) &&
                  styles.sendButtonDisabled,
              ]}
              onPress={handleSendRequest}
              disabled={!subject.trim() || !message.trim() || isSending}
              activeOpacity={0.8}
            >
              {isSending ? (
                <View style={styles.sendingRow}>
                  <Text style={[styles.sendButtonText, { color: "#000" }]}>
                    Opening Email...
                  </Text>
                </View>
              ) : (
                <>
                  <Ionicons
                    name="send"
                    size={18}
                    color="#000"
                    style={{ marginRight: 8 }}
                  />
                  <Text style={[styles.sendButtonText, { color: "#000" }]}>
                    Send Request
                  </Text>
                </>
              )}
            </TouchableOpacity>

            {/* Direct Contact */}
            <View style={styles.directContact}>
              <Text
                style={[styles.directLabel, { color: COLORS.textSecondary }]}
              >
                Or contact directly:
              </Text>
              <TouchableOpacity
                onPress={() => Linking.openURL(`mailto:${SUPPORT_EMAIL}`)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={[styles.directEmail, { color: COLORS.primary }]}>
                  {SUPPORT_EMAIL}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>

        {/* FAQ Preview */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: COLORS.textSecondary }]}>
            Quick Answers
          </Text>
          <View style={[styles.card, { backgroundColor: COLORS.card }]}>
            <TouchableOpacity style={styles.faqItem}>
              <Text style={[styles.faqQuestion, { color: COLORS.text }]}>
                How do I reset my password?
              </Text>
              <Ionicons
                name="chevron-forward"
                size={16}
                color={COLORS.textSecondary}
              />
            </TouchableOpacity>
            <View
              style={[styles.divider, { backgroundColor: COLORS.border }]}
            />
            <TouchableOpacity style={styles.faqItem}>
              <Text style={[styles.faqQuestion, { color: COLORS.text }]}>
                Why can't I send messages?
              </Text>
              <Ionicons
                name="chevron-forward"
                size={16}
                color={COLORS.textSecondary}
              />
            </TouchableOpacity>
            <View
              style={[styles.divider, { backgroundColor: COLORS.border }]}
            />
            <TouchableOpacity style={styles.faqItem}>
              <Text style={[styles.faqQuestion, { color: COLORS.text }]}>
                How do I update my profile?
              </Text>
              <Ionicons
                name="chevron-forward"
                size={16}
                color={COLORS.textSecondary}
              />
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  backButton: { padding: 4 },
  headerTitle: { fontSize: 20, fontWeight: "700" },
  scrollContent: { padding: 20 },

  infoCard: {
    borderRadius: 16,
    padding: 20,
    marginBottom: 20,
    alignItems: "center",
  },
  infoIcon: { marginBottom: 12 },
  infoTitle: {
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 8,
    textAlign: "center",
  },
  infoText: { fontSize: 14, textAlign: "center", lineHeight: 20 },

  formCard: { borderRadius: 16, padding: 20, marginBottom: 24 },
  inputGroup: { marginBottom: 20 },
  inputLabel: {
    fontSize: 11,
    letterSpacing: 1.2,
    fontWeight: "600",
    marginBottom: 8,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    height: 50,
  },
  textareaRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 12,
    minHeight: 120,
  },
  textareaIcon: { marginTop: 4, marginRight: 8 },
  input: { flex: 1, fontSize: 15 },
  textarea: { flex: 1, fontSize: 15, lineHeight: 20 },
  charCount: { fontSize: 11, textAlign: "right", marginTop: 4 },

  sendButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.primary,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  sendButtonDisabled: { backgroundColor: "#333333", opacity: 0.6 },
  sendingRow: { flexDirection: "row", alignItems: "center" },
  sendButtonText: { fontWeight: "600", fontSize: 16 },

  directContact: {
    alignItems: "center",
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  directLabel: { fontSize: 12, marginBottom: 4 },
  directEmail: { fontSize: 14, fontWeight: "500" },

  section: { marginBottom: 24 },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 12,
    marginLeft: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  card: { borderRadius: 16, overflow: "hidden" },
  faqItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
  },
  faqQuestion: { fontSize: 15, fontWeight: "500", flex: 1, marginRight: 8 },
  divider: { height: 1, marginLeft: 16 },
});
