import { useEffect, useState } from 'react';

/**
 * Returns `value` after it has stayed unchanged for `delay` ms.
 *
 * Used for search inputs so typing does not fire a SQLite query and a full list
 * re-render on every keystroke (noticeable on low-end Android devices).
 */
export function useDebouncedValue<T>(value: T, delay: number = 275): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timeout);
  }, [value, delay]);

  return debouncedValue;
}
