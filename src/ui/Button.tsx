import { ActivityIndicator, Text, TouchableOpacity } from 'react-native';
import { colors } from '../theme/colors';

type ButtonProps = {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
};

export default function Button({
  title,
  onPress,
  disabled = false,
  loading = false,
}: ButtonProps) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || loading}
      style={{
        backgroundColor: disabled ? colors.muted : colors.primary,
        paddingVertical: 14,
        borderRadius: 30,
        alignItems: 'center',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {loading ? (
        <ActivityIndicator color="#000" />
      ) : (
        <Text style={{ color: '#000', fontWeight: 'bold', fontSize: 16 }}>
          {title}
        </Text>
      )}
    </TouchableOpacity>
  );
}
