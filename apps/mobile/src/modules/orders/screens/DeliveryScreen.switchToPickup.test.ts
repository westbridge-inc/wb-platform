import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// [PROD-RIDER-TEST 11 Nov 2026 · COORD ruling (a)2] No rider was found for an accepted delivery: the customer is offered
// "Switch to pickup" (the server's words: what comes off and what is left to pay) BEFORE the free cancel, which stays.
const screen = readFileSync(join(__dirname, 'DeliveryScreen.tsx'), 'utf8');
const api = readFileSync(join(__dirname, '../../../services/api.ts'), 'utf8');

describe('[PROD-RIDER-TEST (a)2] the customer\'s "Switch to pickup"', () => {
  it('is drawn only from the server\'s offer, in its words, and calls the conversion', () => {
    expect(screen).toContain('o.switchToPickup && typeof o.switchToPickup.message === \'string\'');
    expect(screen).toContain('{o.switchToPickup.message}');
    expect(screen).toContain('label="Switch to pickup"');
    expect(screen).toContain('customerApi.switchToPickup(targetOrderId)');
    // [review S4-4] The first tap only opens the confirmation; the switch is sent from its "Yes" (never the first tap).
    expect(screen).toContain('onPress={() => setConfirmPickupFor(orderId)}');
    expect(screen.match(/switchToPickup\.mutate\(/g)).toHaveLength(1);
    expect(api).toMatch(/switchToPickup: \(id: string\) =>\s*\n\s*api\.post\(`\/customer\/orders\/\$\{id\}\/convert-to-pickup`, \{\}\)/);
  });

  it('comes before the Cancel button, which stays (the last option)', () => {
    const offer = screen.indexOf('label="Switch to pickup"');
    const cancel = screen.lastIndexOf('label={`Cancel ${referenceNoun}`}'); // the order screen's own Cancel (the first is inside the hold card)
    expect(offer).toBeGreaterThan(0);
    expect(cancel).toBeGreaterThan(offer);
  });

  it('a failed switch shows the server\'s reason and reads the order again (a rider or the store may have taken it)', () => {
    const block = screen.slice(screen.indexOf('const switchToPickup = useMutation'), screen.indexOf('const decideSub = useDecideSubstitution();'));
    expect(block).toContain("toast.error('Couldn’t switch to pickup', errorMessage(error,");
    expect(block).toContain('void order.refetch();');
  });
});

describe('[review S4-4] a confirmation before the switch', () => {
  const popup = screen.slice(screen.indexOf('Switch to pickup?'), screen.indexOf('{/* Cancel confirm */}'));

  it('repeats the server\'s words (what comes off, what is left to pay) and says it cannot be undone', () => {
    expect(popup).toContain('{o.switchToPickup.message}');
    expect(popup).toContain('{PICKUP_SWITCH_FINAL}');
    expect(screen).toContain("const PICKUP_SWITCH_FINAL = 'You collect it from the store yourself, and this can’t be undone.';");
  });

  it('"Yes" sends it, for the order the confirmation was opened on; "Keep delivery" closes it', () => {
    expect(popup).toContain('label="Yes, switch to pickup"');
    expect(popup).toContain('switchToPickup.mutate({ targetOrderId: orderId }, { onSettled: () => setConfirmPickupFor(null) })');
    expect(popup).toContain('label="Keep delivery"');
    expect(screen).toContain('visible={confirmPickupFor === orderId && !!o.switchToPickup}');
  });
});
