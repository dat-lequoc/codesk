import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // Tailwind's Vite plugin is not loaded here, so components render
    // unstyled — assertions target roles, text and behaviour, never classes.
    css: false,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/main.tsx',
        'src/test/**',
        'src/**/*.test.{ts,tsx}',
        // Style-token modules are plain string constants.
        'src/**/*-styles.ts',
        'src/features/thread/thread-column.ts',
      ],
    },
  },
})
