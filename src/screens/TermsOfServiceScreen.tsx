// src/screens/TermsOfServiceScreen.tsx
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React from "react";
import {
    Linking,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

const COLORS = {
  background: "#121212",
  surface: "#181818",
  card: "#212121",
  primary: "#1DB954",
  text: "#FFFFFF",
  textSecondary: "#B3B3B3",
  border: "#333333",
  error: "#ef4444",
} as const;

export default function TermsOfServiceScreen() {
  const router = useRouter();

  const Section = ({
    title,
    children,
  }: {
    title: string;
    children: React.ReactNode;
  }) => (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: COLORS.text }]}>{title}</Text>
      {children}
    </View>
  );

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
          Terms of Service
        </Text>
        <View style={{ width: 28 }} />
      </View>

      <ScrollView
        style={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.card, { backgroundColor: COLORS.card }]}>
          <Text style={[styles.lastUpdated, { color: COLORS.textSecondary }]}>
            Last Updated: April 2026
          </Text>

          <Section title="1. Acceptance of Terms">
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              By downloading, accessing, or using YPN Messenger ("the App"), you
              agree to be bound by these Terms of Service ("Terms"). If you do
              not agree, please do not use the App.
            </Text>
          </Section>

          <Section title="2. Eligibility">
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              You must be at least 13 years old to use YPN Messenger. By using
              the App, you represent that you meet this age requirement and have
              the legal capacity to enter into these Terms.
            </Text>
          </Section>

          <Section title="3. Account Responsibilities">
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              • You are responsible for maintaining the confidentiality of your
              account credentials.
            </Text>
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              • You agree to notify us immediately of any unauthorized use of
              your account.
            </Text>
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              • You are responsible for all activities that occur under your
              account.
            </Text>
          </Section>

          <Section title="4. Acceptable Use">
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              You agree NOT to use the App to:
            </Text>
            <Text style={[styles.listItem, { color: COLORS.textSecondary }]}>
              • Harass, threaten, or intimidate other users
            </Text>
            <Text style={[styles.listItem, { color: COLORS.textSecondary }]}>
              • Share illegal, harmful, or offensive content
            </Text>
            <Text style={[styles.listItem, { color: COLORS.textSecondary }]}>
              • Impersonate any person or entity
            </Text>
            <Text style={[styles.listItem, { color: COLORS.textSecondary }]}>
              • Distribute spam, malware, or malicious links
            </Text>
            <Text style={[styles.listItem, { color: COLORS.textSecondary }]}>
              • Violate any applicable laws or regulations
            </Text>
            <Text
              style={[
                styles.paragraph,
                { color: COLORS.textSecondary, marginTop: 8 },
              ]}
            >
              We reserve the right to suspend or terminate accounts that violate
              these Terms.
            </Text>
          </Section>

          <Section title="5. Content & Intellectual Property">
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              • You retain ownership of content you create and share through the
              App.
            </Text>
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              • By sharing content, you grant YPN a non-exclusive license to
              display and distribute it within the App for operational purposes.
            </Text>
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              • The App's design, code, and branding are owned by YPN and
              protected by copyright and trademark laws.
            </Text>
          </Section>

          <Section title="6. AI Chat Feature">
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              • The AI chat feature is provided "as is" for informational and
              supportive purposes only.
            </Text>
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              • AI responses are generated automatically and may not always be
              accurate. Do not rely on AI responses for medical, legal, or
              emergency advice.
            </Text>
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              • Conversations with the AI may be stored to improve service
              quality, in accordance with our Privacy Policy.
            </Text>
          </Section>

          <Section title="7. Service Availability">
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              • We strive to keep YPN Messenger available 24/7, but we do not
              guarantee uninterrupted access.
            </Text>
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              • We may modify, suspend, or discontinue the App at any time
              without notice.
            </Text>
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              • You are responsible for your internet connection and any
              associated costs.
            </Text>
          </Section>

          <Section title="8. Limitation of Liability">
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              To the maximum extent permitted by law, YPN and its creators shall
              not be liable for any indirect, incidental, or consequential
              damages arising from your use of the App. Our total liability
              shall not exceed the amount you paid to use the App (if any).
            </Text>
          </Section>

          <Section title="9. Indemnification">
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              You agree to indemnify and hold harmless YPN, its creators, and
              affiliates from any claims, damages, or expenses arising from your
              use of the App or violation of these Terms.
            </Text>
          </Section>

          <Section title="10. Termination">
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              • You may delete your account at any time through the App
              settings.
            </Text>
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              • We may terminate or suspend your account immediately for
              violations of these Terms.
            </Text>
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              • Upon termination, your right to use the App ceases immediately.
            </Text>
          </Section>

          <Section title="11. Governing Law">
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              These Terms shall be governed by the laws of Zimbabwe. Any
              disputes shall be resolved in the courts of Zimbabwe.
            </Text>
          </Section>

          <Section title="12. Changes to Terms">
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              We may update these Terms periodically. We will notify users of
              material changes via the App or email. Continued use after changes
              constitutes acceptance of the new Terms.
            </Text>
          </Section>

          <Section title="13. Contact">
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              For questions about these Terms, contact:
            </Text>
            <TouchableOpacity
              style={styles.contactLink}
              onPress={() =>
                Linking.openURL("mailto:tafadzwarunowanda@gmail.com")
              }
            >
              <Text style={[styles.contactEmail, { color: COLORS.primary }]}>
                tafadzwarunowanda@gmail.com
              </Text>
            </TouchableOpacity>
            <Text
              style={[styles.contactLocation, { color: COLORS.textSecondary }]}
            >
              YPN Initiative • Zimbabwe
            </Text>
          </Section>

          {/* Agreement Checkbox */}
          <View style={styles.agreementBox}>
            <View style={styles.checkboxRow}>
              <View
                style={[styles.checkbox, { borderColor: COLORS.primary }]}
              />
              <Text
                style={[styles.agreementText, { color: COLORS.textSecondary }]}
              >
                By using YPN Messenger, you acknowledge that you have read,
                understood, and agree to be bound by these Terms of Service.
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.footer}>
          <Text style={[styles.footerText, { color: COLORS.textSecondary }]}>
            © 2026 YPN Messenger. All rights reserved.
          </Text>
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
  card: { borderRadius: 16, padding: 20 },
  lastUpdated: { fontSize: 12, marginBottom: 20, textAlign: "center" },

  section: { marginBottom: 24 },
  sectionTitle: { fontSize: 18, fontWeight: "600", marginBottom: 12 },
  paragraph: { fontSize: 14, lineHeight: 22, marginTop: 8 },
  listItem: { fontSize: 14, lineHeight: 22, marginLeft: 8, marginTop: 4 },

  contactLink: { marginTop: 8 },
  contactEmail: { fontSize: 15, fontWeight: "500" },
  contactLocation: { fontSize: 13, marginTop: 4 },

  agreementBox: {
    marginTop: 24,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  checkboxRow: { flexDirection: "row", alignItems: "flex-start" },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 2,
    marginRight: 12,
    marginTop: 2,
  },
  agreementText: { fontSize: 13, flex: 1, lineHeight: 20 },

  footer: { paddingVertical: 24, alignItems: "center" },
  footerText: { fontSize: 12 },
});
