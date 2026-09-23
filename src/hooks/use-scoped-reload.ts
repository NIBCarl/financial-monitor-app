import { useCallback, useEffect, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import { useAppStore, versionKeyFor, type RefreshScope } from '../stores/useAppStore';

/**
 * Loads a screen's data, and reloads it when — and only when — its own data changed.
 *
 * Three properties, all of them the point of this hook:
 *
 *  1. **Scoped.** The screen names the data it shows (`['loans']`), so a payment no longer reloads
 *     the borrower directory's own query unless that query actually shows what changed.
 *  2. **Focus-aware.** A tab that is mounted but not on screen does not run queries: the reload is
 *     deferred until the treasurer opens that tab.
 *  3. **Deduplicated.** Loading the same version twice in one frame (mount plus focus, which both
 *     fire on first open) triggers one query set, not two.
 *
 * `reload` must be a stable callback (`useCallback`) — it is a dependency of the effect.
 */
export function useScopedReload(
  scopes: RefreshScope[],
  reload: () => void | Promise<void>
): void {
  const versionKey = useAppStore((state) => versionKeyFor(state.versions, scopes));

  const loadedKey = useRef<string | null>(null);
  const inFlightKey = useRef<string | null>(null);
  const isFocused = useRef(false);

  // `scopes` is usually an inline array literal; keying off its contents keeps `run` stable.
  const scopeKey = scopes.join('.');

  const run = useCallback(async () => {
    if (inFlightKey.current === versionKey || loadedKey.current === versionKey) return;

    inFlightKey.current = versionKey;
    try {
      await reload();
      loadedKey.current = versionKey;
    } finally {
      inFlightKey.current = null;
    }
    // `scopeKey` is derived from `scopes`, which cannot be a dependency itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionKey, reload, scopeKey]);

  useFocusEffect(
    useCallback(() => {
      isFocused.current = true;
      void run();
      return () => {
        isFocused.current = false;
      };
    }, [run])
  );

  useEffect(() => {
    // While the screen is on-screen, a change to its data reloads it immediately. While it is in
    // the background, the focus effect above picks it up when the treasurer comes back.
    if (isFocused.current || loadedKey.current === null) void run();
  }, [run]);
}
