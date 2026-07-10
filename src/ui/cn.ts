import { clsx, type ClassValue } from 'clsx'

// Minimal class combiner. The SDK ships plain Tailwind utility classes; the host
// supplies the Tailwind runtime. No tailwind-merge to keep the dep surface thin.
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs)
}
