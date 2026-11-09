import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { proHomeJobsCard } from './proHomeJobs';

// [OWNER-ASKS · owner ruling 9 Nov 2026 ~20:1xZ (A)] An independent pro takes new home jobs only with a profile photo a
// person checked against the approved ID; the pro's screen says what to add, and opens the camera for the photo.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('[owner 9 Nov (A)] the pro is told what home jobs need', () => {
  it('no photo: asked to take it', () => {
    expect(proHomeJobsCard({ photo: false, photoChecked: false })).toMatchObject({ title: 'Home jobs need your profile photo', action: 'TAKE_PHOTO' });
  });
  it('photo waiting for the check: told, nothing to do', () => {
    expect(proHomeJobsCard({ photo: true, photoChecked: false })).toMatchObject({ title: 'Your photo is being checked', action: null });
  });
  it('ready, or an older server: nothing', () => {
    expect(proHomeJobsCard({ photo: true, photoChecked: true })).toBeNull();
    expect(proHomeJobsCard(undefined)).toBeNull();
    expect(proHomeJobsCard({})).toBeNull();
  });
  it('the pro screen shows the card and opens the camera screen; the customer stack registers it only as ProSelfie', () => {
    const screen = read('./screens/ServiceProviderScreen.tsx');
    expect(screen).toMatch(/proHomeJobsCard\(provider\.homeJobs\)/);
    expect(screen).toMatch(/navigate\?\.\('ProSelfie'\)/);
    const stack = read('../../navigation/CustomerStack.tsx');
    expect(stack).toMatch(/<Stack\.Screen name="ProSelfie" component=\{SelfieCaptureScreen\} \/>/);
  });
});
