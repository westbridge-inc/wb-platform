/**
 * [CALLS-ERASE · legal review F1, 9 Nov 2026] Before an account is deleted or closed from this phone, take the phone
 * out of in-app calls FIRST, while the session can still ask the server for the removal token.
 *
 * Why first: deleting the account revokes every session on the server. The sign-out teardown that follows
 * (authStore revokeCapturedSession) asks for the removal token with that session, is refused (401), and the phone's
 * push token would stay with Twilio, bound to a dead identity, until Twilio's own expiry. The privacy policy says the
 * app asks Twilio to remove it when you sign out; this keeps that true for a deletion too.
 *
 * Never throws and never blocks the request that follows: unregisterInAppCalls is bounded (UNREGISTER_TIMEOUT_MS) and
 * returns false on any failure. A phone that never registered sends nothing. If the request is then not sent (the
 * security code sheet is dismissed) or the account stays open (a closure REQUEST the team completes later), the
 * app's own reach registers the phone again on its next check while the person is on a live order.
 *
 * What the phone cannot do: when the removal token cannot be fetched at all (the session was already ended
 * elsewhere: "sign out other devices", a deletion made on another phone or by the team, a refused refresh, or an
 * expired session while offline), nothing on the phone can remove the binding. Twilio's Voice React Native SDK
 * 1.8.1 has NO local, token-free unregister: Voice.unregister(token) on both platforms (iOS
 * TwilioVoiceSDK.unregisterWithAccessToken, Android Voice.unregister(token, FCM, fcmToken)) is a request to Twilio
 * that needs a server-issued access token. In that case Swift can never ring that identity again (it is per session
 * and the session is gone), and Twilio removes the stale registration on its own schedule.
 */
import type { AuthSessionSnapshot } from '../lib/authSession';

export async function unregisterCallsBeforeAccountEnds(session: AuthSessionSnapshot): Promise<boolean> {
  try {
    const voice = await import('./inAppVoice');
    return await voice.unregisterInAppCalls(async (platform) =>
      (await import('./api')).inAppUnregisterTokenForLiveSession(session, platform));
  } catch {
    return false;
  }
}
