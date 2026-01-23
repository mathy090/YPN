import { TextInput } from 'react-native';
import { colors } from '../theme/colors';

type InputProps = {
  value?: string;
  onChangeText?: (text: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'number-pad' | 'phone-pad';
  secureTextEntry?: boolean;
  maxLength?: number;
};

export default function Input({
  value,
  onChangeText,
  placeholder,
  keyboardType = 'default',
  secureTextEntry = false,
  maxLength,
}: InputProps) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.muted}
      keyboardType={keyboardType}
      secureTextEntry={secureTextEntry}
      maxLength={maxLength}
      style={{
        color: colors.text,
        borderBottomWidth: 1,
        borderBottomColor: colors.muted,
        paddingVertical: 10,
        fontSize: 16,
      }}
    />
  );
}
