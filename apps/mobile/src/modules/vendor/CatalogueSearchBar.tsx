/** @jsxImportSource react */
import { useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, font, fontSize, radius, space } from '@swift/ui';

/**
 * [MENU-SEARCH · owner 14 Nov 2026] The store's search box over its own list (VendorMenuScreen): the field language of
 * the vendor InlineInput (a defined border, brand on focus), a search glass, and an x that empties it. Grows with the
 * phone's text size (no fixed height); the x is a full-size tap target.
 */
export function CatalogueSearchBar({
  value,
  onChangeText,
  onClear,
  placeholder,
}: {
  value: string;
  onChangeText: (text: string) => void;
  onClear: () => void;
  placeholder: string;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View
      accessibilityRole="search"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        minHeight: 52,
        borderRadius: radius.md,
        borderWidth: focused ? 1.5 : 1,
        borderColor: focused ? color.brand[500] : color.border.strong,
        backgroundColor: color.surface.base,
        paddingLeft: space.lg,
      }}
    >
      <Feather name="search" size={18} color={color.text.muted} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={color.text.muted}
        accessibilityLabel={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        clearButtonMode="never"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          flex: 1,
          fontFamily: font.body,
          fontSize: fontSize.base,
          color: color.text.primary,
          paddingVertical: space.sm,
          paddingRight: value ? 0 : space.lg,
        }}
      />
      {value ? (
        <Pressable
          onPress={onClear}
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          hitSlop={4}
          style={{ width: 48, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' }}
        >
          <Feather name="x" size={18} color={color.text.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}
