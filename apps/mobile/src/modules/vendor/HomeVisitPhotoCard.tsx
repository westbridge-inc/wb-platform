import { View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Feather } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { Card, PillButton, T } from '../../kit';
import { HOME_VISIT_PHOTO_WORDS } from './homeVisitPhoto';

/**
 * [OWNER-ASKS · owner ruling 9 Nov 2026] Asked only of a business that goes to the customer (homeVisitPhoto): opens the
 * camera screen pushed on the business stack, where "Not now" goes back and a saved photo returns here.
 */
export function HomeVisitPhotoCard() {
  const navigation = useNavigation<any>();
  return (
    <Card style={{ marginBottom: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.xs }}>
        <Feather name="camera" size={16} color={color.brand[600]} />
        <T variant="label" weight="semibold" style={{ flex: 1 }}>{HOME_VISIT_PHOTO_WORDS.title}</T>
      </View>
      <T variant="caption" tone="muted" style={{ marginBottom: space.md }}>{HOME_VISIT_PHOTO_WORDS.body}</T>
      <PillButton label={HOME_VISIT_PHOTO_WORDS.action} onPress={() => navigation.navigate('Selfie')} />
    </Card>
  );
}
