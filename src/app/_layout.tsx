import React, { useEffect } from 'react';
import { Tabs, DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { LayoutDashboard, Users, BookOpen, BarChart3 } from 'lucide-react-native';
import { useColorScheme, Platform, AppState } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import { getDatabase, optimizeDatabase } from '../db/client';
import { runAutoBackupIfDue } from '../services/backupService';
import { settingsRepo } from '../db/repositories/settingsRepo';
import { useAppStore } from '../stores/useAppStore';

SplashScreen.preventAutoHideAsync().catch(() => {});

/**
 * expo-router only provides safe-area context *inside* the tab navigator, so the root
 * layout has to supply it for `useSafeAreaInsets()` to work here.
 */
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <TabLayout />
    </SafeAreaProvider>
  );
}

function TabLayout() {
  const colorScheme = useColorScheme();
  // On-screen 3-button navigation reports a large bottom inset; using it keeps the tab
  // bar above the system buttons instead of underneath them (and still looks right on
  // gesture-navigation devices, where the inset is smaller).
  const insets = useSafeAreaInsets();
  const setCurrencySymbol = useAppStore((state) => state.setCurrencySymbol);
  const setOrganizationName = useAppStore((state) => state.setOrganizationName);

  const tabBarHeight =
    Platform.OS === 'ios'
      ? Math.max(insets.bottom, 20) + 56
      : Math.max(insets.bottom, 16) + 60;

  const tabBarPaddingBottom =
    Platform.OS === 'ios' ? Math.max(insets.bottom, 20) : Math.max(insets.bottom, 14);

  useEffect(() => {
    let active = true;

    const bootstrap = async () => {
      try {
        await getDatabase();
        // Hydrate persisted preferences — previously these lived only in memory and
        // silently reverted to the defaults on every cold start.
        const settings = await settingsRepo.getAll();
        if (active) {
          setCurrencySymbol(settings.currency_symbol);
          setOrganizationName(settings.org_name);
        }
      } catch (err) {
        console.error('Failed to initialise the database:', err);
      } finally {
        SplashScreen.hideAsync().catch(() => {});
      }
    };

    void bootstrap();

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        // Refresh the query planner statistics while the app is not in use.
        void optimizeDatabase().catch(() => {});
        // And take the day's backup on the way out, so a phone that is used daily is never more
        // than a day behind without the treasurer doing anything (§20.9). Both calls are gated
        // internally (cadence, "nothing changed", empty book), so this is cheap when there is
        // nothing to do.
        void runAutoBackupIfDue().catch((err) => {
          console.warn('Background backup skipped:', err);
        });
      }
    });

    return () => {
      active = false;
      subscription.remove();
    };
  }, [setCurrencySymbol, setOrganizationName]);

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: '#0284c7', // Sky Blue 600
          tabBarInactiveTintColor: '#64748b',
          tabBarStyle: {
            backgroundColor: '#ffffff',
            borderTopColor: '#e0f2fe',
            borderTopWidth: 1,
            height: tabBarHeight,
            paddingBottom: tabBarPaddingBottom,
            paddingTop: 8,
            elevation: 4,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: -2 },
            shadowOpacity: 0.04,
            shadowRadius: 3,
          },
          tabBarLabelStyle: {
            fontSize: 11,
            fontWeight: '600',
          },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Dashboard',
            tabBarIcon: ({ color, size }) => <LayoutDashboard color={color} size={size - 2} />,
          }}
        />
        <Tabs.Screen
          name="borrowers"
          options={{
            title: 'Borrowers',
            tabBarIcon: ({ color, size }) => <Users color={color} size={size - 2} />,
          }}
        />
        <Tabs.Screen
          name="ledger"
          options={{
            title: 'Ledger',
            tabBarIcon: ({ color, size }) => <BookOpen color={color} size={size - 2} />,
          }}
        />
        <Tabs.Screen
          name="reports"
          options={{
            title: 'Reports',
            tabBarIcon: ({ color, size }) => <BarChart3 color={color} size={size - 2} />,
          }}
        />
      </Tabs>
    </ThemeProvider>
  );
}
