// src/screens/PrivacyPolicyScreen.tsx
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
} as const;

export default function PrivacyPolicyScreen() {
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
          Privacy Policy
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

          <Section title="1. Introduction">
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              YPN Messenger ("we", "our", or "us") is committed to protecting
              your privacy. This Privacy Policy explains how we collect, use,
              and safeguard your information when you use our mobile
              application.
            </Text>
          </Section>

          <Section title="2. Information We Collect">
            <Text style={[styles.subheading, { color: COLORS.text }]}>
              2.1 Account Information
            </Text>
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              When you create an account, we collect your email address,
              username, and optionally a profile picture. This information is
              used to identify you and personalize your experience.
            </Text>

            <Text
              style={[
                styles.subheading,
                { color: COLORS.text },
                { marginTop: 12 },
              ]}
            >
              2.2 Usage Data
            </Text>
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              We automatically collect information about how you use the app,
              including messages sent, features accessed, and device
              information. This helps us improve the app and provide better
              support.
            </Text>

            <Text
              style={[
                styles.subheading,
                { color: COLORS.text },
                { marginTop: 12 },
              ]}
            >
              2.3 Device Information
            </Text>
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              We may collect device model, operating system version, and app
              version to ensure compatibility and troubleshoot issues.
            </Text>
          </Section>

          <Section title="3. How We Use Your Information">
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              We use your information to:
            </Text>
            <Text style={[styles.listItem, { color: COLORS.textSecondary }]}>
              • Provide, maintain, and improve the YPN Messenger app
            </Text>
            <Text style={[styles.listItem, { color: COLORS.textSecondary }]}>
              • Personalize your experience and show relevant content
            </Text>
            <Text style={[styles.listItem, { color: COLORS.textSecondary }]}>
              • Respond to your support requests and inquiries
            </Text>
            <Text style={[styles.listItem, { color: COLORS.textSecondary }]}>
              • Send important updates about the app (you can opt out of
              promotional messages)
            </Text>
            <Text style={[styles.listItem, { color: COLORS.textSecondary }]}>
              • Protect against fraud and ensure app security
            </Text>
          </Section>

          <Section title="4. Data Storage & Security">
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              Your data is stored securely using industry-standard encryption.
              We use Supabase for database storage and Upstash Redis for session
              management. While we implement strong security measures, no method
              of electronic transmission is 100% secure.
            </Text>
          </Section>

          <Section title="5. Third-Party Services">
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              We use trusted third-party services to operate the app:
            </Text>
            <Text style={[styles.listItem, { color: COLORS.textSecondary }]}>
              • <Text style={{ color: COLORS.primary }}>Supabase</Text> -
              Database and authentication
            </Text>
            <Text style={[styles.listItem, { color: COLORS.textSecondary }]}>
              • <Text style={{ color: COLORS.primary }}>Upstash</Text> - Redis
              caching for sessions
            </Text>
            <Text style={[styles.listItem, { color: COLORS.textSecondary }]}>
              • <Text style={{ color: COLORS.primary }}>Cohere</Text> - AI chat
              functionality
            </Text>
            <Text
              style={[
                styles.paragraph,
                { color: COLORS.textSecondary, marginTop: 8 },
              ]}
            >
              These services have their own privacy policies. We encourage you
              to review them.
            </Text>
          </Section>

          <Section title="6. Your Rights">
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              You have the right to:
            </Text>
            <Text style={[styles.listItem, { color: COLORS.textSecondary }]}>
              • Access the personal information we hold about you
            </Text>
            <Text style={[styles.listItem, { color: COLORS.textSecondary }]}>
              • Request correction of inaccurate information
            </Text>
            <Text style={[styles.listItem, { color: COLORS.textSecondary }]}>
              • Request deletion of your account and data
            </Text>
            <Text style={[styles.listItem, { color: COLORS.textSecondary }]}>
              • Opt out of non-essential communications
            </Text>
            <Text
              style={[
                styles.paragraph,
                { color: COLORS.textSecondary, marginTop: 8 },
              ]}
            >
              To exercise these rights, contact us at{" "}
              <Text
                style={{ color: COLORS.primary }}
                onPress={() =>
                  Linking.openURL("mailto:tafadzwarunowanda@gmail.com")
                }
              >
                tafadzwarunowanda@gmail.com
              </Text>
            </Text>
          </Section>

          <Section title="7. Children's Privacy">
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              YPN Messenger is intended for users aged 13 and older. We do not
              knowingly collect personal information from children under 13. If
              you believe we have, please contact us immediately.
            </Text>
          </Section>

          <Section title="8. Changes to This Policy">
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              We may update this Privacy Policy periodically. We will notify you
              of significant changes by posting the new policy in the app and
              updating the "Last Updated" date. Your continued use of the app
              after changes constitutes acceptance.
            </Text>
          </Section>

          <Section title="9. Contact Us">
            <Text style={[styles.paragraph, { color: COLORS.textSecondary }]}>
              If you have questions about this Privacy Policy, please contact:
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
  subheading: { fontSize: 15, fontWeight: "600" },
  paragraph: { fontSize: 14, lineHeight: 22, marginTop: 8 },
  listItem: { fontSize: 14, lineHeight: 22, marginLeft: 8, marginTop: 4 },

  contactLink: { marginTop: 8 },
  contactEmail: { fontSize: 15, fontWeight: "500" },
  contactLocation: { fontSize: 13, marginTop: 4 },

  footer: { paddingVertical: 24, alignItems: "center" },
  footerText: { fontSize: 12 },
});
