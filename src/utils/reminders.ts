import { Alert, Linking, Platform, Share } from 'react-native';
import {
  buildBulkReminderMessage,
  buildReminderMessage,
  normalisePhone,
  type BulkReminderLine,
  type ReminderInput,
} from './reminderText';

/**
 * Payment reminders.
 *
 * Deliberately dependency-free: reminders go through the treasurer's own SMS or WhatsApp app
 * via deep links, so nothing has to be paid for, no phone numbers leave the device through a
 * third party, and it works with zero server setup.
 *
 * The message is always pre-filled and *shown in the composer first* — the treasurer can edit
 * it and decides whether to actually send.
 *
 * The message builders live in `./reminderText` (pure, unit-tested); this module adds the
 * platform plumbing only.
 */

export { buildBulkReminderMessage, buildReminderMessage, normalisePhone };
export type { BulkReminderLine, ReminderInput };

/**
 * Opens the SMS composer with the message pre-filled.
 *
 * Android expects `?body=`, iOS expects `&body=` — the difference matters because a wrong
 * separator silently drops the text on one platform.
 */
export async function openSmsComposer(phone: string, message: string): Promise<boolean> {
  const number = normalisePhone(phone);
  const separator = Platform.OS === 'ios' ? '&' : '?';
  const url = `sms:${number}${separator}body=${encodeURIComponent(message)}`;
  return openUrl(url, 'No messaging app responded. You can copy the reminder and send it manually.');
}

/**
 * Opens WhatsApp with the message pre-filled.
 *
 * WhatsApp needs the number in international form without a leading `+`, hence `normalisePhone`.
 * Falls back to the share sheet when WhatsApp is not installed.
 */
export async function openWhatsApp(phone: string, message: string): Promise<boolean> {
  const number = normalisePhone(phone);
  const url = number
    ? `whatsapp://send?phone=${number}&text=${encodeURIComponent(message)}`
    : `whatsapp://send?text=${encodeURIComponent(message)}`;
  const opened = await openUrl(url, '');
  if (!opened) {
    await Share.share({ message });
    return true;
  }
  return true;
}

/** Returns true when the URL opened; otherwise shows `failureMessage` (if given). */
async function openUrl(url: string, failureMessage: string): Promise<boolean> {
  try {
    const supported = await Linking.canOpenURL(url);
    if (!supported) {
      if (failureMessage) Alert.alert('Cannot open', failureMessage);
      return false;
    }
    await Linking.openURL(url);
    return true;
  } catch (err) {
    if (failureMessage) {
      Alert.alert('Cannot open', err instanceof Error ? err.message : failureMessage);
    }
    return false;
  }
}

/** Asks how the treasurer wants to send, then opens the matching composer. */
export function chooseReminderChannel(phone: string, message: string): void {
  if (!normalisePhone(phone)) {
    void Share.share({ message });
    return;
  }
  Alert.alert('Send reminder', 'How would you like to send this?', [
    { text: 'SMS', onPress: () => void openSmsComposer(phone, message) },
    { text: 'WhatsApp', onPress: () => void openWhatsApp(phone, message) },
    { text: 'Other app', onPress: () => void Share.share({ message }) },
    { text: 'Cancel', style: 'cancel' },
  ]);
}
