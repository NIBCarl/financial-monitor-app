# Treasurer Vault (Financial Monitor – Mobile App)

> **A focused, offline-first mobile application designed for treasurers to manage member loans, track collections, monitor overdue dues, and maintain a general cash ledger without requiring borrower logins.**

---

## 📱 How to Test on Your Android Device in 2 Minutes

You **do not** need Android Studio or any cables to test this on your phone:

1. **Install Expo Go:**
   * Open the **Google Play Store** on your Android phone.
   * Search for and install **Expo Go**.

2. **Start the Development Server:**
   * Open your terminal in this directory (`financial-monitor-app`) and run:
     ```bash
     npx expo start
     ```
   * *(Optional: If on a different network/cellular hotspot, run `npx expo start --tunnel`)*

3. **Scan the QR Code:**
   * Open the **Expo Go** app on your Android phone.
   * Tap **"Scan QR code"** and point your camera at the QR code in your terminal.
   * The app will load onto your phone with **live reload enabled**!

---

## ✨ Features Implemented

* 👤 **Zero-Auth Borrower Onboarding:**
  * Register borrowers in under 30 seconds with Name, Phone, and Tag.
  * No borrower accounts, passwords, or emails required.
* 🧮 **Automated Amortization Engine:**
  * Configurable Principal, Interest Rate (Flat %, Monthly %, or 0% Dues), Frequency (Weekly, Bi-Weekly, Monthly, Daily), and Term Count.
  * Real-time repayment schedule preview with exact calendar due dates.
* 🚨 **Proactive Overdue & Due Today Alerts:**
  * Delinquent loan tracking with days late.
  * 1-Tap WhatsApp/SMS payment reminder forwarder.
* 💵 **Installment & Partial Payment Recording:**
  * Quick 1-tap "Mark Paid" or enter custom partial amounts.
  * Automatic schedule status adjustment (`PENDING` -> `PARTIAL` -> `PAID`).
  * Real-time parent loan balance deduction.
* 🧾 **Shareable Proof of Payment (Digital Receipts):**
  * Instant branded digital receipt generation.
  * 1-Tap share sheet integration (WhatsApp, SMS, Messenger, Bluetooth).
* 📖 **General Ledger (Cash In & Out):**
  * Outside-of-loan financial tracking (Membership dues, donations, event expenses).
  * Auto-reconciliation of total liquid cash on hand.
* 📊 **Reports & Data Export:**
  * Loan portfolio recovery health score.
  * Export borrower directory to CSV via native Android share.

---

## 🗄️ Database & Offline Architecture

* **Engine:** Embedded `expo-sqlite` (SQLite 3 with WAL mode enabled).
* **Storage Location:** Local Android sandbox (`financial_monitor.db`).
* **Offline Guarantee:** 100% functional without internet connectivity.
* **Pre-seeded Data:** Contains sample borrowers, active loans, and overdue alerts so you can test all features immediately upon launching.
