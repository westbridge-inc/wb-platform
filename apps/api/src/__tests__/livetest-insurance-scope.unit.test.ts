import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { VEHICLE_CLASSES, isMotorVehicle, type VehicleType } from '../config/vehicle-classes';

// ---------------------------------------------------------------------------
// [LOAD-SEED-FIX · 14 Nov 2026] The provisioner (scripts/livetest/provision.ts approvalBody) approves a mover's
// insurance as the admin. Since R13 (#1774) EVERY motor vehicle's insurance must be confirmed by the reviewer as
// permitting use for hire or reward (verification.service assertStoredVehicleApproval): the API refuses an approval
// without that check (400 INSURANCE_SCOPE_INSUFFICIENT). The helper sent the check for passenger vehicles only, so a
// fresh motorbike rider was never approved: the load seed on the walled copy of staging (13 Nov) made 0 of 390
// riders. CI never runs the journeys or the load seed: this holds the helper to the API's own motor-vehicle rule,
// class by class, with an insurance check the API accepts.
// ---------------------------------------------------------------------------

const PROVISION = join(__dirname, '../../../../scripts/livetest/provision.ts');
let approvalBody: (docId: string, docType: string, vehicleType?: string) => Record<string, unknown>;

beforeAll(async () => {
  ({ approvalBody } = await import(pathToFileURL(PROVISION).href));
});

const CLASSES = Object.keys(VEHICLE_CLASSES) as VehicleType[];

describe('[load seed · R13] the provisioner confirms hire-or-reward insurance for every motor vehicle', () => {
  it('the class list is not vacuous: a motorbike, a car and a bicycle are in it', () => {
    expect(CLASSES).toEqual(expect.arrayContaining(['MOTORCYCLE', 'CAR', 'BICYCLE']));
  });

  it.each(CLASSES)('%s: the insurance check is sent exactly when the API says the vehicle has a motor', (vehicleType) => {
    const body = approvalBody('cmdoc0000000000000000ins1', 'vehicle_insurance', vehicleType);
    if (isMotorVehicle(vehicleType)) {
      // What assertStoredVehicleApproval accepts: coverage class HIRE, confirmed by the reviewer.
      expect(body.insurance).toMatchObject({ coverageClass: 'HIRE', hireClassConfirmed: true });
      const insurance = body.insurance as Record<string, unknown>;
      expect(typeof insurance.insurerName === 'string' && insurance.insurerName.length > 0).toBe(true);
      expect(typeof insurance.policyNumber === 'string' && insurance.policyNumber.length > 0).toBe(true);
    } else {
      expect(body.insurance).toBeUndefined();
    }
  });

  it('a motorbike rider (the load seed\'s delivery riders) gets the check', () => {
    expect(approvalBody('cmdoc0000000000000000ins2', 'vehicle_insurance', 'MOTORCYCLE').insurance).toMatchObject({ coverageClass: 'HIRE', hireClassConfirmed: true });
  });

  it('no other document carries an insurance check, whatever the vehicle', () => {
    for (const docType of ['vehicle_registration', 'drivers_licence', 'fitness_cert']) {
      expect(approvalBody('cmdoc0000000000000000ins3', docType, 'MOTORCYCLE').insurance).toBeUndefined();
    }
  });

  it('the helper\'s no-motor list is the API\'s: only classes isMotorVehicle calls motorless', () => {
    const m = /const NO_MOTOR = new Set\(\[([^\]]*)\]\);/.exec(readFileSync(PROVISION, 'utf8'));
    if (!m) throw new Error('scripts/livetest/provision.ts: the NO_MOTOR set was not found');
    const listed = [...m[1]!.matchAll(/'([A-Z0-9_]+)'/g)].map((x) => x[1]!).sort();
    expect(listed).toEqual(CLASSES.filter((c) => !isMotorVehicle(c)).sort());
  });
});
